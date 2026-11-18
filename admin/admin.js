/* Website admin: email sign-in, content editor, photos, replies, subscribers and access control (Firebase). */
(() => {
const CFG = (window.SITE_CONFIG || {}).firebase || {};
const $ = id => document.getElementById(id);
const VIEWS = ["v-setup","v-auth","v-pending","v-app"];
const show = v => VIEWS.forEach(x => $(x).hidden = x !== v);

/* Light / dark mode switch, remembered on this device. */
function syncTheme(){
  const light = document.documentElement.dataset.theme === "light";
  document.querySelectorAll("[data-theme-toggle]").forEach(b => { b.textContent = light ? "Dark mode" : "Gold mode"; b.setAttribute("aria-pressed", String(light)); });
}
document.addEventListener("click", e => {
  if (!e.target.closest("[data-theme-toggle]")) return;
  const light = document.documentElement.dataset.theme !== "light";
  if (light) document.documentElement.dataset.theme = "light"; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem("admin-theme", light ? "light" : "dark"); } catch {}
  syncTheme();
});
syncTheme();

if (!CFG.apiKey || !CFG.projectId || !window.firebase) { show("v-setup"); return; }
firebase.initializeApp(CFG);
const auth = firebase.auth(), db = firebase.firestore();
const TS = () => firebase.firestore.FieldValue.serverTimestamp();
const MEDIA = {};

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const imgSrc = u => { u = String(u || "").trim(); if (u.startsWith("media:")) return MEDIA[u.slice(6)] || ""; return /^(https?:|\/|data:image\/)/i.test(u) || (/^[\w./-]+$/.test(u) && !u.includes("..")) ? (/^(https?:|\/|data:)/.test(u) ? u : "/" + u) : ""; };
const ROLE_LABEL = {super_admin: "Super admin", admin: "Admin", pending: "No access"};
const toDate = t => t && t.toDate ? t.toDate() : (t ? new Date(t) : null);
const fmtWhen = t => { const d = toDate(t); return !d || isNaN(d) ? "" : d.toLocaleString("en-US", {month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit"}); };

let myPhoto = "", myTitle = "";
let myEmailReq = null, myEmailOk = "";
let me = null, role = null, perms = [], myName = "", SAVED = null, S = null, dirty = false, tab = "account", saving = false;
const storage = (CFG.storageBucket && firebase.storage) ? firebase.storage() : null;

/* Sections a super admin can grant to an admin. Content keys match the website data. */
const PERM_LABELS = [["profile","Homepage intro"],["socials","Social links"],["about","About"],["building","Building"],["interests","Interests"],["gallery","Gallery"],["thoughts","Thoughts"],["quote","Quotes"],["journal","Journal"],["subscribe","Subscribe"],["sections","Show / hide"],["replies","Replies"],["subscribers","Subscribers"]];
const WS_PERMS = [["ws_tasks","Tasks"],["ws_assign","Assign tasks to others"],["ws_chat","Chat"],["ws_calendar","Calendar"],["ws_docs","Documents"],["ws_notice_post","Post notices"]];
const ALL_PERMS = [...PERM_LABELS, ...WS_PERMS];
const can = k => role === "super_admin" || k === "ws_notices" || (k === "ws_team" ? perms.some(p => p.startsWith("ws_")) : perms.includes(k));   /* everyone reads notices */
const CATEGORIES = ["Content Writer","Video Editor","Graphic Designer","Social Media Manager","Photographer","Developer","Marketing","Operations","Assistant"];

/* ---------------- auth ---------------- */
let mode = "signin";
function setMode(m){
  mode = m;
  $("auth-title").textContent = {signin:"Sign in", signup:"Request access", reset:"Reset password"}[m];
  $("auth-sub").textContent = {signin:"Admin access for the website.", signup:"Create an account with your email. A super admin approves new accounts before they can edit.", reset:"We'll email you a link to choose a new password."}[m];
  $("auth-btn").textContent = {signin:"Sign in", signup:"Create account", reset:"Send reset link"}[m];
  $("a-pass-wrap").hidden = m === "reset";
  $("a-pass").autocomplete = m === "signup" ? "new-password" : "current-password";
  $("to-signup").hidden = m !== "signin"; $("to-reset").hidden = m !== "signin"; $("to-signin").hidden = m === "signin";
  $("auth-msg").textContent = ""; $("auth-msg").className = "hint";
}
document.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
const authMsg = (t, cls = "hint") => { $("auth-msg").textContent = t; $("auth-msg").className = cls; };
const AUTH_ERRORS = {
  "auth/invalid-credential": "That email and password don't match.",
  "auth/wrong-password": "That email and password don't match.",
  "auth/user-not-found": "That email and password don't match.",
  "auth/invalid-login-credentials": "That email and password don't match.",
  "auth/email-already-in-use": "That email already has an account. Sign in instead.",
  "auth/weak-password": "Choose a stronger password (at least 8 characters).",
  "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
  "auth/operation-not-allowed": "Email sign-in isn't turned on yet in Firebase (Authentication → Email/Password).",
  "auth/network-request-failed": "No connection. Check your internet and try again."
};

$("auth-form").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("a-email").value.trim(), password = $("a-pass").value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return authMsg("Enter a valid email address.", "hint err");
  if (mode !== "reset" && password.length < 8) return authMsg("Passwords need at least 8 characters.", "hint err");
  const btn = $("auth-btn"); btn.disabled = true; authMsg("One moment…");
  try {
    if (mode === "signin") await auth.signInWithEmailAndPassword(email, password);
    else if (mode === "signup") await auth.createUserWithEmailAndPassword(email, password);
    else { await auth.sendPasswordResetEmail(email); authMsg("If that email has an account, a reset link is on its way. Check your inbox and spam folder.", "hint okc"); }
  } catch (err) {
    authMsg(AUTH_ERRORS[err && err.code] || "Something went wrong. Please try again.", "hint err");
  } finally { btn.disabled = false; }
});

document.querySelectorAll("[data-signout]").forEach(b => b.addEventListener("click", async () => {
  if (dirty && !confirmLeave()) return;
  dirty = false; try { history.replaceState(null, "", location.pathname); } catch {}   /* next sign-in starts on My overview */
  await auth.signOut();
}));
$("pending-refresh").addEventListener("click", () => boot(auth.currentUser));

/* Make sure every signed-in person has a users/{uid} record. The very first one becomes super admin. */
async function ensureProfile(user){
  const ref = db.collection("users").doc(user.uid);
  const snap = await ref.get();
  if (snap.exists) {
    const d = snap.data();
    if (user.email && d.email && d.email.toLowerCase() !== user.email.toLowerCase()) {
      /* their sign-in email changed: accept it only if a super admin approved that address */
      if ((d.emailApproved || "").toLowerCase() === user.email.toLowerCase()) {
        try { await ref.update({email: user.email}); d.email = user.email; } catch {}
      } else d.__unapprovedEmail = true;
    }
    return d;
  }
  const boot = await db.doc("meta/bootstrap").get();
  if (!boot.exists) {
    try {
      const batch = db.batch();
      batch.set(ref, {email: user.email, role: "super_admin", createdAt: TS()});
      batch.set(db.doc("meta/bootstrap"), {uid: user.uid, createdAt: TS()});
      await batch.commit();
      return {email: user.email, role: "super_admin"};
    } catch { /* someone else became super admin first */ }
  }
  await ref.set({email: user.email, role: "pending", createdAt: TS()});
  return {email: user.email, role: "pending"};
}

async function seedContent(){
  /* First run: copy the starting content from the website into the database. */
  const html = await (await fetch("/", {cache: "no-store"})).text();
  const m = html.match(/<script type="application\/json" id="site-data">([\s\S]*?)<\/script>/);
  if (!m) return null;
  const data = JSON.parse(m[1]);
  await db.doc("site/content").set({data, updatedAt: TS(), updatedBy: me.uid});
  return data;
}

async function loadMedia(obj){
  const ids = [...new Set((JSON.stringify(obj).match(/"media:[\w-]+"/g) || []).map(m => m.slice(7, -1)))].filter(id => !(id in MEDIA));
  await Promise.all(ids.map(id => db.collection("media").doc(id).get().then(d => { MEDIA[id] = d.exists ? d.data().data : ""; }).catch(() => {})));
}

async function boot(user){
  if (!user) { me = null; role = null; setMode("signin"); show("v-auth"); return; }
  me = user;
  let prof;
  try { prof = await ensureProfile(user); }
  catch { authMsg("Couldn't load your account. Make sure the Firestore rules have been published.", "hint err"); show("v-auth"); return; }
  role = prof.role; perms = Array.isArray(prof.perms) ? prof.perms : []; myName = prof.name || ""; myPhoto = prof.photo || ""; myTitle = prof.title || "";
  if (role !== "admin" && role !== "super_admin") { $("pending-email").textContent = user.email; show("v-pending"); return; }
  if (prof.__unapprovedEmail) {             /* email was changed without a super admin's approval */
    $("pending-email").textContent = `${user.email} (this email change hasn't been approved; ask a super admin to approve it, or sign in with ${prof.email})`;
    show("v-pending"); return;
  }
  myEmailReq = prof.emailRequest || null; myEmailOk = prof.emailApproved || "";
  let snap, data;
  try { snap = await db.doc("site/content").get(); data = snap.exists ? snap.data().data : await seedContent(); }
  catch { data = null; }
  paintMe(); $("me-role").textContent = ROLE_LABEL[role] + (myTitle ? " · " + myTitle : "");
  show("v-app");
  if (!data) { $("savebar").hidden = true; $("content").innerHTML = `<div class="notice">The website content couldn't be loaded. Check that Firestore is set up and the rules are published, then reload.</div>`; return; }
  await loadMedia(data);
  SAVED = data; S = structuredClone(SAVED); dirty = false;
  /* Stay on the same page after a refresh (the page is kept in the address, e.g. #/ws_tasks/abc123).
     A fresh sign-in with no page in the address starts on My overview. */
  const [hTab, hItem] = decodeURIComponent(location.hash.replace(/^#\/?/, "")).split("/");
  tab = hTab && (hTab in CONTENT_TABS || hTab in OTHER_TABS || (window.WS && WS.tabs[hTab])) ? hTab : "account";
  if (hItem) window.__WS_OPEN = tab === "ws_tasks" ? {id: hItem} : tab === "ws_chat" ? {channel: hItem} : tab === "ws_calendar" ? {event: hItem} : null;
  if (window.WS) WS.start();
  drawNav(); draw();
  const when = snap && snap.exists ? snap.data().updatedAt : null;
  setStatus(when ? `Last published ${fmtWhen(when)}.` : "All changes saved.");
  if (role === "super_admin") { refreshPendingCount(); watchApprovals(); }
}
/* Doorway for workspace.js */
window.__ADMIN = {
  db, auth, storage, TS, esc, imgSrc, MEDIA, loadMedia, compress, fmtWhen, toDate, ROLE_LABEL, CATEGORIES,
  setStatus: (t, c) => setStatus(t, c),
  get me() { return me; }, get role() { return role; }, get perms() { return perms; }, get myName() { return myName; },
  can: k => can(k),
  goto: (t, open) => { tab = t; window.__WS_OPEN = open || null; drawNav(); draw(); window.scrollTo(0, 0); },
  redrawNav: () => drawNav()
};
auth.onAuthStateChanged(user => { if (!user && window.WS) WS.stop(); boot(user); });

/* ---------------- editor helpers ---------------- */
const get = path => path.reduce((o,k) => o?.[k], S);
const set = (path, v) => { let o = S; for (const k of path.slice(0,-1)) { if (o[k] == null) o[k] = typeof k === "number" ? [] : {}; o = o[k]; } o[path[path.length-1]] = v; };
const getArr = path => { let a = get(path); if (!Array.isArray(a)) { a = []; set(path, a); } return a; };
const P = p => esc(JSON.stringify(p));
function setStatus(t, cls = ""){ $("status").textContent = t; $("status").className = "status " + cls; }
function markDirty(){ dirty = true; setStatus("Unsaved changes. Click Save & publish to put them on the website."); }
const confirmLeave = () => confirm("You have unsaved changes. Leave without saving?");

const fText = (label, path, o = {}) => {
  const v = get(path) ?? "";
  return o.area
    ? `<label class="f"><span>${label}</span><textarea class="${o.tall?"tall":""}" data-path="${P(path)}" placeholder="${esc(o.ph||"")}">${esc(v)}</textarea></label>`
    : `<label class="f"><span>${label}</span><input type="${o.type||"text"}" data-path="${P(path)}" value="${esc(v)}" placeholder="${esc(o.ph||"")}"></label>`;
};
const fCheck = (label, path) => `<label class="f check"><input type="checkbox" data-path="${P(path)}" ${get(path)?"checked":""}><span>${label}</span></label>`;
const fSelect = (label, path, opts) => `<label class="f"><span>${label}</span><select data-path="${P(path)}">${opts.map(([v,l]) => `<option value="${esc(v)}" ${get(path)===v?"selected":""}>${esc(l)}</option>`).join("")}</select></label>`;
const fImage = (label, path) => { const src = imgSrc(get(path)); return `<div class="f"><span>${label}</span><div class="img-row">${src ? `<img src="${esc(src)}" alt="">` : ""}<div style="display:grid;gap:8px;flex:1">
  <input type="file" accept="image/*" data-upload="${P(path)}" aria-label="Upload ${esc(label)}">${src ? `<button class="btn ghost sm" type="button" data-clear="${P(path)}" style="justify-self:start">Remove photo</button>` : ""}</div></div></div>`; };

const vidSrc = u => { u = String(u || "").trim(); return /^https:\/\//i.test(u) ? u : ""; };
/* Each video field also keeps a cover photo and a clip (start/end, in seconds) beside it:
   e.g. "video" -> "videoPoster", "videoStart", "videoEnd" on the same item. */
const sib = (path, suffix) => [...path.slice(0, -1), path[path.length - 1] + suffix];
const LOCAL_VID = {};   /* videos uploaded in this visit: their local copy, so any frame can become the cover */
const fmtSec = s => { s = Math.max(0, +s || 0); const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`; };
const fVideo = (label, path) => {
  const src = vidSrc(get(path)), poster = imgSrc(get(sib(path, "Poster")));
  const st = +get(sib(path, "Start")) || 0, en = +get(sib(path, "End")) || 0;
  const upload = storage ? `<input type="file" accept="video/mp4,video/quicktime,video/webm" data-upload-video="${P(path)}" aria-label="Upload ${esc(label)}">` : `<p class="hint">Video uploads need Firebase Storage turned on.</p>`;
  if (!src) return `<div class="f"><span>${label}</span><div style="display:grid;gap:8px">${upload}<div class="progress" data-progress="${P(path)}" hidden><i></i></div></div>
    <p class="hint">MP4 or MOV, up to 200 MB. After uploading you can choose the clip and the cover.</p></div>`;
  return `<div class="f"><span>${label}</span>
  <div class="vid-editor" data-vid-editor="${P(path)}">
    <video src="${esc(LOCAL_VID[src] || src)}" ${poster ? `poster="${esc(poster)}"` : ""} controls playsinline preload="metadata" data-vid-for="${P(path)}"></video>
    <div class="vid-side">
      <div class="vid-group"><strong>Clip</strong> <span class="hint">Only this part plays on the website.</span>
        <label class="rng">Start <input type="range" min="0" max="0" step="0.1" value="${st}" data-clip="Start" data-path-base="${P(path)}"> <output>${fmtSec(st)}</output></label>
        <label class="rng">End <input type="range" min="0" max="0" step="0.1" value="${en}" data-clip="End" data-path-base="${P(path)}"> <output>${en ? fmtSec(en) : "Full"}</output></label>
        <div class="row-btns"><button class="btn ghost sm" type="button" data-play-clip="${P(path)}">Play clip</button><button class="btn ghost sm" type="button" data-reset-clip="${P(path)}">Use whole video</button></div>
      </div>
      <div class="vid-group"><strong>Cover</strong> <span class="hint">Shown before the video plays.</span>
        <div class="img-row">${poster ? `<img src="${esc(poster)}" alt="Current cover">` : `<span class="hint">No cover yet.</span>`}
          <div style="display:grid;gap:6px">
            <button class="btn ghost sm" type="button" data-grab-frame="${P(path)}">Use this frame as cover</button>
            <label class="btn ghost sm" style="cursor:pointer">Upload a cover photo<input type="file" accept="image/*" data-upload="${P(sib(path, "Poster"))}" hidden></label>
            ${poster ? `<button class="btn ghost sm" type="button" data-clear="${P(sib(path, "Poster"))}">Remove cover</button>` : ""}
          </div></div>
        <p class="hint">Pause the video on the moment you like, then click "Use this frame as cover".</p>
      </div>
      <div class="row-btns">${storage ? `<label class="btn ghost sm" style="cursor:pointer">Replace video<input type="file" accept="video/mp4,video/quicktime,video/webm" data-upload-video="${P(path)}" hidden></label>` : ""}
        <button class="btn danger sm" type="button" data-clear-video="${P(path)}">Remove video</button></div>
      <div class="progress" data-progress="${P(path)}" hidden><i></i></div>
    </div>
  </div></div>`; };

/* After a tab is drawn: give the clip sliders the video's length. */
function hydrateVideos(){
  content.querySelectorAll("video[data-vid-for]").forEach(v => {
    const ed = v.closest("[data-vid-editor]");
    const setup = () => {
      const d = Math.floor((v.duration || 0) * 10) / 10; if (!d || !isFinite(d)) return;
      const base = JSON.parse(v.dataset.vidFor);
      const st = Math.min(+get(sib(base, "Start")) || 0, d), en = Math.min(+get(sib(base, "End")) || d, d);
      ed.querySelectorAll("input[data-clip]").forEach(r => {
        r.max = d; r.value = r.dataset.clip === "Start" ? st : en;
        r.nextElementSibling.textContent = r.dataset.clip === "End" && en >= d ? "Full" : fmtSec(r.value);
      });
      if (st) v.currentTime = st;
    };
    v.readyState >= 1 ? setup() : v.addEventListener("loadedmetadata", setup, {once: true});
  });
}

function list(path, title, fields, blank, addLabel, top){
  const a = getArr(path);
  const addBtn = `<button class="add" type="button" data-op="add" data-list="${P(path)}" data-blank="${P(blank)}"${top ? ' data-top="1"' : ""}>+ ${addLabel}</button>`;
  return (top ? addBtn : "") + a.map((it,i) => `<div class="item"><div class="item-head"><strong>${esc(title(it || {}) || "Untitled")}</strong>
    <button class="icon-btn" type="button" aria-label="Move up" title="Move up" data-op="up" data-list="${P(path)}" data-i="${i}">↑</button>
    <button class="icon-btn" type="button" aria-label="Move down" title="Move down" data-op="down" data-list="${P(path)}" data-i="${i}">↓</button>
    <button class="icon-btn del" type="button" aria-label="Remove" title="Remove" data-op="del" data-list="${P(path)}" data-i="${i}">✕</button></div>
    ${fields(i)}</div>`).join("") + (top ? "" : addBtn);
}
const PLATFORMS = [["instagram","Instagram"],["tiktok","TikTok"],["x","X"],["linkedin","LinkedIn"],["youtube","YouTube"],["facebook","Facebook"],["threads","Threads"],["website","Website"]];
/* Post to X: opens X with the text and a link back to the site. A link counts as 23 characters on X. */
const X_LINK = () => location.origin + "/#thoughts";
const xCount = txt => { const n = String(txt || "").trim().length + 24; return n <= 280 ? `${280 - n} characters left on X` : `${n - 280} characters too long for X; it will be shortened`; };
function xText(txt){ txt = String(txt || "").trim(); const room = 280 - 24; return txt.length > room ? txt.slice(0, room - 1).trimEnd() + "…" : txt; }
const today = () => new Date().toISOString().slice(0,10);

/* ---------------- tabs ---------------- */
const CONTENT_TABS = {
  profile: ["Homepage intro", () => `
    ${fText("Name", ["profile","name"])}
    <p class="hint">Wrap a word in *asterisks* to make it gold, like Angela Agunwami *Onwuka*. Works in project names too.</p>
    ${fText("Small line above your name", ["profile","kicker"])}
    ${fText("Tagline", ["profile","tagline"], {area:true})}
    ${fImage("Main photo", ["profile","photo"])}
    ${fVideo("Main video (optional, plays silently in your photo frame; the photo shows while it loads)", ["profile","video"])}
    ${fText("Photo description (for screen readers)", ["profile","photoAlt"])}`],
  socials: ["Social links", () => list(["socials"], s => `${(PLATFORMS.find(p => p[0]===s.platform)||[,"Link"])[1]} ${s.handle||""}`, i => `
    ${fSelect("Platform", ["socials",i,"platform"], PLATFORMS)}
    ${fText("Handle", ["socials",i,"handle"], {ph:"@agunwamiii"})}
    ${fText("Link", ["socials",i,"url"], {type:"url", ph:"https://"})}`, {platform:"instagram",handle:"",url:""}, "Add social link")],
  about: ["About", () => `
    ${fText("Heading", ["about","heading"])}
    ${fText("Opening line (large text)", ["about","lead"], {area:true})}
    <h3 class="group-title">Paragraphs</h3>
    ${list(["about","paragraphs"], p => String(p).slice(0,48), i => fText("Text", ["about","paragraphs",i], {area:true}), "", "Add paragraph")}
    <h3 class="group-title">Quick facts</h3>
    ${list(["about","facts"], f => f.label, i => fText("Label", ["about","facts",i,"label"]) + fText("Value", ["about","facts",i,"value"]), {label:"",value:""}, "Add fact")}
    <h3 class="group-title">Photo (optional)</h3>
    ${fImage("About photo", ["about","photo"])}
    ${fText("Photo description", ["about","photoAlt"])}`],
  building: ["Building", () => `
    ${fText("Heading", ["building","heading"])}
    ${list(["building","items"], v => String(v.name||"").replace(/\*/g,""), i => `
      ${fText("Name", ["building","items",i,"name"])}
      ${fText("Status line", ["building","items",i,"status"], {ph:"In development"})}
      ${fText("Description", ["building","items",i,"description"], {area:true})}
      ${fText("Link (optional)", ["building","items",i,"link"], {type:"url"})}
      ${fCheck("Feature this one (full-width card)", ["building","items",i,"featured"])}
      ${get(["building","items",i,"featured"]) ? fText("Button text (optional)", ["building","items",i,"ctaText"], {ph:"Start a project"}) : ""}`,
      {name:"",status:"",description:"",link:"",ctaText:"",featured:false}, "Add project")}`],
  interests: ["Interests", () => `
    ${fText("Heading", ["interests","heading"])}
    ${list(["interests","items"], x => x.title, i => fText("Title", ["interests","items",i,"title"]) + fText("Text", ["interests","items",i,"text"], {area:true}), {title:"",text:""}, "Add interest")}`],
  gallery: ["Gallery", () => `
    ${fText("Heading", ["gallery","heading"])}
    <p class="hint">Each item can be a photo, a video, or both (the photo becomes the video's cover).</p>
    ${list(["gallery","items"], g => g.caption || (g.video ? "Video" : "Photo"), i => fImage("Photo", ["gallery","items",i,"src"]) + fVideo("Video (optional)", ["gallery","items",i,"video"]) + fText("Caption (optional)", ["gallery","items",i,"caption"]), {src:"",video:"",caption:""}, "Add photo or video", true)}`],
  thoughts: ["Thoughts", () => `
    ${fText("Heading", ["thoughts","heading"])}
    <p class="hint">Short posts, like tweets. Newest shows first. Click "Post to X" to share a post on X, then paste its link below so visitors see a "Reply on X" button. Replies on the site show under Replies.</p>
    ${list(["thoughts","items"], t => String(t.text||"").slice(0,48), i => `
      ${fText("Post", ["thoughts","items",i,"text"], {area:true})}
      <div class="row-btns" style="align-items:center"><button class="btn sm" type="button" data-post-x="${i}">Post to X</button><span class="hint" data-x-count="${i}">${xCount(get(["thoughts","items",i,"text"]))}</span></div>
      ${fVideo("Video (optional)", ["thoughts","items",i,"video"])}
      ${fText("Date", ["thoughts","items",i,"date"], {type:"date"})}
      ${fText("Link to this post on X (optional)", ["thoughts","items",i,"xUrl"], {type:"url", ph:"https://x.com/agunwamiii/status/…"})}`,
      {id:"",text:"",date:"",xUrl:"",video:""}, "Add thought", true)}`],
  quote: ["Quotes", () => {
    if (!S.quote || typeof S.quote !== "object") S.quote = {label: "This week"};
    if (!Array.isArray(S.quote.items)) S.quote.items = S.quote.text ? [{text: S.quote.text, by: S.quote.by || "", date: ""}] : [];
    return `
    ${fText("Label above the quote", ["quote","label"], {ph:"This week"})}
    <p class="hint">The quote at the top of the list is the one shown on the website. New quotes are added to the top, and older ones stay here as your archive. Use the arrows to bring an older one back.</p>
    ${list(["quote","items"], q => String(q.text || "New quote").slice(0,48), i => `
      ${fText("Quote", ["quote","items",i,"text"], {area:true})}
      ${fText("Signed", ["quote","items",i,"by"], {ph:"Angela"})}
      ${fText("Date", ["quote","items",i,"date"], {type:"date"})}`,
      {text:"",by:"Angela",date:""}, "Add quote", true)}`; }],
  journal: ["Journal", () => {
    if (!S.journal || typeof S.journal !== "object") S.journal = {heading: "", posts: []};
    if (!Array.isArray(S.journal.categories)) S.journal.categories = ["Life", "Building", "Tech"];
    const cats = S.journal.categories.map(c => String(c || "").trim()).filter(Boolean);
    const catOpts = i => { const cur = get(["journal","posts",i,"category"]) || ""; const list = cur && !cats.includes(cur) ? [...cats, cur] : cats; return [["", "No category"], ...list.map(c => [c, c])]; };
    return `
    ${fText("Heading", ["journal","heading"])}
    <h3 class="group-title">Categories</h3>
    <p class="hint">Add, rename or remove the categories you can pick for each post.</p>
    ${list(["journal","categories"], c => String(c || "New category"), i => fText("Category name", ["journal","categories",i], {ph:"e.g. Faith, Travel, Career"}), "", "Add category")}
    <h3 class="group-title">Posts</h3>
    <p class="hint">Published posts get a "Read post" link. Coming soon shows a teaser. Drafts are hidden from visitors.</p>
    ${list(["journal","posts"], p => `${p.title || "Untitled"} (${({published:"published",soon:"coming soon",draft:"draft"})[p.status] || "draft"})`, i => `
      ${fText("Title", ["journal","posts",i,"title"])}
      ${fSelect("Status", ["journal","posts",i,"status"], [["published","Published"],["soon","Coming soon"],["draft","Draft (hidden)"]])}
      ${fSelect("Category", ["journal","posts",i,"category"], catOpts(i))}
      ${fText("Date", ["journal","posts",i,"date"], {type:"date"})}
      ${fText("Short summary", ["journal","posts",i,"excerpt"], {area:true})}
      ${fText("Full post (leave a blank line between paragraphs)", ["journal","posts",i,"body"], {area:true, tall:true})}`,
      {title:"New post",category:cats[0] || "",date:"",status:"draft",excerpt:"",body:""}, "Add post", true)}`; }],
  subscribe: ["Subscribe", () => `
    ${fText("Heading", ["subscribe","heading"])}
    ${fText("Text", ["subscribe","text"], {area:true})}
    ${fText("Daily option note", ["subscribe","dailyNote"])}
    ${fText("Weekly option note", ["subscribe","weeklyNote"])}
    ${fText("Outside newsletter signup URL (optional)", ["subscribe","url"], {type:"url"})}
    <p class="hint">Leave the URL empty to collect subscribers here, under Subscribers. Fill it only if you move to a service like Beehiiv or Kit.</p>`],
  sections: ["Show / hide", () => `<p class="hint">Turn whole sections of the website on or off.</p>
    ${[["about","About"],["building","Building"],["interests","Interests"],["gallery","Gallery"],["thoughts","Thoughts"],["quote","Quote"],["journal","Journal"],["subscribe","Subscribe"]].map(([k,l]) => fCheck(l, ["sections",k])).join("")}`]
};
const OTHER_TABS = {
  replies: "Replies", subscribers: "Subscribers", users: "Users & access", account: "My overview"
};

function drawNav(){
  const c = Object.entries(CONTENT_TABS).filter(([k]) => can(k)).map(([k,[l]]) => btn(k,l)).join("");
  const a = (can("replies") ? btn("replies", "Replies") : "") + (can("subscribers") ? btn("subscribers", "Subscribers") : "");
  const s = role === "super_admin" ? btn("users", `Users &amp; access <span id="pending-badge"></span>`) : "";
  const w = window.WS ? Object.entries(WS.tabs).filter(([k]) => can(k)).map(([k, l]) => btn(k, `${l} <span class="nav-badge" data-badge="${k}"></span>`)).join("") : "";
  $("tabs").innerHTML = btn("account", "My overview") + group("Workspace", w) + group("Website", c) + group("Audience", a) + group("Access", s);
  if (window.WS) WS.badges();
  function group(name, items){
    if (!items) return "";
    let shut = false; try { shut = localStorage.getItem("nav-shut-" + name) === "1"; } catch {}
    if (items.includes('aria-current="page"')) shut = false;       /* never hide the page you're on */
    return `<button type="button" class="grp grp-btn" data-grp="${name}" aria-expanded="${!shut}"><span>${name}</span><span class="caret" aria-hidden="true">▾</span></button><div class="grp-items"${shut ? " hidden" : ""}>${items}</div>`;
  }
  function btn(k,l){ return `<button type="button" data-tab="${k}" ${k===tab?'aria-current="page"':""}>${l}</button>`; }
}
$("tabs").addEventListener("click", e => {
  const g = e.target.closest("[data-grp]");
  if (g) { const box = g.nextElementSibling, open = box.hidden; box.hidden = !open; g.setAttribute("aria-expanded", String(open));
    try { localStorage.setItem("nav-shut-" + g.dataset.grp, open ? "0" : "1"); } catch {} return; }
  const b = e.target.closest("[data-tab]"); if (!b) return;
  tab = b.dataset.tab; usersNote = null; drawNav(); draw(); window.scrollTo(0,0); $("side").classList.remove("open");
});
$("menu-btn").addEventListener("click", () => $("side").classList.toggle("open"));

function setHash(t, item){ try { history.replaceState(null, "", "#/" + t + (item ? "/" + encodeURIComponent(item) : "")); } catch {} }
window.__setHash = item => setHash(tab, item);
function draw(){
  if (window.WS) WS.leave();
  if (tab !== "account" && tab !== "users" && !can(tab)) tab = "account";
  if (tab === "users" && role !== "super_admin") tab = "account";
  setHash(tab, window.__WS_OPEN && (window.__WS_OPEN.id || window.__WS_OPEN.channel || window.__WS_OPEN.event));
  if (window.WS && WS.tabs[tab]) { $("savebar").hidden = true; $("tab-title").textContent = WS.tabs[tab]; WS.draw(tab); return; }
  if (tab === "users" && role !== "super_admin") tab = "account";
  const isContent = tab in CONTENT_TABS;
  $("savebar").hidden = !isContent;
  $("tab-title").textContent = isContent ? CONTENT_TABS[tab][0] : OTHER_TABS[tab];
  if (isContent) { $("content").innerHTML = CONTENT_TABS[tab][1](); hydrateVideos(); return; }
  $("content").innerHTML = `<p class="hint">Loading…</p>`;
  ({replies: drawReplies, subscribers: drawSubscribers, users: drawUsers, account: drawAccount})[tab]();
}

/* ---------------- content editing ---------------- */
const content = $("content");
content.addEventListener("input", e => {
  const el = e.target; if (!el.dataset.path) return;
  const pth = JSON.parse(el.dataset.path);
  if (pth[0] === "thoughts" && pth[3] === "text") { const c = content.querySelector(`[data-x-count="${pth[2]}"]`); if (c) c.textContent = xCount(el.value); }
  set(JSON.parse(el.dataset.path), el.type === "checkbox" ? el.checked : el.value);
  markDirty();
});
content.addEventListener("change", e => {
  const el = e.target;
  if (el.dataset.path && (el.tagName === "SELECT" || el.type === "checkbox" || el.dataset.path.includes('"categories"'))) draw();
  if (el.dataset.upload && el.files[0]) upload(JSON.parse(el.dataset.upload), el.files[0], el);
  if (el.dataset.uploadVideo && el.files[0]) uploadVideo(JSON.parse(el.dataset.uploadVideo), el.files[0], el);
});
content.addEventListener("click", e => {
  const c = e.target.closest("[data-clear]");
  if (c) { set(JSON.parse(c.dataset.clear), ""); markDirty(); draw(); return; }
  const b = e.target.closest("[data-op]"); if (!b) return;
  const a = getArr(JSON.parse(b.dataset.list)), i = +b.dataset.i;
  if (b.dataset.op === "add") {
    const it = structuredClone(JSON.parse(b.dataset.blank));
    if (it && typeof it === "object") { if ("id" in it && !it.id) it.id = "t" + Date.now().toString(36); if ("date" in it && !it.date) it.date = today(); }
    if (b.dataset.top) a.unshift(it); else a.push(it);
  }
  if (b.dataset.op === "del") {
    if (!b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = "Remove?"; return; }
    a.splice(i,1);
  }
  if (b.dataset.op === "up" && i > 0) [a[i-1],a[i]] = [a[i],a[i-1]];
  if (b.dataset.op === "down" && i < a.length-1) [a[i+1],a[i]] = [a[i],a[i+1]];
  markDirty(); draw();
});

/* Photos are shrunk in the browser and stored in the database (no paid storage plan needed). */
async function compress(file){
  const bmp = await createImageBitmap(file);
  let max = 1600, q = 0.85, out = "";
  for (let tries = 0; tries < 8; tries++) {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    out = c.toDataURL("image/webp", q);
    if (!out.startsWith("data:image/webp")) out = c.toDataURL("image/jpeg", q);
    if (out.length < 900000) return out;
    if (q > 0.6) q -= 0.1; else max = Math.round(max * 0.8);
  }
  throw new Error("too-large");
}
async function upload(path, file, input){
  if (!/^image\//.test(file.type)) { setStatus("Choose an image file (JPG, PNG or WebP).", "err"); return; }
  input.disabled = true; setStatus("Preparing photo…");
  try {
    const data = await compress(file);
    setStatus("Uploading photo…");
    const ref = await db.collection("media").add({data, name: file.name.slice(0,120), createdAt: TS()});
    MEDIA[ref.id] = data;
    set(path, "media:" + ref.id);
    markDirty(); draw(); setStatus("Photo uploaded. Click Save & publish to put it on the website.");
  } catch {
    input.disabled = false;
    setStatus("The photo didn't upload. Try a different photo.", "err");
  }
}

/* Videos go to Firebase Storage (needs the Blaze plan). */
async function uploadVideo(path, file, input){
  if (!storage) { setStatus("Video uploads need Firebase Storage turned on.", "err"); return; }
  if (!/^video\//.test(file.type)) { setStatus("Choose a video file (MP4 or MOV).", "err"); input.value = ""; return; }
  if (file.size > 200 * 1024 * 1024) { setStatus("That video is over 200 MB. Trim it or export a smaller version.", "err"); input.value = ""; return; }
  const bar = content.querySelector(`[data-progress='${JSON.stringify(path)}']`);
  const ext = (file.name.split(".").pop() || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp4";
  const ref = storage.ref(`media/videos/${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`);
  input.disabled = true; if (bar) bar.hidden = false; setStatus("Uploading video… 0%");
  try {
    const task = ref.put(file, {contentType: file.type, cacheControl: "public,max-age=31536000"});
    task.on("state_changed", s => { const pct = Math.round(s.bytesTransferred / s.totalBytes * 100); setStatus(`Uploading video… ${pct}%`); if (bar) bar.firstElementChild.style.width = pct + "%"; });
    await task;
    const url = await ref.getDownloadURL();
    set(path, url); set(sib(path, "Start"), 0); set(sib(path, "End"), 0);
    LOCAL_VID[url] = URL.createObjectURL(file);
    try { const cover = await frameFromVideo(LOCAL_VID[url], 1); await saveCover(path, cover); } catch {}
    markDirty(); draw(); setStatus("Video uploaded with a cover from its first second. Adjust the clip or cover, then click Save & publish.");
  } catch (err) {
    input.disabled = false; if (bar) bar.hidden = true;
    const c = err && err.code || "";
    setStatus(c === "storage/unauthorized" ? "You don't have permission to upload videos, or the storage rules aren't published yet." :
              c === "storage/canceled" ? "Upload cancelled." :
              /bucket|project-not-found|unknown/.test(c) ? "Video storage isn't set up yet in Firebase (Storage)." :
              "The video didn't upload. Check your connection and try again.", "err");
  }
}

/* Grab one frame from a video as a compressed image (works for videos uploaded in this visit). */
function frameFromVideo(src, time){
  return new Promise((resolve, reject) => {
    const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.preload = "auto";
    if (!src.startsWith("blob:")) v.crossOrigin = "anonymous";
    const fail = () => reject(new Error("frame")); const timer = setTimeout(fail, 15000);
    v.addEventListener("error", () => { clearTimeout(timer); fail(); }, {once: true});
    v.addEventListener("loadedmetadata", () => { v.currentTime = Math.min(Math.max(time, 0), Math.max((v.duration || 1) - 0.1, 0)); }, {once: true});
    v.addEventListener("seeked", () => {
      try {
        const max = 1600, sc = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight));
        const c = document.createElement("canvas"); c.width = Math.round(v.videoWidth * sc); c.height = Math.round(v.videoHeight * sc);
        c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
        let out = c.toDataURL("image/webp", 0.82); if (!out.startsWith("data:image/webp")) out = c.toDataURL("image/jpeg", 0.82);
        clearTimeout(timer); resolve(out);
      } catch { clearTimeout(timer); fail(); }
    }, {once: true});
    v.src = src;
  });
}
async function saveCover(path, data){
  const ref = await db.collection("media").add({data, name: "video-cover", createdAt: TS()});
  MEDIA[ref.id] = data; set(sib(path, "Poster"), "media:" + ref.id);
}
content.addEventListener("input", e => {
  const r = e.target.closest("input[data-clip]"); if (!r) return;
  const base = JSON.parse(r.dataset.pathBase), ed = r.closest("[data-vid-editor]");
  const [s, en] = ["Start", "End"].map(k => ed.querySelector(`input[data-clip="${k}"]`));
  if (+s.value > +en.value - 0.5) { if (r === s) s.value = Math.max(0, +en.value - 0.5); else en.value = Math.min(+en.max, +s.value + 0.5); }
  const full = +en.value >= +en.max;
  set(sib(base, "Start"), +s.value); set(sib(base, "End"), full ? 0 : +en.value);
  s.nextElementSibling.textContent = fmtSec(s.value); en.nextElementSibling.textContent = full ? "Full" : fmtSec(en.value);
  const v = ed.querySelector("video"); v.pause(); v.currentTime = +r.value;
  markDirty();
});
content.addEventListener("click", e => {
  const b = e.target.closest("[data-post-x]"); if (!b) return;
  const t = get(["thoughts","items",+b.dataset.postX]) || {};
  if (!String(t.text || "").trim()) { setStatus("Write the post first, then click Post to X.", "err"); return; }
  const url = "https://x.com/intent/tweet?text=" + encodeURIComponent(xText(t.text)) + "&url=" + encodeURIComponent(X_LINK());
  const w = window.open(url, "_blank"); if (w) { try { w.opener = null; } catch {} }
  setStatus(w === null ? "Your browser blocked the X window. Allow pop-ups for this site and try again."
    : "X opened in a new tab. Press Post there, then copy the post's link into \"Link to this post on X\" here and click Save & publish.");
});
let clipStop = null;
content.addEventListener("click", async e => {
  const play = e.target.closest("[data-play-clip]"), reset = e.target.closest("[data-reset-clip]"), grab = e.target.closest("[data-grab-frame]"), rm = e.target.closest("[data-clear-video]");
  if (play) {
    const base = JSON.parse(play.dataset.playClip), v = play.closest("[data-vid-editor]").querySelector("video");
    const st = +get(sib(base, "Start")) || 0, en = +get(sib(base, "End")) || v.duration;
    if (clipStop) v.removeEventListener("timeupdate", clipStop);
    clipStop = () => { if (v.currentTime >= en) { v.pause(); v.removeEventListener("timeupdate", clipStop); } };
    v.addEventListener("timeupdate", clipStop); v.currentTime = st; v.play().catch(() => {});
  }
  if (reset) { const base = JSON.parse(reset.dataset.resetClip); set(sib(base, "Start"), 0); set(sib(base, "End"), 0); markDirty(); draw(); }
  if (rm) {
    if (!rm.dataset.confirm) { rm.dataset.confirm = "1"; rm.textContent = "Click again to remove"; return; }
    const base = JSON.parse(rm.dataset.clearVideo); for (const k of ["", "Poster", "Start", "End"]) set(k ? sib(base, k) : base, k === "Start" || k === "End" ? 0 : "");
    markDirty(); draw();
  }
  if (grab) {
    const base = JSON.parse(grab.dataset.grabFrame), v = grab.closest("[data-vid-editor]").querySelector("video"), src = vidSrc(get(base));
    grab.disabled = true; setStatus("Saving this frame as the cover…");
    try { await saveCover(base, await frameFromVideo(LOCAL_VID[src] || src, v.currentTime)); markDirty(); draw(); setStatus(`Cover set from ${fmtSec(v.currentTime)}. Click Save & publish to put it on the website.`); }
    catch { grab.disabled = false; setStatus("This video's frames can't be captured here (it was uploaded earlier). Use \"Upload a cover photo\" instead, or re-upload the video to pick any frame.", "err"); }
  }
});

$("save").addEventListener("click", async () => {
  if (saving) return; saving = true; $("save").disabled = true; setStatus("Publishing…");
  try {
    /* Only write the sections that changed, so admins never overwrite each other's work. */
    const changed = Object.keys(S).filter(k => JSON.stringify(S[k]) !== JSON.stringify(SAVED[k]));
    const blocked = changed.filter(k => !can(k));
    if (blocked.length) { setStatus("Some changes are in sections you can't edit. Click Discard changes and try again.", "err"); return; }
    if (!changed.length) { dirty = false; setStatus("Nothing new to publish."); return; }
    const upd = {updatedAt: TS(), updatedBy: me.uid};
    for (const k of changed) upd["data." + k] = JSON.parse(JSON.stringify(S[k] ?? null));
    await db.doc("site/content").update(upd);
    for (const k of changed) SAVED[k] = structuredClone(S[k]);
    dirty = false; setStatus(`Published ${fmtWhen(new Date())}. The website shows it now.`, "okc");
  } catch (err) {
    setStatus(err && err.code === "permission-denied" ? "You don't have permission to publish. Ask a super admin." : "Couldn't publish. Check your connection and try again.", "err");
  } finally { saving = false; $("save").disabled = false; }
});
$("discard").addEventListener("click", () => { if (!dirty) return; S = structuredClone(SAVED); dirty = false; draw(); setStatus("Changes discarded."); });
window.addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

/* ---------------- replies ---------------- */
async function drawReplies(){
  let docs;
  try { docs = (await db.collection("replies").orderBy("createdAt", "desc").limit(500).get()).docs; }
  catch { if (tab === "replies") content.innerHTML = `<p class="hint err">Replies couldn't be loaded.</p>`; return; }
  if (tab !== "replies") return;
  const tText = id => String(((S.thoughts && S.thoughts.items) || []).find(t => t.id === id)?.text || "(removed post)").slice(0,60);
  content.innerHTML = docs.length ? `<p class="hint">${docs.length} ${docs.length === 1 ? "reply" : "replies"} from visitors. Removing one takes it off the website right away.</p>
    <div class="scroll"><table class="tbl"><thead><tr><th>On</th><th>From</th><th>Reply</th><th>When</th><th></th></tr></thead><tbody>
    ${docs.map(d => { const r = d.data(); return `<tr><td class="num" style="white-space:normal;max-width:180px">${esc(tText(r.thoughtId))}</td><td>${esc(r.name)}</td><td>${esc(r.body)}</td><td class="num">${esc(fmtWhen(r.createdAt))}</td>
      <td><button class="btn danger sm" type="button" data-del-reply="${esc(d.id)}">Remove</button></td></tr>`; }).join("")}</tbody></table></div>`
    : `<div class="empty">No replies yet. They'll show here when visitors reply to your Thoughts.</div>`;
}
/* ---------------- subscribers ---------------- */
let SUBS = [];
async function drawSubscribers(){
  let docs;
  try { docs = (await db.collection("subscribers").orderBy("createdAt", "desc").get()).docs; }
  catch { if (tab === "subscribers") content.innerHTML = `<p class="hint err">Subscribers couldn't be loaded.</p>`; return; }
  if (tab !== "subscribers") return;
  SUBS = docs.map(d => ({id: d.id, ...d.data()}));
  const daily = SUBS.filter(s => s.frequency === "daily").length;
  content.innerHTML = `<div class="stats"><div class="stat"><b>${SUBS.length}</b><span>Total</span></div><div class="stat"><b>${daily}</b><span>Daily</span></div><div class="stat"><b>${SUBS.length - daily}</b><span>Weekly</span></div></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn ghost" type="button" id="export-csv" ${SUBS.length ? "" : "disabled"}>Download as CSV</button></div>
    <p class="hint">Upload the CSV to an email tool (Beehiiv, Kit, Mailchimp) when you're ready to send.</p>
    ${SUBS.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>Email</th><th>Name</th><th>How often</th><th>Joined</th><th></th></tr></thead><tbody>
    ${SUBS.map(s => `<tr><td>${esc(s.email)}</td><td>${esc(s.name || "")}</td><td>${s.frequency === "daily" ? "Daily" : "Weekly"}</td><td class="num">${esc(fmtWhen(s.createdAt))}</td>
      <td><button class="btn danger sm" type="button" data-del-sub="${esc(s.id)}">Remove</button></td></tr>`).join("")}</tbody></table></div>`
    : `<div class="empty">No subscribers yet.</div>`}`;
}
/* ---------------- users ---------------- */
let usersNote = null; /* [text, cls] shown after the list redraws */
function noteUsers(text, cls){ usersNote = [text, cls]; const m = $("users-msg"); if (m) { m.textContent = text; m.className = cls; } }
async function drawUsers(){
  if (role !== "super_admin") { content.innerHTML = `<p class="hint">Only super admins can manage access.</p>`; return; }
  let users;
  try { users = (await db.collection("users").orderBy("createdAt", "asc").get()).docs.map(d => ({id: d.id, ...d.data()})); }
  catch { if (tab === "users") content.innerHTML = `<p class="hint err">Users couldn't be loaded.</p>`; return; }
  if (tab !== "users") return;
  const pending = users.filter(u => u.role === "pending");
  content.innerHTML = `
    <div class="notice"><strong>How access works.</strong> <span class="hint" style="display:block;margin-top:4px">People request access at <strong>${esc(location.origin)}/admin</strong> with their email. They can't change anything until you give them a role here.<br>
    <b>Admin</b>: edits only the sections you tick for them. <b>Super admin</b>: everything, including this page. You can't change your own role, so there's always at least one super admin.</span></div>
    ${users.filter(u => u.emailRequest && u.emailRequest.email).map(u => `<div class="notice email-req"><strong>Email change request</strong>
      <span class="hint" style="display:block;margin:4px 0 10px">${esc(u.name || u.email)} wants to sign in with <strong>${esc(u.emailRequest.email)}</strong> instead of ${esc(u.email)}.</span>
      <div class="row-btns"><button class="btn sm" type="button" data-email-approve="${esc(u.id)}" data-new="${esc(u.emailRequest.email)}">Approve</button>
      <button class="btn ghost sm" type="button" data-email-decline="${esc(u.id)}" data-new="${esc(u.emailRequest.email)}">Decline</button></div></div>`).join("")}
    ${pending.length ? `<p class="hint" style="color:var(--gold)">${pending.length} ${pending.length === 1 ? "person is" : "people are"} waiting for approval.</p>` : ""}
    <p class="${usersNote ? usersNote[1] : "hint"}" id="users-msg" role="status" aria-live="polite">${usersNote ? esc(usersNote[0]) : ""}</p>
    ${users.map(u => {
      const self = u.id === me.uid, up = Array.isArray(u.perms) ? u.perms : [];
      return `<div class="item user-card">
        <div class="user-top">
          <div style="display:flex;gap:12px;align-items:center;min-width:0">${avatarHTML(u, 48)}<div style="min-width:0"><strong>${esc(u.name || u.email)}</strong>${self ? ` <span class="chip muted">You</span>` : ""}
            ${u.name ? `<div class="hint">${esc(u.email)}</div>` : ""}<div class="hint">Joined ${esc(fmtWhen(u.createdAt))}</div></div></div>
          ${self ? `<span class="chip">${ROLE_LABEL[u.role]}</span>`
            : `<label class="f" style="min-width:170px"><span>Role</span><select data-role-for="${esc(u.id)}">${["pending","admin","super_admin"].map(r => `<option value="${r}" ${u.role===r?"selected":""}>${ROLE_LABEL[r]}</option>`).join("")}</select></label>`}
        </div>
        ${u.role !== "pending" ? `<label class="f" style="max-width:320px"><span>Category</span><input type="text" list="cat-list" value="${esc(u.title || "")}" placeholder="e.g. Content Writer" data-title-for="${esc(u.id)}"></label>` : ""}
        ${u.role === "admin" ? `<fieldset class="perm-box"><legend>Can use <span class="hint">(${up.length} of ${ALL_PERMS.length})</span></legend>
          <p class="hint" style="margin:0"><b>Workspace</b></p>
          <div class="perm-grid">${WS_PERMS.map(([k,l]) => `<label class="f check"><input type="checkbox" data-perm-for="${esc(u.id)}" value="${k}" ${up.includes(k) ? "checked" : ""}><span>${l}</span></label>`).join("")}</div>
          <p class="hint" style="margin:0"><b>Website</b></p>
          <div class="perm-grid">${PERM_LABELS.map(([k,l]) => `<label class="f check"><input type="checkbox" data-perm-for="${esc(u.id)}" value="${k}" ${up.includes(k) ? "checked" : ""}><span>${l}</span></label>`).join("")}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn ghost sm" type="button" data-perm-all="${esc(u.id)}">Tick all</button><button class="btn ghost sm" type="button" data-perm-none="${esc(u.id)}">Untick all</button></div>
          ${up.length ? "" : `<p class="hint" style="color:var(--gold)">This admin can't use anything yet. Tick what they should have.</p>`}
        </fieldset>` : u.role === "super_admin" && !self ? `<p class="hint">Super admins can edit everything.</p>` : ""}
        ${self ? "" : `<details class="pw-box"><summary>Password</summary>
          <div style="display:grid;gap:10px;margin-top:10px;max-width:420px">
            <button class="btn ghost sm" type="button" data-pw-reset="${esc(u.email)}" data-pw-msg="pwm-${esc(u.id)}" style="justify-self:start">Email them a reset link</button>
            <p class="hint" style="margin:0">Or set a new password yourself, then tell them what it is:</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap"><input type="text" id="pwi-${esc(u.id)}" minlength="8" maxlength="128" placeholder="New password (8+ characters)" autocomplete="off" style="flex:1;min-width:180px">
              <button class="btn sm" type="button" data-pw-set="${esc(u.id)}">Set password</button></div>
            <p class="hint" id="pwm-${esc(u.id)}" role="status" aria-live="polite"></p></div></details>
          <div><button class="btn danger sm" type="button" data-remove-user="${esc(u.id)}" data-email="${esc(u.email)}">Remove account</button></div>`}
      </div>`; }).join("")}
    <datalist id="cat-list">${CATEGORIES.map(c => `<option value="${esc(c)}">`).join("")}</datalist>`;
  loadMedia(users).then(() => content.querySelectorAll("img[data-avatar-src]").forEach(i => { const s = imgSrc(i.dataset.avatarSrc); if (s) i.src = s; }));
}
function avatarHTML(u, size){
  const initials = String(u.name || u.email || "?").split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
  const src = u.photo ? imgSrc(u.photo) : "";
  return u.photo ? `<img class="avatar" style="width:${size}px;height:${size}px" src="${esc(src)}" data-avatar-src="${esc(u.photo)}" alt="">`
    : `<span class="avatar ini" style="width:${size}px;height:${size}px;font-size:${Math.round(size * .38)}px">${esc(initials)}</span>`;
}
content.addEventListener("change", async e => {
  const inp = e.target.closest("[data-title-for]"); if (!inp) return;
  try { await db.collection("users").doc(inp.dataset.titleFor).update({title: inp.value.trim().slice(0, 60)}); noteUsers("Category saved.", "hint okc"); const m = $("users-msg"); if (m) { m.textContent = "Category saved."; m.className = "hint okc"; } }
  catch { const m = $("users-msg"); if (m) { m.textContent = "That category didn't save."; m.className = "hint err"; } }
});
async function removeUser(btn){
  if (!btn.dataset.confirm) { btn.dataset.confirm = "1"; btn.textContent = `Click again to remove ${btn.dataset.email}`; return; }
  const msg = $("users-msg"); btn.disabled = true; msg.textContent = "Removing…"; msg.className = "hint";
  try {
    await db.collection("users").doc(btn.dataset.removeUser).delete();
    noteUsers(`${btn.dataset.email} was removed. If they sign in again, they'll need your approval.`, "hint okc");
    refreshPendingCount(); drawUsers();
  } catch (err) {
    btn.disabled = false;
    msg.textContent = err && err.code === "permission-denied" ? "Couldn't remove. Make sure the latest database rules are published in Firebase." : "Couldn't remove that account. Please try again."; msg.className = "hint err";
  }
}
content.addEventListener("click", e => { const b = e.target.closest("[data-remove-user]"); if (b) removeUser(b); });
content.addEventListener("click", async e => {
  const a = e.target.closest("[data-email-approve]"), d = e.target.closest("[data-email-decline]"), b = a || d; if (!b) return;
  const id = a ? a.dataset.emailApprove : d.dataset.emailDecline, next = b.dataset.new; b.disabled = true;
  try {
    await db.collection("users").doc(id).update(a ? {emailApproved: next, emailRequest: firebase.firestore.FieldValue.delete()} : {emailRequest: firebase.firestore.FieldValue.delete()});
    await db.collection("notifications").doc(id).collection("items").add({text: a ? `Your email change to ${next} was approved. Go to My overview → Sign-in & security to finish it.` : `Your request to change your email to ${next} was declined.`,
      link: {tab: "account"}, from: me.uid, read: false, createdAt: TS()});
    noteUsers(a ? `Approved. They'll finish the change from their overview.` : "Request declined.", "hint okc");
    approvalNote = a ? `Approved ${next}. They'll get a notification to finish the change.` : `Declined the change to ${next}.`;
    if (tab === "users") drawUsers(); else drawApprovals();
  } catch { b.disabled = false; noteUsers("That didn't save. Make sure the latest database rules are published.", "hint err"); drawUsers(); }
});
/* Super admin: reset or set someone's password */
content.addEventListener("click", async e => {
  const r = e.target.closest("[data-pw-reset]"), st = e.target.closest("[data-pw-set]");
  if (r) {
    const m = $(r.dataset.pwMsg); r.disabled = true;
    try { await auth.sendPasswordResetEmail(r.dataset.pwReset); m.textContent = `Reset link sent to ${r.dataset.pwReset}. They pick their own new password from the email (ask them to check spam).`; }
    catch { m.textContent = "Couldn't send the reset email. Try again in a minute."; }
    r.disabled = false;
  }
  if (st) {
    const id = st.dataset.pwSet, inp = $("pwi-" + id), m = $("pwm-" + id), pw = inp.value;
    if (pw.length < 8) { m.textContent = "Passwords need 8 or more characters."; inp.focus(); return; }
    st.disabled = true; m.textContent = "Setting password…";
    try {
      const res = await fetch("/api/set-password", {method: "POST", headers: {"Content-Type": "application/json", Authorization: "Bearer " + await me.getIdToken()}, body: JSON.stringify({uid: id, password: pw})});
      const j = await res.json().catch(() => ({}));
      if (res.ok) { m.textContent = "Password changed. Tell them the new password privately (not in team chat)."; inp.value = ""; }
      else if (j.error === "not-set-up") m.textContent = "Setting passwords directly isn't switched on yet (it needs a one-time setup in Vercel). Use “Email them a reset link” for now.";
      else m.textContent = j.error || "That didn't work. Try again.";
    } catch { m.textContent = "That didn't work. Check your connection and try again."; }
    st.disabled = false;
  }
});
async function savePerms(uid){
  const list = [...content.querySelectorAll(`[data-perm-for="${CSS.escape(uid)}"]:checked`)].map(i => i.value);
  const msg = $("users-msg"); msg.textContent = "Saving…"; msg.className = "hint";
  try { await db.collection("users").doc(uid).update({perms: list}); noteUsers("Access saved.", "hint okc"); drawUsers(); }
  catch { msg.textContent = "That change didn't save."; msg.className = "hint err"; drawUsers(); }
}
async function refreshPendingCount(){
  try {
    const snap = await db.collection("users").where("role", "==", "pending").get();
    let reqs = 0; try { reqs = (await db.collection("users").where("emailRequest.email", ">", "").get()).size; } catch {}
    const n = snap.size + reqs, b = document.getElementById("pending-badge"); if (b) b.innerHTML = n ? `<span class="chip" style="margin-left:6px">${n}</span>` : "";
  } catch {}
}
/* ---------------- approvals (super admins) ---------------- */
let APPROVALS = {signups: [], emails: []}, approvalsUnsub = null, approvalNote = "";
function watchApprovals(){
  if (approvalsUnsub) approvalsUnsub();
  approvalsUnsub = db.collection("users").onSnapshot(s => {
    const all = s.docs.map(d => ({id: d.id, ...d.data()}));
    APPROVALS = {signups: all.filter(u => u.role === "pending"), emails: all.filter(u => u.emailRequest && u.emailRequest.email)};
    const n = APPROVALS.signups.length + APPROVALS.emails.length, b = document.getElementById("pending-badge");
    if (b) b.innerHTML = n ? `<span class="chip" style="margin-left:6px">${n}</span>` : "";
    drawApprovals();
    if (tab === "users" && !document.querySelector("#content :focus")) drawUsers();
  }, () => {});
}
function drawApprovals(){
  const box = $("me-approvals"); if (!box) return;
  if (role !== "super_admin") { box.innerHTML = ""; return; }
  const {signups, emails} = APPROVALS;
  const note = approvalNote ? `<p class="hint okc">${esc(approvalNote)}</p>` : "";
  if (!signups.length && !emails.length) { box.innerHTML = note; return; }
  box.innerHTML = note + `<h3 class="group-title">Needs your approval <span class="chip">${signups.length + emails.length}</span></h3><div class="sum-grid">
    ${emails.map(u => `<section class="sum-card"><h4>Email change</h4>
      <p class="hint" style="margin:0"><strong>${esc(u.name || u.email)}</strong> wants to sign in with <strong>${esc(u.emailRequest.email)}</strong> instead of ${esc(u.email)}.</p>
      <div class="row-btns"><button class="btn sm" type="button" data-email-approve="${esc(u.id)}" data-new="${esc(u.emailRequest.email)}">Approve</button>
      <button class="btn ghost sm" type="button" data-email-decline="${esc(u.id)}" data-new="${esc(u.emailRequest.email)}">Decline</button></div></section>`).join("")}
    ${signups.map(u => `<section class="sum-card"><h4>New sign-up</h4>
      <p class="hint" style="margin:0"><strong>${esc(u.email)}</strong> is waiting for access.</p>
      <button class="btn sm" type="button" data-go-users>Review in Users &amp; access</button></section>`).join("")}</div>`;
}
document.addEventListener("click", e => { if (e.target.closest("[data-go-users]")) window.__ADMIN.goto("users"); });

/* ---------------- account ---------------- */
/* Changing your sign-in email: ask -> a super admin approves -> you confirm from the new inbox. */
function emailBoxHTML(){
  const approved = myEmailOk && myEmailOk.toLowerCase() !== (me.email || "").toLowerCase();
  const head = `<h4 style="margin:0 0 6px">Change your email</h4><p class="hint" style="margin:0 0 12px">You sign in with <strong>${esc(me.email)}</strong>.</p>`;
  if (approved) return head + `<form id="email-form" data-step="confirm" style="display:grid;gap:12px" novalidate>
      <div class="notice"><strong>Approved.</strong> <span class="hint">A super admin approved <strong>${esc(myEmailOk)}</strong>. Send yourself the confirmation link to finish.</span></div>
      <label class="f" for="em-pw"><span>Your current password</span><input type="password" id="em-pw" autocomplete="current-password"></label>
      <button class="btn" type="submit" style="justify-self:start">Send confirmation link</button>
      <p class="hint" id="em-msg" role="status" aria-live="polite"></p></form>`;
  if (myEmailReq) return head + `<div class="notice"><strong>Waiting for approval.</strong> <span class="hint">You asked to change to <strong>${esc(myEmailReq.email)}</strong>. A super admin needs to approve it. You'll get a notification.</span></div>
      <button class="btn ghost sm" type="button" data-email-cancel style="margin-top:10px">Cancel request</button><p class="hint" id="em-msg" role="status" aria-live="polite"></p>`;
  return head + `<form id="email-form" data-step="ask" style="display:grid;gap:12px" novalidate>
      <p class="hint" style="margin:0">${role === "super_admin" ? "As a super admin you approve your own change." : "A super admin approves the change first. Then you confirm it from the new inbox."}</p>
      <label class="f" for="em-new"><span>New email</span><input type="email" id="em-new" autocomplete="email" placeholder="you@example.com"></label>
      <label class="f" for="em-pw"><span>Your current password</span><input type="password" id="em-pw" autocomplete="current-password"></label>
      <button class="btn ghost" type="submit" style="justify-self:start">${role === "super_admin" ? "Continue" : "Ask for approval"}</button>
      <p class="hint" id="em-msg" role="status" aria-live="polite"></p></form>`;
}
function drawEmailBox(){ const b = $("email-box"); if (b) b.innerHTML = emailBoxHTML(); }
async function notifySupers(text){
  try {
    const sup = await db.collection("users").where("role", "==", "super_admin").get();
    await Promise.all(sup.docs.filter(d => d.id !== me.uid).map(d => db.collection("notifications").doc(d.id).collection("items")
      .add({text, link: {tab: "users"}, from: me.uid, read: false, createdAt: TS()})));
  } catch {}
}
content.addEventListener("click", async e => {
  if (!e.target.closest("[data-email-cancel]")) return;
  try { await db.collection("users").doc(me.uid).update({emailRequest: firebase.firestore.FieldValue.delete()}); myEmailReq = null; drawEmailBox(); }
  catch { const m = $("em-msg"); if (m) m.textContent = "Couldn't cancel. Try again."; }
});
function paintMe(){
  const el = $("me-email"); if (!el || !me) return;
  el.innerHTML = `<button type="button" class="me-link" data-open-profile>${avatarHTML({name: myName, email: me.email, photo: myPhoto}, 36)}<span><strong>${esc(myName || "Add your name")}</strong><span class="hint" style="display:block">${esc(me.email)}</span></span></button>`;
  if (myPhoto) loadMedia({p: myPhoto}).then(() => { const i = el.querySelector("img"); if (i) i.src = imgSrc(myPhoto); });
}
document.addEventListener("click", e => { if (e.target.closest("[data-open-profile]")) { e.preventDefault(); $("side").classList.remove("open"); window.__ADMIN.goto("account"); } });
function drawAccount(){
  setTimeout(() => { const s = $("me-avatar"); if (s) { s.innerHTML = avatarHTML({name: myName, email: me.email, photo: myPhoto}, 84); loadMedia({p: myPhoto}).then(() => { const i = s.querySelector("img"); if (i) i.src = imgSrc(myPhoto); }); } if (window.WS) { WS.drawSummary(); WS.drawNoticeBanner(); } drawApprovals(); }, 0);
  const first = (myName || "").split(" ")[0];
  const wsHave = WS_PERMS.filter(([k]) => can(k)).map(([,l]) => l), siteHave = PERM_LABELS.filter(([k]) => can(k)).map(([,l]) => l);
  const chips = l => l.map(x => `<span class="chip muted">${esc(x)}</span>`).join(" ");
  content.innerHTML = `
    <section class="me-hero">
      <span id="me-avatar"></span>
      <div style="min-width:0">
        <p class="hint" style="margin:0">Welcome${first ? ", " + esc(first) : ""}</p>
        <h3 class="me-name">${esc(myName || me.email)}</h3>
        <p style="margin:2px 0 0">${myTitle ? `<strong>${esc(myTitle)}</strong> · ` : ""}${ROLE_LABEL[role]}</p>
        <p class="hint" style="margin:2px 0 0">${esc(me.email)}</p>
      </div>
    </section>
    <p class="hint" style="max-width:640px">This is your home in the admin. It shows what's waiting for you and what you have access to. Use the menu to get to your work.</p>
    <div id="me-notice"></div>
    <div id="me-approvals"></div>
    <div id="me-summary"></div>
    <h3 class="group-title">What you can use</h3>
    ${role === "super_admin" ? `<p class="hint">Everything. As a super admin you can also manage people under Users &amp; access.</p>`
      : `<div style="display:grid;gap:8px">
          <div><span class="hint">Workspace:</span> ${wsHave.length ? chips(wsHave) : `<span class="hint">nothing yet</span>`}</div>
          <div><span class="hint">Website:</span> ${siteHave.length ? chips(siteHave) : `<span class="hint">nothing yet</span>`}</div>
          ${wsHave.length + siteHave.length ? "" : `<p class="hint">Ask a super admin to give you access.</p>`}</div>`}
    <form id="name-form" style="display:grid;gap:14px;max-width:420px" novalidate>
      <h3 class="group-title">Edit your profile</h3>
      <p class="hint" style="margin:0">Your photo and name show on tasks, chat and the Team page.</p>
      <label class="btn ghost sm" style="cursor:pointer;justify-self:start">${myPhoto ? "Change" : "Upload"} profile photo<input type="file" accept="image/*" id="me-photo" hidden></label>
      <span class="hint" id="photo-msg"></span>
      <label class="f" for="me-name"><span>Display name</span><input type="text" id="me-name" maxlength="80" value="${esc(myName)}" placeholder="e.g. Angela" autocomplete="name"></label>
      ${role === "super_admin" ? `<label class="f" for="me-title"><span>Your category</span><input type="text" id="me-title" maxlength="60" list="me-cat-list" value="${esc(myTitle)}" placeholder="e.g. Founder"></label><datalist id="me-cat-list">${["Founder","CEO","Creative Director",...CATEGORIES].map(c => `<option value="${esc(c)}">`).join("")}</datalist>`
        : `<p class="hint" style="margin:0">Category: ${myTitle ? esc(myTitle) : "not set yet"} (set by a super admin)</p>`}
      <button class="btn" type="submit" style="justify-self:start">Save profile</button>
      <p class="hint" id="name-msg" role="status" aria-live="polite"></p>
    </form>
    <details class="me-security">
      <summary>Sign-in &amp; security <span class="hint">(optional)</span></summary>
      <form id="pw-form" style="display:grid;gap:14px;max-width:420px;margin-top:12px" novalidate>
        <p class="hint" style="margin:0">You don't need to do anything here. Only change your email or password if you want to.</p>
        <label class="f" for="pw-new"><span>New password (8+ characters)</span><input type="password" id="pw-new" autocomplete="new-password" minlength="8"></label>
        <button class="btn ghost" type="submit" style="justify-self:start">Change password</button>
        <p class="hint" id="pw-msg" role="status" aria-live="polite"></p>
      </form>
      <div id="email-box" style="max-width:420px;margin-top:22px">${emailBoxHTML()}</div>
    </details>`;
}

/* actions on non-content tabs */
content.addEventListener("click", async e => {
  const r = e.target.closest("[data-del-reply]"), s = e.target.closest("[data-del-sub]");
  const b = r || s; if (!b) return;
  if (!b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = "Click to confirm"; return; }
  b.disabled = true;
  try { await (r ? db.collection("replies").doc(r.dataset.delReply) : db.collection("subscribers").doc(s.dataset.delSub)).delete(); draw(); }
  catch { b.textContent = "Couldn't remove"; }
});
content.addEventListener("click", e => {
  if (e.target.id !== "export-csv") return;
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = ["email,name,frequency,joined", ...SUBS.map(s => [s.email, s.name, s.frequency, toDate(s.createdAt)?.toISOString() || ""].map(q).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], {type: "text/csv"}));
  a.download = `subscribers-${today()}.csv`; document.body.appendChild(a); a.click(); a.remove();
});
content.addEventListener("change", e => { const c = e.target.closest("[data-perm-for]"); if (c) savePerms(c.dataset.permFor); });
content.addEventListener("click", e => {
  const all = e.target.closest("[data-perm-all]"), none = e.target.closest("[data-perm-none]");
  const uid = (all || none) && (all ? all.dataset.permAll : none.dataset.permNone); if (!uid) return;
  content.querySelectorAll(`[data-perm-for="${CSS.escape(uid)}"]`).forEach(i => i.checked = !!all);
  savePerms(uid);
});
content.addEventListener("change", async e => {
  if (e.target.id !== "me-photo" || !e.target.files[0]) return;
  const msg = $("photo-msg"); msg.textContent = "Uploading photo…";
  try {
    const data = await compress(e.target.files[0]);
    const ref = await db.collection("media").add({data, name: "profile-photo", createdAt: TS()});
    MEDIA[ref.id] = data; myPhoto = "media:" + ref.id;
    await db.collection("users").doc(me.uid).update({photo: myPhoto});
    msg.textContent = "Profile photo saved."; paintMe(); drawAccount();
  } catch { msg.textContent = "The photo didn't save. Make sure the latest database rules are published."; }
});
content.addEventListener("submit", async e => {
  if (e.target.id !== "name-form") return;
  e.preventDefault();
  const name = $("me-name").value.trim().slice(0,80), msg = $("name-msg");
  const upd = {name}; if (role === "super_admin" && $("me-title")) upd.title = $("me-title").value.trim().slice(0,60);
  try { await db.collection("users").doc(me.uid).update(upd); if ("title" in upd) { myTitle = upd.title;  $("me-role").textContent = ROLE_LABEL[role] + (myTitle ? " · " + myTitle : ""); } myName = name; paintMe(); msg.textContent = "Profile saved."; msg.className = "hint okc"; }
  catch { msg.textContent = "That didn't save. Please try again."; msg.className = "hint err"; }
});
content.addEventListener("change", async e => {
  const sel = e.target.closest("[data-role-for]"); if (!sel) return;
  const msg = $("users-msg"); sel.disabled = true; msg.textContent = "Saving…"; msg.className = "hint";
  try {
    await db.collection("users").doc(sel.dataset.roleFor).update({role: sel.value});
    noteUsers(`Access updated to ${ROLE_LABEL[sel.value]}.`, "hint okc"); refreshPendingCount(); drawUsers();
  } catch { msg.textContent = "That change didn't save."; msg.className = "hint err"; drawUsers(); }
  finally { sel.disabled = false; }
});
content.addEventListener("submit", async e => {
  if (e.target.id !== "email-form") return;
  e.preventDefault();
  const step = e.target.dataset.step, pw = $("em-pw").value, msg = $("em-msg"), btn = e.target.querySelector("button[type=submit]");
  const say = (t, ok) => { msg.textContent = t; msg.className = ok ? "hint okc" : "hint err"; };
  const next = step === "confirm" ? myEmailOk : $("em-new").value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next)) return say("Enter a valid email address.");
  if (next === (me.email || "").toLowerCase()) return say("That's already your email.");
  if (!pw) return say("Enter your current password so we know it's you.");
  btn.disabled = true; say("One moment…", true);
  try {
    await auth.currentUser.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(me.email, pw));
    if (step === "ask" && role !== "super_admin") {
      await db.collection("users").doc(me.uid).update({emailRequest: {email: next, at: TS()}});
      myEmailReq = {email: next};
      notifySupers(`${myName || me.email} asked to change their sign-in email to ${next}`);
      drawEmailBox(); return;
    }
    if (step === "ask") { await db.collection("users").doc(me.uid).update({emailApproved: next}); myEmailOk = next; }
    await auth.currentUser.verifyBeforeUpdateEmail(next);
    drawEmailBox();
    const m = $("em-msg"); if (m) { m.textContent = `Check ${next} (and its spam folder) for a link. Your email changes once you click it. After that, sign in with ${next}.`; m.className = "hint okc"; }
  } catch (err) {
    const c = err && err.code;
    say(c === "auth/wrong-password" || c === "auth/invalid-credential" || c === "auth/invalid-login-credentials" ? "That password isn't right."
      : c === "auth/email-already-in-use" ? "Another account already uses that email."
      : c === "auth/too-many-requests" ? "Too many tries. Wait a few minutes and try again."
      : c === "permission-denied" ? "That didn't save. A super admin needs to publish the latest database rules."
      : "That didn't work. Please try again.");
  }
  if (btn) btn.disabled = false;
});
content.addEventListener("submit", async e => {
  if (e.target.id !== "pw-form") return;
  e.preventDefault();
  const password = $("pw-new").value, msg = $("pw-msg");
  if (password.length < 8) { msg.textContent = "Use at least 8 characters."; msg.className = "hint err"; return; }
  try { await auth.currentUser.updatePassword(password); msg.textContent = "Password updated."; msg.className = "hint okc"; $("pw-new").value = ""; }
  catch (err) { msg.textContent = err && err.code === "auth/requires-recent-login" ? "For security, sign out and back in, then try again." : "That didn't work. Please try again."; msg.className = "hint err"; }
});
})();
