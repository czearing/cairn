// Dependency-free knowledge graph: every thought is a small dot laid out radially (root center,
// each depth in a ring) so the whole brain fits compactly with no overlap. Labels appear on hover
// and when zoomed in; click a dot for full detail. Cross-links are dashed, hover highlights links.

const ANS = { accent: "#059669", bt: "#059669", label: "answered" };
const UNS = { accent: "#a8a29e", bt: "#78716c", label: "unsolved" };
export const cfg = (n) => (n.answer && n.answer.trim() ? ANS : UNS);
export const firstLine = (t) => (t || "").split("\n")[0];
const esc = (s) => (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const RING = 165, SEP = 34, LABEL_ZOOM = 0.85;

function layout(members, rootId) {
  const ord = new Map(members.map((m, i) => [m.id, i]));
  const ids = new Set(members.map((m) => m.id));
  const adj = new Map(members.map((m) => [m.id, new Set()]));
  for (const m of members) for (const e of m.edges) if (ids.has(e)) { adj.get(m.id).add(e); adj.get(e).add(m.id); }

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

  // collision relaxation so dots never overlap, keeping the radial structure
  const pts = members.map((m) => pos.get(m.id));
  for (let it = 0; it < 200; it++) {
    let moved = false;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], b = pts[j]; let dx = b.x - a.x, dy = b.y - a.y;
      let d = Math.hypot(dx, dy) || 0.01;
      if (d < SEP) { moved = true; const push = (SEP - d) / 2; dx /= d; dy /= d; a.x -= dx * push; a.y -= dy * push; b.x += dx * push; b.y += dy * push; }
    }
    if (!moved) break;
  }

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
  const pad = 90;
  for (const p of pos.values()) { p.x += -minX + pad; p.y += -minY + pad; }
  return { pos, edges, nbr, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}

export function renderGraph(canvas, members, rootId, focusId, onNode) {
  const { pos, edges, nbr, width, height } = layout(members, rootId);
  const byId = new Map(members.map((m) => [m.id, m]));
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
    const g = document.createElement("div");
    g.className = "gnode" + (m.id === focusId ? " focus" : "");
    g.dataset.id = m.id;
    g.style.left = p.x + "px"; g.style.top = p.y + "px";
    g.style.setProperty("--accent", cfg(m).accent);
    g.innerHTML = `<span class="dot"></span><span class="label">${esc(firstLine(m.text))}</span>`;
    g.onclick = (e) => { e.stopPropagation(); onNode(m.id); };
    g.onmouseenter = () => highlight(m.id);
    g.onmouseleave = () => highlight(null);
    stage.appendChild(g);
  }

  function highlight(id) {
    const near = id ? new Set([id, ...nbr.get(id)]) : new Set();
    stage.querySelectorAll(".gnode").forEach((el) => el.classList.toggle("lit", near.has(el.dataset.id)));
    stage.querySelectorAll(".edge").forEach((el) => el.classList.toggle("hot", !!id && (el.dataset.a === id || el.dataset.b === id)));
  }

  canvas.appendChild(stage);
  panZoom(canvas, stage, width, height, focusId && pos.get(focusId), !!focusId);
}

function panZoom(canvas, stage, w, h, focus, drawerOpen) {
  const vw = canvas.clientWidth, vh = canvas.clientHeight, viewW = vw - (drawerOpen ? 400 : 0);
  let z = Math.min(1.2, (viewW - 60) / w, (vh - 60) / h);
  if (!isFinite(z) || z <= 0) z = 1;
  let x = focus ? viewW / 2 - focus.x * z : (viewW - w * z) / 2;
  let y = focus ? vh / 2 - focus.y * z : (vh - h * z) / 2;
  let drag = null;
  const apply = () => { stage.style.transform = `translate(${x}px,${y}px) scale(${z})`; canvas.classList.toggle("zoomed", z >= LABEL_ZOOM); };
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
