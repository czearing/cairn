// Dependency-free graph rendering: a layered (left-to-right) tree layout + SVG edges + pan/zoom.

const ANS = { accent: "#059669", bt: "#059669", label: "answered" };
const UNS = { accent: "#a8a29e", bt: "#78716c", label: "unsolved" };
export const cfg = (n) => (n.answer && n.answer.trim() ? ANS : UNS);
export const firstLine = (t) => (t || "").split("\n")[0];
const esc = (s) => (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const W = 230, H = 62, HGAP = 84, VGAP = 22;

function layout(members, rootId) {
  const ids = new Set(members.map((m) => m.id));
  const adj = new Map(members.map((m) => [m.id, new Set()]));
  for (const m of members) for (const e of m.edges) if (ids.has(e)) { adj.get(m.id).add(e); adj.get(e).add(m.id); }

  const layer = new Map([[rootId, 0]]), order = [], q = [rootId];
  while (q.length) {
    const id = q.shift(); order.push(id);
    for (const nb of adj.get(id)) if (!layer.has(nb)) { layer.set(nb, layer.get(id) + 1); q.push(nb); }
  }
  for (const m of members) if (!layer.has(m.id)) { layer.set(m.id, 0); order.push(m.id); }

  const byLayer = new Map();
  for (const id of order) { const l = layer.get(id); (byLayer.get(l) ?? byLayer.set(l, []).get(l)).push(id); }
  const rows = Math.max(1, ...[...byLayer.values()].map((a) => a.length));
  const height = rows * (H + VGAP);
  const pos = new Map();
  for (const [l, list] of byLayer) {
    const offY = (height - list.length * (H + VGAP)) / 2;
    list.forEach((id, i) => pos.set(id, { x: l * (W + HGAP), y: offY + i * (H + VGAP) }));
  }
  return { pos, width: byLayer.size * (W + HGAP), height };
}

export function renderGraph(canvas, members, rootId, focusId, onNode) {
  const { pos, width, height } = layout(members, rootId);
  const NS = "http://www.w3.org/2000/svg";
  canvas.innerHTML = "";
  const stage = document.createElement("div");
  stage.id = "stage";

  const svg = document.createElementNS(NS, "svg");
  svg.id = "edges";
  svg.setAttribute("width", width + W);
  svg.setAttribute("height", height + H);
  const drawn = new Set();
  for (const m of members) for (const t of m.edges) {
    if (!pos.has(m.id) || !pos.has(t)) continue;
    const key = [m.id, t].sort().join("|");
    if (drawn.has(key)) continue;
    drawn.add(key);
    let a = pos.get(m.id), b = pos.get(t);
    if (a.x > b.x) [a, b] = [b, a];
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "#cbd5e1");
    path.setAttribute("stroke-width", "1.6");
    svg.appendChild(path);
  }
  stage.appendChild(svg);

  for (const m of members) {
    const p = pos.get(m.id);
    if (!p) continue;
    const c = cfg(m);
    const node = document.createElement("div");
    node.className = "node" + (m.id === focusId ? " focus" : "");
    node.style.left = p.x + "px";
    node.style.top = p.y + "px";
    node.style.setProperty("--accent", c.accent);
    node.innerHTML = `<span class="badge" style="--bt:${c.bt}">${c.label}</span>${esc(firstLine(m.text)).slice(0, 96)}`;
    node.onclick = (e) => { e.stopPropagation(); onNode(m.id); };
    stage.appendChild(node);
  }

  canvas.appendChild(stage);
  enablePanZoom(canvas, stage, width + W, height + H);
}

function enablePanZoom(canvas, stage, w, h) {
  const vw = canvas.clientWidth, vh = canvas.clientHeight;
  let z = Math.min(1, (vw - 60) / w, (vh - 60) / h);
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
