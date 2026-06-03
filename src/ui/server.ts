import { all, create, mutate, remove, link, unlink } from "../core/neurons";
import { search } from "../core/search";
import { config } from "../core/config";

// Optional read/write viewer. Run with `cairn ui`. Serves the brain (+ semantic search) and a
// dependency-free single-page app that can add/edit/delete thoughts and their connections.

const DIR = new URL("./", import.meta.url);
const asset = (name: string, type: string) =>
  new Response(Bun.file(new URL(name, DIR)), { headers: { "content-type": type } });
const bad = (error: string, status = 400) => Response.json({ error }, { status });
type Body = { text?: string; answer?: string; citation?: string; a?: string; b?: string };

async function handler(req: Request): Promise<Response> {
  const { pathname, searchParams } = new URL(req.url);
  const m = req.method;

  if (pathname === "/api/neurons" && m === "GET") return Response.json({ neurons: all() });
  if (pathname === "/api/search") return Response.json({ results: await search(searchParams.get("q") || "") });

  if (pathname === "/api/neurons" && m === "POST") {
    const b = (await req.json()) as Body;
    return b.text?.trim() ? Response.json({ neuron: await create(b.text) }) : bad("text is required");
  }

  const node = pathname.match(/^\/api\/neurons\/(.+)$/);
  if (node) {
    const id = decodeURIComponent(node[1]!);
    if (m === "DELETE") return Response.json({ deleted: remove(id) });
    if (m === "PATCH") {
      const b = (await req.json()) as Body;
      try {
        const n = await mutate(id, { text: b.text, answer: b.answer, citation: b.citation });
        return n ? Response.json({ neuron: n }) : bad("not found", 404);
      } catch (e) {
        return bad(e instanceof Error ? e.message : String(e));
      }
    }
  }

  if (pathname === "/api/link" && m === "POST") { const b = (await req.json()) as Body; if (b.a && b.b) link(b.a, b.b); return Response.json({ ok: true }); }
  if (pathname === "/api/unlink" && m === "POST") { const b = (await req.json()) as Body; if (b.a && b.b) unlink(b.a, b.b); return Response.json({ ok: true }); }

  if (pathname === "/app.js") return asset("app.js", "text/javascript; charset=utf-8");
  if (pathname === "/graph.js") return asset("graph.js", "text/javascript; charset=utf-8");
  if (pathname === "/detail.js") return asset("detail.js", "text/javascript; charset=utf-8");
  return asset("index.html", "text/html; charset=utf-8");
}

export function start(port: number = config.uiPort) {
  return Bun.serve({ port, fetch: handler });
}

if (import.meta.main) {
  const server = start();
  console.log(`Cairn viewer → http://localhost:${server.port}  (brain: ${config.dbPath})`);
}
