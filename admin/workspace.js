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
const STATUSES = [["idea", "Ideas"], ["todo", "To do"], ["doing", "In progress"], ["review", "Review"], ["scheduled", "Scheduled"], ["done", "Done"]];
const PLATFORMS = [["Instagram", "IG"], ["TikTok", "TT"], ["X", "X"], ["YouTube", "YT"], ["Facebook", "FB"], ["LinkedIn", "IN"], ["Threads", "TH"], ["Website", "WEB"], ["Newsletter", "NL"]];
const platShort = p => (PLATFORMS.find(x => x[0] === p) || [p, p])[1];
const PRIORITIES = [["high", "High"], ["med", "Medium"], ["low", "Low"]];
const TYPES = ["Content", "Video", "Design", "Social", "Website", "Admin", "Other"];

let PEOPLE = {}, TASKS = [], CHANNELS = [], NOTES = [], EVENTS = [], DOCS = [], FOLDERS = [], migrated = false;
let subs = [], viewSubs = [], current = null;
let pendingChannel = null, pendingEvent = null, pendingEventNew = false, pendingTask = null;
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
/* Time zones: each event remembers the creator's time zone and its exact moment (startAt/endAt, UTC).
   Everyone sees it in their own time zone. Older events without a zone were made in New York time. */
const MY_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York"; } catch { return "America/New_York"; } })();
const tzCity = tz => String(tz || "").split("/").pop().replace(/_/g, " ");
function tzOffsetMin(ms, tz){
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"}).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms) / 60000;
}
function zonedToUtc(date, time, tz){
  const [y, mo, d] = date.split("-").map(Number), [h, mi] = (time || "00:00").split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi); let t = guess - tzOffsetMin(guess, tz) * 60000;
  const t2 = guess - tzOffsetMin(t, tz) * 60000; return t2;
}
const timed = ev => !ev.allDay && !!ev.start;
const evStartMs = ev => !timed(ev) ? null : ev.startAt ? Date.parse(ev.startAt) : zonedToUtc(ev.date, ev.start, ev.tz || "America/New_York");
const evEndMs = ev => { if (!timed(ev)) return null; if (ev.endAt) return Date.parse(ev.endAt); const s = evStartMs(ev); let e = zonedToUtc(ev.date, ev.end || ev.start, ev.tz || "America/New_York"); if (e < s) e += 864e5; return e; };
const evDay = ev => timed(ev) ? dayStr(new Date(evStartMs(ev))) : ev.date;           /* the day it falls on for *you* */
const hm = ms => new Date(ms).toLocaleTimeString("en-US", {hour: "numeric", minute: "2-digit"});
const hm24 = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const evTime = ev => timed(ev) ? hm(evStartMs(ev)) : "";
const evSortKey = ev => timed(ev) ? new Date(evStartMs(ev)).toISOString() : ev.date + "T00";
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
  subs.push(db.collection("users").onSnapshot(s => { PEOPLE = {}; s.docs.forEach(d => PEOPLE[d.id] = d.data()); resolvePhotos(); drawBubble(); saveMyTz(); refresh(); }, () => {}));
  subs.push(db.collection("notifications").doc(uid()).collection("items").orderBy("createdAt", "desc").limit(40)
    .onSnapshot(s => { NOTES = s.docs.map(d => ({id: d.id, ...d.data()})); bell(); }, () => {}));
  /* Super admins see every conversation (including other people's private chats); everyone else only their own. */
  if (canWS("ws_chat")) subs.push((isSuper() ? db.collection("channels") : db.collection("channels").where("members", "array-contains", uid()))
    .onSnapshot(s => { CHANNELS = s.docs.map(d => ({id: d.id, ...d.data()})).sort((a, b) => (toDate(b.lastAt) || 0) - (toDate(a.lastAt) || 0)); badges(); refresh("ws_chat"); }, () => {}));
  if (canWS("ws_tasks")) subs.push(db.collection("tasks").orderBy("createdAt", "desc").limit(500)
    .onSnapshot(s => { TASKS = s.docs.map(d => ({id: d.id, ...d.data()})); remLoaded.t = true; badges(); refresh("ws_tasks"); refresh("ws_calendar"); }, () => {}));
  if (canWS("ws_calendar")) subs.push(db.collection("events").orderBy("date").limit(500)
    .onSnapshot(s => { EVENTS = s.docs.map(d => ({id: d.id, ...d.data()})); remLoaded.e = true; refresh("ws_calendar"); }, () => {}));
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
  clearInterval(remTimer); remTimer = setInterval(() => runReminders(true), 5 * 60 * 1000);
}
let beatTimer = null;
let tzSaved = false;
function saveMyTz(){
  if (tzSaved || !uid() || !PEOPLE[uid()]) return; tzSaved = true;
  if (PEOPLE[uid()].tz !== MY_TZ) db.collection("users").doc(uid()).update({tz: MY_TZ}).catch(() => {});
}
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
function stop(){ clearInterval(remTimer); removeDock(); subs.forEach(u => u()); subs = []; leave(); clearInterval(beatTimer); const b = $("bell"); if (b) b.hidden = true; const w = $("me-bubble-wrap"); if (w) w.hidden = true; }
function leave(){ viewSubs.forEach(u => u()); viewSubs = []; current = null; if (typeof drawDock === "function") drawDock(); }
function refresh(k){
  drawSummary(); drawDock(); drawExtras(); runReminders();
  if (current === "ws_tasks" && pendingTask && TASKS.find(t => t.id === pendingTask) && !$("ws-modal")) { const id = pendingTask; pendingTask = null; openTask(id); return; }
  if (!current || (k && current !== k)) return;
  if (current === "ws_chat") {                                    /* never rebuild an open conversation */
    if (pendingChannel && CHANNELS.find(c => c.id === pendingChannel)) { const id = pendingChannel; pendingChannel = null; openThread(id); return; }
    drawChatList(); return;
  }
  if (current === "ws_calendar" && pendingEvent && EVENTS.find(e => e.id === pendingEvent)) { const id = pendingEvent, isNew = pendingEventNew; pendingEvent = null; pendingEventNew = false; draw(current); openEvent(id, isNew); return; }
  if (document.querySelector("#content :focus")) return;          /* don't interrupt typing */
  draw(current);
}

/* ---------- badges + bell ---------- */
const inChat = c => (c.members || []).includes(uid());
const unreadChannels = () => CHANNELS.filter(c => inChat(c) && c.lastAt && c.lastFrom !== uid() && (!c.reads || !c.reads[uid()] || toDate(c.reads[uid()]) < toDate(c.lastAt))).length;
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
/* ===== REMINDERS (in the bell) =====
   Checked while the admin is open: your tasks due tomorrow / today / overdue, content going out today,
   and events you're invited to starting within the hour or tomorrow. Each reminder is sent once.
   A daily email summary is sent separately by /api/reminders once email is set up. */
let remLast = 0, remDone = new Set();
try { remDone = new Set(JSON.parse(sessionStorage.getItem("rem-done") || "[]")); } catch {}
async function remind(rid, text, link){
  if (remDone.has(rid)) return; remDone.add(rid); try { sessionStorage.setItem("rem-done", JSON.stringify([...remDone].slice(-300))); } catch {}
  const ref = db.collection("notifications").doc(uid()).collection("items").doc(rid);
  try { if (!(await ref.get()).exists) await ref.set({text: text.slice(0, 300), link, from: uid(), read: false, createdAt: TS()}); } catch {}
}
const remLoaded = {t: false, e: false};
function runReminders(force){
  if (!uid() || (canWS("ws_tasks") && !remLoaded.t) || (canWS("ws_calendar") && !remLoaded.e)) return;   /* wait for data */
  if (!force && Date.now() - remLast < 4 * 60 * 1000) return; remLast = Date.now();
  const today = dayStr(new Date()), tomorrow = dayStr(new Date(Date.now() + 864e5)), now = Date.now();
  if (canWS("ws_tasks")) TASKS.filter(t => t.assignee === uid() && t.status !== "done").forEach(t => {
    const link = {tab: "ws_tasks", id: t.id};
    if (t.due === tomorrow) remind(`rem_due1_${t.id}_${t.due}`, `⏰ "${t.title}" is due tomorrow`, link);
    else if (t.due === today) remind(`rem_due0_${t.id}_${t.due}`, `⏰ "${t.title}" is due today`, link);
    else if (t.due && t.due < today) remind(`rem_over_${t.id}_${today}`, `⚠️ "${t.title}" is overdue (was due ${fmtDay(t.due)})`, link);
    if (t.postDate === today && t.status !== "idea") remind(`rem_post_${t.id}_${t.postDate}`, `📣 "${t.title}" goes out today${(t.platforms || []).length ? " on " + t.platforms.join(", ") : ""}`, link);
  });
  if (canWS("ws_calendar")) EVENTS.filter(e => (e.attendees || []).includes(uid())).forEach(e => {
    const link = {tab: "ws_calendar", event: e.id};
    if (timed(e)) { const st = evStartMs(e), mins = (st - now) / 60000;
      if (mins > 0 && mins <= 60) remind(`rem_ev_${e.id}_${st}`, `📅 "${e.title}" starts at ${hm(st)} (in ${Math.max(1, Math.round(mins))} min)`, link);
      else if (evDay(e) === tomorrow) remind(`rem_ev1_${e.id}_${st}`, `📅 Tomorrow: "${e.title}" at ${hm(st)}`, link);
    } else if (e.date === tomorrow) remind(`rem_ev1_${e.id}_${e.date}`, `📅 Tomorrow: "${e.title}" (all day)`, link);
  });
}
let remTimer = null;

/* "Your week" on My profile */
function summaryHTML(){
  if (!uid()) return "";
  const today = dayStr(new Date()), soon = dayStr(new Date(Date.now() + 14 * 864e5));
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
    const up = EVENTS.filter(e => evDay(e) >= today && evDay(e) <= soon && (e.attendees || []).includes(uid())).sort((a, b) => evSortKey(a).localeCompare(evSortKey(b)));
    cards.push(`<section class="sum-card"><h4>Coming up <span class="chip">${up.length}</span></h4>
      ${up.slice(0, 3).map(e => `<button class="sum-row" type="button" data-go="ws_calendar"><span>${esc(e.title)}</span><span class="hint">${esc(fmtDay(evDay(e)))}${timed(e) ? " · " + esc(evTime(e)) : ""}</span></button>`).join("") || `<p class="hint">No events in the next two weeks.</p>`}
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
  current = tab; drawDock();
  const open = window.__WS_OPEN; window.__WS_OPEN = null;
  ({ws_tasks: drawTasks, ws_chat: drawChat, ws_calendar: drawCalendar, ws_docs: drawDocs, ws_team: drawTeam})[tab](open);
}

/* ===== TASKS ===== */
function visibleTasks(){
  return TASKS.filter(t => taskFilter === "all" || (taskFilter === "mine" && t.assignee === uid()) || (taskFilter === "created" && t.reporter === uid()) || (taskFilter.startsWith("u:") && t.assignee === taskFilter.slice(2))
    || (taskFilter === "content" && ((t.platforms || []).length || t.postDate))
    || (taskFilter.startsWith("p:") && (t.platforms || []).includes(taskFilter.slice(2))));
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
        <option value="content" ${taskFilter === "content" ? "selected" : ""}>Content only</option>
        ${PLATFORMS.map(([p]) => `<option value="p:${esc(p)}" ${taskFilter === "p:" + p ? "selected" : ""}>${esc(p)}</option>`).join("")}
        ${members().filter(id => id !== uid()).map(id => `<option value="u:${esc(id)}" ${taskFilter === "u:" + id ? "selected" : ""}>${esc(pname(id))}'s tasks</option>`).join("")}
      </select>
      <span class="hint" id="ws-note"></span>
    </div>
    <div class="board">${STATUSES.map(([k, l]) => { const col = list.filter(t => (t.status || "todo") === k);
      return `<section class="col" data-col="${k}"><h3>${l} <span class="hint">${col.length}</span></h3>
        ${col.map(t => `<button class="card" type="button" draggable="${canMove(t)}" data-task="${esc(t.id)}">
          <span class="card-top"><span class="tchip">${esc(t.type || "Task")}</span><span class="prio p-${esc(t.priority || "med")}" title="${esc((PRIORITIES.find(p => p[0] === t.priority) || PRIORITIES[1])[1])} priority"></span></span>
          <span class="card-title">${esc(t.title)}</span>
          ${(t.platforms || []).length || t.postDate ? `<span class="card-plat">${(t.platforms || []).map(p => `<span class="pchip" title="${esc(p)}">${esc(platShort(p))}</span>`).join("")}${t.postDate ? `<span class="hint">📣 ${esc(fmtDay(t.postDate))}</span>` : ""}</span>` : ""}
          <span class="card-foot">${avatar(t.assignee, 24)}<span class="hint">${t.due ? "Due " + esc(fmtDay(t.due)) : ""}</span>${(t.checklist || []).length ? `<span class="hint">☑ ${(t.checklist || []).filter(c => c.done).length}/${t.checklist.length}</span>` : ""}${(t.files || []).length + (t.links || []).length ? `<span class="hint">📎 ${(t.files || []).length + (t.links || []).length}</span>` : ""}${t.comments ? `<span class="hint">💬 ${t.comments}</span>` : ""}</span>
        </button>`).join("") || `<p class="hint empty-col">Nothing here.</p>`}
      </section>`; }).join("")}</div>`;
  if (open && open.id) { if (TASKS.find(t => t.id === open.id)) openTask(open.id); else pendingTask = open.id; }
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
      <label class="f"><span>Post date <span class="hint">(content)</span></span><input type="date" name="postDate" value="${esc(t.postDate || "")}"></label>
    </div>
    <fieldset class="perm-box"><legend>Platforms <span class="hint">(for content)</span></legend><div class="plat-pick">${PLATFORMS.map(([p]) => `<label class="f check"><input type="checkbox" name="platforms" value="${esc(p)}" ${(t.platforms || []).includes(p) ? "checked" : ""}><span>${esc(p)}</span></label>`).join("")}</div></fieldset>
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
function closeModal(){ if (typeof dockPick !== "undefined" && !document.querySelector("#ws-modal [data-dm]:focus")) setTimeout(() => { if (!$("ws-modal")) dockPick = false; }, 0); const m = $("ws-modal"); if (m && window.__setHash) window.__setHash(current === "ws_chat" ? openChannel : null); if (m) { viewSubs = viewSubs.filter(u => u !== m._unsub); if (m._unsub) m._unsub(); m.remove(); } }
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });
document.addEventListener("click", e => { if (e.target.closest("[data-close-modal]") || e.target.id === "ws-modal") closeModal(); });

/* Review flow, checklist, files and links (shown under the task, updates live) */
function reviewHTML(t){
  const creator = isCreator(t), assignee = t.assignee === uid(), st = t.status || "todo";
  let review = "";
  if (st === "review" && creator && !assignee) review = `<div class="notice review-bar"><strong>${esc(pname(t.assignee))} sent this for review.</strong>
      <div class="row-btns" style="margin-top:8px"><button class="btn sm" type="button" data-approve="${esc(t.id)}">Approve</button><button class="btn ghost sm" type="button" data-changes="${esc(t.id)}">Request changes</button></div>
      <form class="changes-form" data-changes-form="${esc(t.id)}" hidden><textarea name="note" maxlength="1500" placeholder="What needs to change?" required></textarea><button class="btn sm" type="submit">Send back</button></form></div>`;
  else if (st === "review" && assignee && !creator) review = `<p class="hint">⏳ Waiting for ${esc(pname(t.reporter))} to review.</p>`;
  else if (assignee && !creator && ["idea", "todo", "doing"].includes(st)) review = `<div class="review-bar"><button class="btn sm" type="button" data-submit-review="${esc(t.id)}">Submit for review</button> <span class="hint">when it's ready for ${esc(pname(t.reporter))} to check.</span></div>`;
  return review;
}
function taskExtras(t){
  const creator = isCreator(t), mover = canMove(t);
  const cl = t.checklist || [], files = t.files || [], links = t.links || [];
  return `
    <h3 class="group-title">Checklist ${cl.length ? `<span class="hint">${cl.filter(c => c.done).length}/${cl.length}</span>` : ""}</h3>
    <div class="checklist">${cl.map(c => `<label class="ck${c.done ? " done" : ""}"><input type="checkbox" data-ck="${esc(t.id)}" data-ck-id="${esc(c.id)}" ${c.done ? "checked" : ""} ${mover ? "" : "disabled"}><span>${esc(c.t)}</span>${creator ? `<button class="x-del" type="button" data-ck-del="${esc(t.id)}" data-ck-id="${esc(c.id)}" aria-label="Remove">✕</button>` : ""}</label>`).join("") || `<p class="hint" style="margin:0">${creator ? "Break it into steps, e.g. Script, Film, Edit, Caption, Post." : "No checklist."}</p>`}</div>
    ${creator ? `<form class="ck-add" data-ck-add="${esc(t.id)}"><input type="text" name="item" maxlength="140" placeholder="Add a step…"><button class="btn ghost sm" type="submit">Add</button></form>` : ""}
    <h3 class="group-title">Files &amp; links</h3>
    <div class="att-list">${files.map((f, i) => `<div class="att">📄 <a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a><span class="hint">${esc(fmtSize(f.size || 0))} · ${esc(pname(f.by))}</span>${creator || f.by === uid() ? `<button class="x-del" type="button" data-att-del="${esc(t.id)}" data-kind="files" data-i="${i}" aria-label="Remove">✕</button>` : ""}</div>`).join("")}
      ${links.map((l, i) => `<div class="att">🔗 <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label || l.url)}</a><span class="hint">${esc(pname(l.by))}</span>${creator || l.by === uid() ? `<button class="x-del" type="button" data-att-del="${esc(t.id)}" data-kind="links" data-i="${i}" aria-label="Remove">✕</button>` : ""}</div>`).join("")}
      ${files.length + links.length ? "" : `<p class="hint" style="margin:0">Nothing attached yet.</p>`}</div>
    ${mover ? `<div class="row-btns"><label class="btn ghost sm" style="cursor:pointer">Attach file<input type="file" multiple hidden data-att-file="${esc(t.id)}"></label><button class="btn ghost sm" type="button" data-link-open>Add link</button></div>
      <form class="link-add" data-link-add="${esc(t.id)}" hidden><input type="text" inputmode="url" name="url" placeholder="Paste a link (Canva, Drive, YouTube…)" required><input type="text" name="label" maxlength="80" placeholder="Label (optional)"><button class="btn sm" type="submit">Add</button></form>
      <div class="progress" id="att-progress" hidden><i></i></div>` : ""}
    <p class="hint" id="extras-msg" role="status" aria-live="polite"></p>`;
}
function drawExtras(){
  const b = $("task-extras"); if (!b) return; const t = TASKS.find(x => x.id === b.dataset.taskExtras); if (!t) return;
  if (!b.contains(document.activeElement)) b.innerHTML = taskExtras(t);
  const r = $("task-review"); if (r && !r.contains(document.activeElement)) r.innerHTML = reviewHTML(t);
}
const exMsg = (t, err) => { const m = $("extras-msg"); if (m) { m.textContent = t; m.className = err ? "hint err" : "hint okc"; } };
async function taskUpdate(id, fields, okText){
  try { await db.collection("tasks").doc(id).update({...fields, updatedAt: TS()}); if (okText) msg(okText); return true; }
  catch { exMsg("That didn't save. Make sure the latest database rules are published.", true); return false; }
}
document.addEventListener("click", async e => {
  const g = s => e.target.closest(s); let b;
  const host = g("#task-extras") || g("#task-review"); if (!host) return;
  const tid = host.dataset.taskExtras, t = TASKS.find(x => x.id === tid); if (!t) return;
  if ((b = g("[data-submit-review]"))) { if (await taskUpdate(tid, {status: "review"}, "Sent for review.")) notify(t.reporter, `${myLabel()} sent "${t.title}" for your review`, {tab: "ws_tasks", id: tid}); return; }
  if ((b = g("[data-approve]"))) { const next = t.postDate ? "scheduled" : "done";
    if (await taskUpdate(tid, {status: next}, "Approved.")) notify(t.assignee, `${myLabel()} approved "${t.title}"${next === "scheduled" ? " — it's scheduled" : ""} ✅`, {tab: "ws_tasks", id: tid}); return; }
  if ((b = g("[data-changes]"))) { const f = document.querySelector("[data-changes-form]"); f.hidden = !f.hidden; if (!f.hidden) f.note.focus(); return; }
  if ((b = g("[data-ck-del]"))) { await taskUpdate(tid, {checklist: (t.checklist || []).filter(c => c.id !== b.dataset.ckId)}); return; }
  if ((b = g("[data-link-open]"))) { const f = document.querySelector("[data-link-add]"); f.hidden = !f.hidden; if (!f.hidden) f.url.focus(); return; }
  if ((b = g("[data-att-del]"))) { const kind = b.dataset.kind, list = [...(t[kind] || [])], gone = list.splice(+b.dataset.i, 1)[0];
    if (await taskUpdate(tid, {[kind]: list}) && gone && gone.path) storage.ref(gone.path).delete().catch(() => {}); return; }
});
document.addEventListener("change", async e => {
  const ck = e.target.closest("[data-ck]");
  if (ck) { const t = TASKS.find(x => x.id === ck.dataset.ck); if (!t) return;
    const list = (t.checklist || []).map(c => c.id === ck.dataset.ckId ? {...c, done: ck.checked} : c);
    ck.blur(); await taskUpdate(t.id, {checklist: list}); return; }
  const fi = e.target.closest("[data-att-file]");
  if (fi && fi.files.length) {
    const t = TASKS.find(x => x.id === fi.dataset.attFile); if (!t) return;
    const bar = $("att-progress"); if (bar) bar.hidden = false; const added = [];
    for (const file of fi.files) {
      if (file.size > 200 * 1024 * 1024) { exMsg(`${file.name} is over 200 MB and was skipped.`, true); continue; }
      const path = `workspace/tasks/${t.id}/${Date.now()}-${file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 100)}`, ref = storage.ref(path);
      try {
        const up = ref.put(file, {contentType: file.type || "application/octet-stream"});
        up.on("state_changed", s => { const p = Math.round(s.bytesTransferred / s.totalBytes * 100); if (bar) bar.firstElementChild.style.width = p + "%"; exMsg(`Uploading ${file.name}… ${p}%`); });
        await up; added.push({name: file.name.slice(0, 200), url: await ref.getDownloadURL(), path, size: file.size, by: uid()});
      } catch { exMsg(`${file.name} didn't upload. Make sure the latest Storage rules are published.`, true); }
    }
    if (bar) bar.hidden = true;
    if (added.length) {
      const cur = TASKS.find(x => x.id === t.id) || t;
      if (await taskUpdate(t.id, {files: [...(cur.files || []), ...added].slice(-30)})) {
        exMsg(`Attached ${added.map(a => a.name).join(", ")}.`);
        const other = uid() === t.reporter ? t.assignee : t.reporter; notify(other, `${myLabel()} attached ${added.length === 1 ? added[0].name : added.length + " files"} to "${t.title}"`, {tab: "ws_tasks", id: t.id});
      }
    }
    fi.value = "";
  }
});
document.addEventListener("submit", async e => {
  const f = e.target;
  if (f.matches("[data-ck-add]")) { e.preventDefault(); const t = TASKS.find(x => x.id === f.dataset.ckAdd), v = f.item.value.trim().slice(0, 140); if (!t || !v) return;
    f.item.value = ""; await taskUpdate(t.id, {checklist: [...(t.checklist || []), {id: Math.random().toString(36).slice(2, 9), t: v, done: false}].slice(0, 40)}); f.item && f.item.focus(); }
  if (f.matches("[data-link-add]")) { e.preventDefault(); const t = TASKS.find(x => x.id === f.dataset.linkAdd); let url = f.url.value.trim(); if (!t || !url) return;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    if (await taskUpdate(t.id, {links: [...(t.links || []), {url: url.slice(0, 500), label: f.label.value.trim().slice(0, 80), by: uid()}].slice(-30)})) {
      const other = uid() === t.reporter ? t.assignee : t.reporter; notify(other, `${myLabel()} added a link to "${t.title}"`, {tab: "ws_tasks", id: t.id}); } }
  if (f.matches("[data-changes-form]")) { e.preventDefault(); const t = TASKS.find(x => x.id === f.dataset.changesForm), note = f.note.value.trim().slice(0, 1500); if (!t || !note) return;
    try {
      await db.collection("tasks").doc(t.id).collection("comments").add({from: uid(), text: "Changes requested: " + note, at: TS()});
      await db.collection("tasks").doc(t.id).update({status: "doing", comments: (t.comments || 0) + 1, updatedAt: TS()});
      notify(t.assignee, `${myLabel()} asked for changes on "${t.title}": ${note.slice(0, 120)}`, {tab: "ws_tasks", id: t.id}); msg("Sent back with your notes.");
    } catch { exMsg("That didn't save. Make sure the latest database rules are published.", true); } }
});

function openTask(id){
  const t = TASKS.find(x => x.id === id); if (!t) return;
  if (window.__setHash) window.__setHash(id);
  const mayEdit = isCreator(t), mayMove = canMove(t);
  const pr = (PRIORITIES.find(p => p[0] === t.priority) || PRIORITIES[1])[1];
  const readOnly = `<h3 class="group-title" style="margin-top:6px">${esc(t.title)}</h3>
    <dl class="task-facts"><div><dt>Assigned to</dt><dd><span class="who-cell">${avatar(t.assignee, 22)} ${esc(pname(t.assignee))}</span></dd></div>
      <div><dt>Status</dt><dd>${mayMove ? `<select data-task-status="${esc(t.id)}" aria-label="Move this task">${STATUSES.map(([k, l]) => `<option value="${k}" ${(t.status || "todo") === k ? "selected" : ""}>${l}</option>`).join("")}</select>` : esc((STATUSES.find(x => x[0] === (t.status || "todo")) || STATUSES[0])[1])}</dd></div>
      <div><dt>Priority</dt><dd>${esc(pr)}</dd></div><div><dt>Due</dt><dd>${t.due ? esc(fmtDay(t.due)) : "No date"}</dd></div>
      ${t.postDate ? `<div><dt>Post date</dt><dd>${esc(fmtDay(t.postDate))}</dd></div>` : ""}${(t.platforms || []).length ? `<div><dt>Platforms</dt><dd>${esc(t.platforms.join(", "))}</dd></div>` : ""}</dl>
    ${t.desc ? `<p style="white-space:pre-wrap">${esc(t.desc)}</p>` : ""}
    <p class="hint">${mayMove ? `Only ${esc(pname(t.reporter))} (who created this) can edit or reassign it. You can move it along and comment.` : `Only ${esc(pname(t.reporter))} (who created this) can edit it. You can comment below.`}</p>`;
  const gcal = t.due ? gcalLink({title: "Due: " + t.title, date: t.due, allDay: true, desc: t.desc}) : "";
  modal(`<p class="hint" style="margin:0">${esc(t.type || "Task")} · created by ${esc(pname(t.reporter))} ${esc(when(t.createdAt))}</p>
    <div id="task-review" data-task-extras="${esc(t.id)}">${reviewHTML(t)}</div>
    ${mayEdit ? taskForm(t) : readOnly}
    <div class="row-btns">${gcal ? `<a class="btn ghost sm" href="${esc(gcal)}" target="_blank" rel="noopener">Add due date to Google Calendar</a>` : ""}
      ${isSuper() || t.reporter === uid() ? `<button class="btn danger sm" type="button" data-del-task="${esc(t.id)}">Delete task</button>` : ""}</div>
    <div id="task-extras" data-task-extras="${esc(t.id)}">${taskExtras(t)}</div>
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
  const id = form.dataset.taskForm, fd = new FormData(form), f = Object.fromEntries(fd);
  const data = {title: f.title.trim().slice(0, 200), desc: (f.desc || "").slice(0, 4000), assignee: f.assignee, status: f.status, type: f.type, priority: f.priority, due: f.due || "",
    postDate: f.postDate || "", platforms: fd.getAll("platforms").slice(0, 12), updatedAt: TS()};
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
    if (id) { msg("Task saved."); const b = form.querySelector("[type=submit]"); if (b) { b.textContent = "Saved ✓"; setTimeout(() => { b.textContent = "Save task"; }, 1500); } }
    else { closeModal(); msg("Task created."); }
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
function chName(c){ return c.type === "group" ? c.name || "Group" : inChat(c) ? pname(c.members.find(m => m !== uid()) || uid()) : c.members.map(pname).join(" & "); }
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
  const item = c => { const unread = inChat(c) && c.lastAt && c.lastFrom !== uid() && (!c.reads || !c.reads[uid()] || toDate(c.reads[uid()]) < toDate(c.lastAt));
    return `<button class="chat-item${c.id === openChannel ? " active" : ""}${unread ? " unread" : ""}" type="button" data-channel="${esc(c.id)}">${chAvatar(c, 38)}
      <span class="ci-text"><strong>${esc(chName(c))}</strong><span class="hint">${esc((c.lastFrom === uid() ? "You: " : "") + (c.lastMessage || "No messages yet"))}</span></span>${unread ? `<span class="dot"></span>` : ""}</button>`; };
  const mine = CHANNELS.filter(inChat), others = CHANNELS.filter(c => !inChat(c));
  box.innerHTML = (mine.map(item).join("") || `<p class="hint" style="padding:12px">No conversations yet.</p>`)
    + (others.length ? `<p class="chat-sec">Team chats <span class="hint">· view only</span></p>${others.map(item).join("")}` : "");
}
function openThread(id){
  openChannel = id; const c = CHANNELS.find(x => x.id === id); if (!c) return;
  if (window.__setHash) window.__setHash(id);
  content.querySelector(".chat").classList.add("has-open"); drawChatList();
  const th = $("chat-thread");
  th.innerHTML = `<header class="th-head"><button class="btn ghost sm th-back" type="button" data-chat-back>← Back</button>${chAvatar(c, 34)}<div><strong>${esc(chName(c))}</strong><div class="hint">${c.type === "group" ? esc(c.members.map(pname).join(", ")) : (o => esc([stateLabel(o), person(o).statusText && stateOf(o) !== "offline" ? person(o).statusText : "", person(o).title].filter(Boolean).join(" · ")))(c.members.find(m => m !== uid()))}</div></div>
      ${c.type === "group" ? `<button class="btn ghost sm" type="button" data-group-edit="${esc(c.id)}" style="margin-left:auto">Members</button>` : ""}</header>
    ${inChat(c) ? "" : `<p class="notice" style="margin:8px 12px">You're viewing this chat as a super admin. Only the people in it can send messages.</p>`}
    <div class="msgs" id="msgs"><p class="hint">Loading…</p></div>
    ${inChat(c) ? "" : "<!--"}<form class="send" data-send="${esc(id)}"><div class="emoji-wrap"><button class="emoji-btn" type="button" data-emoji-toggle aria-label="Add emoji" aria-expanded="false">😊</button>
      <div class="emoji-pop" hidden role="dialog" aria-label="Emoji">${EMOJI.map(([g, list]) => `<p class="hint">${g}</p><div class="emoji-grid">${[...list].filter(c => c.trim()).map(c => `<button type="button" data-emoji="${c}">${c}</button>`).join("")}</div>`).join("")}</div></div>
      <textarea name="text" maxlength="4000" placeholder="Write a message…" rows="1" required></textarea><button class="btn sm" type="submit">Send</button></form>${inChat(c) ? "" : "-->"}`;
  viewSubs.forEach(u => u()); viewSubs = [];
  viewSubs.push(db.collection("channels").doc(id).collection("messages").orderBy("at").limitToLast(200).onSnapshot(s => {
    const box = $("msgs"); if (!box) return;
    let last = null;
    box.innerHTML = s.docs.map(d => { const m = d.data(), mine = m.from === uid(), showWho = m.from !== last; last = m.from;
      return `<div class="msg${mine ? " mine" : ""}">${!mine && showWho ? avatar(m.from, 28) : `<span style="width:28px;flex:none"></span>`}<div class="bubble">${!mine && showWho && (c.type === "group" || !inChat(c)) ? `<span class="who">${esc(pname(m.from))}</span>` : ""}${esc(m.text).replace(/\n/g, "<br>")}<span class="t">${esc(when(m.at))}</span></div></div>`; }).join("") || `<p class="hint">Say hello 👋</p>`;
    box.scrollTop = box.scrollHeight;
    if (inChat(c)) db.collection("channels").doc(id).update({["reads." + uid()]: TS()}).catch(() => {});
  }, () => { const box = $("msgs"); if (box) box.innerHTML = `<p class="hint err">Messages couldn't be loaded.</p>`; }));
  const ta = th.querySelector("textarea"); if (!ta) return; ta.focus();
  ta.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); th.querySelector("form").requestSubmit(); } });
}
async function sendMsg(form){
  const id = form.dataset.send, ta = form.querySelector("textarea"), text = ta.value.trim().slice(0, 4000); if (!text) return;
  ta.value = "";
  try {
    await db.collection("channels").doc(id).collection("messages").add({from: uid(), text, at: TS()});
    await db.collection("channels").doc(id).update({lastMessage: text.slice(0, 120), lastAt: TS(), lastFrom: uid(), ["reads." + uid()]: TS()});
    chatNotify(id, text);
  } catch { ta.value = text; msg("That message didn't send. Check your connection.", true); }
}
/* Put new chat messages in the other people's notification bell (in-app only, no email).
   One notification per burst: skip people who already have unread messages here, or who are
   in the conversation right now (they read it in the last minute). */
function chatNotify(id, text){
  const c = CHANNELS.find(x => x.id === id); if (!c) return;
  const last = toDate(c.lastAt), now = Date.now();
  const preview = text.length > 80 ? text.slice(0, 77) + "…" : text;
  const line = c.type === "group" ? `${myLabel()} in ${c.name || "a group"}: “${preview}”` : `${myLabel()} sent you a message: “${preview}”`;
  (c.members || []).filter(m => m !== uid()).forEach(m => {
    const read = toDate(c.reads && c.reads[m]);
    const hasUnread = c.lastFrom && c.lastFrom !== m && last && (!read || read < last);
    const activeNow = read && now - read.getTime() < 60000;
    if (hasUnread || activeNow) return;
    db.collection("notifications").doc(m).collection("items")
      .add({text: line.slice(0, 300), link: {tab: "ws_chat", channel: id}, from: uid(), read: false, createdAt: TS()}).catch(() => {});
  });
}
async function openDM(other){
  const ids = [uid(), other].sort(), id = "dm_" + ids.join("_"), ref = db.collection("channels").doc(id);
  try { const s = await ref.get(); if (!s.exists) await ref.set({type: "dm", members: ids, createdBy: uid(), createdAt: TS(), lastAt: TS(), lastMessage: "", lastFrom: ""}); }
  catch { msg("That conversation couldn't be opened. Check that you have Chat access.", true); return; }
  closeModal();
  if (dockPick) { dockPick = false; openMini(id); return; }
  A.goto("ws_chat", {channel: id});
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
const utcStamp = ms => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function gcalLink(ev){
  let dates;
  if (!timed(ev)) { const n = new Date(ev.date + "T12:00:00"); n.setDate(n.getDate() + 1); dates = ev.date.replace(/-/g, "") + "/" + dayStr(n).replace(/-/g, ""); }
  else dates = utcStamp(evStartMs(ev)) + "/" + utcStamp(evEndMs(ev));
  return "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + encodeURIComponent(ev.title) + "&dates=" + dates + "&details=" + encodeURIComponent((ev.desc || "") + "\n\nFrom the A·A·O Workspace");
}
function icsFile(ev){
  const st = !timed(ev) ? `DTSTART;VALUE=DATE:${ev.date.replace(/-/g, "")}` : `DTSTART:${utcStamp(evStartMs(ev))}`;
  const en = !timed(ev) ? "" : `DTEND:${utcStamp(evEndMs(ev))}`;
  const txt = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AAO Workspace//EN", "BEGIN:VEVENT", `UID:${ev.id}@aao`, st, en, `SUMMARY:${(ev.title || "").replace(/[,;]/g, "\\$&")}`, `DESCRIPTION:${(ev.desc || "").replace(/\n/g, "\\n").replace(/[,;]/g, "\\$&")}`, "BEGIN:VALARM", "TRIGGER:-PT30M", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "END:VALARM", "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");
  return URL.createObjectURL(new Blob([txt], {type: "text/calendar"}));
}
let calShow = "all";
function drawCalendar(open){
  const y = calMonth.getFullYear(), m = calMonth.getMonth(), first = new Date(y, m, 1), startDay = first.getDay(), days = new Date(y, m + 1, 0).getDate(), todayS = dayStr(new Date());
  const cells = []; for (let i = 0; i < startDay; i++) cells.push(null); for (let d = 1; d <= days; d++) cells.push(new Date(y, m, d)); while (cells.length % 7) cells.push(null);
  const showEv = calShow !== "content", showDue = calShow === "all", showPost = calShow !== "events";
  const evOn = s => !showEv ? [] : EVENTS.filter(e => evDay(e) === s).sort((a, b) => evSortKey(a).localeCompare(evSortKey(b))), dueOn = s => !showDue ? [] : TASKS.filter(t => t.due === s && t.status !== "done");
  const postOn = s => !showPost ? [] : TASKS.filter(t => t.postDate === s);
  const upcoming = [...EVENTS.filter(e => evDay(e) >= todayS).map(e => ({id: e.id, title: e.title, day: evDay(e), time: evTime(e), key: evSortKey(e), kind: "event"})),
      ...TASKS.filter(t => t.due && t.due >= todayS && t.status !== "done").map(t => ({id: t.id, title: t.title, day: t.due, time: "", key: t.due + "T23", kind: "task"})),
      ...TASKS.filter(t => t.postDate && t.postDate >= todayS && t.status !== "done").map(t => ({id: t.id, title: t.title, day: t.postDate, time: "", key: t.postDate + "T22", kind: "post", plat: (t.platforms || []).map(platShort).join("·")}))]
    .filter(x => (x.kind === "event" && showEv) || (x.kind === "task" && showDue) || (x.kind === "post" && showPost))
    .sort((a, b) => a.key.localeCompare(b.key)).slice(0, 12);
  content.innerHTML = `<div class="ws-bar"><button class="btn ghost sm" type="button" data-cal="-1" aria-label="Previous month">←</button><strong class="cal-title">${calMonth.toLocaleDateString("en-US", {month: "long", year: "numeric"})}</strong><button class="btn ghost sm" type="button" data-cal="1" aria-label="Next month">→</button><button class="btn ghost sm" type="button" data-cal="0">Today</button><select data-cal-show aria-label="Show on calendar" style="margin-left:auto"><option value="all" ${calShow === "all" ? "selected" : ""}>Everything</option><option value="content" ${calShow === "content" ? "selected" : ""}>Content calendar</option><option value="events" ${calShow === "events" ? "selected" : ""}>Meetings &amp; events</option></select><button class="btn" type="button" data-new-event="${todayS}">+ New event</button><span class="hint" id="ws-note"></span></div>
    <div class="cal"><div class="cal-dow">${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => `<span>${d}</span>`).join("")}</div>
    <div class="cal-grid">${cells.map(d => { if (!d) return `<div class="cell empty"></div>`; const s = dayStr(d);
      return `<div class="cell${s === todayS ? " today" : ""}" data-new-event="${s}"><span class="dn">${d.getDate()}</span>
        ${evOn(s).map(e => `<button class="ev" type="button" data-event="${esc(e.id)}">${timed(e) ? esc(evTime(e)) + " " : ""}${esc(e.title)}</button>`).join("")}
        ${postOn(s).map(t => `<button class="ev post${t.status === "done" ? " posted" : ""}" type="button" data-open-task="${esc(t.id)}" title="${esc((t.platforms || []).join(", "))}">📣 ${(t.platforms || []).length ? esc(t.platforms.map(platShort).join("·")) + " " : ""}${esc(t.title)}</button>`).join("")}
        ${dueOn(s).map(t => `<button class="ev due" type="button" data-open-task="${esc(t.id)}">Due: ${esc(t.title)}</button>`).join("")}</div>`; }).join("")}</div></div>
    <p class="hint cal-key"><span class="k k-ev"></span> Events <span class="k k-post"></span> Content going out <span class="k k-due"></span> Task due</p>
    <h3 class="group-title">Coming up</h3>
    <div class="agenda">${upcoming.map(x => `<button class="ag" type="button" ${x.kind === "event" ? `data-event="${esc(x.id)}"` : `data-open-task="${esc(x.id)}"`}><span class="ag-d">${esc(fmtDay(x.day))}</span><span>${x.kind === "task" ? "Due: " : x.kind === "post" ? `📣 ${x.plat ? esc(x.plat) + " " : ""}` : ""}${esc(x.title)}${x.time ? ` <span class="hint">${esc(x.time)}</span>` : ""}</span></button>`).join("") || `<p class="hint">Nothing scheduled.</p>`}</div>
    <p class="hint">Times are shown in your time zone (${esc(tzCity(MY_TZ))}).</p>`;
  if (open && open.event) { if (EVENTS.find(e => e.id === open.event)) openEvent(open.event); else pendingEvent = open.event; }
}
function eventForm(ev = {}){
  const sMs = evStartMs(ev), eMs = evEndMs(ev);
  const vDate = sMs ? dayStr(new Date(sMs)) : (ev.date || dayStr(new Date())), vStart = sMs ? hm24(sMs) : (ev.start || "10:00"), vEnd = eMs ? hm24(eMs) : (ev.end || "11:00");
  return `<form class="ws-form" data-event-form="${esc(ev.id || "")}">
    <label class="f"><span>Title</span><input type="text" name="title" maxlength="160" required value="${esc(ev.title || "")}" placeholder="e.g. Content planning call"></label>
    <div class="grid2">
      <label class="f"><span>Date</span><input type="date" name="date" required value="${esc(vDate)}"></label>
      <label class="f check" style="align-self:end"><input type="checkbox" name="allDay" ${ev.allDay ? "checked" : ""}><span>All day</span></label>
      <label class="f"><span>Start</span><input type="time" name="start" value="${esc(vStart)}"></label>
      <label class="f"><span>End</span><input type="time" name="end" value="${esc(vEnd)}"></label>
    </div>
    <p class="hint" style="margin:0">Times are in your time zone (${esc(tzCity(MY_TZ))}). Teammates elsewhere see it in theirs.</p>
    <label class="f"><span>Details</span><textarea name="desc" maxlength="2000" placeholder="Agenda, meeting link…">${esc(ev.desc || "")}</textarea></label>
    <fieldset class="perm-box"><legend>Who's invited</legend><div class="invite-list">${members().map(id => `<label class="inv"><input type="checkbox" name="att" value="${esc(id)}" ${(ev.attendees || [uid()]).includes(id) ? "checked" : ""}>${avatar(id, 28)}<span class="inv-t"><strong>${esc(pname(id))}</strong>${person(id).name && person(id).email ? `<span class="hint">${esc(person(id).email)}</span>` : ""}</span></label>`).join("")}</div></fieldset>
    <div class="row-btns"><button class="btn" type="submit">${ev.id ? "Save event" : "Create event"}</button><button class="btn ghost" type="button" data-close-modal>Cancel</button></div></form>`;
}
function openEvent(id, justCreated){
  const ev = EVENTS.find(e => e.id === id); if (!ev) return;
  if (window.__setHash) window.__setHash(id);
  const mine = isSuper() || ev.createdBy === uid();
  modal(`${justCreated ? `<div class="notice"><strong>Event created.</strong> <span class="hint">Click "Add to Google Calendar" below so it shows on your phone.</span></div>` : ""}<p class="hint" style="margin:0">Created by ${esc(pname(ev.createdBy))}</p>
    ${mine ? eventForm(ev) : `<h3 class="group-title">${esc(ev.title)}</h3><p>${esc(fmtDay(evDay(ev)))} ${!timed(ev) ? "· all day" : `· ${esc(hm(evStartMs(ev)))}–${esc(hm(evEndMs(ev)))} <span class="hint">your time (${esc(tzCity(MY_TZ))})</span>`}</p>
      ${timed(ev) && ev.tz && ev.tz !== MY_TZ ? `<p class="hint" style="margin-top:-8px">That's ${esc(new Date(evStartMs(ev)).toLocaleTimeString("en-US", {timeZone: ev.tz, hour: "numeric", minute: "2-digit"}))} in ${esc(tzCity(ev.tz))}.</p>` : ""}<p>${esc(ev.desc || "")}</p>`}
    <div class="row-btns"><a class="btn sm" href="${esc(gcalLink(ev))}" target="_blank" rel="noopener">Add to Google Calendar</a><a class="btn ghost sm" href="${icsFile(ev)}" download="${esc((ev.title || "event").replace(/[^\w ]+/g, "")).slice(0, 40)}.ics">Download .ics</a>
      ${mine ? `<button class="btn danger sm" type="button" data-del-event="${esc(ev.id)}">Delete</button>` : ""}</div>
    <p class="hint">Adding it to Google Calendar lets your phone remind you before it starts.</p>`, true);
}
async function saveEvent(form){
  const id = form.dataset.eventForm, fd = new FormData(form);
  const data = {title: String(fd.get("title")).trim().slice(0, 160), date: fd.get("date"), allDay: !!fd.get("allDay"), start: fd.get("start") || "", end: fd.get("end") || "", desc: String(fd.get("desc") || "").slice(0, 2000), attendees: [...new Set([uid(), ...fd.getAll("att")])], updatedAt: TS()};
  if (!data.title || !data.date) return;
  data.tz = MY_TZ;
  if (!data.allDay && data.start) {
    const sMs = zonedToUtc(data.date, data.start, MY_TZ); let eMs = zonedToUtc(data.date, data.end || data.start, MY_TZ); if (eMs < sMs) eMs += 864e5;
    data.startAt = new Date(sMs).toISOString(); data.endAt = new Date(eMs).toISOString();
  } else { data.startAt = ""; data.endAt = ""; }
  try {
    let evId = id;
    if (id) await db.collection("events").doc(id).update(data);
    else evId = (await db.collection("events").add({...data, createdBy: uid(), createdAt: TS()})).id;
    data.attendees.forEach(p => notify(p, `${myLabel()} ${id ? "updated" : "invited you to"} "${data.title}" on ${fmtDay(data.date)}${data.startAt ? " at " + new Date(data.startAt).toLocaleTimeString("en-US", {timeZone: MY_TZ, hour: "numeric", minute: "2-digit", timeZoneName: "short"}) : ""}`, {tab: "ws_calendar", event: evId}));
    closeModal();
    if (id) msg("Event saved.");
    else { msg("Event created. Add it to your Google Calendar so your phone reminds you."); if (EVENTS.find(e => e.id === evId)) openEvent(evId, true); else { pendingEvent = evId; pendingEventNew = true; } }
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
<button class="btn ghost" type="button" data-new-folder>+ New folder</button>
      <span class="hint">Uploads go into <strong>${esc(target)}</strong></span><span class="hint" id="ws-note"></span></div>
    <div class="progress" id="doc-progress" hidden><i></i></div>
    <div class="chips"><button class="fchip${docFolder === "All" ? " on" : ""}" type="button" data-folder="All">All files</button>
      <button class="fchip${docFolder === "" ? " on" : ""}" type="button" data-folder="">General <span class="hint">${count("")}</span></button>
      ${FOLDERS.map(f => `<button class="fchip${f.id === docFolder ? " on" : ""}" type="button" data-folder="${esc(f.id)}">${esc(f.name)}${lock(f)} <span class="hint">${count(f.id)}</span></button>`).join("")}</div>
    ${docFolder !== "All" ? `<div class="folder-head"><span class="hint">Who can see <strong>${esc(cur ? cur.name : "General")}</strong>: ${esc(folderWho(cur))}</span>
      ${cur && ownsFolder(cur) ? `<button class="btn ghost sm" type="button" data-folder-settings="${esc(cur.id)}">Folder settings</button>` : ""}</div>` : ""}
    ${list.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>Name</th><th>Folder</th><th>Size</th><th>Added by</th><th></th></tr></thead><tbody>
      ${list.map(d => { const fid = fileFolder(d), f = folderById(fid);
        return `<tr><td><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.name)}</a></td>
        <td>${isSuper() ? `<select class="move-sel" data-move-doc="${esc(d.id)}" aria-label="Move to folder"><option value="">General</option>${FOLDERS.map(x => `<option value="${esc(x.id)}" ${x.id === fid ? "selected" : ""}>${esc(x.name)}${x.open ? "" : " (private)"}</option>`).join("")}</select>`
          : `${esc(f ? f.name : "General")}${lock(f)}`}</td><td class="num">${esc(fmtSize(d.size || 0))}</td>
        <td><span class="who-cell">${avatar(d.uploadedBy, 22)} ${esc(pname(d.uploadedBy))}</span><div class="hint">${esc(when(d.createdAt))}</div></td>
        <td>${isSuper() || d.uploadedBy === uid() ? `<button class="btn danger sm" type="button" data-del-doc="${esc(d.id)}">Delete</button>` : ""}</td></tr>`; }).join("")}</tbody></table></div>`
      : `<div class="empty">No documents here yet. Upload briefs, scripts, brand files and anything the team needs.</div>`}`;
}
/* Anyone with Documents access can make a folder and decide who sees it. Super admins can change any folder. */
const ownsFolder = f => isSuper() || f.createdBy === uid();
function folderForm(f){
  f = f || {open: true, members: []};
  const people = members().filter(id => person(id).role !== "super_admin" && docsAccess(id) && (isSuper() || id !== uid()));
  return `<form data-folder-form="${esc(f.id || "")}" style="display:grid;gap:14px">
    <h3 class="group-title" style="margin-top:0">${f.id ? "Folder settings" : "New folder"}</h3>
    <label class="f"><span>Folder name</span><input type="text" name="fname" maxlength="60" required value="${esc(f.name || "")}" placeholder="e.g. Brand assets"></label>
    <fieldset class="perm-box"><legend>Who can see it</legend>
      <label class="f check"><input type="radio" name="open" value="1" ${f.open ? "checked" : ""}><span>Everyone with Documents access</span></label>
      <label class="f check"><input type="radio" name="open" value="0" ${f.open ? "" : "checked"}><span>Only the people I choose</span></label>
      <div class="invite-list" data-folder-people ${f.open ? "hidden" : ""}>${people.length ? people.map(id => `<label class="inv"><input type="checkbox" name="mem" value="${esc(id)}" ${(f.members || []).includes(id) ? "checked" : ""}>${avatar(id, 28)}<span class="inv-t"><strong>${esc(pname(id))}</strong><span class="hint">${esc(person(id).title || person(id).email || "")}</span></span></label>`).join("")
        : `<p class="hint">No admins have Documents access yet. Give it under Users &amp; access.</p>`}</div>
      <p class="hint" style="margin:0">${isSuper() ? "" : "You'll always see folders you make. "}Super admins can always see every folder.</p></fieldset>
    <div class="row-btns"><button class="btn" type="submit">${f.id ? "Save folder" : "Create folder"}</button>
      ${f.id ? `<button class="btn danger sm" type="button" data-del-folder="${esc(f.id)}">Delete folder</button>` : ""}</div>
    <p class="hint" id="folder-msg" role="status" aria-live="polite"></p></form>`;
}
async function saveFolder(form){
  const id = form.dataset.folderForm, name = form.fname.value.trim().slice(0, 60), open = form.querySelector("[name=open]:checked").value === "1";
  const mem = open ? [] : [...form.querySelectorAll("[name=mem]:checked")].map(i => i.value);
  const owner = id ? (folderById(id) || {}).createdBy : uid();
  if (!open && owner && person(owner).role !== "super_admin" && !mem.includes(owner)) mem.push(owner);   /* the maker keeps access */
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
    return `<article class="tm">${avatar(id, 72)}<strong class="tm-name"><b>${esc(p.name || String(p.email || "").split("@")[0])}</b>${id === uid() ? `<span class="chip muted">You</span>` : ""}</strong>
      ${p.email ? `<span class="hint tm-mail" title="${esc(p.email)}">${esc(p.email)}</span>` : ""}
      <span class="tm-cat">${esc(p.title || "No category yet")}</span>
      <span class="hint">${esc(stateLabel(id))}${p.statusText && stateOf(id) !== "offline" ? " · " + esc(p.statusText) : ""}</span><span class="hint">${esc(A.ROLE_LABEL[p.role] || "")}</span>
      ${p.tz ? `<span class="hint">🕒 ${esc(new Date().toLocaleTimeString("en-US", {timeZone: p.tz, hour: "numeric", minute: "2-digit"}))} in ${esc(tzCity(p.tz))}</span>` : ""}
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
  if ((b = g("[data-chat-back]"))) { openChannel = null; if (window.__setHash) window.__setHash(null); content.querySelector(".chat").classList.remove("has-open"); drawChatList(); return; }
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
  if (e.target.matches("[data-cal-show]")) { calShow = e.target.value; drawCalendar(); return; }
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


/* ===== CORNER CHAT (bottom-right, like Facebook) ===== */
let MINI = [], miniSubs = {}, dockOpen = false, dockPick = false, pendingMini = null;
try { MINI = JSON.parse(sessionStorage.getItem("cd-wins") || "[]"); } catch { MINI = []; }
const saveMini = () => { try { sessionStorage.setItem("cd-wins", JSON.stringify(MINI)); } catch {} };
const maxWins = () => window.innerWidth < 700 ? 1 : window.innerWidth < 1100 ? 2 : 3;
function dockEl(){
  let d = $("chat-dock"); if (d) return d;
  d = document.createElement("div"); d.id = "chat-dock";
  d.innerHTML = `<div class="cd-wins" id="cd-wins"></div>
    <div class="cd-panel" id="cd-panel" hidden role="dialog" aria-label="Chats">
      <div class="cd-phead"><strong>Chats</strong><span style="display:flex;gap:6px"><button class="btn ghost sm" type="button" data-cd-new>New message</button><button class="cd-x" type="button" data-cd-toggle aria-label="Close">✕</button></span></div>
      <div class="cd-list" id="cd-list"></div>
      <button class="cd-full" type="button" data-cd-full>Open full chat page</button></div>
    <button class="cd-launch" type="button" data-cd-toggle aria-label="Chats" title="Chats"><img src="/admin/tiger-chat.svg" alt="" width="54" height="54"><span class="cd-badge" id="cd-badge" hidden></span></button>`;
  document.body.appendChild(d); return d;
}
function drawDock(){
  if (!uid() || !canWS("ws_chat")) { removeDock(); return; }
  const d = dockEl(); d.hidden = current === "ws_chat";          /* the full Chat page is already open */
  const n = unreadChannels(), b = $("cd-badge"); b.hidden = !n; b.textContent = n > 9 ? "9+" : n;
  const list = $("cd-list");
  if (list && dockOpen) list.innerHTML = CHANNELS.filter(inChat).map(c => { const unread = c.lastAt && c.lastFrom !== uid() && (!c.reads || !c.reads[uid()] || toDate(c.reads[uid()]) < toDate(c.lastAt));
    return `<button class="chat-item${unread ? " unread" : ""}" type="button" data-cd-open="${esc(c.id)}">${chAvatar(c, 36)}<span class="ci-text"><strong>${esc(chName(c))}</strong><span class="hint">${esc((c.lastFrom === uid() ? "You: " : "") + (c.lastMessage || "No messages yet"))}</span></span>${unread ? `<span class="dot"></span>` : ""}</button>`; }).join("")
    || `<p class="hint" style="padding:14px">No conversations yet. Click New message to start one.</p>`;
  if (pendingMini && CHANNELS.find(c => c.id === pendingMini)) { const id = pendingMini; pendingMini = null; openMini(id); }
  MINI = MINI.filter(w => CHANNELS.find(c => c.id === w.id) || !CHANNELS.length);
  MINI.forEach(w => miniShell(w));
  [...document.querySelectorAll(".cd-win")].forEach(el => { if (!MINI.find(w => w.id === el.dataset.win)) { closeMiniSub(el.dataset.win); el.remove(); } });
}
function removeDock(){ Object.keys(miniSubs).forEach(closeMiniSub); const d = $("chat-dock"); if (d) d.remove(); }
function closeMiniSub(id){ if (miniSubs[id]) { miniSubs[id](); delete miniSubs[id]; } }
function openMini(id){
  if (!CHANNELS.find(c => c.id === id)) { pendingMini = id; return; }
  const ex = MINI.find(w => w.id === id);
  if (ex) ex.min = false; else { MINI.unshift({id, min: false}); while (MINI.length > maxWins()) MINI.pop(); }
  dockOpen = false; $("cd-panel").hidden = true; saveMini(); drawDock();
  const el = document.querySelector(`.cd-win[data-win="${CSS.escape(id)}"] textarea`); if (el) el.focus();
}
function miniShell(w){
  const c = CHANNELS.find(x => x.id === w.id); if (!c) return;
  let el = document.querySelector(`.cd-win[data-win="${CSS.escape(w.id)}"]`);
  const box = $("cd-wins");
  if (!el) {
    el = document.createElement("section"); el.className = "cd-win"; el.dataset.win = w.id;
    el.innerHTML = `<header class="cd-whead" data-cd-min="${esc(w.id)}"><span class="cd-who"></span><span class="cd-wbtns">
        <button type="button" data-cd-expand="${esc(w.id)}" title="Open on the Chat page" aria-label="Open on the Chat page">↗</button>
        <button type="button" data-cd-min="${esc(w.id)}" title="Minimize" aria-label="Minimize">–</button>
        <button type="button" data-cd-close="${esc(w.id)}" title="Close" aria-label="Close">✕</button></span></header>
      <div class="cd-body"><div class="msgs cd-msgs"><p class="hint">Loading…</p></div>
      ${inChat(c) ? `<form class="send" data-send="${esc(w.id)}"><div class="emoji-wrap"><button class="emoji-btn" type="button" data-emoji-toggle aria-label="Add emoji" aria-expanded="false">😊</button>
        <div class="emoji-pop" hidden role="dialog" aria-label="Emoji">${EMOJI.map(([g, list]) => `<p class="hint">${g}</p><div class="emoji-grid">${[...list].filter(x => x.trim()).map(x => `<button type="button" data-emoji="${x}">${x}</button>`).join("")}</div>`).join("")}</div></div>
        <textarea name="text" maxlength="4000" placeholder="Aa" rows="1" required></textarea><button class="btn sm" type="submit" aria-label="Send">➤</button></form>`
        : `<p class="hint" style="padding:8px 10px;margin:0">View only (super admin).</p>`}</div>`;
    box.appendChild(el);
    const ta = el.querySelector("textarea");
    if (ta) ta.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ta.form.requestSubmit(); } });
    miniSubs[w.id] = db.collection("channels").doc(w.id).collection("messages").orderBy("at").limitToLast(60).onSnapshot(s => {
      const m = el.querySelector(".cd-msgs"); if (!m) return; let last = null;
      const ch = CHANNELS.find(x => x.id === w.id) || c;
      m.innerHTML = s.docs.map(d => { const x = d.data(), mine = x.from === uid(), showWho = x.from !== last; last = x.from;
        return `<div class="msg${mine ? " mine" : ""}">${!mine && showWho ? avatar(x.from, 24) : `<span style="width:24px;flex:none"></span>`}<div class="bubble">${!mine && showWho && (ch.type === "group" || !inChat(ch)) ? `<span class="who">${esc(pname(x.from))}</span>` : ""}${esc(x.text).replace(/\n/g, "<br>")}<span class="t">${esc(when(x.at))}</span></div></div>`; }).join("") || `<p class="hint">Say hello 👋</p>`;
      m.scrollTop = m.scrollHeight;
      const cur = MINI.find(z => z.id === w.id);
      if (cur && !cur.min && inChat(ch)) db.collection("channels").doc(w.id).update({["reads." + uid()]: TS()}).catch(() => {});
    }, () => {});
  }
  if (el.parentElement !== box || [...box.children].indexOf(el) !== MINI.indexOf(w)) box.insertBefore(el, box.children[MINI.indexOf(w)] || null);
  const unread = inChat(c) && c.lastAt && c.lastFrom !== uid() && (!c.reads || !c.reads[uid()] || toDate(c.reads[uid()]) < toDate(c.lastAt));
  el.classList.toggle("min", !!w.min); el.classList.toggle("unread", !!(w.min && unread));
  el.querySelector(".cd-who").innerHTML = `${chAvatar(c, 26)}<strong>${esc(chName(c))}</strong>`;
}
document.addEventListener("click", e => {
  const g = s => e.target.closest(s); let b;
  if (!g("#chat-dock") && !dockPick) return;
  if ((b = g("[data-cd-toggle]"))) { dockOpen = !dockOpen; $("cd-panel").hidden = !dockOpen; drawDock(); return; }
  if ((b = g("[data-cd-new]"))) { dockPick = true; pickPeople("New message", false); return; }
  if ((b = g("[data-cd-full]"))) { dockOpen = false; $("cd-panel").hidden = true; A.goto("ws_chat"); return; }
  if ((b = g("[data-cd-open]"))) { openMini(b.dataset.cdOpen); return; }
  if ((b = g("[data-cd-close]"))) { MINI = MINI.filter(w => w.id !== b.dataset.cdClose); saveMini(); drawDock(); return; }
  if ((b = g("[data-cd-expand]"))) { const id = b.dataset.cdExpand; MINI = MINI.filter(w => w.id !== id); saveMini(); A.goto("ws_chat", {channel: id}); return; }
  if ((b = g("[data-cd-min]")) && !g(".cd-wbtns [data-cd-expand], .cd-wbtns [data-cd-close]")) { const w = MINI.find(x => x.id === b.dataset.cdMin); if (w) { w.min = !w.min; saveMini(); drawDock(); if (!w.min) { const ta = document.querySelector(`.cd-win[data-win="${CSS.escape(w.id)}"] textarea`); if (ta) ta.focus(); } } return; }
});
window.addEventListener("resize", () => { if (MINI.length > maxWins()) { MINI = MINI.slice(0, maxWins()); saveMini(); drawDock(); } });

window.WS = {tabs: TABS, draw, start, stop, leave, badges, drawSummary, openMini: id => openMini(id)};
})();

