// Dependency-free graph: a RADIAL tree shows the whole brain compactly. Root at center, each depth
// in a ring radiating outward (uses 360 degrees instead of one wide row), so even large graphs fit
// in a tight disc. Small nodes, distinct cross-links, hover to highlight a node's connections.

const ANS = { accent: "#059669", bt: "#059669", label: "answered" };
const UNS = { accent: "#a8a29e", bt: "#78716c", label: "unsolved" };
export const cfg = (n) => (n.answer && n.answer.trim() ? ANS : UNS);
export const firstLine = (t) => (t || "").split("\n")[0];
const esc = (s) => (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const NW = 168, NH = 54, RING = 230;

function layout(members, rootId) {
  const ord = new Map(members.map((m, i) => [m.id, i]));
  const ids = new Set(members.map((m) => m.id));
  const adj = new Map(members.map((m) => [m.id, new Set()]));
  for (const m of members) for (const e of m.edges) if (ids.has(e)) { adj.get(m.id).add(e); adj.get(e).add(m.id); }

  // BFS spanning tree from root; remaining edges are cross-links
  const start = ids.has(rootId) ? rootId : members[0] && members[0].id;
  const parent = new Map(), kids = new Map(members.map((m) => [m.id, []])), depth = new Map(), seen = new Set();
  const bfs = (r) => { seen.add(r); depth.set(r, 0); const q = [r];
    while (q.length) { const id = q.shift();
      for (const nb of [...adj.get(id)].sort((a, b) => ord.get(a) - ord.get(b))) {
        if (seen.has(nb)) continue;
        seen.add(nb); parent.set(nb, id); kids.get(id).push(nb); depth.set(nb, depth.get(id) + 1); q.push(nb);
      } } };
  if (start) bfs(start);
  for (const m of members) if (!seen.has(m.id)) bfs(m.id);

  const leaves = (id) => kids.get(id).length ? kids.get(id).reduce((s, k) => s + leaves(k), 0) : 1;
  const pos = new Map();
  const roots = members.filter((m) => !parent.has(m.id)).map((m) => m.id);
  const assign = (id, a0, a1) => {
    const d = depth.get(id), ang = (a0 + a1) / 2, r = d * RING;
    pos.set(id, { x: Math.cos(ang) * r, y: Math.sin(ang) * r });
    const cs = kids.get(id); if (!cs.length) return;
    const total = leaves(id); let cur = a0;
    for (const c of cs) { const w = leaves(c) / total; assign(c, cur, cur + (a1 - a0) * w); cur += (a1 - a0) * w; }
  };
  roots.forEach((r, i) => assign(r, (i / roots.length) * 6.2832, ((i + 1) / roots.length) * 6.2832));

  const edges = [], nbr = new Map(members.map((m) => [m.id, new Set()])), drawn = new Set();
  for (const m of members) for (const e of m.edges) {
    if (!pos.has(e) || m.id === e) continue;
    const key = [m.id, e].sort().join("|");
    if (drawn.has(key)) continue;
    drawn.add(key);
    nbr.get(m.id).add(e); nbr.get(e).add(m.id);
    edges.push({ a: m.id, b: e, tree: parent.get(m.id) === e || parent.get(e) === m.id });
  }
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (const p of pos.values()) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const pad = NW;
  for (const p of pos.values()) { p.x += -minX + pad; p.y += -minY + pad; }
  return { pos, edges, nbr, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}

export function renderGraph(canvas, members, rootId, focusId, onNode) {
  const { pos, edges, nbr, width, height } = layout(members, rootId);
  const NS = "http://www.w3.org/2000/svg";
  canvas.innerHTML = "";
  const stage = document.createElement("div");
  stage.id = "stage";

  const svg = document.createElementNS(NS, "svg");
  svg.id = "edges"; svg.setAttribute("width", width); svg.setAttribute("height", height);
  for (const e of edges) {
    const a = pos.get(e.a), b = pos.get(e.b);
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", `M${a.x},${a.y} L${b.x},${b.y}`);
    path.setAttribute("class", e.tree ? "edge" : "edge cross");
    path.dataset.a = e.a; path.dataset.b = e.b;
    svg.appendChild(path);
  }
  stage.appendChild(svg);

  for (const m of members) {
    const p = pos.get(m.id);
    const node = document.createElement("div");
    node.className = "node sm" + (m.id === focusId ? " focus" : "");
    node.dataset.id = m.id;
    node.style.left = p.x - NW / 2 + "px";
    node.style.top = p.y - NH / 2 + "px";
    node.style.setProperty("--accent", cfg(m).accent);
    node.innerHTML = `<span class="text">${esc(firstLine(m.text))}</span>`;
    node.onclick = (e) => { e.stopPropagation(); onNode(m.id); };
    node.onmouseenter = () => highlight(m.id);
    node.onmouseleave = () => highlight(null);
    stage.appendChild(node);
  }

  function highlight(id) {
    const near = id ? new Set([id, ...nbr.get(id)]) : null;
    stage.querySelectorAll(".node").forEach((el) => el.classList.toggle("dim", !!near && !near.has(el.dataset.id)));
    stage.querySelectorAll(".edge").forEach((el) => {
      const on = id && (el.dataset.a === id || el.dataset.b === id);
      el.classList.toggle("hot", !!on); el.classList.toggle("faded", !!near && !on);
    });
  }

  canvas.appendChild(stage);
  panZoom(canvas, stage, width, height, focusId && pos.get(focusId), !!focusId);
}

function panZoom(canvas, stage, w, h, focus, drawerOpen) {
  const vw = canvas.clientWidth, vh = canvas.clientHeight, viewW = vw - (drawerOpen ? 400 : 0);
  let z = Math.min(1.4, (viewW - 60) / w, (vh - 60) / h);
  if (!isFinite(z) || z <= 0) z = 1;
  let x = (viewW - w * z) / 2, y = (vh - h * z) / 2, drag = null;
  const apply = () => (stage.style.transform = `translate(${x}px,${y}px) scale(${z})`);
  apply();
  canvas.onmousedown = (e) => { drag = { x: e.clientX - x, y: e.clientY - y }; canvas.classList.add("drag"); };
  canvas.onmousemove = (e) => { if (!drag) return; x = e.clientX - drag.x; y = e.clientY - drag.y; apply(); };
  const end = () => { drag = null; canvas.classList.remove("drag"); };
  canvas.onmouseup = end; canvas.onmouseleave = end;
  canvas.onwheel = (e) => {
    e.preventDefault();
    const nz = Math.min(2.5, Math.max(0.15, z * (e.deltaY < 0 ? 1.12 : 0.88)));
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    x = cx - (cx - x) * (nz / z); y = cy - (cy - y) * (nz / z); z = nz; apply();
  };
}
