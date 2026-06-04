// Dependency-free LOCAL graph: render only the focused node's neighborhood so it stays legible no
// matter how huge the brain gets. Parent sits above, children grid below, cross-links to the side.
// Click any node to recenter on it and walk outward. Edge style marks backbone vs cross-link.

const ANS = { accent: "#059669", bt: "#059669", label: "answered" };
const UNS = { accent: "#a8a29e", bt: "#78716c", label: "unsolved" };
export const cfg = (n) => (n.answer && n.answer.trim() ? ANS : UNS);
export const firstLine = (t) => (t || "").split("\n")[0];
const esc = (s) => (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const W = 220, H = 80, HGAP = 48, VGAP = 72, COLS = 5;

export function renderGraph(canvas, members, rootId, focusId, onNode) {
  const byId = new Map(members.map((m) => [m.id, m]));
  const focus = focusId && byId.has(focusId) ? focusId : rootId;
  if (!byId.has(focus)) return;
  const ord = new Map(members.map((m, i) => [m.id, i]));
  const ids = new Set(members.map((m) => m.id));
  const adj = new Map(members.map((m) => [m.id, new Set()]));
  for (const m of members) for (const e of m.edges) if (ids.has(e)) { adj.get(m.id).add(e); adj.get(e).add(m.id); }
  const parentOf = (x) => { let best = null; for (const e of adj.get(x)) if (ord.get(e) < ord.get(x)) if (best === null || ord.get(e) < ord.get(best)) best = e; return best; };

  const par = parentOf(focus);
  const nbrs = [...adj.get(focus)];
  const children = nbrs.filter((id) => parentOf(id) === focus).sort((a, b) => ord.get(a) - ord.get(b));
  const cross = nbrs.filter((id) => id !== par && parentOf(id) !== focus).sort((a, b) => ord.get(a) - ord.get(b));

  // centers, focus at origin
  const C = new Map([[focus, { x: 0, y: 0 }]]);
  if (par) C.set(par, { x: 0, y: -(H + VGAP) });
  const cols = Math.min(COLS, Math.max(1, children.length));
  const rowW = cols * (W + HGAP) - HGAP;
  children.forEach((id, i) => C.set(id, { x: -rowW / 2 + W / 2 + (i % cols) * (W + HGAP), y: (H + VGAP) + Math.floor(i / cols) * (H + VGAP) }));
  cross.forEach((id, i) => C.set(id, { x: rowW / 2 + W + HGAP, y: i * (H + VGAP) }));

  const NS = "http://www.w3.org/2000/svg";
  canvas.innerHTML = "";
  const stage = document.createElement("div");
  stage.id = "stage";

  // edges from focus to each shown neighbor
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (const { x, y } of C.values()) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const pad = 90, ox = -minX + pad, oy = -minY + pad;
  const at = (id) => ({ x: C.get(id).x + ox, y: C.get(id).y + oy });
  const width = maxX - minX + pad * 2, height = maxY - minY + pad * 2;

  const svg = document.createElementNS(NS, "svg");
  svg.id = "edges"; svg.setAttribute("width", width); svg.setAttribute("height", height);
  const fc = at(focus);
  for (const id of [par, ...children, ...cross].filter(Boolean)) {
    const p = at(id), isCross = cross.includes(id);
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", `M${fc.x},${fc.y} L${p.x},${p.y}`);
    path.setAttribute("class", isCross ? "edge cross" : "edge");
    svg.appendChild(path);
  }
  stage.appendChild(svg);

  const draw = (id) => {
    const m = byId.get(id), p = at(id), c = cfg(m);
    const node = document.createElement("div");
    node.className = "node" + (id === focus ? " focus" : "");
    node.style.left = p.x - W / 2 + "px";
    node.style.top = p.y - H / 2 + "px";
    node.style.setProperty("--accent", c.accent);
    const more = adj.get(id).size - 1; // connections not shown from here
    node.innerHTML = `<span class="badge" style="--bt:${c.bt}">${c.label}</span><span class="text">${esc(firstLine(m.text))}</span>` +
      (id !== focus && more > 0 ? `<span class="more">+${more}</span>` : "");
    if (id !== focus) node.onclick = (e) => { e.stopPropagation(); onNode(id); };
    stage.appendChild(node);
  };
  draw(focus);
  [par, ...children, ...cross].filter(Boolean).forEach(draw);

  canvas.appendChild(stage);
  fitCenter(canvas, stage, width, height, at(focus), !!focusId);
}

function fitCenter(canvas, stage, w, h, focus, drawerOpen) {
  const vw = canvas.clientWidth, vh = canvas.clientHeight;
  const viewW = vw - (drawerOpen ? 400 : 0);
  let z = Math.min(1, (viewW - 80) / w, (vh - 80) / h);
  z = Math.max(z, 0.4);
  let x = viewW / 2 - focus.x * z, y = vh / 2 - focus.y * z, drag = null;
  const apply = () => (stage.style.transform = `translate(${x}px,${y}px) scale(${z})`);
  apply();
  canvas.onmousedown = (e) => { drag = { x: e.clientX - x, y: e.clientY - y }; canvas.classList.add("drag"); };
  canvas.onmousemove = (e) => { if (!drag) return; x = e.clientX - drag.x; y = e.clientY - drag.y; apply(); };
  const end = () => { drag = null; canvas.classList.remove("drag"); };
  canvas.onmouseup = end; canvas.onmouseleave = end;
  canvas.onwheel = (e) => {
    e.preventDefault();
    const nz = Math.min(2, Math.max(0.3, z * (e.deltaY < 0 ? 1.1 : 0.9)));
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    x = cx - (cx - x) * (nz / z); y = cy - (cy - y) * (nz / z); z = nz; apply();
  };
}
