// Dependency-free graph: a left-to-right tree with EVERYTHING expanded by default (nothing hidden).
// Width is bounded by depth (a few columns); it grows downward and you scroll like a document.
// Cross-links draw as dashed arcs so it reads as a graph. Hover highlights a node's connections.
// Collapse toggles are optional, for taming very large branches.

const ANS = { accent: "#059669", bt: "#059669", label: "answered" };
const UNS = { accent: "#a8a29e", bt: "#78716c", label: "unsolved" };
export const cfg = (n) => (n.answer && n.answer.trim() ? ANS : UNS);
export const firstLine = (t) => (t || "").split("\n")[0];
const esc = (s) => (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const NW = 220, NH = 48, HGAP = 56, VGAP = 12;
let collapsed = new Set(), lastRoot = null;

export function renderGraph(canvas, members, rootId, focusId, onNode) {
  const byId = new Map(members.map((m) => [m.id, m]));
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
  const descendants = (id) => kids.get(id).reduce((s, k) => s + 1 + descendants(k), 0);

  if (rootId !== lastRoot) { lastRoot = rootId; collapsed = new Set(); } // default: everything expanded

  let x = 0, y = 0, z = 1, drag = null, fitted = false;
  const stage = document.createElement("div");
  stage.id = "stage";
  const apply = () => (stage.style.transform = `translate(${x}px,${y}px) scale(${z})`);

  function render() {
    const pos = new Map(); let row = 0;
    const place = (id) => {
      const cs = collapsed.has(id) ? [] : kids.get(id);
      if (!cs.length) { pos.set(id, { d: depth.get(id), r: row++ }); return; }
      cs.forEach(place);
      pos.set(id, { d: depth.get(id), r: (pos.get(cs[0]).r + pos.get(cs[cs.length - 1]).r) / 2 });
    };
    members.filter((m) => !parent.has(m.id)).forEach((m) => place(m.id));
    const XY = (p) => ({ x: p.d * (NW + HGAP) + 50, y: p.r * (NH + VGAP) + 40 });
    const vis = [...pos.keys()], visSet = new Set(vis);
    const width = Math.max(...vis.map((id) => XY(pos.get(id)).x)) + NW + 50;
    const height = Math.max(...vis.map((id) => XY(pos.get(id)).y)) + NH + 40;

    const NS = "http://www.w3.org/2000/svg";
    stage.innerHTML = "";
    const svg = document.createElementNS(NS, "svg");
    svg.id = "edges"; svg.setAttribute("width", width); svg.setAttribute("height", height);
    const nbr = new Map(vis.map((id) => [id, new Set()])), drawn = new Set();
    for (const id of vis) for (const e of adj.get(id)) {
      if (!visSet.has(e)) continue;
      const key = [id, e].sort().join("|"); if (drawn.has(key)) continue; drawn.add(key);
      nbr.get(id).add(e); nbr.get(e).add(id);
      const tree = parent.get(id) === e || parent.get(e) === id;
      const a = XY(pos.get(id)), b = XY(pos.get(e)), [l, r] = a.x <= b.x ? [a, b] : [b, a];
      const x1 = l.x + NW, y1 = l.y + NH / 2, x2 = r.x, y2 = r.y + NH / 2, mx = (x1 + x2) / 2;
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`);
      path.setAttribute("class", tree ? "edge" : "edge cross");
      path.dataset.a = id; path.dataset.b = e;
      svg.appendChild(path);
    }
    stage.appendChild(svg);

    for (const id of vis) {
      const m = byId.get(id), p = XY(pos.get(id)), n = kids.get(id).length;
      const node = document.createElement("div");
      node.className = "tnode" + (id === focusId ? " focus" : "");
      node.dataset.id = id;
      node.style.left = p.x + "px"; node.style.top = p.y + "px"; node.style.setProperty("--accent", cfg(m).accent);
      const tog = n ? `<button class="ttoggle">${collapsed.has(id) ? "+" + descendants(id) : "−"}</button>` : "";
      node.innerHTML = `<span class="tlabel">${esc(firstLine(m.text))}</span>${tog}`;
      node.onclick = (e) => { e.stopPropagation(); onNode(id); };
      node.onmouseenter = () => light(id);
      node.onmouseleave = () => light(null);
      if (n) node.querySelector(".ttoggle").onclick = (e) => {
        e.stopPropagation(); collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); render();
      };
      stage.appendChild(node);
    }

    function light(id) {
      const near = id ? new Set([id, ...nbr.get(id)]) : new Set();
      stage.querySelectorAll(".tnode").forEach((el) => el.classList.toggle("lit", near.has(el.dataset.id)));
      stage.querySelectorAll(".edge").forEach((el) => el.classList.toggle("hot", !!id && (el.dataset.a === id || el.dataset.b === id)));
    }

    if (!fitted) {
      fitted = true;
      const vw = canvas.clientWidth, vh = canvas.clientHeight, viewW = vw - (focusId ? 400 : 0);
      z = Math.min(1, (viewW - 70) / width); if (!isFinite(z) || z <= 0) z = 1; // fit WIDTH (keep readable), scroll height
      const f = focusId && pos.has(focusId) ? XY(pos.get(focusId)) : null;
      x = Math.max(20, (viewW - width * z) / 2);
      y = f ? Math.min(40, vh / 2 - (f.y + NH / 2) * z) : 30;
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
  // Figma-style: scroll pans, shift-scroll pans sideways, cmd/ctrl-scroll (and trackpad pinch)
  // zooms toward the cursor. Zoom is continuous (proportional to the gesture), not stepped.
  canvas.onwheel = (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = canvas.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
      const nz = Math.min(3, Math.max(0.1, z * Math.exp(-e.deltaY * 0.0016)));
      x = cx - (cx - x) * (nz / z); y = cy - (cy - y) * (nz / z); z = nz;
    } else if (e.shiftKey) {
      x -= e.deltaY || e.deltaX;
    } else {
      x -= e.deltaX; y -= e.deltaY;
    }
    apply();
  };
}
