import { renderGraph, cfg, firstLine } from "/graph.js";
import { openEditor } from "/detail.js";

const app = document.getElementById("app");
const detail = document.getElementById("detail");
const crumb = document.getElementById("crumb");
const toggle = document.getElementById("toggle");
const qInput = document.getElementById("q");

let neurons = [], byId = new Map(), roots = [], mode = "graph", focusNew = null;

const esc = (s) => (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const CAIRN = `<svg width="48" height="48" viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="19" rx="8" ry="2.5" fill="#d6d3d1"/><ellipse cx="12" cy="13.6" rx="6.2" ry="2.3" fill="#e7e5e4"/><ellipse cx="12" cy="8.6" rx="4.5" ry="2.1" fill="#e7e5e4"/><ellipse cx="12" cy="4.4" rx="2.7" ry="1.7" fill="#d6d3d1"/></svg>`;
const emptyHTML = (h, p) => `<div class="empty">${CAIRN}<h2>${h}</h2><p>${p}</p></div>`;
const div = (cls) => { const d = document.createElement("div"); if (cls) d.className = cls; return d; };
const meta = (t) => { const p = document.createElement("p"); p.className = "meta"; p.textContent = t; return p; };
const answered = (n) => n.answer && n.answer.trim();
const title = (n) => firstLine(n.text) || "Untitled";
const go = (path) => { history.pushState({}, "", path); route(); };

async function fetchData() {
  neurons = (await (await fetch("/api/neurons")).json()).neurons;
  byId = new Map(neurons.map((n) => [n.id, n]));
  roots = components();
}
async function load() { await fetchData(); route(); }

// connected components; rep = earliest-created member (insertion order)
function components() {
  const idset = new Set(neurons.map((n) => n.id));
  const adj = new Map(neurons.map((n) => [n.id, new Set()]));
  for (const n of neurons) for (const e of n.edges) if (idset.has(e)) { adj.get(n.id).add(e); adj.get(e).add(n.id); }
  const seen = new Set(), out = [];
  for (const n of neurons) {
    if (seen.has(n.id)) continue;
    const members = [], stack = [n.id];
    seen.add(n.id);
    while (stack.length) { const id = stack.pop(); members.push(byId.get(id)); for (const nb of adj.get(id)) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); } }
    out.push({ rep: n, members });
  }
  return out;
}
const componentOf = (id) => roots.find((r) => r.members.some((m) => m.id === id));

// route = render the main view, then open or close the drawer
function route() {
  if (qInput.value.trim()) return;
  const m = location.pathname.match(/^\/node\/(.+)$/);
  const id = m && decodeURIComponent(m[1]);
  renderMain(id);
  if (id && byId.has(id)) showDetail(id);
  else detail.hidden = true;
}
window.onpopstate = route;
document.getElementById("home").onclick = (e) => { e.preventDefault(); qInput.value = ""; go("/"); };

// renderMain draws #app only; it never touches the drawer (so autosave keeps the editor alive)
function renderMain(focusId) {
  if (qInput.value.trim()) return;
  const id = focusId && byId.has(focusId) ? focusId : null;
  if (id) showComponent(componentOf(id), id);
  else showRoots();
}

function showRoots() {
  toggle.hidden = true;
  crumb.innerHTML = "";
  if (!neurons.length) { app.innerHTML = emptyHTML("No thoughts yet", "Create one to get started."); return; }
  const w = div("wrap");
  w.appendChild(meta(`${roots.length} ${roots.length === 1 ? "root" : "roots"}`));
  for (const r of roots) {
    const done = r.members.every(answered);
    const a = document.createElement("button");
    a.className = "card";
    a.dataset.id = r.rep.id;
    a.style.setProperty("--accent", done ? "#059669" : "#a8a29e");
    a.onclick = () => go("/node/" + r.rep.id);
    a.innerHTML = `<span class="dot"></span><span class="q">${esc(title(r.rep))}</span>` +
      `<span class="count">${r.members.filter(answered).length}/${r.members.length} answered</span>`;
    w.appendChild(a);
  }
  app.replaceChildren(w);
}

function showComponent(comp, focusId) {
  if (!comp) return showRoots();
  toggle.hidden = false;
  const here = (focusId && byId.get(focusId)) || comp.rep;
  crumb.innerHTML = `/ <a href="/" id="back">roots</a> / ${esc(title(here)).slice(0, 50)}`;
  crumb.querySelector("#back").onclick = (e) => { e.preventDefault(); go("/"); };
  if (mode === "list") {
    const w = div("wrap");
    w.appendChild(meta(`${comp.members.length} ${comp.members.length === 1 ? "thought" : "thoughts"}`));
    for (const n of comp.members) w.appendChild(card(n, () => go("/node/" + n.id)));
    app.replaceChildren(w);
  } else {
    const canvas = div();
    canvas.id = "canvas";
    canvas.onclick = () => { detail.hidden = true; };
    app.replaceChildren(canvas);
    renderGraph(canvas, comp.members, comp.rep.id, focusId, (id) => go("/node/" + id));
  }
}

function card(n, onClick) {
  const c = cfg(n);
  const b = document.createElement("button");
  b.className = "card";
  b.dataset.id = n.id;
  b.style.setProperty("--accent", c.accent);
  b.onclick = onClick;
  b.innerHTML = `<span class="dot"></span><span style="flex:1"><span class="q">${esc(title(n))}</span>` +
    `${answered(n) ? `<span class="a">${esc(n.answer).slice(0, 170)}</span>` : ""}</span>`;
  return b;
}

// ── editor wiring ──
function showDetail(id) {
  const ft = id === focusNew; focusNew = null;
  openEditor(id, { byId, neurons, go, saved, reloadAndReopen, reloadAndClose, focusTitle: ft });
}

function mergeLocal(u) {
  const i = neurons.findIndex((n) => n.id === u.id);
  if (i >= 0) neurons[i] = u; else neurons.push(u);
  byId.set(u.id, u); roots = components();
}
// autosave callback: keep the live drawer; only repaint the main view when needed
function saved(prev, u) {
  mergeLocal(u);
  const flipped = !!(prev.answer && prev.answer.trim()) !== !!(u.answer && u.answer.trim());
  if (flipped) renderMain(u.id);
  else document.querySelectorAll(`[data-id="${u.id}"] .q,[data-id="${u.id}"] .text`).forEach((el) => (el.textContent = title(u)));
}
async function reloadAndReopen(id) { await fetchData(); renderMain(id); showDetail(id); }
async function reloadAndClose() { await fetchData(); detail.hidden = true; go("/"); }

document.getElementById("new").onclick = async () => {
  const { neuron } = await (await fetch("/api/neurons", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Untitled question" }),
  })).json();
  await fetchData(); focusNew = neuron.id; go("/node/" + neuron.id);
};

// ── search ──
let timer;
qInput.oninput = () => {
  clearTimeout(timer);
  if (!qInput.value.trim()) return route();
  timer = setTimeout(async () => {
    const q = qInput.value.trim();
    const results = (await (await fetch("/api/search?q=" + encodeURIComponent(q))).json()).results;
    toggle.hidden = true; crumb.innerHTML = ""; detail.hidden = true;
    const w = div("wrap");
    w.appendChild(meta(`${results.length} result${results.length !== 1 ? "s" : ""}`));
    if (!results.length) w.appendChild(Object.assign(document.createElement("p"), { textContent: "No matches.", style: "color:var(--muted)" }));
    results.forEach((n) => w.appendChild(card(n, () => { qInput.value = ""; go("/node/" + n.id); })));
    app.replaceChildren(w);
  }, 220);
};

toggle.querySelectorAll("button").forEach((b) =>
  (b.onclick = () => {
    mode = b.dataset.mode;
    toggle.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    route();
  })
);

load();
