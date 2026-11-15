/* Workspace: team tasks (board), chat (1:1 and groups), calendar, documents, team directory, notifications.
   Plugs into admin.js through window.__ADMIN. All access is enforced again by firestore.rules / storage.rules. */
(() => {
const A = window.__ADMIN; if (!A) return;
const {db, storage, esc, imgSrc, MEDIA} = A;
const TS = () => A.TS();
const $ = id => document.getElementById(id);
const content = $("content");
const toDate = t => t && t.toDate ? t.toDate() : (t ? new Date(t) : null);
const uid = () => A.me && A.me.uid;
const isSuper = () => A.role === "super_admin";

const TABS = {ws_tasks: "Tasks", ws_chat: "Chat", ws_calendar: "Calendar", ws_docs: "Documents", ws_team: "Team"};
const STATUSES = [["todo", "To do"], ["doing", "In progress"], ["review", "Review"], ["done", "Done"]];
const PRIORITIES = [["high", "High"], ["med", "Medium"], ["low", "Low"]];
const TYPES = ["Content", "Video", "Design", "Social", "Website", "Admin", "Other"];

let PEOPLE = {}, TASKS = [], CHANNELS = [], NOTES = [], EVENTS = [], DOCS = [], FOLDERS = [], migrated = false;
let subs = [], viewSubs = [], current = null;
let pendingChannel = null, pendingEvent = null;
let taskFilter = "all", openChannel = null, calMonth = (d => new Date(d.getFullYear(), d.getMonth(), 1))(new Date()), docFolder = "All";

/* ---------- helpers ---------- */
const person = id => PEOPLE[id] || {name: "Someone", email: ""};
/* How I appear in notifications: my display name, or my email if I haven't set one */
const myLabel = () => A.myName || (PEOPLE[uid()] || {}).name || (A.me && A.me.email) || "A teammate";
const pname = id => id === uid() ? "You" : (person(id).name || person(id).email || "Someone");
/* Status: what each person chose (online / busy / away / offline). If we haven't seen them in the
   admin for 10 minutes, they show as offline whatever they chose. */
const STATES = [["online", "Online", "🟢"], ["busy", "Busy", "🔴"], ["away", "Away", "🟡"], ["offline", "Appear offline", "⚫"]];
const stateOf = id => { const p = PEOPLE[id]; if (!p) return "offline"; if (p.status === "offline") return "offline";
  const seen = toDate(p.lastSeen); if (!seen || Date.now() - seen > 10 * 60 * 1000) return "offline"; return p.status || "online"; };
const stateLabel = id => { const st = stateOf(id), l = (STATES.find(x => x[0] === st) || STATES[3])[1]; return st === "offline" ? "Offline" : l; };
function avatar(id, size = 32){ return `<span class="av-wrap" title="${esc(stateLabel(id))}">${avatarBare(id, size)}${size >= 22 && PEOPLE[id] ? `<i class="st st-${stateOf(id)}" style="width:${Math.max(8, Math.round(size * .28))}px;height:${Math.max(8, Math.round(size * .28))}px"></i>` : ""}</span>`; }
function avatarBare(id, size = 32){
  const p = person(id), src = p.photo ? imgSrc(p.photo) : "";
  const ini = String(p.name || p.email || "?").split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
  return src ? `<img class="avatar" style="width:${size}px;height:${size}px" src="${esc(src)}" alt="" title="${esc(p.name || p.email)}">`
             : `<span class="avatar ini" style="width:${size}px;height:${size}px;font-size:${Math.round(size * .38)}px" title="${esc(p.name || p.email || "")}">${esc(ini)}</span>`;
}
const canWS = k => A.can(k);
const canAssign = () => isSuper() || A.perms.includes("ws_assign");
const members = () => Object.entries(PEOPLE).filter(([, p]) => p.role === "admin" || p.role === "super_admin").map(([id]) => id);
const assignable = () => canAssign() ? members() : members().filter(id => id === uid() || person(id).role === "super_admin");
const when = t => { const d = toDate(t); return !d || isNaN(d) ? "" : d.toLocaleString("en-US", {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"}); };
const dayStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmtDay = s => { if (!s) return ""; const d = new Date(s + "T12:00:00"); return isNaN(d) ? s : d.toLocaleDateString("en-US", {month: "short", day: "numeric"}); };
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
function msg(t, err){ A.setStatus(t, err ? "err" : ""); const n = $("ws-note"); if (n) { n.textContent = t; n.className = "hint " + (err ? "err" : "okc"); } }
async function notify(to, text, link){
  if (!to || to === uid()) return;
  try { await db.collection("notifications").doc(to).collection("items").add({text, link: link || null, from: uid(), read: false, createdAt: TS()}); } catch {}
  emailNotify(to, text);
}
/* Also email them (Gmail, via /api/notify). Quietly does nothing until email is set up in Vercel. */
async function emailNotify(to, text){
  try {
    const token = await A.auth.currentUser.getIdToken();
    await fetch("/api/notify", {method: "POST", headers: {"Content-Type": "application/json", Authorization: "Bearer " + token}, body: JSON.stringify({to, text})});
  } catch {}
}
async function resolvePhotos(){
  const ids = Object.values(PEOPLE).map(p => p.photo).filter(p => p && p.startsWith("media:") && !(p.slice(6) in MEDIA));
  if (ids.length) { await A.loadMedia({ids}); drawBubble(); if (current) draw(current); }
}

/* ---------- live data while signed in ---------- */
function start(){
  stop();
  if (!uid()) return;
  subs.push(db.collection("users").onSnapshot(s => { PEOPLE = {}; s.docs.forEach(d => PEOPLE[d.id] = d.data()); resolvePhotos(); drawBubble(); refresh(); }, () => {}));
  subs.push(db.collection("notifications").doc(uid()).collection("items").orderBy("createdAt", "desc").limit(40)
    .onSnapshot(s => { NOTES = s.docs.map(d => ({id: d.id, ...d.data()})); bell(); }, () => {}));
  if (canWS("ws_chat")) subs.push(db.collection("channels").where("members", "array-contains", uid())
    .onSnapshot(s => { CHANNELS = s.docs.map(d => ({id: d.id, ...d.data()})).sort((a, b) => (toDate(b.lastAt) || 0) - (toDate(a.lastAt) || 0)); badges(); refresh("ws_chat"); }, () => {}));
  if (canWS("ws_tasks")) subs.push(db.collection("tasks").orderBy("createdAt", "desc").limit(500)
    .onSnapshot(s => { TASKS = s.docs.map(d => ({id: d.id, ...d.data()})); badges(); refresh("ws_tasks"); refresh("ws_calendar"); }, () => {}));
  if (canWS("ws_calendar")) subs.push(db.collection("events").orderBy("date").limit(500)
    .onSnapshot(s => { EVENTS = s.docs.map(d => ({id: d.id, ...d.data()})); refresh("ws_calendar"); }, () => {}));
  if (canWS("ws_docs")) {
    /* Super admins see every folder and file. Everyone else only gets folders/files that are open to all,
       or that list them; the database rules enforce the same thing. */
    const merged = (col, field, set) => { const parts = {}; return key => s => { parts[key] = s.docs.map(d => ({id: d.id, ...d.data()}));
      const all = {}; Object.values(parts).flat().forEach(x => all[x.id] = x); set(Object.values(all)); }; };
    const setDocs = v => { DOCS = v.sort((a, b) => (toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0)); migrate(); refresh("ws_docs"); };
    const setFolders = v => { FOLDERS = v.sort((a, b) => String(a.name).localeCompare(String(b.name))); migrate(); refresh("ws_docs"); };
    if (isSuper()) {
      subs.push(db.collection("docs").orderBy("createdAt", "desc").limit(1000).onSnapshot(s => setDocs(s.docs.map(d => ({id: d.id, ...d.data()}))), () => {}));
      subs.push(db.collection("folders").onSnapshot(s => setFolders(s.docs.map(d => ({id: d.id, ...d.data()}))), () => {}));
    } else {
      const md = merged(null, null, setDocs), mf = merged(null, null, setFolders);
      subs.push(db.collection("docs").where("open", "==", true).onSnapshot(md("open"), () => {}));
      subs.push(db.collection("docs").where("viewers", "array-contains", uid()).onSnapshot(md("mine"), () => {}));
      subs.push(db.collection("folders").where("open", "==", true).onSnapshot(mf("open"), () => {}));
      subs.push(db.collection("folders").where("members", "array-contains", uid()).onSnapshot(mf("mine"), () => {}));
    }
  }
  $("bell").hidden = false; $("me-bubble-wrap").hidden = false;
  beat(); clearInterval(beatTimer); beatTimer = setInterval(beat, 4 * 60 * 1000);
}
let beatTimer = null;
function beat(){ if (uid() && document.visibilityState !== "hidden") db.collection("users").doc(uid()).update({lastSeen: TS()}).catch(() => {}); }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") beat(); });
function drawBubble(){
  const b = $("me-bubble"); if (!b || !uid()) return;
  b.innerHTML = avatar(uid(), 36); b.setAttribute("aria-label", "Your status: " + stateLabel(uid()));
  const m = $("me-menu"); if (m && !m.hidden) drawMeMenu();
}
function drawMeMenu(){
  const p = PEOPLE[uid()] || {}, cur = p.status || "online";
  $("me-menu").innerHTML = `<div class="mm-head">${avatar(uid(), 44)}<div style="min-width:0"><strong>${esc(p.name || A.me.email)}</strong><span class="hint" style="display:block">${esc(p.title || A.ROLE_LABEL[p.role] || "")}</span></div></div>
    <p class="hint mm-label">Set your status</p>
    ${STATES.map(([k, l, ico]) => `<button type="button" class="mm-item${cur === k ? " on" : ""}" data-set-status="${k}"><span>${ico}</span><span>${l}</span>${cur === k ? `<span class="mm-check">✓</span>` : ""}</button>`).join("")}
    <form class="mm-note" data-status-note><input type="text" maxlength="60" name="note" value="${esc(p.statusText || "")}" placeholder="What are you up to? e.g. In a meeting"><button class="btn sm" type="submit">Set</button></form>
    <div class="mm-sep"></div>
    <button type="button" class="mm-item" data-open-profile><span>👤</span><span>My overview</span></button>
    <a class="mm-item" href="/" target="_blank" rel="noopener"><span>🌐</span><span>Take me to the website</span></a>
    <button type="button" class="mm-item" data-signout-menu><span>↩</span><span>Sign out</span></button>`;
}
async function setStatus(fields){ try { await db.collection("users").doc(uid()).update({...fields, lastSeen: TS()}); } catch { msg("Your status didn't save. Make sure the latest database rules are published.", true); } }
document.addEventListener("click", e => {
  if (e.target.closest("#me-bubble")) { const m = $("me-menu"); m.hidden = !m.hidden; $("notif-panel").hidden = true; if (!m.hidden) drawMeMenu(); return; }
  const st = e.target.closest("[data-set-status]"); if (st) { setStatus({status: st.dataset.setStatus}); return; }
  if (e.target.closest("[data-signout-menu]")) { const so = document.querySelector("[data-signout]"); if (so) so.click(); return; }
  const m = $("me-menu"); if (m && !m.hidden && !e.target.closest("#me-menu")) m.hidden = true;
  if (m && e.target.closest("#me-menu [data-open-profile], #me-menu a")) m.hidden = true;
});
document.addEventListener("submit", e => { const f = e.target.closest("[data-status-note]"); if (!f) return; e.preventDefault(); setStatus({statusText: f.note.value.trim().slice(0, 60)}); f.querySelector("button").textContent = "Saved"; });
function stop(){ subs.forEach(u => u()); subs = []; leave(); clearInterval(beatTimer); const b = $("bell"); if (b) b.hidden = true; const w = $("me-bubble-wrap"); if (w) w.hidden = true; }
function leave(){ viewSubs.forEach(u => u()); viewSubs = []; current = null; }
function refresh(k){
  drawSummary();
  if (!current || (k && current !== k)) return;
  if (current === "ws_chat") {                                    /* never rebuild an open conversation */
    if (pendingChannel && CHANNELS.find(c => c.id === pendingChannel)) { const id = pendingChannel; pendingChannel = null; openThread(id); return; }
    drawChatList(); return;
  }
  if (current === "ws_calendar" && pendingEvent && EVENTS.find(e => e.id === pendingEvent)) { const id = pendingEvent; pendingEvent = null; draw(current); openEvent(id, true); return; }
  if (document.querySelector("#content :focus")) return;          /* don't interrupt typing */
  draw(current);
}

/* ---------- badges + bell ---------- */
const unreadChannels = () => CHANNELS.filter(c => c.lastAt && c.lastFrom !== uid() && (!c.reads || !c.reads[uid()] || toDate(c.reads[uid()]) < toDate(c.lastAt))).length;
/* Task rules: only the person who created a task edits or reassigns it. The person it's assigned to can
   move it along (change its status) and comment. Everyone else with Tasks access can comment. */
const EMOJI = [
  ["Smileys", "😀 😂 🥹 😊 😍 🥰 😘 😎 🤩 🥳 😅 😉 🤔 🙃 😴 😭 😤 😱 🤯 🙄 😬 🤗 🫡 🤭"],
  ["Hands", "👍 👎 👏 🙌 🙏 💪 👀 👋 🤝 ✌️ 🤞 👌 🫶 ☝️ ✍️"],
  ["Hearts", "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💯 ✨ 🔥 ⭐ 🌟 💫 🎉 🎊"],
  ["Work", "✅ ❌ ⏰ 📅 📌 📎 📝 📣 💡 🚀 🎯 📈 💼 💰 📸 🎥 🎬 🎤 📱 💻"],
  ["Fun", "☕ 🍾 🥂 🍕 🌍 🇳🇬 🇺🇸 🐯 👑 💎 🌸 🌻 🎶 🏆"]
].map(([g, s]) => [g, s.split(" ")]);
const isCreator = t => t.reporter === uid();
const canMove = t => isCreator(t) || t.assignee === uid();
const myOpenTasks = () => TASKS.filter(t => t.assignee === uid() && t.status !== "done").length;
/* "Your week" on My profile */
function summaryHTML(){
  if (!uid()) return "";
  const today = new Date().toISOString().slice(0, 10), soon = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  const cards = [];
  if (canWS("ws_tasks")) {
    const mine = TASKS.filter(t => t.assignee === uid() && t.status !== "done").sort((a, b) => (a.due || "9") < (b.due || "9") ? -1 : 1);
    const late = mine.filter(t => t.due && t.due < today).length;
    const waiting = TASKS.filter(t => t.reporter === uid() && t.assignee !== uid() && t.status !== "done").length;
    cards.push(`<section class="sum-card"><h4>Your tasks <span class="chip">${mine.length}</span></h4>
      ${late ? `<p class="hint err" style="margin:0">${late} overdue</p>` : ""}
      ${mine.slice(0, 3).map(t => `<button class="sum-row" type="button" data-open-task="${esc(t.id)}"><span>${esc(t.title)}</span><span class="hint">${t.due ? "Due " + esc(fmtDay(t.due)) : esc((STATUSES.find(x => x[0] === (t.status || "todo")) || STATUSES[0])[1])}</span></button>`).join("") || `<p class="hint">Nothing assigned to you right now.</p>`}
      ${waiting ? `<p class="hint">You're waiting on ${waiting} task${waiting === 1 ? "" : "s"} you gave to others.</p>` : ""}
      <button class="btn ghost sm" type="button" data-go="ws_tasks">Open Tasks</button></section>`);
  }
  if (canWS("ws_calendar")) {
    const up = EVENTS.filter(e => e.date >= today && e.date <= soon && (e.attendees || []).includes(uid())).sort((a, b) => (a.date + (a.start || "")) < (b.date + (b.start || "")) ? -1 : 1);
    cards.push(`<section class="sum-card"><h4>Coming up <span class="chip">${up.length}</span></h4>
      ${up.slice(0, 3).map(e => `<button class="sum-row" type="button" data-go="ws_calendar"><span>${esc(e.title)}</span><span class="hint">${esc(fmtDay(e.date))}${e.allDay || !e.start ? "" : " · " + esc(e.start)}</span></button>`).join("") || `<p class="hint">No events in the next two weeks.</p>`}
      <button class="btn ghost sm" type="button" data-go="ws_calendar">Open Calendar</button></section>`);
  }
  if (canWS("ws_chat")) {
    const n = unreadChannels();
    cards.push(`<section class="sum-card"><h4>Messages <span class="chip">${n}</span></h4>
      <p class="hint">${n ? `${n} conversation${n === 1 ? " has" : "s have"} new messages.` : "You're all caught up."}</p>
      <button class="btn ghost sm" type="button" data-go="ws_chat">Open Chat</button></section>`);
  }
  return cards.length ? `<h3 class="group-title">Your week</h3><div class="sum-grid">${cards.join("")}</div>` : "";
}
function drawSummary(){ const box = $("me-summary"); if (box) box.innerHTML = summaryHTML(); }
document.addEventListener("click", e => { const g = e.target.closest("#me-summary [data-go]"); if (g) A.goto(g.dataset.go); });

function badges(){
  const set = (k, n) => document.querySelectorAll(`[data-badge="${k}"]`).forEach(b => b.innerHTML = n ? `<span class="chip">${n}</span>` : "");
  set("ws_chat", unreadChannels()); set("ws_tasks", myOpenTasks());
}
function bell(){
  const n = NOTES.filter(x => !x.read).length, c = $("bell-count");
  if (c) { c.textContent = n > 9 ? "9+" : n; c.hidden = !n; }
  if (!$("notif-panel").hidden) drawNotes();
}
function drawNotes(){
  $("notif-panel").innerHTML = `<div class="np-head"><strong>Notifications</strong>${NOTES.some(x => !x.read) ? `<button class="lnk" type="button" data-notes-all>Mark all read</button>` : ""}</div>
    ${NOTES.length ? NOTES.map(x => `<button class="np-item${x.read ? "" : " unread"}" type="button" data-note="${esc(x.id)}">${avatar(x.from, 30)}<span><span>${esc(x.from && /^Someone /.test(x.text || "") ? (person(x.from).name || person(x.from).email || "Someone") + x.text.slice(7) : x.text)}</span><span class="hint">${esc(when(x.createdAt))}</span></span></button>`).join("")
      : `<p class="hint" style="padding:16px">Nothing yet. You'll see new tasks, comments and events here.</p>`}`;
}
document.addEventListener("click", async e => {
  if (e.target.closest("#bell")) { const mm = $("me-menu"); if (mm) mm.hidden = true; const p = $("notif-panel"); p.hidden = !p.hidden; if (!p.hidden) drawNotes(); return; }
  const all = e.target.closest("[data-notes-all]");
  if (all) { const batch = db.batch(); NOTES.filter(x => !x.read).forEach(x => batch.update(db.collection("notifications").doc(uid()).collection("items").doc(x.id), {read: true})); try { await batch.commit(); } catch {} return; }
  const it = e.target.closest("[data-note]");
  if (it) {
    const x = NOTES.find(n => n.id === it.dataset.note); $("notif-panel").hidden = true;
    if (x && !x.read) db.collection("notifications").doc(uid()).collection("items").doc(x.id).update({read: true}).catch(() => {});
    if (x && x.link && x.link.tab && A.can(x.link.tab)) A.goto(x.link.tab, x.link);
    return;
  }
  if (!e.target.closest("#notif-panel")) { const p = $("notif-panel"); if (p) p.hidden = true; }
});

/* ---------- drawing ---------- */
function draw(tab){
  current = tab;
  const open = window.__WS_OPEN; window.__WS_OPEN = null;
  ({ws_tasks: drawTasks, ws_chat: drawChat, ws_calendar: drawCalendar, ws_docs: drawDocs, ws_team: drawTeam})[tab](open);
}

/* ===== TASKS ===== */
function visibleTasks(){
  return TASKS.filter(t => taskFilter === "all" || (taskFilter === "mine" && t.assignee === uid()) || (taskFilter === "created" && t.reporter === uid()) || (taskFilter.startsWith("u:") && t.assignee === taskFilter.slice(2)));
}
function drawTasks(open){
  const list = visibleTasks();
  content.innerHTML = `
    <div class="ws-bar">
      <button class="btn" type="button" data-new-task>+ New task</button>
      <select data-task-filter aria-label="Show tasks">
        <option value="all" ${taskFilter === "all" ? "selected" : ""}>All tasks</option>
        <option value="mine" ${taskFilter === "mine" ? "selected" : ""}>Assigned to me</option>
        <option value="created" ${taskFilter === "created" ? "selected" : ""}>Created by me</option>
        ${members().filter(id => id !== uid()).map(id => `<option value="u:${esc(id)}" ${taskFilter === "u:" + id ? "selected" : ""}>${esc(pname(id))}'s tasks</option>`).join("")}
      </select>
      <span class="hint" id="ws-note"></span>
    </div>
    <div class="board">${STATUSES.map(([k, l]) => { const col = list.filter(t => (t.status || "todo") === k);
      return `<section class="col" data-col="${k}"><h3>${l} <span class="hint">${col.length}</span></h3>
        ${col.map(t => `<button class="card" type="button" draggable="${canMove(t)}" data-task="${esc(t.id)}">
          <span class="card-top"><span class="tchip">${esc(t.type || "Task")}</span><span class="prio p-${esc(t.priority || "med")}" title="${esc((PRIORITIES.find(p => p[0] === t.priority) || PRIORITIES[1])[1])} priority"></span></span>
          <span class="card-title">${esc(t.title)}</span>
          <span class="card-foot">${avatar(t.assignee, 24)}<span class="hint">${t.due ? "Due " + esc(fmtDay(t.due)) : ""}</span>${t.comments ? `<span class="hint">💬 ${t.comments}</span>` : ""}</span>
        </button>`).join("") || `<p class="hint empty-col">Nothing here.</p>`}
      </section>`; }).join("")}</div>`;
  if (open && open.id) openTask(open.id);
}
function taskForm(t = {}){
  const opts = assignable(); if (t.assignee && !opts.includes(t.assignee)) opts.push(t.assignee);
  return `<form class="ws-form" data-task-form="${esc(t.id || "")}">
    <label class="f"><span>Title</span><input type="text" name="title" maxlength="200" required value="${esc(t.title || "")}" placeholder="e.g. Write caption for Friday's reel"></label>
    <label class="f"><span>Details</span><textarea name="desc" maxlength="4000" placeholder="What needs to be done, links, notes…">${esc(t.desc || "")}</textarea></label>
    <div class="grid2">
      <label class="f"><span>Assign to</span><select name="assignee">${opts.map(id => `<option value="${esc(id)}" ${(t.assignee || uid()) === id ? "selected" : ""}>${esc(pname(id))}${person(id).title ? " · " + esc(person(id).title) : ""}</option>`).join("")}</select></label>
      <label class="f"><span>Status</span><select name="status">${STATUSES.map(([k, l]) => `<option value="${k}" ${(t.status || "todo") === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="f"><span>Type</span><select name="type">${TYPES.map(x => `<option ${(t.type || "Content") === x ? "selected" : ""}>${x}</option>`).join("")}</select></label>
      <label class="f"><span>Priority</span><select name="priority">${PRIORITIES.map(([k, l]) => `<option value="${k}" ${(t.priority || "med") === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="f"><span>Due date</span><input type="date" name="due" value="${esc(t.due || "")}"></label>
    </div>
    ${canAssign() ? "" : `<p class="hint">You can assign tasks to yourself or to a super admin.</p>`}
    <div class="row-btns"><button class="btn" type="submit">${t.id ? "Save task" : "Create task"}</button><button class="btn ghost" type="button" data-close-modal>Cancel</button></div>
  </form>`;
}
function modal(html, wide){
  closeModal();
  const m = document.createElement("div"); m.className = "ws-modal"; m.id = "ws-modal";
  m.innerHTML = `<div class="ws-dialog${wide ? " wide" : ""}" role="dialog" aria-modal="true"><button class="x" type="button" data-close-modal aria-label="Close">✕</button>${html}</div>`;
  document.body.appendChild(m); const f = m.querySelector("input,textarea,select"); if (f) f.focus();
}
function closeModal(){ const m = $("ws-modal"); if (m) { viewSubs = viewSubs.filter(u => u !== m._unsub); if (m._unsub) m._unsub(); m.remove(); } }
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });
document.addEventListener("click", e => { if (e.target.closest("[data-close-modal]") || e.target.id === "ws-modal") closeModal(); });

function openTask(id){
  const t = TASKS.find(x => x.id === id); if (!t) return;
  const mayEdit = isCreator(t), mayMove = canMove(t);
  const pr = (PRIORITIES.find(p => p[0] === t.priority) || PRIORITIES[1])[1];
  const readOnly = `<h3 class="group-title" style="margin-top:6px">${esc(t.title)}</h3>
    <dl class="task-facts"><div><dt>Assigned to</dt><dd><span class="who-cell">${avatar(t.assignee, 22)} ${esc(pname(t.assignee))}</span></dd></div>
      <div><dt>Status</dt><dd>${mayMove ? `<select data-task-status="${esc(t.id)}" aria-label="Move this task">${STATUSES.map(([k, l]) => `<option value="${k}" ${(t.status || "todo") === k ? "selected" : ""}>${l}</option>`).join("")}</select>` : esc((STATUSES.find(x => x[0] === (t.status || "todo")) || STATUSES[0])[1])}</dd></div>
      <div><dt>Priority</dt><dd>${esc(pr)}</dd></div><div><dt>Due</dt><dd>${t.due ? esc(fmtDay(t.due)) : "No date"}</dd></div></dl>
    ${t.desc ? `<p style="white-space:pre-wrap">${esc(t.desc)}</p>` : ""}
    <p class="hint">${mayMove ? `Only ${esc(pname(t.reporter))} (who created this) can edit or reassign it. You can move it along and comment.` : `Only ${esc(pname(t.reporter))} (who created this) can edit it. You can comment below.`}</p>`;
  const gcal = t.due ? gcalLink({title: "Due: " + t.title, date: t.due, allDay: true, desc: t.desc}) : "";
  modal(`<p class="hint" style="margin:0">${esc(t.type || "Task")} · created by ${esc(pname(t.reporter))} ${esc(when(t.createdAt))}</p>
    ${mayEdit ? taskForm(t) : readOnly}
    <div class="row-btns">${gcal ? `<a class="btn ghost sm" href="${esc(gcal)}" target="_blank" rel="noopener">Add due date to Google Calendar</a>` : ""}
      ${isSuper() || t.reporter === uid() ? `<button class="btn danger sm" type="button" data-del-task="${esc(t.id)}">Delete task</button>` : ""}</div>
    <h3 class="group-title">Comments</h3><div class="comments" id="task-comments"><p class="hint">Loading…</p></div>
    <form class="comment-form" data-comment-form="${esc(t.id)}"><textarea name="text" maxlength="2000" placeholder="Write a comment…" required></textarea><button class="btn sm" type="submit">Comment</button></form>`, true);
  const m = $("ws-modal");
  m._unsub = db.collection("tasks").doc(id).collection("comments").orderBy("at").limit(200).onSnapshot(s => {
    const box = $("task-comments"); if (!box) return;
    box.innerHTML = s.docs.map(d => { const c = d.data(); return `<div class="comment">${avatar(c.from, 28)}<div><strong>${esc(pname(c.from))}</strong> <span class="hint">${esc(when(c.at))}</span><p>${esc(c.text)}</p></div></div>`; }).join("") || `<p class="hint">No comments yet.</p>`;
  }, () => {});
  viewSubs.push(m._unsub);
}
async function saveTask(form){
  const id = form.dataset.taskForm, f = Object.fromEntries(new FormData(form));
  const data = {title: f.title.trim().slice(0, 200), desc: (f.desc || "").slice(0, 4000), assignee: f.assignee, status: f.status, type: f.type, priority: f.priority, due: f.due || "", updatedAt: TS()};
  if (!data.title) return;
  try {
    if (id) {
      const before = TASKS.find(x => x.id === id) || {};
      await db.collection("tasks").doc(id).update(data);
      if (before.assignee !== data.assignee) notify(data.assignee, `${myLabel()} assigned you "${data.title}"`, {tab: "ws_tasks", id});
      else if (before.status !== data.status) { const label = STATUSES.find(s => s[0] === data.status)[1]; notify(before.reporter, `${myLabel()} moved "${data.title}" to ${label}`, {tab: "ws_tasks", id}); notify(data.assignee, `${myLabel()} moved "${data.title}" to ${label}`, {tab: "ws_tasks", id}); }
    } else {
      const ref = await db.collection("tasks").add({...data, reporter: uid(), comments: 0, createdAt: TS()});
      notify(data.assignee, `${myLabel()} assigned you "${data.title}"`, {tab: "ws_tasks", id: ref.id});
    }
    closeModal(); msg(id ? "Task saved." : "Task created.");
  } catch { msg("That task didn't save. Check your access, or that the latest database rules are published.", true); }
}
async function moveTask(id, status){
  const t = TASKS.find(x => x.id === id); if (!t || t.status === status) return;
  if (!canMove(t)) { msg("Only the person who created this task, or the person it's assigned to, can move it.", true); return; }
  try { await db.collection("tasks").doc(id).update({status, updatedAt: TS()});
    const label = STATUSES.find(s => s[0] === status)[1];
    notify(t.reporter, `${myLabel()} moved "${t.title}" to ${label}`, {tab: "ws_tasks", id}); notify(t.assignee, `${myLabel()} moved "${t.title}" to ${label}`, {tab: "ws_tasks", id});
    return true;
  } catch { msg("That move didn't save. Make sure the latest database rules are published.", true); }
}
document.addEventListener("change", e => { const s = e.target.closest("[data-task-status]"); if (s) moveTask(s.dataset.taskStatus, s.value).then(ok => { if (ok) msg("Task moved."); }); });
content.addEventListener("dragstart", e => { const c = e.target.closest("[data-task]"); if (c) { e.dataTransfer.setData("text/plain", c.dataset.task); c.classList.add("dragging"); } });
content.addEventListener("dragend", e => { const c = e.target.closest("[data-task]"); if (c) c.classList.remove("dragging"); });
content.addEventListener("dragover", e => { const col = e.target.closest("[data-col]"); if (col) { e.preventDefault(); col.classList.add("over"); } });
content.addEventListener("dragleave", e => { const col = e.target.closest("[data-col]"); if (col) col.classList.remove("over"); });
content.addEventListener("drop", e => { const col = e.target.closest("[data-col]"); if (!col) return; e.preventDefault(); col.classList.remove("over"); moveTask(e.dataTransfer.getData("text/plain"), col.dataset.col); });

/* ===== CHAT ===== */
function chName(c){ return c.type === "group" ? c.name || "Group" : pname(c.members.find(m => m !== uid()) || uid()); }
function chAvatar(c, size){ return c.type === "group" ? `<span class="avatar ini grp" style="width:${size}px;height:${size}px;font-size:${Math.round(size * .4)}px">#</span>` : avatar(c.members.find(m => m !== uid()) || uid(), size); }
function drawChat(open){
  if (open && open.channel) openChannel = open.channel;
  if (openChannel && !CHANNELS.find(c => c.id === openChannel)) { pendingChannel = openChannel; openChannel = null; }
  content.innerHTML = `<div class="chat${openChannel ? " has-open" : ""}">
    <aside class="chat-list"><div class="row-btns" style="padding:12px"><button class="btn sm" type="button" data-new-dm>New message</button><button class="btn ghost sm" type="button" data-new-group>New group</button></div><div id="chat-items"></div></aside>
    <section class="chat-thread" id="chat-thread">${openChannel ? "" : `<p class="hint" style="padding:24px">Pick a conversation, or start a new one.</p>`}</section></div>`;
  drawChatList();
  if (openChannel) openThread(openChannel);
}
function drawChatList(){
  const box = $("chat-items"); if (!box) return;
  box.innerHTML = CHANNELS.map(c => { const unread = c.lastAt && c.lastFrom !== uid() && (!c.reads || !c.reads[uid()] || toDate(c.reads[uid()]) < toDate(c.lastAt));
    return `<button class="chat-item${c.id === openChannel ? " active" : ""}${unread ? " unread" : ""}" type="button" data-channel="${esc(c.id)}">${chAvatar(c, 38)}
      <span class="ci-text"><strong>${esc(chName(c))}</strong><span class="hint">${esc((c.lastFrom === uid() ? "You: " : "") + (c.lastMessage || "No messages yet"))}</span></span>${unread ? `<span class="dot"></span>` : ""}</button>`; }).join("") || `<p class="hint" style="padding:12px">No conversations yet.</p>`;
}
function openThread(id){
  openChannel = id; const c = CHANNELS.find(x => x.id === id); if (!c) return;
  content.querySelector(".chat").classList.add("has-open"); drawChatList();
  const th = $("chat-thread");
  th.innerHTML = `<header class="th-head"><button class="btn ghost sm th-back" type="button" data-chat-back>← Back</button>${chAvatar(c, 34)}<div><strong>${esc(chName(c))}</strong><div class="hint">${c.type === "group" ? esc(c.members.map(pname).join(", ")) : (o => esc([stateLabel(o), person(o).statusText && stateOf(o) !== "offline" ? person(o).statusText : "", person(o).title].filter(Boolean).join(" · ")))(c.members.find(m => m !== uid()))}</div></div>
      ${c.type === "group" ? `<button class="btn ghost sm" type="button" data-group-edit="${esc(c.id)}" style="margin-left:auto">Members</button>` : ""}</header>
    <div class="msgs" id="msgs"><p class="hint">Loading…</p></div>
    <form class="send" data-send="${esc(id)}"><div class="emoji-wrap"><button class="emoji-btn" type="button" data-emoji-toggle aria-label="Add emoji" aria-expanded="false">😊</button>
      <div class="emoji-pop" hidden role="dialog" aria-label="Emoji">${EMOJI.map(([g, list]) => `<p class="hint">${g}</p><div class="emoji-grid">${[...list].filter(c => c.trim()).map(c => `<button type="button" data-emoji="${c}">${c}</button>`).join("")}</div>`).join("")}</div></div>
      <textarea name="text" maxlength="4000" placeholder="Write a message…" rows="1" required></textarea><button class="btn sm" type="submit">Send</button></form>`;
  viewSubs.forEach(u => u()); viewSubs = [];
  viewSubs.push(db.collection("channels").doc(id).collection("messages").orderBy("at").limitToLast(200).onSnapshot(s => {
    const box = $("msgs"); if (!box) return;
    let last = null;
    box.innerHTML = s.docs.map(d => { const m = d.data(), mine = m.from === uid(), showWho = m.from !== last; last = m.from;
      return `<div class="msg${mine ? " mine" : ""}">${!mine && showWho ? avatar(m.from, 28) : `<span style="width:28px;flex:none"></span>`}<div class="bubble">${!mine && showWho && c.type === "group" ? `<span class="who">${esc(pname(m.from))}</span>` : ""}${esc(m.text).replace(/\n/g, "<br>")}<span class="t">${esc(when(m.at))}</span></div></div>`; }).join("") || `<p class="hint">Say hello 👋</p>`;
    box.scrollTop = box.scrollHeight;
    db.collection("channels").doc(id).update({["reads." + uid()]: TS()}).catch(() => {});
  }, () => { const box = $("msgs"); if (box) box.innerHTML = `<p class="hint err">Messages couldn't be loaded.</p>`; }));
  const ta = th.querySelector("textarea"); ta.focus();
  ta.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); th.querySelector("form").requestSubmit(); } });
}
async function sendMsg(form){
  const id = form.dataset.send, ta = form.querySelector("textarea"), text = ta.value.trim().slice(0, 4000); if (!text) return;
  ta.value = "";
  try {
    await db.collection("channels").doc(id).collection("messages").add({from: uid(), text, at: TS()});
    await db.collection("channels").doc(id).update({lastMessage: text.slice(0, 120), lastAt: TS(), lastFrom: uid(), ["reads." + uid()]: TS()});
  } catch { ta.value = text; msg("That message didn't send. Check your connection.", true); }
}
async function openDM(other){
  const ids = [uid(), other].sort(), id = "dm_" + ids.join("_"), ref = db.collection("channels").doc(id);
  try { const s = await ref.get(); if (!s.exists) await ref.set({type: "dm", members: ids, createdBy: uid(), createdAt: TS(), lastAt: TS(), lastMessage: "", lastFrom: ""}); }
  catch { msg("That conversation couldn't be opened. Check that you have Chat access.", true); return; }
  closeModal(); A.goto("ws_chat", {channel: id});
}
function pickPeople(title, multi, preselected = [], extra = ""){
  modal(`<h3 class="group-title" style="margin-top:0">${title}</h3>${extra}
    <div class="people-pick">${members().filter(id => id !== uid()).map(id => `<label class="pp">${multi ? `<input type="checkbox" value="${esc(id)}" ${preselected.includes(id) ? "checked" : ""}>` : ""}${avatar(id, 34)}<span><strong>${esc(pname(id))}</strong><span class="hint">${esc(person(id).title || A.ROLE_LABEL[person(id).role] || "")}</span></span>${multi ? "" : `<button class="btn ghost sm" type="button" data-dm="${esc(id)}">Message</button>`}</label>`).join("") || `<p class="hint">No one else is in the workspace yet.</p>`}</div>
    ${multi ? `<div class="row-btns"><button class="btn" type="button" data-group-save>Save</button><button class="btn ghost" type="button" data-close-modal>Cancel</button></div>` : ""}`);
}
async function saveGroup(editId){
  const m = $("ws-modal"), name = (m.querySelector("[name=gname]") || {}).value || "", sel = [...m.querySelectorAll(".people-pick input:checked")].map(i => i.value);
  if (!editId && (!name.trim() || !sel.length)) { msg("Give the group a name and pick at least one person.", true); return; }
  try {
    if (editId) await db.collection("channels").doc(editId).update({members: [...new Set([uid(), ...sel])], ...(name.trim() ? {name: name.trim().slice(0, 60)} : {})});
    else { const ref = await db.collection("channels").add({type: "group", name: name.trim().slice(0, 60), members: [uid(), ...sel], createdBy: uid(), createdAt: TS(), lastAt: TS(), lastMessage: "", lastFrom: ""});
      sel.forEach(p => notify(p, `${myLabel()} added you to the group "${name.trim()}"`, {tab: "ws_chat", channel: ref.id})); openChannel = ref.id; }
    closeModal(); A.goto("ws_chat", {channel: openChannel || editId});
  } catch { msg("The group didn't save. Only the person who created it (or a super admin) can change members.", true); }
}

/* ===== CALENDAR ===== */
function gcalLink(ev){
  const fmt = (d, t) => d.replace(/-/g, "") + (t ? "T" + t.replace(":", "") + "00" : "");
  let dates;
  if (ev.allDay || !ev.start) { const n = new Date(ev.date + "T12:00:00"); n.setDate(n.getDate() + 1); dates = fmt(ev.date) + "/" + fmt(dayStr(n)); }
  else dates = fmt(ev.date, ev.start) + "/" + fmt(ev.date, ev.end || ev.start);
  return "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + encodeURIComponent(ev.title) + "&dates=" + dates + "&details=" + encodeURIComponent((ev.desc || "") + "\n\nFrom the A·A·O Workspace") + "&ctz=America/New_York";
}
function icsFile(ev){
  const st = ev.allDay || !ev.start ? `DTSTART;VALUE=DATE:${ev.date.replace(/-/g, "")}` : `DTSTART;TZID=America/New_York:${ev.date.replace(/-/g, "")}T${ev.start.replace(":", "")}00`;
  const en = ev.allDay || !ev.start ? "" : `DTEND;TZID=America/New_York:${ev.date.replace(/-/g, "")}T${(ev.end || ev.start).replace(":", "")}00`;
  const txt = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AAO Workspace//EN", "BEGIN:VEVENT", `UID:${ev.id}@aao`, st, en, `SUMMARY:${(ev.title || "").replace(/[,;]/g, "\\$&")}`, `DESCRIPTION:${(ev.desc || "").replace(/\n/g, "\\n").replace(/[,;]/g, "\\$&")}`, "BEGIN:VALARM", "TRIGGER:-PT30M", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "END:VALARM", "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");
  return URL.createObjectURL(new Blob([txt], {type: "text/calendar"}));
}
function drawCalendar(open){
  const y = calMonth.getFullYear(), m = calMonth.getMonth(), first = new Date(y, m, 1), startDay = first.getDay(), days = new Date(y, m + 1, 0).getDate(), todayS = dayStr(new Date());
  const cells = []; for (let i = 0; i < startDay; i++) cells.push(null); for (let d = 1; d <= days; d++) cells.push(new Date(y, m, d)); while (cells.length % 7) cells.push(null);
  const evOn = s => EVENTS.filter(e => e.date === s), dueOn = s => TASKS.filter(t => t.due === s && t.status !== "done");
  const upcoming = [...EVENTS.filter(e => e.date >= todayS).map(e => ({...e, kind: "event"})), ...TASKS.filter(t => t.due && t.due >= todayS && t.status !== "done").map(t => ({id: t.id, title: t.title, date: t.due, kind: "task"}))]
    .sort((a, b) => (a.date + (a.start || "")).localeCompare(b.date + (b.start || ""))).slice(0, 12);
  content.innerHTML = `<div class="ws-bar"><button class="btn ghost sm" type="button" data-cal="-1" aria-label="Previous month">←</button><strong class="cal-title">${calMonth.toLocaleDateString("en-US", {month: "long", year: "numeric"})}</strong><button class="btn ghost sm" type="button" data-cal="1" aria-label="Next month">→</button><button class="btn ghost sm" type="button" data-cal="0">Today</button><button class="btn" type="button" data-new-event="${todayS}" style="margin-left:auto">+ New event</button><span class="hint" id="ws-note"></span></div>
    <div class="cal"><div class="cal-dow">${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => `<span>${d}</span>`).join("")}</div>
    <div class="cal-grid">${cells.map(d => { if (!d) return `<div class="cell empty"></div>`; const s = dayStr(d);
      return `<div class="cell${s === todayS ? " today" : ""}" data-new-event="${s}"><span class="dn">${d.getDate()}</span>
        ${evOn(s).map(e => `<button class="ev" type="button" data-event="${esc(e.id)}">${e.start && !e.allDay ? esc(e.start) + " " : ""}${esc(e.title)}</button>`).join("")}
        ${dueOn(s).map(t => `<button class="ev due" type="button" data-open-task="${esc(t.id)}">Due: ${esc(t.title)}</button>`).join("")}</div>`; }).join("")}</div></div>
    <h3 class="group-title">Coming up</h3>
    <div class="agenda">${upcoming.map(x => `<button class="ag" type="button" ${x.kind === "event" ? `data-event="${esc(x.id)}"` : `data-open-task="${esc(x.id)}"`}><span class="ag-d">${esc(fmtDay(x.date))}</span><span>${x.kind === "task" ? "Due: " : ""}${esc(x.title)}${x.start && !x.allDay ? ` <span class="hint">${esc(x.start)}</span>` : ""}</span></button>`).join("") || `<p class="hint">Nothing scheduled.</p>`}</div>`;
  if (open && open.event) openEvent(open.event);
}
function eventForm(ev = {}){
  return `<form class="ws-form" data-event-form="${esc(ev.id || "")}">
    <label class="f"><span>Title</span><input type="text" name="title" maxlength="160" required value="${esc(ev.title || "")}" placeholder="e.g. Content planning call"></label>
    <div class="grid2">
      <label class="f"><span>Date</span><input type="date" name="date" required value="${esc(ev.date || dayStr(new Date()))}"></label>
      <label class="f check" style="align-self:end"><input type="checkbox" name="allDay" ${ev.allDay ? "checked" : ""}><span>All day</span></label>
      <label class="f"><span>Start</span><input type="time" name="start" value="${esc(ev.start || "10:00")}"></label>
      <label class="f"><span>End</span><input type="time" name="end" value="${esc(ev.end || "11:00")}"></label>
    </div>
    <label class="f"><span>Details</span><textarea name="desc" maxlength="2000" placeholder="Agenda, meeting link…">${esc(ev.desc || "")}</textarea></label>
    <fieldset class="perm-box"><legend>Who's invited</legend><div class="invite-list">${members().map(id => `<label class="inv"><input type="checkbox" name="att" value="${esc(id)}" ${(ev.attendees || [uid()]).includes(id) ? "checked" : ""}>${avatar(id, 28)}<span class="inv-t"><strong>${esc(pname(id))}</strong>${person(id).name && person(id).email ? `<span class="hint">${esc(person(id).email)}</span>` : ""}</span></label>`).join("")}</div></fieldset>
    <div class="row-btns"><button class="btn" type="submit">${ev.id ? "Save event" : "Create event"}</button><button class="btn ghost" type="button" data-close-modal>Cancel</button></div></form>`;
}
function openEvent(id, justCreated){
  const ev = EVENTS.find(e => e.id === id); if (!ev) return;
  const mine = isSuper() || ev.createdBy === uid();
  modal(`${justCreated ? `<div class="notice"><strong>Event created.</strong> <span class="hint">Click "Add to Google Calendar" below so it shows on your phone.</span></div>` : ""}<p class="hint" style="margin:0">Created by ${esc(pname(ev.createdBy))}</p>
    ${mine ? eventForm(ev) : `<h3 class="group-title">${esc(ev.title)}</h3><p>${esc(fmtDay(ev.date))} ${ev.allDay ? "· all day" : `· ${esc(ev.start || "")}–${esc(ev.end || "")}`}</p><p>${esc(ev.desc || "")}</p>`}
    <div class="row-btns"><a class="btn sm" href="${esc(gcalLink(ev))}" target="_blank" rel="noopener">Add to Google Calendar</a><a class="btn ghost sm" href="${icsFile(ev)}" download="${esc((ev.title || "event").replace(/[^\w ]+/g, "")).slice(0, 40)}.ics">Download .ics</a>
      ${mine ? `<button class="btn danger sm" type="button" data-del-event="${esc(ev.id)}">Delete</button>` : ""}</div>
    <p class="hint">Adding it to Google Calendar lets your phone remind you before it starts.</p>`, true);
}
async function saveEvent(form){
  const id = form.dataset.eventForm, fd = new FormData(form);
  const data = {title: String(fd.get("title")).trim().slice(0, 160), date: fd.get("date"), allDay: !!fd.get("allDay"), start: fd.get("start") || "", end: fd.get("end") || "", desc: String(fd.get("desc") || "").slice(0, 2000), attendees: [...new Set([uid(), ...fd.getAll("att")])], updatedAt: TS()};
  if (!data.title || !data.date) return;
  try {
    let evId = id;
    if (id) await db.collection("events").doc(id).update(data);
    else evId = (await db.collection("events").add({...data, createdBy: uid(), createdAt: TS()})).id;
    data.attendees.forEach(p => notify(p, `${myLabel()} ${id ? "updated" : "invited you to"} "${data.title}" on ${fmtDay(data.date)}`, {tab: "ws_calendar", event: evId}));
    closeModal();
    if (id) msg("Event saved.");
    else { msg("Event created. Add it to your Google Calendar so your phone reminds you."); if (EVENTS.find(e => e.id === evId)) openEvent(evId, true); else pendingEvent = evId; }
  } catch { msg("That event didn't save. Check your Calendar access.", true); }
}

/* ===== DOCUMENTS ===== */
/* Folders live in "folders" ({name, open, members}). Each file copies its folder's access (open / viewers)
   so the database can check it quickly; changing a folder's access updates its files too. */
const folderById = id => FOLDERS.find(f => f.id === id);
const fileFolder = d => d.folderId && folderById(d.folderId) ? d.folderId : (d.folderId || "");
const docsAccess = id => person(id).role === "super_admin" || (person(id).perms || []).includes("ws_docs");
function folderWho(f){
  if (!f || f.open) return "Everyone with Documents access";
  const names = (f.members || []).filter(id => PEOPLE[id]).map(pname);
  return names.length ? "Only " + names.join(", ") + " (and super admins)" : "Only super admins";
}
async function migrate(){
  /* One-time tidy-up for files uploaded before folders had access settings (super admin only). */
  if (migrated || !isSuper()) return;
  const old = DOCS.filter(d => d.open === undefined); if (!old.length) { migrated = true; return; }
  migrated = true;
  try {
    const ids = {};
    for (const name of [...new Set(old.map(d => (d.folder || "General").trim()).filter(n => n && n !== "General"))]) {
      const f = FOLDERS.find(x => x.name === name);
      ids[name] = f ? f.id : (await db.collection("folders").add({name: name.slice(0, 60), open: true, members: [], createdBy: uid(), createdAt: TS()})).id;
    }
    const b = db.batch();
    old.forEach(d => { const n = (d.folder || "General").trim(), fid = ids[n] || "", f = folderById(fid);
      b.update(db.collection("docs").doc(d.id), {folderId: fid, folder: fid ? n : "General", open: f ? !!f.open : true, viewers: f && !f.open ? (f.members || []) : []}); });
    await b.commit();
  } catch { migrated = false; }
}
function drawDocs(){
  const list = DOCS.filter(d => docFolder === "All" || fileFolder(d) === docFolder);
  const cur = docFolder === "All" || docFolder === "" ? null : folderById(docFolder);
  const target = docFolder === "All" ? "General" : cur ? cur.name : "General";
  const lock = f => f && !f.open ? ` <span aria-label="private" title="Private folder">🔒</span>` : "";
  const count = id => DOCS.filter(d => fileFolder(d) === id).length;
  content.innerHTML = `<div class="ws-bar"><label class="btn" style="cursor:pointer">+ Upload files<input type="file" multiple hidden data-doc-upload></label>
      ${isSuper() ? `<button class="btn ghost" type="button" data-new-folder>+ New folder</button>` : ""}
      <span class="hint">Uploads go into <strong>${esc(target)}</strong></span><span class="hint" id="ws-note"></span></div>
    <div class="progress" id="doc-progress" hidden><i></i></div>
    <div class="chips"><button class="fchip${docFolder === "All" ? " on" : ""}" type="button" data-folder="All">All files</button>
      <button class="fchip${docFolder === "" ? " on" : ""}" type="button" data-folder="">General <span class="hint">${count("")}</span></button>
      ${FOLDERS.map(f => `<button class="fchip${f.id === docFolder ? " on" : ""}" type="button" data-folder="${esc(f.id)}">${esc(f.name)}${lock(f)} <span class="hint">${count(f.id)}</span></button>`).join("")}</div>
    ${docFolder !== "All" ? `<div class="folder-head"><span class="hint">Who can see <strong>${esc(cur ? cur.name : "General")}</strong>: ${esc(folderWho(cur))}</span>
      ${isSuper() && cur ? `<button class="btn ghost sm" type="button" data-folder-settings="${esc(cur.id)}">Folder settings</button>` : ""}</div>` : ""}
    ${list.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>Name</th><th>Folder</th><th>Size</th><th>Added by</th><th></th></tr></thead><tbody>
      ${list.map(d => { const fid = fileFolder(d), f = folderById(fid);
        return `<tr><td><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.name)}</a></td>
        <td>${isSuper() ? `<select class="move-sel" data-move-doc="${esc(d.id)}" aria-label="Move to folder"><option value="">General</option>${FOLDERS.map(x => `<option value="${esc(x.id)}" ${x.id === fid ? "selected" : ""}>${esc(x.name)}${x.open ? "" : " (private)"}</option>`).join("")}</select>`
          : `${esc(f ? f.name : "General")}${lock(f)}`}</td><td class="num">${esc(fmtSize(d.size || 0))}</td>
        <td><span class="who-cell">${avatar(d.uploadedBy, 22)} ${esc(pname(d.uploadedBy))}</span><div class="hint">${esc(when(d.createdAt))}</div></td>
        <td>${isSuper() || d.uploadedBy === uid() ? `<button class="btn danger sm" type="button" data-del-doc="${esc(d.id)}">Delete</button>` : ""}</td></tr>`; }).join("")}</tbody></table></div>`
      : `<div class="empty">No documents here yet. Upload briefs, scripts, brand files and anything the team needs.</div>`}`;
}
function folderForm(f){
  f = f || {open: true, members: []};
  const people = members().filter(id => person(id).role !== "super_admin" && docsAccess(id));
  return `<form data-folder-form="${esc(f.id || "")}" style="display:grid;gap:14px">
    <h3 class="group-title" style="margin-top:0">${f.id ? "Folder settings" : "New folder"}</h3>
    <label class="f"><span>Folder name</span><input type="text" name="fname" maxlength="60" required value="${esc(f.name || "")}" placeholder="e.g. Brand assets"></label>
    <fieldset class="perm-box"><legend>Who can see it</legend>
      <label class="f check"><input type="radio" name="open" value="1" ${f.open ? "checked" : ""}><span>Everyone with Documents access</span></label>
      <label class="f check"><input type="radio" name="open" value="0" ${f.open ? "" : "checked"}><span>Only the people I choose</span></label>
      <div class="invite-list" data-folder-people ${f.open ? "hidden" : ""}>${people.length ? people.map(id => `<label class="inv"><input type="checkbox" name="mem" value="${esc(id)}" ${(f.members || []).includes(id) ? "checked" : ""}>${avatar(id, 28)}<span class="inv-t"><strong>${esc(pname(id))}</strong><span class="hint">${esc(person(id).title || person(id).email || "")}</span></span></label>`).join("")
        : `<p class="hint">No admins have Documents access yet. Give it under Users &amp; access.</p>`}</div>
      <p class="hint" style="margin:0">Super admins can always see every folder.</p></fieldset>
    <div class="row-btns"><button class="btn" type="submit">${f.id ? "Save folder" : "Create folder"}</button>
      ${f.id ? `<button class="btn danger sm" type="button" data-del-folder="${esc(f.id)}">Delete folder</button>` : ""}</div>
    <p class="hint" id="folder-msg" role="status" aria-live="polite"></p></form>`;
}
async function saveFolder(form){
  const id = form.dataset.folderForm, name = form.fname.value.trim().slice(0, 60), open = form.querySelector("[name=open]:checked").value === "1";
  const mem = open ? [] : [...form.querySelectorAll("[name=mem]:checked")].map(i => i.value);
  if (!name) { $("folder-msg").textContent = "Give the folder a name."; return; }
  form.querySelector("[type=submit]").disabled = true;
  try {
    if (!id) { const r = await db.collection("folders").add({name, open, members: mem, createdBy: uid(), createdAt: TS()}); docFolder = r.id; msg(`Folder "${name}" created.`); }
    else {
      const b = db.batch(); b.update(db.collection("folders").doc(id), {name, open, members: mem});
      DOCS.filter(d => d.folderId === id).forEach(d => b.update(db.collection("docs").doc(d.id), {folder: name, open, viewers: mem}));
      await b.commit(); msg("Folder saved.");
      mem.filter(p => !(folderById(id).members || []).includes(p)).forEach(p => notify(p, `${myLabel()} shared the "${name}" folder with you`, {tab: "ws_docs"}));
    }
    closeModal(); drawDocs();
  } catch { $("folder-msg").textContent = "That didn't save. Make sure the latest database rules are published."; form.querySelector("[type=submit]").disabled = false; }
}
async function moveDoc(id, fid){
  const f = folderById(fid);
  try { await db.collection("docs").doc(id).update({folderId: fid, folder: f ? f.name : "General", open: f ? !!f.open : true, viewers: f && !f.open ? (f.members || []) : []}); msg(`Moved to ${f ? f.name : "General"}.`); }
  catch { msg("Couldn't move that file.", true); }
}
async function uploadDocs(files){
  const fid = docFolder === "All" ? "" : docFolder, f = folderById(fid);
  const access = {folderId: f ? fid : "", folder: f ? f.name : "General", open: f ? !!f.open : true, viewers: f && !f.open ? (f.members || []) : []};
  const bar = $("doc-progress"); bar.hidden = false;
  for (const file of files) {
    if (file.size > 50 * 1024 * 1024) { msg(`${file.name} is over 50 MB and was skipped.`, true); continue; }
    const path = `workspace/docs/${Date.now()}-${file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 100)}`, ref = storage.ref(path);
    try {
      const task = ref.put(file, {contentType: file.type || "application/octet-stream"});
      task.on("state_changed", s => { bar.firstElementChild.style.width = Math.round(s.bytesTransferred / s.totalBytes * 100) + "%"; msg(`Uploading ${file.name}… ${Math.round(s.bytesTransferred / s.totalBytes * 100)}%`); });
      await task;
      await db.collection("docs").add({name: file.name.slice(0, 200), ...access, path, url: await ref.getDownloadURL(), size: file.size, type: file.type || "", uploadedBy: uid(), createdAt: TS()});
      msg(`${file.name} uploaded to ${access.folder}.`);
    } catch { msg(`${file.name} didn't upload. Check your Documents access and that the latest rules are published.`, true); }
  }
  bar.hidden = true;
}

/* ===== TEAM ===== */
function drawTeam(){
  const ms = members().sort((a, b) => (person(b).role === "super_admin") - (person(a).role === "super_admin") || pname(a).localeCompare(pname(b)));
  content.innerHTML = `<div class="team">${ms.map(id => { const p = person(id);
    return `<article class="tm">${avatar(id, 72)}<strong>${esc(p.name || p.email)}${id === uid() ? ` <span class="chip muted">You</span>` : ""}</strong>
      <span class="tm-cat">${esc(p.title || "No category yet")}</span>
      <span class="hint">${esc(stateLabel(id))}${p.statusText && stateOf(id) !== "offline" ? " · " + esc(p.statusText) : ""}</span><span class="hint">${esc(A.ROLE_LABEL[p.role] || "")}</span>
      ${id === uid() ? "" : `<div class="row-btns">${canWS("ws_chat") ? `<button class="btn ghost sm" type="button" data-dm="${esc(id)}">Message</button>` : ""}${canWS("ws_tasks") && assignable().includes(id) ? `<button class="btn ghost sm" type="button" data-task-for="${esc(id)}">Give a task</button>` : ""}</div>`}</article>`; }).join("")}</div>
    <p class="hint">${isSuper() ? "Set categories, photos and access under Users & access." : "Ask a super admin to update your category. Add your photo under My account."}</p>`;
}

/* ---------- shared events ---------- */
content.addEventListener("click", e => {
  const g = s => e.target.closest(s);
  let b;
  if ((b = g("[data-new-task]"))) { modal(`<h3 class="group-title" style="margin-top:0">New task</h3>` + taskForm()); return; }
  if ((b = g("[data-task-for]"))) { modal(`<h3 class="group-title" style="margin-top:0">New task</h3>` + taskForm({assignee: b.dataset.taskFor})); return; }
  if ((b = g("[data-task]"))) { openTask(b.dataset.task); return; }
  if ((b = g("[data-open-task]"))) { A.goto("ws_tasks", {id: b.dataset.openTask}); return; }
  if ((b = g("[data-channel]"))) { openThread(b.dataset.channel); return; }
  if ((b = g("[data-chat-back]"))) { openChannel = null; content.querySelector(".chat").classList.remove("has-open"); drawChatList(); return; }
  if ((b = g("[data-new-dm]"))) { pickPeople("New message", false); return; }
  if ((b = g("[data-new-group]"))) { pickPeople("New group", true, [], `<label class="f"><span>Group name</span><input type="text" name="gname" maxlength="60" placeholder="e.g. Content team"></label>`); $("ws-modal").dataset.group = ""; return; }
  if ((b = g("[data-group-edit]"))) { const c = CHANNELS.find(x => x.id === b.dataset.groupEdit);
    pickPeople("Group members", true, c.members, `<label class="f"><span>Group name</span><input type="text" name="gname" maxlength="60" value="${esc(c.name || "")}"></label><p class="hint">Only the group's creator or a super admin can change members.</p>`); $("ws-modal").dataset.group = c.id; return; }
  if ((b = g("[data-cal]"))) { const d = +b.dataset.cal; calMonth = d ? new Date(calMonth.getFullYear(), calMonth.getMonth() + d, 1) : (n => new Date(n.getFullYear(), n.getMonth(), 1))(new Date()); drawCalendar(); return; }
  if ((b = g("[data-event]"))) { openEvent(b.dataset.event); return; }
  if ((b = g("[data-new-event]"))) { modal(`<h3 class="group-title" style="margin-top:0">New event</h3>` + eventForm({date: b.dataset.newEvent})); return; }
  if ((b = g("[data-folder]"))) { docFolder = b.dataset.folder; drawDocs(); return; }
  if ((b = g("[data-new-folder]"))) { modal(folderForm()); return; }
  if ((b = g("[data-folder-settings]"))) { modal(folderForm(folderById(b.dataset.folderSettings))); return; }
  if ((b = g("[data-dm]"))) { openDM(b.dataset.dm); return; }
  if ((b = g("[data-del-doc]"))) { confirmThen(b, async () => { const d = DOCS.find(x => x.id === b.dataset.delDoc); try { if (d && d.path) await storage.ref(d.path).delete().catch(() => {}); await db.collection("docs").doc(b.dataset.delDoc).delete(); msg("Document deleted."); } catch { msg("Couldn't delete that document.", true); } }); return; }
});
document.addEventListener("click", e => {   /* things inside the modal (outside #content) */
  const g = s => e.target.closest(s); let b;
  if ((b = g("#ws-modal [data-dm]"))) { openDM(b.dataset.dm); return; }
  if ((b = g("[data-del-folder]"))) { const fid = b.dataset.delFolder, n = DOCS.filter(d => d.folderId === fid).length;
    if (n) { $("folder-msg").textContent = `This folder still has ${n} file${n === 1 ? "" : "s"}. Move or delete them first.`; return; }
    confirmThen(b, async () => { try { await db.collection("folders").doc(fid).delete(); docFolder = "All"; closeModal(); drawDocs(); msg("Folder deleted."); } catch { msg("Couldn't delete that folder.", true); } }); return; }
  if ((b = g("[data-group-save]"))) { saveGroup($("ws-modal").dataset.group || ""); return; }
  if ((b = g("[data-del-task]"))) { confirmThen(b, async () => { try { await db.collection("tasks").doc(b.dataset.delTask).delete(); closeModal(); msg("Task deleted."); } catch { msg("Couldn't delete that task.", true); } }); return; }
  if ((b = g("[data-del-event]"))) { confirmThen(b, async () => { try { await db.collection("events").doc(b.dataset.delEvent).delete(); closeModal(); msg("Event deleted."); } catch { msg("Couldn't delete that event.", true); } }); return; }
});
function confirmThen(b, fn){ if (!b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = "Click again to confirm"; return; } b.disabled = true; fn(); }
document.addEventListener("submit", async e => {
  const f = e.target;
  if (f.matches("[data-task-form]")) { e.preventDefault(); saveTask(f); }
  else if (f.matches("[data-event-form]")) { e.preventDefault(); saveEvent(f); }
  else if (f.matches("[data-folder-form]")) { e.preventDefault(); saveFolder(f); }
  else if (f.matches("[data-send]")) { e.preventDefault(); sendMsg(f); }
  else if (f.matches("[data-comment-form]")) {
    e.preventDefault(); const id = f.dataset.commentForm, ta = f.querySelector("textarea"), text = ta.value.trim().slice(0, 2000); if (!text) return;
    const t = TASKS.find(x => x.id === id) || {};
    try { await db.collection("tasks").doc(id).collection("comments").add({from: uid(), text, at: TS()}); ta.value = "";
      db.collection("tasks").doc(id).update({comments: (t.comments || 0) + 1, updatedAt: TS()}).catch(() => {});
      [t.assignee, t.reporter].filter((v, i, a) => v && a.indexOf(v) === i).forEach(p => notify(p, `${myLabel()} commented on "${t.title}"`, {tab: "ws_tasks", id}));
    } catch { msg("That comment didn't post.", true); }
  }
});
content.addEventListener("change", e => {
  if (e.target.matches("[data-task-filter]")) { taskFilter = e.target.value; drawTasks(); }
  if (e.target.matches("[data-doc-upload]") && e.target.files.length) uploadDocs([...e.target.files]);
});

document.addEventListener("change", e => {
  const r = e.target.closest("[data-folder-form] [name=open]"); if (r) { const box = document.querySelector("[data-folder-people]"); if (box) box.hidden = r.value === "1"; }
  const m = e.target.closest("[data-move-doc]"); if (m) moveDoc(m.dataset.moveDoc, m.value);
});

document.addEventListener("click", e => {
  const t = e.target.closest("[data-emoji-toggle]"), pick = e.target.closest("[data-emoji]");
  if (t) { const pop = t.nextElementSibling; pop.hidden = !pop.hidden; t.setAttribute("aria-expanded", String(!pop.hidden)); return; }
  if (pick) { const f = pick.closest("form"), ta = f.querySelector("textarea"), a = ta.selectionStart ?? ta.value.length, z = ta.selectionEnd ?? a;
    ta.value = ta.value.slice(0, a) + pick.dataset.emoji + ta.value.slice(z); ta.focus(); ta.selectionStart = ta.selectionEnd = a + pick.dataset.emoji.length; return; }
  document.querySelectorAll(".emoji-pop:not([hidden])").forEach(p => { if (!p.parentElement.contains(e.target)) { p.hidden = true; p.previousElementSibling.setAttribute("aria-expanded", "false"); } });
});

window.WS = {tabs: TABS, draw, start, stop, leave, badges, drawSummary};
})();

