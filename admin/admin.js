/* Website admin: sign-in, content editor, photos, replies, subscribers and access control. */
(() => {
const CFG = window.SITE_CONFIG || {};
const $ = id => document.getElementById(id);
const VIEWS = ["v-setup","v-auth","v-newpass","v-pending","v-app"];
const show = v => VIEWS.forEach(x => $(x).hidden = x !== v);

if (!CFG.supabaseUrl || !CFG.supabaseAnonKey || !window.supabase) { show("v-setup"); return; }
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const imgSrc = u => { u = String(u || "").trim(); return /^(https?:|\/|data:image\/)/i.test(u) || (/^[\w./-]+$/.test(u) && !u.includes("..")) ? (u.startsWith("http") || u.startsWith("/") ? u : "/" + u) : ""; };
const ROLE_LABEL = {super_admin: "Super admin", admin: "Admin", pending: "No access"};
const fmtWhen = iso => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString("en-US", {month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit"}); };

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

$("auth-form").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("a-email").value.trim(), password = $("a-pass").value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return authMsg("Enter a valid email address.", "hint err");
  if (mode !== "reset" && password.length < 8) return authMsg("Passwords need at least 8 characters.", "hint err");
  const btn = $("auth-btn"); btn.disabled = true; authMsg("One moment…");
  const redirect = location.origin + "/admin/";
  try {
    if (mode === "signin") {
      const {error} = await sb.auth.signInWithPassword({email, password});
      if (error) throw error;
      authMsg(""); await boot();
    } else if (mode === "signup") {
      const {data, error} = await sb.auth.signUp({email, password, options: {emailRedirectTo: redirect}});
      if (error) throw error;
      if (data.session) await boot();
      else authMsg("Check your email and click the confirmation link, then come back and sign in.", "hint okc");
    } else {
      const {error} = await sb.auth.resetPasswordForEmail(email, {redirectTo: redirect});
      if (error) throw error;
      authMsg("If that email has an account, a reset link is on its way.", "hint okc");
    }
  } catch (err) {
    const m = String(err?.message || "");
    authMsg(/invalid login/i.test(m) ? "That email and password don't match." :
            /not confirmed/i.test(m) ? "Confirm your email first. Check your inbox for the link." :
            /already registered/i.test(m) ? "That email already has an account. Sign in instead." :
            m || "Something went wrong. Please try again.", "hint err");
  } finally { btn.disabled = false; }
});

$("np-form").addEventListener("submit", async e => {
  e.preventDefault();
  const password = $("np-pass").value;
  if (password.length < 8) { $("np-msg").textContent = "Use at least 8 characters."; return; }
  const {error} = await sb.auth.updateUser({password});
  if (error) { $("np-msg").textContent = error.message; $("np-msg").className = "hint err"; return; }
  $("np-msg").textContent = "Password saved."; $("np-msg").className = "hint okc";
  history.replaceState(null, "", location.pathname);
  setTimeout(boot, 800);
});

document.querySelectorAll("[data-signout]").forEach(b => b.addEventListener("click", async () => {
  if (dirty && !confirmLeave()) return;
  await sb.auth.signOut(); dirty = false; me = null; role = null; setMode("signin"); show("v-auth");
}));
$("pending-refresh").addEventListener("click", boot);

let recovering = false;
sb.auth.onAuthStateChange(event => { if (event === "PASSWORD_RECOVERY") { recovering = true; show("v-newpass"); } });

async function boot(){
  if (recovering) return;
  const {data: {session}} = await sb.auth.getSession();
  if (!session) { setMode("signin"); show("v-auth"); return; }
  me = session.user;
  const {data: prof} = await sb.from("profiles").select("role,email").eq("id", me.id).maybeSingle();
  role = prof?.role || "pending";
  if (role !== "admin" && role !== "super_admin") { $("pending-email").textContent = me.email; show("v-pending"); return; }
  const {data: row, error} = await sb.from("site_content").select("data,updated_at").eq("id", 1).maybeSingle();
  if (error || !row) { show("v-app"); $("content").innerHTML = `<div class="notice">The website content couldn't be loaded. Make sure <code>setup.sql</code> has been run in Supabase.</div>`; return; }
  SAVED = row.data; S = structuredClone(SAVED); dirty = false;
  $("me-email").textContent = me.email; $("me-role").textContent = ROLE_LABEL[role];
  show("v-app"); drawNav(); draw();
  setStatus(row.updated_at ? `Last published ${fmtWhen(row.updated_at)}.` : "All changes saved.");
  if (role === "super_admin") refreshPendingCount();
}

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

function list(path, title, fields, blank, addLabel){
  const a = getArr(path);
  return a.map((it,i) => `<div class="item"><div class="item-head"><strong>${esc(title(it || {}) || "Untitled")}</strong>
    <button class="icon-btn" type="button" aria-label="Move up" title="Move up" data-op="up" data-list="${P(path)}" data-i="${i}">↑</button>
    <button class="icon-btn" type="button" aria-label="Move down" title="Move down" data-op="down" data-list="${P(path)}" data-i="${i}">↓</button>
    <button class="icon-btn del" type="button" aria-label="Remove" title="Remove" data-op="del" data-list="${P(path)}" data-i="${i}">✕</button></div>
    ${fields(i)}</div>`).join("") + `<button class="add" type="button" data-op="add" data-list="${P(path)}" data-blank="${P(blank)}">+ ${addLabel}</button>`;
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
      {id:"",text:"",date:"",xUrl:""}, "Add thought")}`],
  quote: ["Quote", () => `
    ${fText("Label", ["quote","label"], {ph:"This week"})}
    ${fText("Quote", ["quote","text"], {area:true})}
    ${fText("Signed", ["quote","by"], {ph:"Angela"})}`],
  journal: ["Journal", () => `
    ${fText("Heading", ["journal","heading"])}
    <p class="hint">Published posts get a "Read post" link. Coming soon shows a teaser. Drafts are hidden from visitors.</p>
    ${list(["journal","posts"], p => `${p.title || "Untitled"} (${({published:"published",soon:"coming soon",draft:"draft"})[p.status] || "draft"})`, i => `
      ${fText("Title", ["journal","posts",i,"title"])}
      ${fSelect("Status", ["journal","posts",i,"status"], [["published","Published"],["soon","Coming soon"],["draft","Draft (hidden)"]])}
      ${fSelect("Category", ["journal","posts",i,"category"], [["Life","Life"],["Building","Building"],["Tech","Tech"]])}
      ${fText("Date", ["journal","posts",i,"date"], {type:"date"})}
      ${fText("Short summary", ["journal","posts",i,"excerpt"], {area:true})}
      ${fText("Full post (leave a blank line between paragraphs)", ["journal","posts",i,"body"], {area:true, tall:true})}`,
      {title:"New post",category:"Life",date:"",status:"draft",excerpt:"",body:""}, "Add post")}`],
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
  if (el.dataset.path && (el.tagName === "SELECT" || el.type === "checkbox")) draw();
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
    a.push(it);
  }
  if (b.dataset.op === "del") {
    if (!b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = "Remove?"; b.classList.add("del"); return; }
    a.splice(i,1);
  }
  if (b.dataset.op === "up" && i > 0) [a[i-1],a[i]] = [a[i],a[i-1]];
  if (b.dataset.op === "down" && i < a.length-1) [a[i+1],a[i]] = [a[i],a[i+1]];
  markDirty(); draw();
});

async function upload(path, file, input){
  if (!/^image\//.test(file.type)) { setStatus("Choose an image file (JPG, PNG or WebP).", "err"); return; }
  if (file.size > 10 * 1024 * 1024) { setStatus("That photo is over 10 MB. Try a smaller one.", "err"); return; }
  input.disabled = true; setStatus("Uploading photo…");
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
  const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`;
  const {error} = await sb.storage.from("media").upload(key, file, {cacheControl: "31536000", upsert: false, contentType: file.type});
  input.disabled = false;
  if (error) { setStatus("The photo didn't upload. Please try again.", "err"); return; }
  set(path, sb.storage.from("media").getPublicUrl(key).data.publicUrl);
  markDirty(); draw(); setStatus("Photo uploaded. Click Save & publish to put it on the website.");
}

$("save").addEventListener("click", async () => {
  if (saving) return; saving = true; $("save").disabled = true; setStatus("Publishing…");
  const {data, error} = await sb.from("site_content").update({data: S, updated_at: new Date().toISOString(), updated_by: me.id}).eq("id", 1).select("id");
  saving = false; $("save").disabled = false;
  if (error || !data || !data.length) { setStatus("Couldn't publish. Your access may have changed; try signing out and back in.", "err"); return; }
  SAVED = structuredClone(S); dirty = false; setStatus(`Published ${fmtWhen(new Date())}. The website shows it now.`, "okc");
});
$("discard").addEventListener("click", () => { if (!dirty) return; S = structuredClone(SAVED); dirty = false; draw(); setStatus("Changes discarded."); });
window.addEventListener("beforeunload", e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

/* ---------------- replies ---------------- */
async function drawReplies(){
  const {data, error} = await sb.from("replies").select("*").order("created_at", {ascending: false}).limit(500);
  if (tab !== "replies") return;
  if (error) { content.innerHTML = `<p class="hint err">Replies couldn't be loaded.</p>`; return; }
  const tText = id => String((S.thoughts?.items || []).find(t => t.id === id)?.text || "(removed post)").slice(0,60);
  content.innerHTML = data.length ? `<p class="hint">${data.length} ${data.length === 1 ? "reply" : "replies"} from visitors. Removing one takes it off the website right away.</p>
    <div class="scroll"><table class="tbl"><thead><tr><th>On</th><th>From</th><th>Reply</th><th>When</th><th></th></tr></thead><tbody>
    ${data.map(r => `<tr><td class="num" style="white-space:normal;max-width:180px">${esc(tText(r.thought_id))}</td><td>${esc(r.name)}</td><td>${esc(r.body)}</td><td class="num">${esc(fmtWhen(r.created_at))}</td>
      <td><button class="btn danger sm" type="button" data-del-reply="${esc(r.id)}">Remove</button></td></tr>`).join("")}</tbody></table></div>`
    : `<div class="empty">No replies yet. They'll show here when visitors reply to your Thoughts.</div>`;
}
/* ---------------- subscribers ---------------- */
let SUBS = [];
async function drawSubscribers(){
  const {data, error} = await sb.from("subscribers").select("*").order("created_at", {ascending: false});
  if (tab !== "subscribers") return;
  if (error) { content.innerHTML = `<p class="hint err">Subscribers couldn't be loaded.</p>`; return; }
  SUBS = data;
  const daily = data.filter(s => s.frequency === "daily").length;
  content.innerHTML = `<div class="stats"><div class="stat"><b>${data.length}</b><span>Total</span></div><div class="stat"><b>${daily}</b><span>Daily</span></div><div class="stat"><b>${data.length - daily}</b><span>Weekly</span></div></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn ghost" type="button" id="export-csv" ${data.length ? "" : "disabled"}>Download as CSV</button></div>
    <p class="hint">Upload the CSV to an email tool (Beehiiv, Kit, Mailchimp) when you're ready to send.</p>
    ${data.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>Email</th><th>Name</th><th>How often</th><th>Joined</th><th></th></tr></thead><tbody>
    ${data.map(s => `<tr><td>${esc(s.email)}</td><td>${esc(s.name || "")}</td><td>${s.frequency === "daily" ? "Daily" : "Weekly"}</td><td class="num">${esc(fmtWhen(s.created_at))}</td>
      <td><button class="btn danger sm" type="button" data-del-sub="${esc(s.id)}">Remove</button></td></tr>`).join("")}</tbody></table></div>`
    : `<div class="empty">No subscribers yet.</div>`}`;
}
/* ---------------- users ---------------- */
async function drawUsers(){
  if (role !== "super_admin") { content.innerHTML = `<p class="hint">Only super admins can manage access.</p>`; return; }
  const {data, error} = await sb.from("profiles").select("*").order("created_at", {ascending: true});
  if (tab !== "users") return;
  if (error) { content.innerHTML = `<p class="hint err">Users couldn't be loaded.</p>`; return; }
  const pending = data.filter(u => u.role === "pending");
  content.innerHTML = `
    <div class="notice"><strong>How access works.</strong> <span class="hint" style="display:block;margin-top:4px">People request access at <strong>${esc(location.origin)}/admin</strong> with their email. They can't change anything until you give them a role here.<br>
    <b>Admin</b>: edits the website, photos, replies and subscribers. <b>Super admin</b>: everything, plus this page. There must always be at least one super admin.</span></div>
    ${pending.length ? `<p class="hint" style="color:var(--gold)">${pending.length} ${pending.length === 1 ? "person is" : "people are"} waiting for approval.</p>` : ""}
    <div class="scroll"><table class="tbl"><thead><tr><th>Email</th><th>Role</th><th>Joined</th></tr></thead><tbody>
    ${data.map(u => `<tr><td>${esc(u.email)}${u.id === me.id ? ` <span class="chip muted">You</span>` : ""}</td>
      <td>${u.id === me.id ? `<span class="chip">${ROLE_LABEL[u.role]}</span>`
        : `<label class="sr" for="role-${esc(u.id)}" style="position:absolute;left:-9999px">Role for ${esc(u.email)}</label><select id="role-${esc(u.id)}" data-role-for="${esc(u.id)}">${["pending","admin","super_admin"].map(r => `<option value="${r}" ${u.role===r?"selected":""}>${ROLE_LABEL[r]}</option>`).join("")}</select>`}</td>
      <td class="num">${esc(fmtWhen(u.created_at))}</td></tr>`).join("")}</tbody></table></div>
    <p class="hint" id="users-msg" role="status" aria-live="polite"></p>`;
}
async function refreshPendingCount(){
  const {count} = await sb.from("profiles").select("id", {count: "exact", head: true}).eq("role", "pending");
  const b = document.getElementById("pending-badge"); if (b) b.innerHTML = count ? `<span class="chip" style="margin-left:6px">${count}</span>` : "";
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
  const {error} = r ? await sb.from("replies").delete().eq("id", r.dataset.delReply) : await sb.from("subscribers").delete().eq("id", s.dataset.delSub);
  if (error) { b.textContent = "Couldn't remove"; return; }
  draw();
});
content.addEventListener("click", e => {
  if (e.target.id !== "export-csv") return;
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = ["email,name,frequency,joined", ...SUBS.map(s => [s.email, s.name, s.frequency, s.created_at].map(q).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], {type: "text/csv"}));
  a.download = `subscribers-${today()}.csv`; document.body.appendChild(a); a.click(); a.remove();
});
content.addEventListener("change", async e => {
  const sel = e.target.closest("[data-role-for]"); if (!sel) return;
  const msg = $("users-msg"); sel.disabled = true; msg.textContent = "Saving…"; msg.className = "hint";
  const {data, error} = await sb.from("profiles").update({role: sel.value}).eq("id", sel.dataset.roleFor).select("id");
  sel.disabled = false;
  if (error || !data?.length) { msg.textContent = /super admin/i.test(error?.message || "") ? "There must always be at least one super admin." : "That change didn't save."; msg.className = "hint err"; drawUsers(); return; }
  msg.textContent = `Access updated to ${ROLE_LABEL[sel.value]}.`; msg.className = "hint okc"; refreshPendingCount();
});
content.addEventListener("submit", async e => {
  if (e.target.id !== "pw-form") return;
  e.preventDefault();
  const password = $("pw-new").value, msg = $("pw-msg");
  if (password.length < 8) { msg.textContent = "Use at least 8 characters."; msg.className = "hint err"; return; }
  const {error} = await sb.auth.updateUser({password});
  msg.textContent = error ? error.message : "Password updated."; msg.className = error ? "hint err" : "hint okc";
  if (!error) $("pw-new").value = "";
});

boot();
})();
