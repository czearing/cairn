import { renderGraph, cfg, firstLine } from "/graph.js";

const app = document.getElementById("app");
const detail = document.getElementById("detail");
const crumb = document.getElementById("crumb");
const toggle = document.getElementById("toggle");
const qInput = document.getElementById("q");

let neurons = [], byId = new Map(), roots = [], mode = "graph";

const esc = (s) => (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const linkify = (s) =>
  esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noreferrer" style="color:var(--accent)">${u}</a>`);
const CAIRN = `<svg width="48" height="48" viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="19" rx="8" ry="2.5" fill="#d6d3d1"/><ellipse cx="12" cy="13.6" rx="6.2" ry="2.3" fill="#e7e5e4"/><ellipse cx="12" cy="8.6" rx="4.5" ry="2.1" fill="#e7e5e4"/><ellipse cx="12" cy="4.4" rx="2.7" ry="1.7" fill="#d6d3d1"/></svg>`;
const emptyHTML = (h, p) => `<div class="empty">${CAIRN}<h2>${h}</h2><p>${p}</p></div>`;
const div = (cls) => { const d = document.createElement("div"); if (cls) d.className = cls; return d; };
const meta = (t) => { const p = document.createElement("p"); p.className = "meta"; p.textContent = t; return p; };
const answered = (n) => n.answer && n.answer.trim();
const go = (path) => { history.pushState({}, "", path); route(); };

async function load() {
  neurons = (await (await fetch("/api/neurons")).json()).neurons;
  byId = new Map(neurons.map((n) => [n.id, n]));
  roots = components();
  route();
}

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

function route() {
  if (qInput.value.trim()) return;
  detail.hidden = true;
  const m = location.pathname.match(/^\/node\/(.+)$/);
  const id = m && decodeURIComponent(m[1]);
  if (id && byId.has(id)) showComponent(componentOf(id), id);
  else showRoots();
}
window.onpopstate = route;
document.getElementById("home").onclick = (e) => { e.preventDefault(); qInput.value = ""; go("/"); };

// ── roots list ──
function showRoots() {
  toggle.hidden = true;
  crumb.innerHTML = "";
  if (!neurons.length) {
    app.innerHTML = emptyHTML("Nothing here yet", "Markers left for whoever comes next — the first thought starts the trail.");
    return;
  }
  const w = div("wrap");
  w.appendChild(meta(`Roots · ${roots.length}`));
  for (const r of roots) {
    const done = r.members.every(answered);
    const a = document.createElement("button");
    a.className = "card";
    a.style.setProperty("--accent", done ? "#059669" : "#a8a29e");
    a.onclick = () => go("/node/" + r.rep.id);
    a.innerHTML = `<span class="dot"></span><span class="q">${esc(firstLine(r.rep.text))}</span>` +
      `<span class="count">${r.members.filter(answered).length}/${r.members.length} answered</span>`;
    w.appendChild(a);
  }
  app.replaceChildren(w);
}

// ── one component: graph or list ──
function showComponent(comp, focusId) {
  if (!comp) return showRoots();
  toggle.hidden = false;
  crumb.innerHTML = `/ <a href="/" id="back">roots</a> / ${esc(firstLine(comp.rep.text)).slice(0, 50)}`;
  crumb.querySelector("#back").onclick = (e) => { e.preventDefault(); go("/"); };

  if (mode === "list") {
    const w = div("wrap");
    w.appendChild(meta(`${comp.members.length} neurons`));
    for (const n of comp.members) w.appendChild(card(n, () => openDetail(n.id)));
    app.replaceChildren(w);
  } else {
    const canvas = div();
    canvas.id = "canvas";
    canvas.onclick = () => { detail.hidden = true; };
    app.replaceChildren(canvas);
    renderGraph(canvas, comp.members, comp.rep.id, focusId, openDetail);
  }
  if (focusId) openDetail(focusId);
}

function card(n, onClick) {
  const c = cfg(n);
  const b = document.createElement("button");
  b.className = "card";
  b.style.setProperty("--accent", c.accent);
  b.onclick = onClick;
  b.innerHTML = `<span class="dot"></span><span style="flex:1"><span class="q">${esc(firstLine(n.text))}</span>` +
    `${answered(n) ? `<span class="a">${esc(n.answer).slice(0, 170)}</span>` : ""}</span>`;
  return b;
}

// ── detail drawer ──
function openDetail(id) {
  const n = byId.get(id);
  if (!n) return;
  const c = cfg(n);
  detail.hidden = false;
  detail.innerHTML =
    `<button class="x">×</button>` +
    `<span class="badge" style="font-size:11px;font-weight:700;text-transform:uppercase;color:${c.bt}">${c.label}</span>` +
    `<div class="lbl">Question</div><div class="q">${esc(n.text)}</div>` +
    `<div class="lbl">Answer</div><div class="ans">${answered(n) ? esc(n.answer) : "<span style='color:#cbd5e1'>—</span>"}</div>` +
    (n.citation && n.citation.trim() ? `<div class="lbl">Citation</div><div class="ans">${linkify(n.citation)}</div>` : "") +
    (n.edges.length ? `<div class="lbl">Edges</div><div id="ed"></div>` : "");
  detail.querySelector(".x").onclick = () => (detail.hidden = true);
  const ed = detail.querySelector("#ed");
  if (ed) for (const e of n.edges) {
    const t = byId.get(e);
    if (!t) continue;
    const ch = document.createElement("span");
    ch.className = "chip";
    ch.textContent = firstLine(t.text).slice(0, 42);
    ch.onclick = () => go("/node/" + e);
    ed.appendChild(ch);
  }
}

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
    w.appendChild(meta(`${results.length} result${results.length !== 1 ? "s" : ""} · most relevant first`));
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
