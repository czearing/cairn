// Dependency-free COLLAPSIBLE tree (progressive disclosure). Readable labelled nodes, root expands
// to the right; click a node's toggle to expand/collapse its branch. Collapsed nodes show a +N of
// what is hidden, so huge brains stay clean and readable. Click a node body to open its detail.

const ANS = { accent: "#059669", bt: "#059669", label: "answered" };
const UNS = { accent: "#a8a29e", bt: "#78716c", label: "unsolved" };
export const cfg = (n) => (n.answer && n.answer.trim() ? ANS : UNS);
export const firstLine = (t) => (t || "").split("\n")[0];
const esc = (s) => (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const NW = 208, NH = 46, HGAP = 58, VGAP = 14, DEFAULT_DEPTH = 1;
let collapsed = new Set(), lastRoot = null;

export function renderGraph(canvas, members, rootId, focusId, onNode) {
  const byId = new Map(members.map((m) => [m.id, m]));
  const ord = new Map(members.map((m, i) => [m.id, i]));
  const ids = new Set(members.map((m) => m.id));
  const adj = new Map(members.map((m) => [m.id, new Set()]));
  for (const m of members) for (const e of m.edges) if (ids.has(e)) { adj.get(m.id).add(e); adj.get(e).add(m.id); }

  // BFS spanning tree from root -> parent/children/depth; leftover edges are cross-links
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
  const descendants = (id) => kids.get(id).reduce((s, k) => s + 1 + descendants(k), 0);

  // default: collapse anything deeper than DEFAULT_DEPTH; persist toggles per component
  if (rootId !== lastRoot) {
    lastRoot = rootId; collapsed = new Set();
    for (const m of members) if ((depth.get(m.id) || 0) >= DEFAULT_DEPTH && kids.get(m.id).length) collapsed.add(m.id);
  }
  for (let a = focusId && parent.get(focusId); a; a = parent.get(a)) collapsed.delete(a); // reveal focus

  let x = 0, y = 0, z = 1, drag = null, fitted = false;
  const stage = document.createElement("div");
  stage.id = "stage";
  const apply = () => (stage.style.transform = `translate(${x}px,${y}px) scale(${z})`);

  function render() {
    // layout visible nodes (tidy tree: y by leaf order, x by depth)
    const pos = new Map(); let row = 0;
    const place = (id) => {
      const cs = collapsed.has(id) ? [] : kids.get(id);
      if (!cs.length) { pos.set(id, { d: depth.get(id), r: row++ }); return; }
      cs.forEach(place);
      pos.set(id, { d: depth.get(id), r: (pos.get(cs[0]).r + pos.get(cs[cs.length - 1]).r) / 2 });
    };
    members.filter((m) => !parent.has(m.id)).forEach((m) => place(m.id));
    const XY = (p) => ({ x: p.d * (NW + HGAP) + 60, y: p.r * (NH + VGAP) + 40 });
    const vis = [...pos.keys()];
    const width = Math.max(...vis.map((id) => XY(pos.get(id)).x)) + NW + 60;
    const height = Math.max(...vis.map((id) => XY(pos.get(id)).y)) + NH + 40;

    const NS = "http://www.w3.org/2000/svg";
    stage.innerHTML = "";
    const svg = document.createElementNS(NS, "svg");
    svg.id = "edges"; svg.setAttribute("width", width); svg.setAttribute("height", height);
    const visSet = new Set(vis), drawn = new Set();
    for (const id of vis) for (const e of adj.get(id)) {
      if (!visSet.has(e)) continue;
      const key = [id, e].sort().join("|"); if (drawn.has(key)) continue; drawn.add(key);
      const tree = parent.get(id) === e || parent.get(e) === id;
      const a = XY(pos.get(id)), b = XY(pos.get(e)), [l, r] = a.x <= b.x ? [a, b] : [b, a];
      const x1 = l.x + NW, y1 = l.y + NH / 2, x2 = r.x, y2 = r.y + NH / 2, mx = (x1 + x2) / 2;
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`);
      path.setAttribute("class", tree ? "edge" : "edge cross");
      svg.appendChild(path);
    }
    stage.appendChild(svg);

    for (const id of vis) {
      const m = byId.get(id), p = XY(pos.get(id)), c = cfg(m), n = kids.get(id).length;
      const node = document.createElement("div");
      node.className = "tnode" + (id === focusId ? " focus" : "");
      node.style.left = p.x + "px"; node.style.top = p.y + "px"; node.style.setProperty("--accent", c.accent);
      const toggle = n ? `<button class="ttoggle">${collapsed.has(id) ? "+" + (descendants(id)) : "−"}</button>` : "";
      node.innerHTML = `<span class="tlabel">${esc(firstLine(m.text))}</span>${toggle}`;
      node.onclick = (e) => { e.stopPropagation(); onNode(id); };
      if (n) node.querySelector(".ttoggle").onclick = (e) => {
        e.stopPropagation();
        collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
        render();
      };
      stage.appendChild(node);
    }

    if (!fitted) {
      fitted = true;
      const vw = canvas.clientWidth, vh = canvas.clientHeight, viewW = vw - (focusId ? 400 : 0);
      z = Math.min(1, (viewW - 60) / width, (vh - 60) / height); if (!isFinite(z) || z <= 0) z = 1;
      const f = focusId && pos.has(focusId) ? XY(pos.get(focusId)) : null;
      x = f ? viewW / 2 - (f.x + NW / 2) * z : 30; y = f ? vh / 2 - (f.y + NH / 2) * z : 30;
    }
    apply();
  }

  canvas.innerHTML = "";
  canvas.appendChild(stage);
  render();

  canvas.onmousedown = (e) => { drag = { x: e.clientX - x, y: e.clientY - y }; canvas.classList.add("drag"); };
  canvas.onmousemove = (e) => { if (!drag) return; x = e.clientX - drag.x; y = e.clientY - drag.y; apply(); };
  const end = () => { drag = null; canvas.classList.remove("drag"); };
  canvas.onmouseup = end; canvas.onmouseleave = end;
  canvas.onwheel = (e) => {
    e.preventDefault();
    const nz = Math.min(2, Math.max(0.3, z * (e.deltaY < 0 ? 1.1 : 0.9)));
    const r = canvas.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
    x = cx - (cx - x) * (nz / z); y = cy - (cy - y) * (nz / z); z = nz; apply();
  };
}
