import { all } from "../core/neurons";
import { config } from "../core/config";

// Optional read-only viewer for the brain. Not part of the MCP/inject core — run it with
// `cairn ui` (or `bun run ui`). Serves the brain as JSON; every page path returns the same
// single-page app, which reads `/node/<id>` from the URL to focus a neuron.

const INDEX = new URL("./index.html", import.meta.url);

function handler(req: Request): Response {
  const { pathname } = new URL(req.url);
  if (pathname === "/api/neurons") return Response.json({ neurons: all() });
  return new Response(Bun.file(INDEX), { headers: { "content-type": "text/html; charset=utf-8" } });
}

export function start(port: number = config.uiPort) {
  return Bun.serve({ port, fetch: handler });
}

if (import.meta.main) {
  const server = start();
  console.log(`Cairn viewer → http://localhost:${server.port}  (brain: ${config.dbPath})`);
}
