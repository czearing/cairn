// Dependency-free node-link graph: a force-directed layout (Fruchterman-Reingold) so connected
// thoughts cluster and cross-links read naturally, plus SVG edges, hover highlighting, pan/zoom.

const ANS = { accent: "#059669", bt: "#059669", label: "answered" };
const UNS = { accent: "#a8a29e", bt: "#78716c", label: "unsolved" };
export const cfg = (n) => (n.answer && n.answer.trim() ? ANS : UNS);
export const firstLine = (t) => (t || "").split("\n")[0];
const esc = (s) => (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const W = 220, H = 80, K = 300, ITERS = 320;

// Deterministic force layout: same members in same order always settle the same way (no jitter
// between re-renders). Positions are node CENTERS.
function layout(members) {
  const n = members.length;
  const idx = new Map(members.map((m, i) => [m.id, i]));
  const ids = new Set(members.map((m) => m.id));
  const edges = [], seen = new Set();
  for (const m of members) for (const e of m.edges) {
    if (!ids.has(e)) continue;
    const key = [m.id, e].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push([idx.get(m.id), idx.get(e)]);
  }
  // deterministic seed: golden-angle spiral
  const pos = members.map((m, i) => {
    const a = i * 2.399963, r = K * 0.55 * Math.sqrt(i + 1);
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
  let t = K * 0.9;
  for (let it = 0; it < ITERS; it++) {
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
      let d = Math.hypot(dx, dy) || 0.01;
      const f = (K * K) / d; // repulsion
      dx = (dx / d) * f; dy = (dy / d) * f;
      disp[i].x += dx; disp[i].y += dy; disp[j].x -= dx; disp[j].y -= dy;
    }
    for (const [a, b] of edges) {
      let dx = pos[a].x - pos[b].x, dy = pos[a].y - pos[b].y;
      let d = Math.hypot(dx, dy) || 0.01;
      const f = (d * d) / K; // attraction
      dx = (dx / d) * f; dy = (dy / d) * f;
      disp[a].x -= dx; disp[a].y -= dy; disp[b].x += dx; disp[b].y += dy;
    }
    for (let i = 0; i < n; i++) {
      disp[i].x -= pos[i].x * 0.012; disp[i].y -= pos[i].y * 0.012; // gravity to center
      const d = Math.hypot(disp[i].x, disp[i].y) || 0.01, lim = Math.min(d, t);
      pos[i].x += (disp[i].x / d) * lim; pos[i].y += (disp[i].y / d) * lim;
    }
    t = Math.max(t * 0.97, 2); // cool
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pos) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const pad = 100, out = new Map();
  members.forEach((m, i) => out.set(m.id, { x: pos[i].x - minX + pad, y: pos[i].y - minY + pad }));
  return { pos: out, edges, width: (maxX - minX) + pad * 2, height: (maxY - minY) + pad * 2 };
}

export function renderGraph(canvas, members, rootId, focusId, onNode) {
  const { pos, width, height } = layout(members);
  const NS = "http://www.w3.org/2000/svg";
  canvas.innerHTML = "";
  const stage = document.createElement("div");
  stage.id = "stage";

  const svg = document.createElementNS(NS, "svg");
  svg.id = "edges";
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  const nbr = new Map(members.map((m) => [m.id, new Set()]));
  const drawn = new Set();
  for (const m of members) for (const e of m.edges) {
    if (!pos.has(m.id) || !pos.has(e)) continue;
    const key = [m.id, e].sort().join("|");
    if (drawn.has(key)) continue;
    drawn.add(key);
    nbr.get(m.id).add(e); nbr.get(e).add(m.id);
    const a = pos.get(m.id), b = pos.get(e);
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", `M${a.x},${a.y} L${b.x},${b.y}`);
    path.setAttribute("class", "edge");
    path.dataset.a = m.id; path.dataset.b = e;
    svg.appendChild(path);
  }
  stage.appendChild(svg);

  for (const m of members) {
    const p = pos.get(m.id);
    if (!p) continue;
    const c = cfg(m);
    const node = document.createElement("div");
    node.className = "node" + (m.id === focusId ? " focus" : "");
    node.dataset.id = m.id;
    node.style.left = p.x - W / 2 + "px";
    node.style.top = p.y - H / 2 + "px";
    node.style.setProperty("--accent", c.accent);
    node.innerHTML = `<span class="badge" style="--bt:${c.bt}">${c.label}</span><span class="text">${esc(firstLine(m.text))}</span>`;
    node.onclick = (e) => { e.stopPropagation(); onNode(m.id); };
    node.onmouseenter = () => highlight(m.id);
    node.onmouseleave = () => highlight(focusId);
    stage.appendChild(node);
  }

  // Highlight a node, its edges, and its neighbors; dim the rest. null clears.
  function highlight(id) {
    const near = id ? new Set([id, ...nbr.get(id)]) : null;
    stage.querySelectorAll(".node").forEach((el) => el.classList.toggle("dim", !!near && !near.has(el.dataset.id)));
    stage.querySelectorAll(".edge").forEach((el) => {
      const on = id && (el.dataset.a === id || el.dataset.b === id);
      el.classList.toggle("hot", !!on);
      el.classList.toggle("dim", !!near && !on);
    });
  }

  canvas.appendChild(stage);
  enablePanZoom(canvas, stage, width, height);
  if (focusId) highlight(focusId);
}

function enablePanZoom(canvas, stage, w, h) {
  const vw = canvas.clientWidth, vh = canvas.clientHeight;
  let z = Math.min(1, (vw - 80) / w, (vh - 80) / h);
  if (!isFinite(z) || z <= 0) z = 1;
  let x = (vw - w * z) / 2, y = (vh - h * z) / 2, drag = null;
  const apply = () => (stage.style.transform = `translate(${x}px,${y}px) scale(${z})`);
  apply();

  canvas.onmousedown = (e) => { drag = { x: e.clientX - x, y: e.clientY - y }; canvas.classList.add("drag"); };
  canvas.onmousemove = (e) => { if (!drag) return; x = e.clientX - drag.x; y = e.clientY - drag.y; apply(); };
  const end = () => { drag = null; canvas.classList.remove("drag"); };
  canvas.onmouseup = end;
  canvas.onmouseleave = end;
  canvas.onwheel = (e) => {
    e.preventDefault();
    const nz = Math.min(2, Math.max(0.2, z * (e.deltaY < 0 ? 1.1 : 0.9)));
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    x = cx - (cx - x) * (nz / z); y = cy - (cy - y) * (nz / z); z = nz; apply();
  };
}
