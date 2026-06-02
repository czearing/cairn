import { all } from "../core/neurons";
import { search } from "../core/search";
import { config } from "../core/config";

// Optional read-only viewer. Not part of the MCP/inject core — run with `cairn ui`.
// Serves the brain as JSON (+ semantic search) and a dependency-free single-page app.

const DIR = new URL("./", import.meta.url);
const asset = (name: string, type: string) =>
  new Response(Bun.file(new URL(name, DIR)), { headers: { "content-type": type } });

async function handler(req: Request): Promise<Response> {
  const { pathname, searchParams } = new URL(req.url);
  if (pathname === "/api/neurons") return Response.json({ neurons: all() });
  if (pathname === "/api/search") return Response.json({ results: await search(searchParams.get("q") || "") });
  if (pathname === "/app.js") return asset("app.js", "text/javascript; charset=utf-8");
  if (pathname === "/graph.js") return asset("graph.js", "text/javascript; charset=utf-8");
  return asset("index.html", "text/html; charset=utf-8");
}

export function start(port: number = config.uiPort) {
  return Bun.serve({ port, fetch: handler });
}

if (import.meta.main) {
  const server = start();
  console.log(`Cairn viewer → http://localhost:${server.port}  (brain: ${config.dbPath})`);
}
