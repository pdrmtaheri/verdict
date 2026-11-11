// The playground page. Repo and agent content is only ever inserted with
// textContent, never as HTML; the only innerHTML below is constant icon markup.
const params = new URLSearchParams(location.search);
const token = params.get("token") ?? "";
let P = params.get("p"); // which playground, when there are several
let V = params.get("v") ?? "main"; // which version of its code
const $ = (id) => document.getElementById(id);
// Every call names the playground; state and checks also name the version.
function withQuery(path, extra = {}) {
  const u = new URL(path, location.origin);
  if (P) u.searchParams.set("p", P);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.pathname + u.search;
}
const api = (path, init = {}, extra = {}) => fetch(withQuery(path, extra), { ...init, headers: { ...init.headers, "x-playground-token": token } });
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== null && text !== undefined) e.textContent = text; return e; };

const ICONS = {
  pass: '<circle cx="12" cy="12" r="10" fill="#0E7A4B"/><path d="M7.5 12.5l3 3 6-6.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  fail: '<circle cx="12" cy="12" r="10" fill="#D42B3A"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>',
  inconclusive: '<circle cx="12" cy="12" r="10" fill="#B7791F"/><path d="M7.5 12h9" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>',
  unplanned: '<circle cx="12" cy="12" r="9" stroke="#8A8A95" stroke-width="1.6" stroke-dasharray="3 3" fill="none"/>',
  unchecked: '<circle cx="12" cy="12" r="9" stroke="#5B5B66" stroke-width="1.6" fill="none"/>',
  running: '<circle cx="12" cy="12" r="9" stroke="#111114" stroke-opacity=".15" stroke-width="2.4" fill="none"/><path class="spin" d="M12 3a9 9 0 0 1 9 9" stroke="#111114" stroke-width="2.4" stroke-linecap="round" fill="none"/>',
};
const icon = (status) => {
  const wrap = el("div", "mark");
  wrap.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[status] ?? ICONS.unchecked}</svg>`;
  return wrap;
};
const WORD = { pass: "Passed", fail: "Failed", inconclusive: "Unsure", running: "Running…" };
// What each kind of check is called to a person.
const KIND = { test: "Test", semgrep: "Code rule", tla: "Model check", llm: "AI review", decision: "Decision model" };
const kindName = (k) => KIND[k] ?? k;
const fileName = (p) => p.split("/").pop();

let state = null;
let selected = null; // law hash
let busy = 0;
let checkingAll = false; // "check all versions" is running
let checking = false; // a check is running: every planned law shows as running until it comes back
// What the last render showed, so only what changed animates.
const prev = { status: new Map(), selected: null, first: true, loaded: false, seen: new Set() };

// "never reads the `now` clock" -> text with <code> for the backticked parts.
function withCode(parent, text) {
  for (const [i, part] of text.split("`").entries()) parent.append(i % 2 ? el("code", "", part) : document.createTextNode(part));
}

// A failure in plain words: a headline, a few points, and the raw output folded away.
function why(e) {
  const w = e.why;
  const box = el("div", "why");
  if (!w) { if (e.message) box.append(el("pre", "err", e.message)); return box; }
  box.append(el("p", `headline ${e.status}`, w.headline));
  if (w.points.length > 0) {
    const ul = el("ul", "points");
    for (const p of w.points) {
      const li = el("li", "");
      li.append(el("span", "", p.text));
      if (p.code) li.append(el("code", "snippet", p.code));
      ul.append(li);
    }
    box.append(ul);
  }
  if (w.raw) {
    const d = el("details", "tech");
    d.append(el("summary", "", "Technical details"), el("pre", "", w.raw));
    d.onclick = (ev) => ev.stopPropagation(); // opening it must not collapse the law
    box.append(d);
  }
  return box;
}

function sub(law) {
  if (law.status === "unplanned") return ["Not planned yet. Press Plan to choose how to check it.", "dim"];
  if (law.status === "running") return [`Running ${law.enforcers.map((e) => kindName(e.kind).toLowerCase()).join(" and ")}…`, "dim"];
  const bad = law.enforcers.find((e) => e.status === "fail") ?? law.enforcers.find((e) => e.status === "inconclusive");
  if (bad) {
    const w = bad.why;
    const line = w ? (w.points[0]?.text ?? w.headline) : bad.message.split("\n")[0];
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- an empty first line must fall back to the file name, which ?? would not do
    return [`${kindName(bad.kind)}: ${line || fileName(bad.path)}`, bad.status];
  }
  if (law.status === "unchecked") return ["Planned. Press Check to run it.", "dim"];
  return [law.enforcers.map((e) => kindName(e.kind)).join(" + "), ""];
}

function lawRow(law, on, index) {
  const row = el("button", `law${on ? " on" : ""}`);
  row.type = "button";
  row.setAttribute("aria-pressed", String(on));
  const mark = icon(law.status);
  if (prev.status.has(law.hash) && prev.status.get(law.hash) !== law.status) mark.classList.add("pop");
  row.append(mark);
  if (prev.first) { row.classList.add("intro"); row.style.animationDelay = `${index * 60}ms`; }
  const body = el("div", "body");
  const text = el("span", "text");
  withCode(text, law.text);
  body.append(text);
  if (!on) {
    const [line, cls] = sub(law);
    if (line) body.append(el("span", `sub ${cls}`, line));
  } else {
    const detail = el("div", "detail");
    if (prev.selected !== law.hash) detail.classList.add("enter");
    for (const e of law.enforcers) {
      const item = el("div", "check");
      const r = el("div", "enf");
      r.append(el("span", "chip", kindName(e.kind)), el("span", "path", fileName(e.path)), el("span", `pill ${e.status ?? "none"}`, e.status ? WORD[e.status] : "Not run"));
      item.append(r);
      if ((e.status === "fail" || e.status === "inconclusive") && (e.why || e.message)) item.append(why(e));
      if (e.status === "pass" && e.scope) item.append(el("p", "scope", `Covers: ${e.scope}`));
      detail.append(item);
    }
    if (law.status === "unplanned") detail.append(el("p", "scope", "Not planned yet. Press Plan to choose how to check this law."));
    if (law.proof) detail.append(el("p", "proof", `To be sure this can really fail, we broke the code on purpose: ${law.proof}`));
    body.append(detail);
  }
  row.append(body);
  row.onclick = () => { selected = law.hash; renderLaws(); };
  return row;
}

// While a check runs, planned laws and their enforcers read as running; unplanned laws have nothing to run.
// Once the server reports the check, it says which laws are still running and has the others' results,
// so a fast law shows its result without waiting for the slowest one.
const shown = () => checking && !state.checking
  ? state.laws.map((l) => (l.status === "unplanned" ? l : { ...l, status: "running", enforcers: l.enforcers.map((e) => ({ ...e, status: "running", message: "" })) }))
  : state.laws;

function renderLaws() {
  const laws = shown();
  const rows = $("law-rows");
  rows.replaceChildren();
  if (laws.length === 0) { rows.append(el("p", "empty", "No laws yet. Press Edit laws and add one as a top-level bullet.")); }
  if (!laws.some((l) => l.hash === selected)) selected = (laws.find((l) => l.status === "fail") ?? laws[0])?.hash ?? null;
  for (const [i, law] of laws.entries()) rows.append(lawRow(law, law.hash === selected, i));
  moveBand();
  prev.status = new Map(laws.map((l) => [l.hash, l.status]));
  prev.selected = selected;
  prev.first = false;

  const counts = $("counts");
  counts.replaceChildren(el("span", "label", `${laws.length} ${laws.length === 1 ? "law" : "laws"}`));
  const n = (s) => laws.filter((l) => l.status === s).length;
  for (const [s, cls, word] of [["running", "none", "running"], ["pass", "pass", "pass"], ["fail", "fail", "fail"], ["inconclusive", "inconclusive", "inconclusive"], ["unchecked", "none", "unchecked"], ["unplanned", "none", "not planned"]]) {
    if (n(s)) counts.append(el("span", `st ${cls}`, `${n(s)} ${word}`));
  }
}

// The brief as a person would read it: paragraphs and bullets, not a block of code.
function renderBrief(box, text) {
  box.replaceChildren(el("h3", "", "What the agent is asked to build"));
  let list = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) { list = null; continue; }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) { list = el("ul", "", ""); box.append(list); }
      const li = el("li");
      withCode(li, bullet[1]);
      list.append(li);
    } else {
      list = null;
      const p = el("p");
      withCode(p, line);
      box.append(p);
    }
  }
}

// The highlighter: one yellow band that sweeps to the selected law instead of each row painting itself.
let bandObserver = null;
function moveBand() {
  const band = document.querySelector("#laws-list .band");
  requestAnimationFrame(() => {
    bandObserver?.disconnect();
    const row = document.querySelector("#law-rows .law.on");
    if (!row) { band.style.opacity = "0"; return; }
    const place = () => { band.style.top = `${row.offsetTop}px`; band.style.height = `${row.offsetHeight}px`; };
    band.style.opacity = "1";
    place();
    // The row grows and shrinks (a failure opens, technical details fold out): the band follows.
    bandObserver = new ResizeObserver(place);
    bandObserver.observe(row);
    requestAnimationFrame(() => band.classList.add("ready")); // no sweep on the very first placement
  });
}
addEventListener("resize", moveBand);

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false });
const WHO = { agent: "agent", ui: "you", server: "verdict" };

function addActivity(a, top = true) {
  const li = el("li", a.isError ? "err" : "");
  const hasId = a.id !== null && a.id !== undefined;
  if (hasId && !prev.seen.has(a.id) && prev.loaded) li.classList.add("fresh");
  if (hasId) prev.seen.add(a.id);
  li.append(el("span", "t", clock(a.at)), el("span", "who", WHO[a.source] ?? a.source), el("span", "tool", a.tool), el("span", "sum", a.summary));
  const ul = $("activity-list");
  if (top) ul.prepend(li);
  else ul.append(li);
  while (ul.children.length > 100) ul.lastChild.remove();
}

function renderConnection() {
  const last = state.activity.find((a) => a.source === "agent");
  const ago = state.activity.findLast((a) => a.source === "agent");
  const latest = ago ?? last;
  $("conn-dot").className = `dot ${latest ? "green" : ""}`;
  $("conn-text").textContent = latest ? "Agent connected" : "No agent connected yet";
  $("conn-text").parentElement.title = $("conn-text").textContent;
  $("dtab-dot").className = `dot ${latest ? "green" : "amber"}`;
  $("wait-dot").className = `dot ${latest ? "green" : "amber"}`;
  $("wait-text").textContent = latest
    ? `Connected. Last tool call: ${latest.tool}, at ${clock(latest.at)}.`
    : "Waiting for the agent to call its first tool. This page updates on its own.";
}

async function openFile(path, li) {
  for (const n of document.querySelectorAll("#file-list li.on")) n.classList.remove("on");
  li.classList.add("on");
  const r = await api(`/api/file?path=${encodeURIComponent(path)}`);
  $("file-view").className = "";
  $("file-view").textContent = await r.text();
}

function renderFiles() {
  const ul = $("file-list");
  ul.replaceChildren();
  for (const f of state.files) { const li = el("li", "", f); li.title = f; li.onclick = () => openFile(f, li); ul.append(li); }
  if (state.files.length === 0) ul.append(el("li", "dim", "no files yet"));
}

function renderConnect() {
  const base = location.origin;
  const many = state.playgrounds.length > 1;
  const url = `${base}/mcp/${state.id}?token=${token}`;
  // One line: a "\\" continuation wraps onto a line of its own in a narrow panel.
  $("cmd-claude").textContent = `claude mcp add --transport http ${many ? `playground-${state.id}` : "playground"} "${url}"`;
  $("cmd-url").textContent = `${base}/mcp/${state.id}`;
  $("cmd-header").textContent = `Authorization: Bearer ${token}`;
}

// Links to the other playgrounds in this folder.
function renderSwitcher() {
  const nav = $("switcher");
  nav.hidden = state.playgrounds.length < 2;
  nav.replaceChildren();
  for (const pg of state.playgrounds) {
    const a = el("a", pg.id === state.id ? "on" : "", pg.title);
    a.href = `/?token=${encodeURIComponent(token)}&p=${encodeURIComponent(pg.id)}`;
    a.title = pg.idea;
    if (pg.id === state.id) a.setAttribute("aria-current", "page");
    nav.append(a);
  }
}

// The versions of the code, all judged by the same laws.
function renderVersions() {
  const box = $("versions");
  box.hidden = state.versions.length < 2;
  const pills = $("vpills");
  pills.replaceChildren();
  for (const v of state.versions) {
    const b = el("button", `vpill${v.id === V ? " on" : ""}`);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(v.id === V));
    b.append(el("span", "vlabel", v.label));
    const t = v.tally;
    if (checkingAll) b.append(el("span", "vtally running", "…"));
    else if (t) b.append(el("span", `vtally ${t.fail ? "fail" : t.inconclusive ? "inconclusive" : "pass"}`, t.fail ? `${t.fail} fail` : t.inconclusive ? `${t.inconclusive} unsure` : `${t.pass}/${t.total}`));
    else b.append(el("span", "vtally none", "not run"));
    b.onclick = () => selectVersion(v.id);
    pills.append(b);
  }
  $("vnote").textContent = state.versions.find((v) => v.id === V)?.note ?? "";
}

async function selectVersion(id) {
  if (id === V) return;
  V = id;
  const u = new URL(location.href);
  u.searchParams.set("v", V);
  history.replaceState(null, "", u);
  selected = null;
  await load();
  reloadPreview();
}

async function load() {
  const r = await api("/api/state", {}, { v: V });
  if (!r.ok) { document.body.textContent = `${r.status}: ${await r.text()}`; return; }
  state = await r.json();
  P = state.id;
  V = state.version;
  const m = state.manifest;
  renderSwitcher();
  renderVersions();
  document.title = `${m.title} · verdict playground`;
  $("title").textContent = m.title;
  $("idea").textContent = m.idea;
  renderBrief($("brief-text"), m.brief);
  $("preview").hidden = !m.panels.includes("preview");
  $("dtab-activity").hidden = !m.panels.includes("activity");
  $("dtab-files").hidden = !m.panels.includes("files");
  $("toggle-brief").hidden = !m.panels.includes("brief");
  renderLaws();
  renderFiles();
  renderConnection();
  $("activity-list").replaceChildren();
  for (const a of state.activity) addActivity(a, true);
  prev.loaded = true;
}

const wait = (ms) => new Promise((r) => {
  setTimeout(r, ms);
});

async function run(button, path) {
  busy++;
  const started = Date.now();
  const isCheck = path.startsWith("/api/check");
  const all = path.includes("v=all");
  if (isCheck) { checking = true; checkingAll = all; renderLaws(); renderVersions(); }
  for (const b of document.querySelectorAll("#plan, #check")) b.disabled = true;
  button.classList.add("busy");
  try {
    const r = await api(path.split("?")[0], { method: "POST" }, isCheck ? { v: all ? "all" : V } : {});
    if (!r.ok) addActivity({ at: new Date().toISOString(), source: "ui", tool: path.slice(5), summary: await r.text(), isError: true });
  } finally {
    if (checking) { await wait(Math.max(0, 700 - (Date.now() - started))); checking = false; checkingAll = false; } // a fast check still reads as a run
    button.classList.remove("busy");
    if (--busy === 0) for (const b of document.querySelectorAll("#plan, #check")) b.disabled = false;
    await load();
  }
}

const reloadPreview = () => { $("preview-frame").src = `/pv/${encodeURIComponent(token)}/${encodeURIComponent(P)}/${encodeURIComponent(V)}/index.html?t=${Date.now()}`; };
const toggle = (id, on) => { $(id).hidden = on ?? !$(id).hidden; };

$("check").onclick = () => run($("check"), "/api/check");
$("check-all").onclick = () => run($("check"), "/api/check?v=all");
$("plan").onclick = () => run($("plan"), "/api/plan");
$("reload").onclick = reloadPreview;
$("toggle-brief").onclick = () => toggle("brief-text");
$("toggle-edit").onclick = () => {
  toggle("edit");
  if (!$("edit").hidden) { $("laws-text").value = state.lawsMarkdown; $("laws-msg").textContent = ""; $("laws-text").focus(); }
};
$("cancel-edit").onclick = () => toggle("edit", true);
$("save-laws").onclick = async () => {
  const r = await api("/api/laws", { method: "PUT", body: JSON.stringify({ markdown: $("laws-text").value }) });
  $("laws-msg").textContent = r.ok ? (await r.json()).message : await r.text();
  if (r.ok) { toggle("edit", true); await load(); }
};
for (const t of document.querySelectorAll(".tab")) {
  t.onclick = () => {
    for (const x of document.querySelectorAll(".tab")) x.classList.toggle("on", x === t);
    $("tab-claude").hidden = t.dataset.tab !== "claude";
    $("tab-other").hidden = t.dataset.tab !== "other";
  };
}
async function copy(text, button) {
  const label = button.textContent;
  try { await navigator.clipboard.writeText(text); button.textContent = "Copied"; }
  catch { button.textContent = "Select and copy"; }
  setTimeout(() => (button.textContent = label), 1500);
}
for (const b of document.querySelectorAll("[data-copy]")) b.onclick = () => copy($(b.dataset.copy).textContent, b);
for (const b of document.querySelectorAll("[data-copy-text]")) b.onclick = () => copy(b.dataset.copyText, b);

// The drawer: closed until a tab is clicked, then it opens upward; drag its top edge to resize.
const drawer = { open: null, height: 300 };
try { drawer.height = Number(localStorage.getItem("playground-drawer-height")) || 300; } catch {}
function setDrawer(panel) {
  drawer.open = panel;
  $("drawer").classList.toggle("open", !!panel);
  $("dpanel").inert = !panel;
  for (const t of document.querySelectorAll(".dtab")) t.setAttribute("aria-expanded", String(t.dataset.panel === panel));
  for (const p of document.querySelectorAll("[data-pane]")) p.hidden = p.dataset.pane !== panel;
  $("dpanel").style.setProperty("--dh", `${drawer.height}px`);
}
for (const t of document.querySelectorAll(".dtab")) t.onclick = () => setDrawer(drawer.open === t.dataset.panel ? null : t.dataset.panel);
$("drawer-close").onclick = () => setDrawer(null);
const maxHeight = () => Math.max(160, document.querySelector(".side").clientHeight - 44 - 160);
function resizeTo(h) {
  drawer.height = Math.min(Math.max(120, h), maxHeight());
  $("dpanel").style.setProperty("--dh", `${drawer.height}px`);
}
$("drawer-handle").onpointerdown = (down) => {
  down.preventDefault();
  const startY = down.clientY, startH = drawer.height;
  document.body.classList.add("dragging");
  const move = (e) => resizeTo(startH + (startY - e.clientY));
  const up = () => {
    document.body.classList.remove("dragging");
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    try { localStorage.setItem("playground-drawer-height", String(drawer.height)); } catch {}
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
};
$("drawer-handle").onkeydown = (e) => {
  if (e.key === "ArrowUp") { e.preventDefault(); resizeTo(drawer.height + 24); }
  if (e.key === "ArrowDown") { e.preventDefault(); resizeTo(drawer.height - 24); }
};

await load();
renderConnect();
reloadPreview();
let pending = null;
new EventSource(`/api/events?token=${encodeURIComponent(token)}&p=${encodeURIComponent(P)}`).onmessage = (m) => {
  const a = JSON.parse(m.data);
  if (a.id === 0) return; // the stream's hello; a ping (id -1) is a law of a running check finishing
  clearTimeout(pending);
  pending = setTimeout(load, 150); // a burst of tool calls reloads once
  if (a.tool === "write_file" && !a.isError && (a.summary.startsWith("public/") || a.summary.startsWith(`versions/${V}/public/`))) reloadPreview();
};
