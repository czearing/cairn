import { all, create, mutate, remove, link, unlink } from "../core/neurons";
import { search } from "../core/search";
import { config } from "../core/config";

// Optional read/write viewer. Run with `cairn ui`. Serves the brain (+ semantic search) and a
// dependency-free single-page app that can add/edit/delete thoughts and their connections.

const DIR = new URL("./", import.meta.url);
const asset = (name: string, type: string) =>
  new Response(Bun.file(new URL(name, DIR)), { headers: { "content-type": type, "cache-control": "no-store" } });
const bad = (error: string, status = 400) => Response.json({ error }, { status });
type Body = { text?: string; answer?: string; citation?: string; a?: string; b?: string };

async function handler(req: Request): Promise<Response> {
  const { pathname, searchParams } = new URL(req.url);
  const m = req.method;

  if (pathname === "/api/neurons" && m === "GET") return Response.json({ neurons: all() });
  if (pathname === "/api/search") return Response.json({ results: await search(searchParams.get("q") || "") });
  // Skill store viewer: what skills exist, their master prompts, and the score of each run over time.
  if (pathname === "/api/skills" && m === "GET") {
    const { listSkills } = await import("../skill/store");
    const all = listSkills();
    const q = searchParams.get("q");
    if (q && q.trim()) {
      // Semantic search: rank skills by relevance, then keep only the RELEVANT ones (drop the anisotropy-floor
      // tail so "how to write code" stops surfacing "audio ref selection"). Floor at 0.25; if nothing clears it,
      // fall back to the single best match so a vague query still returns something.
      const { rankSkillIds } = await import("../skill/retrieve");
      const order = await rankSkillIds(q);
      const FLOOR = Number(process.env.CAIRN_SKILL_SEARCH_FLOOR || "0.25");
      const kept = order.filter((o) => o.score >= FLOOR);
      const chosen = kept.length ? kept : order.slice(0, 1);
      const byId = new Map(all.map((s) => [s.id, s]));
      const ranked = chosen.map((o) => { const s = byId.get(o.id); return s ? { ...s, score: o.score } : null; }).filter(Boolean);
      return Response.json({ skills: ranked, query: q });
    }
    return Response.json({ skills: all });
  }
  // Delete a skill (and its runs + version history) by id, for the /skills page delete button.
  if (pathname.startsWith("/api/skills/") && m === "DELETE") {
    const id = decodeURIComponent(pathname.slice("/api/skills/".length));
    const { deleteSkill } = await import("../skill/store");
    return Response.json({ deleted: deleteSkill(id) });
  }
  if (pathname === "/skills") return asset("skills.html", "text/html; charset=utf-8");
  // Live activity feed data, consumed by the unified /skills dashboard (newest first).
  if (pathname === "/api/activity" && m === "GET") { const { readActivity } = await import("../skill/activity"); return Response.json({ activity: readActivity().slice(-100).reverse() }); }
  if (pathname === "/api/review-jobs" && m === "GET") {
    const { listReviewJobs } = await import("../skill/review-queue");
    return Response.json({ jobs: listReviewJobs(100) });
  }
  // /activity converged into /skills (one dashboard: skills + live feed). Redirect old links there.
  if (pathname === "/activity") return new Response(null, { status: 302, headers: { location: "/skills" } });

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
