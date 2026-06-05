// cairn proxy: an OpenAI-compatible gateway that recalls memory on the way in.
//
// A client points its base_url at this server. On /v1/chat/completions, the proxy searches the brain
// with the latest user message and appends what it finds to the system prompt, then forwards the
// request unchanged to an upstream (Ollama by default) and streams the reply straight back. Every
// other path is forwarded as-is. The request and response shapes never change, so any OpenAI client
// works without modification.

import { search } from "../core/search";
import { resolveUpstream, type Upstream } from "./upstreams";
import { injectMemories, lastUserQuery, formatMemories, type ChatMessage } from "./inject";

const TOPK = Number(process.env.CAIRN_PROXY_MEMORIES || "5");

async function recall(query: string): Promise<string> {
  if (!query.trim()) return "";
  try {
    const hits = (await search(query)).slice(0, TOPK);
    return formatMemories(hits.map((n) => ({ text: n.text, answer: n.answer })));
  } catch {
    return ""; // recall is best-effort; never block the chat on a brain hiccup
  }
}

// Map the incoming path to the upstream. Clients call us at /v1/...; the upstream base already
// ends in /v1, so we strip our /v1 prefix before appending.
function targetUrl(upstream: Upstream, pathname: string, searchStr: string): string {
  const sub = pathname.startsWith("/v1") ? pathname.slice(3) : pathname;
  return `${upstream.baseUrl}${sub}${searchStr}`;
}

function authHeaders(req: Request, upstream: Upstream): Headers {
  const h = new Headers(req.headers);
  h.delete("host");
  h.delete("content-length");
  if (upstream.apiKey) h.set("authorization", `Bearer ${upstream.apiKey}`);
  return h;
}

function upstreamDown(upstream: Upstream, err: unknown): Response {
  const message =
    `cairn proxy: upstream "${upstream.name}" at ${upstream.baseUrl} is unreachable. ` +
    `Is it running? ${err instanceof Error ? err.message : String(err)}`;
  return Response.json({ error: { message, type: "upstream_unreachable" } }, { status: 502 });
}

export function start(): { port: number; upstream: Upstream; stop: () => void } {
  const upstream = resolveUpstream();
  const recallOff = Boolean(process.env.CAIRN_PROXY_NO_RECALL);

  const server = Bun.serve({
    port: Number(process.env.CAIRN_PROXY_PORT ?? 11435),
    idleTimeout: 240, // allow slow local models to stream
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return Response.json({ ok: true, upstream: upstream.name, baseUrl: upstream.baseUrl });
      }

      const target = targetUrl(upstream, url.pathname, url.search);
      const isChat = req.method === "POST" && url.pathname.endsWith("/chat/completions");

      // Chat: read the body, inject recalled memory, forward.
      if (isChat) {
        const raw = await req.text();
        let body: { messages?: ChatMessage[] } | null = null;
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
        let forward = raw;
        if (body && Array.isArray(body.messages) && !recallOff) {
          const memory = await recall(lastUserQuery(body.messages));
          if (memory) {
            body.messages = injectMemories(body.messages, memory);
            forward = JSON.stringify(body);
          }
        }
        const headers = authHeaders(req, upstream);
        headers.set("content-type", "application/json");
        try {
          const resp = await fetch(target, { method: "POST", headers, body: forward });
          return new Response(resp.body, { status: resp.status, headers: resp.headers });
        } catch (err) {
          return upstreamDown(upstream, err);
        }
      }

      // Everything else: forward unchanged.
      try {
        const init: RequestInit = { method: req.method, headers: authHeaders(req, upstream) };
        if (req.method !== "GET" && req.method !== "HEAD") init.body = await req.text();
        const resp = await fetch(target, init);
        return new Response(resp.body, { status: resp.status, headers: resp.headers });
      } catch (err) {
        return upstreamDown(upstream, err);
      }
    },
  });

  return { port: server.port ?? 0, upstream, stop: () => void server.stop(true) };
}
