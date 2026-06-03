import { cfg, firstLine } from "/graph.js";

const drawer = document.getElementById("detail");
const esc = (s) =>
  (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const post = (url, body) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Editable detail drawer. ctx = { byId, neurons, reload, go, reopen }.
export function openEditor(id, ctx) {
  const { byId, neurons, reload, go, reopen } = ctx;
  const n = byId.get(id);
  if (!n) { drawer.hidden = true; return; }
  const c = cfg(n);
  const linkable = neurons
    .filter((t) => t.id !== id && !n.edges.includes(t.id))
    .map((t) => `<option value="${t.id}">${esc(firstLine(t.text)).slice(0, 52)}</option>`)
    .join("");
  const links = n.edges.filter((e) => byId.has(e))
    .map((e) => `<span class="chip" data-go="${e}">${esc(firstLine(byId.get(e).text)).slice(0, 34)}<b data-unlink="${e}">×</b></span>`)
    .join("") || `<span style="color:#a8a29e;font-size:12.5px">No links yet</span>`;

  drawer.hidden = false;
  drawer.innerHTML = `
    <button class="x" data-x>×</button>
    <span class="badge" style="font-size:11px;font-weight:700;text-transform:uppercase;color:${c.bt}">${c.label}</span>
    <div class="lbl">Question</div>
    <textarea class="field" id="f-text" rows="2">${esc(n.text)}</textarea>
    <div class="lbl">Answer</div>
    <textarea class="field" id="f-answer" rows="5" placeholder="Not answered yet">${esc(n.answer)}</textarea>
    <div class="lbl">Citation</div>
    <input class="field" id="f-cite" placeholder="https://…  (required when answered)" value="${esc(n.citation)}" />
    <div class="err" id="f-err" hidden></div>
    <div class="row">
      <button class="btn primary" data-save>Save</button>
      <button class="btn danger" data-del>Delete</button>
    </div>
    <div class="lbl">Links</div>
    <div>${links}</div>
    ${linkable ? `<select class="field" id="f-add" style="margin-top:9px"><option value="">+ Link a thought…</option>${linkable}</select>` : ""}`;

  const q = (s) => drawer.querySelector(s);
  q("[data-x]").onclick = () => (drawer.hidden = true);

  q("[data-save]").onclick = async () => {
    const body = { text: q("#f-text").value, answer: q("#f-answer").value, citation: q("#f-cite").value };
    const res = await fetch("/api/neurons/" + id, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) { const e = q("#f-err"); e.hidden = false; e.textContent = (await res.json()).error || "Save failed"; return; }
    await reload(); reopen(id);
  };

  q("[data-del]").onclick = async () => {
    await fetch("/api/neurons/" + id, { method: "DELETE" });
    drawer.hidden = true; await reload(); go("/");
  };

  drawer.querySelectorAll("[data-unlink]").forEach((b) => (b.onclick = async (ev) => {
    ev.stopPropagation();
    await post("/api/unlink", { a: id, b: b.dataset.unlink });
    await reload(); reopen(id);
  }));
  drawer.querySelectorAll("[data-go]").forEach((ch) => (ch.onclick = () => go("/node/" + ch.dataset.go)));

  const add = q("#f-add");
  if (add) add.onchange = async () => {
    if (!add.value) return;
    await post("/api/link", { a: id, b: add.value });
    await reload(); reopen(id);
  };
}
