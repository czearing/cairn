// Dependency-free graph: a tidy top-down hierarchy (BFS spanning tree from the root) draws the
// decomposition backbone; non-tree edges are drawn as distinct dashed cross-links. Hover or focus
// a node to highlight its connections. Opens centered on the focused node at a legible zoom.

const ANS = { accent: "#059669", bt: "#059669", label: "answered" };
const UNS = { accent: "#a8a29e", bt: "#78716c", label: "unsolved" };
export const cfg = (n) => (n.answer && n.answer.trim() ? ANS : UNS);
export const firstLine = (t) => (t || "").split("\n")[0];
const esc = (s) => (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const W = 220, H = 80, HGAP = 56, VGAP = 78, DRAWER = 400;

function layout(members, rootId) {
  const ord = new Map(members.map((m, i) => [m.id, i]));
  const ids = new Set(members.map((m) => m.id));
  const adj = new Map(members.map((m) => [m.id, []]));
  for (const m of members) for (const e of m.edges) if (ids.has(e)) adj.get(m.id).push(e);

  // BFS spanning tree from the root: first discoverer is the parent; rest of the edges are cross-links
  const parent = new Map(), depth = new Map(), kids = new Map(members.map((m) => [m.id, []]));
  const start = ids.has(rootId) ? rootId : (members[0] && members[0].id);
  const visited = new Set();
  const seed = (r) => { depth.set(r, 0); visited.add(r); const q = [r];
    while (q.length) {
      const id = q.shift();
      for (const nb of adj.get(id).slice().sort((a, b) => ord.get(a) - ord.get(b))) {
        if (visited.has(nb)) continue;
        visited.add(nb); parent.set(nb, id); depth.set(nb, depth.get(id) + 1); kids.get(id).push(nb); q.push(nb);
      }
    } };
  if (start) seed(start);
  for (const m of members) if (!visited.has(m.id)) seed(m.id); // detached pieces become their own roots

  // tidy x: leaves take sequential slots, parents center over their children (post-order)
  const xs = new Map(); let leaf = 0;
  const place = (id) => {
    const cs = kids.get(id);
    if (!cs.length) { xs.set(id, leaf++); return; }
    cs.forEach(place);
    xs.set(id, (xs.get(cs[0]) + xs.get(cs[cs.length - 1])) / 2);
  };
  members.filter((m) => !parent.has(m.id)).forEach((m) => place(m.id));
  for (const m of members) if (!xs.has(m.id)) xs.set(m.id, leaf++);

  const pos = new Map();
  for (const m of members) pos.set(m.id, { x: xs.get(m.id) * (W + HGAP), y: (depth.get(m.id) || 0) * (H + VGAP) });

  const edges = [], nbr = new Map(members.map((m) => [m.id, new Set()])), drawn = new Set();
  for (const m of members) for (const e of m.edges) {
    if (!pos.has(e) || m.id === e) continue;
    const key = [m.id, e].sort().join("|");
    if (drawn.has(key)) continue;
    drawn.add(key);
    nbr.get(m.id).add(e); nbr.get(e).add(m.id);
    const tree = parent.get(m.id) === e || parent.get(e) === m.id;
    edges.push({ a: m.id, b: e, tree });
  }
  let maxX = 0, maxY = 0;
  for (const p of pos.values()) { maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { pos, edges, nbr, width: maxX + W, height: maxY + H };
}

export function renderGraph(canvas, members, rootId, focusId, onNode) {
  const { pos, edges, nbr, width, height } = layout(members, rootId);
  const NS = "http://www.w3.org/2000/svg";
  canvas.innerHTML = "";
  const stage = document.createElement("div");
  stage.id = "stage";

  const svg = document.createElementNS(NS, "svg");
  svg.id = "edges";
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  for (const e of edges) {
    const a = pos.get(e.a), b = pos.get(e.b);
    const path = document.createElementNS(NS, "path");
    if (e.tree) {
      const [t, d] = a.y <= b.y ? [a, b] : [b, a]; // parent on top
      const x1 = t.x + W / 2, y1 = t.y + H, x2 = d.x + W / 2, y2 = d.y, my = (y1 + y2) / 2;
      path.setAttribute("d", `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`);
    } else {
      path.setAttribute("d", `M${a.x + W / 2},${a.y + H / 2} L${b.x + W / 2},${b.y + H / 2}`);
    }
    path.setAttribute("class", e.tree ? "edge" : "edge cross");
    path.dataset.a = e.a; path.dataset.b = e.b;
    svg.appendChild(path);
  }
  stage.appendChild(svg);

  for (const m of members) {
    const p = pos.get(m.id);
    const c = cfg(m);
    const node = document.createElement("div");
    node.className = "node" + (m.id === focusId ? " focus" : "");
    node.dataset.id = m.id;
    node.style.left = p.x + "px";
    node.style.top = p.y + "px";
    node.style.setProperty("--accent", c.accent);
    node.innerHTML = `<span class="badge" style="--bt:${c.bt}">${c.label}</span><span class="text">${esc(firstLine(m.text))}</span>`;
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
      el.classList.toggle("hot", !!on);
      el.classList.toggle("faded", !!near && !on);
    });
  }

  canvas.appendChild(stage);
  enablePanZoom(canvas, stage, width, height, focusId && pos.get(focusId), !!focusId);
}

function enablePanZoom(canvas, stage, w, h, focus, drawerOpen) {
  const vw = canvas.clientWidth, vh = canvas.clientHeight;
  const viewW = vw - (drawerOpen ? DRAWER : 0);
  // open at a legible zoom; fit only when that still keeps cards readable
  let z = Math.min(1, (viewW - 80) / w, (vh - 80) / h);
  z = Math.max(z, 0.55);
  let x, y;
  if (focus) { x = viewW / 2 - (focus.x + W / 2) * z; y = vh / 2 - (focus.y + H / 2) * z; }
  else { x = (viewW - w * z) / 2; y = (vh - h * z) / 2; }
  let drag = null;
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
