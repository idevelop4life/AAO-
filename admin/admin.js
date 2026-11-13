/* Website admin: email sign-in, content editor, photos, replies, subscribers and access control (Firebase). */
(() => {
const CFG = (window.SITE_CONFIG || {}).firebase || {};
const $ = id => document.getElementById(id);
const VIEWS = ["v-setup","v-auth","v-pending","v-app"];
const show = v => VIEWS.forEach(x => $(x).hidden = x !== v);

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

let me = null, role = null, SAVED = null, S = null, dirty = false, tab = "profile", saving = false;

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
  dirty = false; await auth.signOut();
}));
$("pending-refresh").addEventListener("click", () => boot(auth.currentUser));

/* Make sure every signed-in person has a users/{uid} record. The very first one becomes super admin. */
async function ensureProfile(user){
  const ref = db.collection("users").doc(user.uid);
  const snap = await ref.get();
  if (snap.exists) return snap.data();
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
  role = prof.role;
  if (role !== "admin" && role !== "super_admin") { $("pending-email").textContent = user.email; show("v-pending"); return; }
  let snap, data;
  try { snap = await db.doc("site/content").get(); data = snap.exists ? snap.data().data : await seedContent(); }
  catch { data = null; }
  $("me-email").textContent = user.email; $("me-role").textContent = ROLE_LABEL[role];
  show("v-app");
  if (!data) { $("savebar").hidden = true; $("content").innerHTML = `<div class="notice">The website content couldn't be loaded. Check that Firestore is set up and the rules are published, then reload.</div>`; return; }
  await loadMedia(data);
  SAVED = data; S = structuredClone(SAVED); dirty = false;
  drawNav(); draw();
  const when = snap && snap.exists ? snap.data().updatedAt : null;
  setStatus(when ? `Last published ${fmtWhen(when)}.` : "All changes saved.");
  if (role === "super_admin") refreshPendingCount();
}
auth.onAuthStateChanged(user => boot(user));

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
const today = () => new Date().toISOString().slice(0,10);

/* ---------------- tabs ---------------- */
const CONTENT_TABS = {
  profile: ["Profile", () => `
    ${fText("Name", ["profile","name"])}
    <p class="hint">Wrap a word in *asterisks* to make it gold, like Angela Agunwami *Onwuka*. Works in project names too.</p>
    ${fText("Small line above your name", ["profile","kicker"])}
    ${fText("Tagline", ["profile","tagline"], {area:true})}
    ${fImage("Main photo", ["profile","photo"])}
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
    ${list(["gallery","items"], g => g.caption || "Photo", i => fImage("Photo", ["gallery","items",i,"src"]) + fText("Caption (optional)", ["gallery","items",i,"caption"]), {src:"",caption:""}, "Add photo")}`],
  thoughts: ["Thoughts", () => `
    ${fText("Heading", ["thoughts","heading"])}
    <p class="hint">Short posts, like tweets. Newest shows first. Visitors can reply on the site; manage replies under Replies. Add the matching X link to show a "Reply on X" button too.</p>
    ${list(["thoughts","items"], t => String(t.text||"").slice(0,48), i => `
      ${fText("Post", ["thoughts","items",i,"text"], {area:true})}
      ${fText("Date", ["thoughts","items",i,"date"], {type:"date"})}
      ${fText("Link to this post on X (optional)", ["thoughts","items",i,"xUrl"], {type:"url", ph:"https://x.com/agunwamiii/status/…"})}`,
      {id:"",text:"",date:"",xUrl:""}, "Add thought", true)}`],
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
  replies: "Replies", subscribers: "Subscribers", users: "Users & access", account: "My account"
};

function drawNav(){
  const c = Object.entries(CONTENT_TABS).map(([k,[l]]) => btn(k,l)).join("");
  const a = btn("replies", "Replies") + btn("subscribers", "Subscribers");
  const s = (role === "super_admin" ? btn("users", `Users &amp; access <span id="pending-badge"></span>`) : "") + btn("account", "My account");
  $("tabs").innerHTML = `<span class="grp">Website</span>${c}<span class="grp">Audience</span>${a}<span class="grp">Access</span>${s}`;
  function btn(k,l){ return `<button type="button" data-tab="${k}" ${k===tab?'aria-current="page"':""}>${l}</button>`; }
}
$("tabs").addEventListener("click", e => {
  const b = e.target.closest("[data-tab]"); if (!b) return;
  tab = b.dataset.tab; drawNav(); draw(); window.scrollTo(0,0); $("side").classList.remove("open");
});
$("menu-btn").addEventListener("click", () => $("side").classList.toggle("open"));

function draw(){
  const isContent = tab in CONTENT_TABS;
  $("savebar").hidden = !isContent;
  $("tab-title").textContent = isContent ? CONTENT_TABS[tab][0] : OTHER_TABS[tab];
  if (isContent) { $("content").innerHTML = CONTENT_TABS[tab][1](); return; }
  $("content").innerHTML = `<p class="hint">Loading…</p>`;
  ({replies: drawReplies, subscribers: drawSubscribers, users: drawUsers, account: drawAccount})[tab]();
}

/* ---------------- content editing ---------------- */
const content = $("content");
content.addEventListener("input", e => {
  const el = e.target; if (!el.dataset.path) return;
  set(JSON.parse(el.dataset.path), el.type === "checkbox" ? el.checked : el.value);
  markDirty();
});
content.addEventListener("change", e => {
  const el = e.target;
  if (el.dataset.path && (el.tagName === "SELECT" || el.type === "checkbox" || el.dataset.path.includes('"categories"'))) draw();
  if (el.dataset.upload && el.files[0]) upload(JSON.parse(el.dataset.upload), el.files[0], el);
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

$("save").addEventListener("click", async () => {
  if (saving) return; saving = true; $("save").disabled = true; setStatus("Publishing…");
  try {
    await db.doc("site/content").set({data: JSON.parse(JSON.stringify(S)), updatedAt: TS(), updatedBy: me.uid});
    SAVED = structuredClone(S); dirty = false; setStatus(`Published ${fmtWhen(new Date())}. The website shows it now.`, "okc");
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
async function drawUsers(){
  if (role !== "super_admin") { content.innerHTML = `<p class="hint">Only super admins can manage access.</p>`; return; }
  let users;
  try { users = (await db.collection("users").orderBy("createdAt", "asc").get()).docs.map(d => ({id: d.id, ...d.data()})); }
  catch { if (tab === "users") content.innerHTML = `<p class="hint err">Users couldn't be loaded.</p>`; return; }
  if (tab !== "users") return;
  const pending = users.filter(u => u.role === "pending");
  content.innerHTML = `
    <div class="notice"><strong>How access works.</strong> <span class="hint" style="display:block;margin-top:4px">People request access at <strong>${esc(location.origin)}/admin</strong> with their email. They can't change anything until you give them a role here.<br>
    <b>Admin</b>: edits the website, photos, replies and subscribers. <b>Super admin</b>: everything, plus this page. You can't change your own role, so there's always at least one super admin.</span></div>
    ${pending.length ? `<p class="hint" style="color:var(--gold)">${pending.length} ${pending.length === 1 ? "person is" : "people are"} waiting for approval.</p>` : ""}
    <div class="scroll"><table class="tbl"><thead><tr><th>Email</th><th>Role</th><th>Joined</th></tr></thead><tbody>
    ${users.map(u => `<tr><td>${esc(u.email)}${u.id === me.uid ? ` <span class="chip muted">You</span>` : ""}</td>
      <td>${u.id === me.uid ? `<span class="chip">${ROLE_LABEL[u.role]}</span>`
        : `<select aria-label="Role for ${esc(u.email)}" data-role-for="${esc(u.id)}">${["pending","admin","super_admin"].map(r => `<option value="${r}" ${u.role===r?"selected":""}>${ROLE_LABEL[r]}</option>`).join("")}</select>`}</td>
      <td class="num">${esc(fmtWhen(u.createdAt))}</td></tr>`).join("")}</tbody></table></div>
    <p class="hint" id="users-msg" role="status" aria-live="polite"></p>`;
}
async function refreshPendingCount(){
  try {
    const snap = await db.collection("users").where("role", "==", "pending").get();
    const b = document.getElementById("pending-badge"); if (b) b.innerHTML = snap.size ? `<span class="chip" style="margin-left:6px">${snap.size}</span>` : "";
  } catch {}
}
/* ---------------- account ---------------- */
function drawAccount(){
  content.innerHTML = `<p class="hint">Signed in as <strong>${esc(me.email)}</strong> · ${ROLE_LABEL[role]}</p>
    <form id="pw-form" style="display:grid;gap:14px;max-width:380px" novalidate>
      <h3 class="group-title">Change password</h3>
      <label class="f" for="pw-new"><span>New password (8+ characters)</span><input type="password" id="pw-new" autocomplete="new-password" minlength="8"></label>
      <button class="btn" type="submit" style="justify-self:start">Update password</button>
      <p class="hint" id="pw-msg" role="status" aria-live="polite"></p>
    </form>`;
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
content.addEventListener("change", async e => {
  const sel = e.target.closest("[data-role-for]"); if (!sel) return;
  const msg = $("users-msg"); sel.disabled = true; msg.textContent = "Saving…"; msg.className = "hint";
  try {
    await db.collection("users").doc(sel.dataset.roleFor).update({role: sel.value});
    msg.textContent = `Access updated to ${ROLE_LABEL[sel.value]}.`; msg.className = "hint okc"; refreshPendingCount();
  } catch { msg.textContent = "That change didn't save."; msg.className = "hint err"; drawUsers(); }
  finally { sel.disabled = false; }
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
