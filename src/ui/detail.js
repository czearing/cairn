import { cfg, firstLine } from "/graph.js";

const drawer = document.getElementById("detail");
const esc = (s) =>
  (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const post = (url, body) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const grow = (el) => { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; };

// Inline, Notion-style editor. Fields are borderless and autosave on blur; no Save button.
// ctx = { byId, neurons, go, saved, reloadAndReopen, reloadAndClose, focusTitle }.
export function openEditor(id, ctx) {
  const { byId, neurons, go, saved, reloadAndReopen, reloadAndClose, focusTitle } = ctx;
  const n = byId.get(id);
  if (!n) { drawer.hidden = true; return; }
  const c = cfg(n);
  const linkable = neurons
    .filter((t) => t.id !== id && !n.edges.includes(t.id))
    .map((t) => `<option value="${t.id}">${esc(firstLine(t.text)).slice(0, 52)}</option>`)
    .join("");
  const links = n.edges.filter((e) => byId.has(e))
    .map((e) => `<span class="chip" data-go="${e}">${esc(firstLine(byId.get(e).text)).slice(0, 34)}<b data-unlink="${e}">×</b></span>`)
    .join("") || `<span class="hint">No links yet</span>`;

  drawer.hidden = false;
  drawer.innerHTML = `
    <div class="d-top">
      <span class="badge2" style="--bt:${c.bt}">${c.label}</span>
      <span class="status" id="d-status"></span>
      <button class="icon" data-x title="Close">×</button>
    </div>
    <textarea class="edit title" id="f-text" rows="1" placeholder="Untitled question">${esc(n.text)}</textarea>
    <textarea class="edit answer" id="f-answer" rows="1" placeholder="Write the finding. One fact, one source.">${esc(n.answer)}</textarea>
    <div class="cite-row"><span class="cite-ic">↗</span><input class="edit cite" id="f-cite" placeholder="Source URL" value="${esc(n.citation)}" /></div>
    <div class="err" id="f-err" hidden></div>
    <div class="lbl">Links</div>
    <div id="d-links">${links}</div>
    ${linkable ? `<select class="addlink" id="f-add"><option value="">+ Add a link</option>${linkable}</select>` : ""}
    <button class="del" data-del>Delete thought</button>`;

  const q = (s) => drawer.querySelector(s);
  const status = q("#d-status"), errBox = q("#f-err");
  const text = q("#f-text"), answer = q("#f-answer"), cite = q("#f-cite");
  [text, answer].forEach((el) => { grow(el); el.addEventListener("input", () => grow(el)); });

  async function save() {
    const t = text.value, a = answer.value, ci = cite.value;
    const needsSource = a.trim() && !ci.trim(); // the brain forbids uncited answers; defer the answer
    const body = needsSource ? { text: t } : { text: t, answer: a, citation: ci };
    const changed = needsSource ? t !== n.text : (t !== n.text || a !== n.answer || ci !== n.citation);
    if (needsSource) status.textContent = "Add a source to save the answer";
    if (!changed) return;
    status.textContent = "Saving";
    const res = await fetch("/api/neurons/" + id, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) { errBox.hidden = false; errBox.textContent = (await res.json()).error || "Save failed"; status.textContent = ""; return; }
    errBox.hidden = true;
    const prev = { ...n };
    const updated = (await res.json()).neuron;
    Object.assign(n, updated);
    if (!needsSource) status.textContent = "Saved";
    saved(prev, updated);
  }
  [text, answer, cite].forEach((el) => el.addEventListener("blur", save));

  q("[data-x]").onclick = () => (drawer.hidden = true);
  q("[data-del]").onclick = async (e) => {
    const b = e.currentTarget;
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.classList.add("armed"); b.textContent = "Click again to delete"; return; }
    await fetch("/api/neurons/" + id, { method: "DELETE" });
    reloadAndClose();
  };
  drawer.querySelectorAll("[data-unlink]").forEach((b) => (b.onclick = async (ev) => {
    ev.stopPropagation();
    await post("/api/unlink", { a: id, b: b.dataset.unlink });
    reloadAndReopen(id);
  }));
  drawer.querySelectorAll("[data-go]").forEach((ch) => (ch.onclick = () => go("/node/" + ch.dataset.go)));

  const add = q("#f-add");
  if (add) add.onchange = async () => {
    if (!add.value) return;
    await post("/api/link", { a: id, b: add.value });
    reloadAndReopen(id);
  };

  if (focusTitle) { text.focus(); text.select(); }
}
