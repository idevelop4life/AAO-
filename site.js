/* Public website script: renders content, loads the latest from the database, handles replies and subscriptions. */
(() => {
const FALLBACK = JSON.parse(document.getElementById("site-data").textContent);
let S = FALLBACK;
let REPLIES = [];

const CFG = (window.SITE_CONFIG || {}).firebase || {};
let fb = null;
try { if (CFG.apiKey && CFG.projectId && window.firebase) { firebase.initializeApp(CFG); fb = firebase.firestore(); } } catch { fb = null; }
const sb = fb; /* replies + subscribe UI turn on when the database is connected */
const MEDIA = {};

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const safeUrl = u => { u = String(u || "").trim(); if (!u) return ""; return /^(https?:|mailto:|\/)/i.test(u) ? u : "https://" + u.replace(/^\/+/, ""); };
const imgSrc = u => { u = String(u || "").trim(); if (u.startsWith("media:")) return MEDIA[u.slice(6)] || ""; return /^(https?:|\/|data:image\/)/i.test(u) || (/^[\w./-]+$/.test(u) && !u.includes("..")) ? u : ""; };
const gold = t => esc(t).replace(/\*([^*]+)\*/g, "<em>$1</em>");
const plain = t => String(t || "").replace(/\*/g, "");
const arr = a => Array.isArray(a) ? a : [];

const ICONS = {
  instagram:'<path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 8.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4ZM17.3 5.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4ZM12 2c-2.7 0-3 0-4.1.1C4.3 2.3 2.3 4.3 2.1 7.9 2 9 2 9.3 2 12s0 3 .1 4.1c.2 3.6 2.2 5.6 5.8 5.8 1.1.1 1.4.1 4.1.1s3 0 4.1-.1c3.6-.2 5.6-2.2 5.8-5.8.1-1.1.1-1.4.1-4.1s0-3-.1-4.1c-.2-3.6-2.2-5.6-5.8-5.8C15 2 14.7 2 12 2Zm0 1.8c2.7 0 3 0 4 .1 2.7.1 4 1.4 4.1 4.1.1 1 .1 1.3.1 4s0 3-.1 4c-.1 2.7-1.4 4-4.1 4.1-1 .1-1.3.1-4 .1s-3 0-4-.1c-2.7-.1-4-1.4-4.1-4.1-.1-1-.1-1.3-.1-4s0-3 .1-4C3.9 5.3 5.3 4 8 3.9c1-.1 1.3-.1 4-.1Z"/>',
  tiktok:'<path d="M16.6 2h-3.4v13.4a2.9 2.9 0 1 1-2.9-2.9c.3 0 .6 0 .8.1V9.1a6.3 6.3 0 1 0 5.5 6.3V8.6a8 8 0 0 0 4.4 1.3V6.5a4.4 4.4 0 0 1-4.4-4.5Z"/>',
  x:'<path d="M17.8 3h3.1l-6.8 7.8L22 21h-6.2l-4.9-6.4L5.3 21H2.2l7.3-8.3L2 3h6.4l4.4 5.8L17.8 3Zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5Z"/>',
  linkedin:'<path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM3 9.75h4V21H3V9.75Zm6.5 0h3.8v1.6h.06c.53-1 1.83-2.05 3.77-2.05 4.03 0 4.77 2.65 4.77 6.1V21h-4v-4.9c0-1.17-.02-2.68-1.63-2.68-1.64 0-1.89 1.28-1.89 2.6V21h-4V9.75Z"/>',
  youtube:'<path d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12a31 31 0 0 0 .5 4.8 3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .5-4.8 31 31 0 0 0-.5-4.8ZM9.8 15V9l5.8 3-5.8 3Z"/>',
  facebook:'<path d="M14 8V6.2c0-.8.2-1.2 1.4-1.2H17V2h-2.6C11.3 2 10 3.5 10 6v2H8v3h2v11h4V11h2.6l.4-3H14Z"/>',
  threads:'<path d="M12.2 22c-3 0-5.3-1-6.8-2.9C4 17.4 3.3 15 3.3 12s.7-5.4 2.1-7.1C6.9 3 9.2 2 12.2 2c2.3 0 4.2.6 5.6 1.8 1.3 1.1 2.2 2.7 2.7 4.6l-2.1.6C17.6 6 15.5 4 12.2 4 10 4 8.3 4.7 7.2 6 6.2 7.4 5.6 9.4 5.6 12s.6 4.6 1.6 6c1.1 1.3 2.8 2 5 2 2 0 3.3-.5 4.4-1.5 1.2-1.2 1.2-2.6.8-3.6-.2-.6-.7-1.1-1.3-1.5-.2 1.3-.6 2.4-1.3 3.2-.9 1.1-2.2 1.7-3.8 1.8-1.2.1-2.4-.2-3.3-.8-1-.7-1.6-1.7-1.7-2.9-.1-2.3 1.8-4 4.7-4.2 1-.1 2 0 2.9.1-.1-.7-.4-1.3-.8-1.7-.5-.5-1.3-.8-2.3-.8-1.3 0-2.1.4-2.6 1.2l-1.7-1.1C8.9 6.9 10.2 6.3 12 6.3c1.6 0 2.9.5 3.8 1.4.8.9 1.2 2.1 1.3 3.6.5.2 1 .5 1.4.8 1 .8 1.8 1.8 2.1 3 .7 2 .2 4.3-1.4 5.9-1.5 1.5-3.5 2.2-6.2 2.2h-.8ZM12.6 13c-1.9.1-2.9.9-2.8 1.9.1 1 1.2 1.5 2.4 1.4 1.4-.1 2.7-.8 2.9-3.1-.8-.2-1.6-.3-2.5-.2Z"/>',
  website:'<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm6.9 6h-3a15.7 15.7 0 0 0-1.4-3.9A8 8 0 0 1 18.9 8ZM12 4c.8 1.2 1.5 2.5 1.9 4h-3.8c.4-1.5 1.1-2.8 1.9-4ZM4.3 14a8.2 8.2 0 0 1 0-4h3.4a16.5 16.5 0 0 0 0 4H4.3Zm.8 2h3c.3 1.4.8 2.7 1.4 3.9A8 8 0 0 1 5.1 16Zm3-8h-3a8 8 0 0 1 4.4-3.9C8.9 5.3 8.4 6.6 8.1 8ZM12 20c-.8-1.2-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.8-1.9 4Zm2.3-6H9.7a14.7 14.7 0 0 1 0-4h4.6a14.7 14.7 0 0 1 0 4Zm.2 5.9c.6-1.2 1.1-2.5 1.4-3.9h3a8 8 0 0 1-4.4 3.9Zm1.8-5.9a16.5 16.5 0 0 0 0-4h3.4a8.2 8.2 0 0 1 0 4h-3.4Z"/>'
};
const PLATFORM_NAMES = {instagram:"Instagram", tiktok:"TikTok", x:"X", linkedin:"LinkedIn", youtube:"YouTube", facebook:"Facebook", threads:"Threads", website:"Website"};

function socialsHTML(withHandle){
  return arr(S.socials).filter(s => s && s.url).map(s => {
    const name = PLATFORM_NAMES[s.platform] || "Link";
    return `<li><a href="${esc(safeUrl(s.url))}" rel="me noopener" target="_blank" aria-label="${esc(name)} ${esc(s.handle)}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[s.platform] || ICONS.website}</svg>${esc(name)}${withHandle && s.handle ? ` <span class="h">${esc(s.handle)}</span>` : ""}</a></li>`;
  }).join("");
}
function nameHTML(n){
  if (String(n).includes("*")) return gold(n);
  const parts = String(n || "").trim().split(/\s+/);
  if (parts.length < 2) return esc(n);
  const last = parts.pop();
  return `${esc(parts.join(" "))} <em>${esc(last)}</em>`;
}
const paras = t => String(t || "").split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => `<p>${esc(p).replace(/\n/g,"<br>")}</p>`).join("");
function fmtDate(d){ if (!d) return ""; const t = new Date(String(d).slice(0,10) + "T12:00:00"); return isNaN(t) ? d : t.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}); }
const linkText = u => String(u).replace(/^https?:\/\//,"").replace(/\/$/,"");

function render(){
  const P = S.profile || {}, on = S.sections || {};
  const navItems = [["about","About",true],["building","Building",true],["gallery","Gallery",true],["thoughts","Thoughts",false],["journal","Journal",false],["subscribe","Subscribe",false]].filter(([k]) => on[k]);
  document.getElementById("nav").innerHTML = navItems.map(([k,l,opt]) => `<li${opt?' class="opt"':""}><a href="#${k}">${l}</a></li>`).join("");

  let h = `<section class="hero"><div class="wrap"><div>
    <p class="kicker">${esc(P.kicker)}</p><h1>${nameHTML(P.name)}</h1>
    <p class="lede">${esc(P.tagline)}</p>
    <ul class="socials" aria-label="Social links">${socialsHTML(true)}</ul></div>
    ${imgSrc(P.photo) ? `<figure class="portrait"><img src="${esc(imgSrc(P.photo))}" alt="${esc(P.photoAlt)}"></figure>` : ""}
  </div></section>`;

  if (on.about && S.about){ const A = S.about; h += `<section class="block" id="about"><div class="wrap">
    <div class="sec-head"><span class="label">About</span><h2>${esc(A.heading)}</h2></div>
    <div class="about${imgSrc(A.photo) ? "" : " solo indent"}">
      ${imgSrc(A.photo) ? `<figure class="cutout"><img src="${esc(imgSrc(A.photo))}" alt="${esc(A.photoAlt)}" loading="lazy"></figure>` : ""}
      <div>${A.lead ? `<p class="big">${esc(A.lead)}</p>` : ""}${arr(A.paragraphs).filter(Boolean).map(p => `<p>${esc(p)}</p>`).join("")}
      ${arr(A.facts).length ? `<dl class="facts">${arr(A.facts).map(f => `<div><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join("")}</dl>` : ""}</div>
    </div></div></section>`; }

  if (on.building && S.building){ const B = S.building; h += `<section class="block" id="building"><div class="wrap">
    <div class="sec-head"><span class="label">Building</span><h2>${esc(B.heading)}</h2></div>
    <div class="ventures">${arr(B.items).map(v => v.featured
      ? `<article class="venture lead"><div><span class="st">${esc(v.status)}</span><h3>${gold(v.name)}</h3></div><div><p>${esc(v.description)}</p>${v.link ? `<div class="cta-row">${v.ctaText ? `<a class="btn" href="${esc(safeUrl(v.link))}" target="_blank" rel="noopener">${esc(v.ctaText)}</a>` : ""}<a href="${esc(safeUrl(v.link))}" target="_blank" rel="noopener">${esc(linkText(v.link))} →</a></div>` : ""}</div></article>`
      : `<article class="venture"><span class="st">${esc(v.status)}</span><h3>${gold(v.name)}</h3><p>${esc(v.description)}</p>${v.link ? `<a href="${esc(safeUrl(v.link))}" target="_blank" rel="noopener">${esc(linkText(v.link))} →</a>` : ""}</article>`).join("")}</div>
    </div></section>`; }

  if (on.interests && S.interests){ const I = S.interests; h += `<section class="block" id="interests"><div class="wrap">
    <div class="sec-head"><span class="label">Interests</span><h2>${esc(I.heading)}</h2></div>
    <div class="interests">${arr(I.items).map(i => `<div class="interest"><h3>${esc(i.title)}</h3><p>${esc(i.text)}</p></div>`).join("")}</div>
    </div></section>`; }

  if (on.gallery && S.gallery){ const G = S.gallery, pics = arr(G.items).map((g,i) => [g,i]).filter(([g]) => imgSrc(g.src));
    h += `<section class="block" id="gallery"><div class="wrap">
    <div class="sec-head"><span class="label">Gallery</span><h2>${esc(G.heading)}</h2></div>
    ${pics.length ? `<div class="gallery">${pics.map(([g,i]) => `<figure><button type="button" class="ph" data-photo="${i}" aria-label="Open photo${g.caption ? ": " + esc(g.caption) : ""}"><img src="${esc(imgSrc(g.src))}" alt="${esc(g.caption)}" loading="lazy"></button>${g.caption ? `<figcaption>${esc(g.caption)}</figcaption>` : ""}</figure>`).join("")}</div>`
      : `<p class="hint indent">Photos coming soon.</p>`}
    </div></section>`; }

  if (on.thoughts && S.thoughts){ const T = S.thoughts;
    const who = plain(P.name).split(" ")[0];
    const handle = (arr(S.socials).find(s => s.platform === "x") || arr(S.socials)[0] || {}).handle || "";
    const items = [...arr(T.items)].sort((a,b) => String(b.date).localeCompare(String(a.date)));
    h += `<section class="block" id="thoughts"><div class="wrap">
    <div class="sec-head"><span class="label">Thoughts</span><h2>${esc(T.heading)}</h2></div>
    <div class="feed indent">${items.map(t => `<article class="thought">
      <header>${imgSrc(P.photo) ? `<img class="av" src="${esc(imgSrc(P.photo))}" alt="">` : ""}<p><strong>${esc(who)}</strong> <span class="mut">${esc(handle)} · ${esc(fmtDate(t.date))}</span></p></header>
      <p class="tx">${esc(t.text).replace(/\n/g,"<br>")}</p>
      <div class="acts">${sb ? `<button class="lnk" type="button" data-reply-toggle="${esc(t.id)}">Reply</button>` : ""}${t.xUrl ? `<a href="${esc(safeUrl(t.xUrl))}" target="_blank" rel="noopener">Reply on X →</a>` : ""}<span class="mut" data-count="${esc(t.id)}"></span></div>
      <ul class="replies" data-replies="${esc(t.id)}"></ul>
      ${sb ? `<form class="reply-form" data-reply-form="${esc(t.id)}" hidden>
        <label class="sr" for="rn-${esc(t.id)}">Your name</label><input class="rname" id="rn-${esc(t.id)}" maxlength="60" placeholder="Your name" required autocomplete="name">
        <label class="sr" for="r-${esc(t.id)}">Your reply</label><textarea id="r-${esc(t.id)}" maxlength="500" placeholder="Write a reply…" required></textarea>
        <input class="hp" tabindex="-1" autocomplete="off" aria-hidden="true" name="website">
        <div class="row"><button class="btn sm" type="submit">Post reply</button><span class="rmsg mut" role="status"></span></div></form>` : ""}
    </article>`).join("") || `<p class="hint">Nothing here yet.</p>`}</div>
    </div></section>`; }

  const Qcur = S.quote ? (arr(S.quote.items).find(q => q && q.text) || (S.quote.text ? S.quote : null)) : null;
  if (on.quote && Qcur){ const Q = {label: S.quote.label, text: Qcur.text, by: Qcur.by}; h += `<section class="quote" aria-label="Quote"><div class="wrap">
    <div class="sec-head" style="margin-bottom:28px"><span class="label">${esc(Q.label)}</span><span></span></div>
    <div class="indent"><blockquote>${esc(Q.text)}</blockquote>${Q.by ? `<p class="by">${esc(Q.by)}</p>` : ""}</div>
    </div></section>`; }

  if (on.journal && S.journal){ const J = S.journal; const visible = arr(J.posts).map((p,i) => [p,i]).filter(([p]) => p.status !== "draft");
    h += `<section class="block" id="journal"><div class="wrap">
    <div class="sec-head"><span class="label">Journal</span><h2>${esc(J.heading)}</h2></div>
    <div class="posts">${visible.map(([p,i]) => {
      const meta = [p.status === "soon" ? "Coming soon" : fmtDate(p.date), p.category].filter(Boolean).join(" · ");
      return `<article class="post"><span class="meta">${esc(meta)}</span><h3>${esc(p.title)}</h3><p>${esc(p.excerpt)}</p>${p.status === "published" && p.body ? `<button class="read" type="button" data-read="${i}">Read post →</button>` : ""}</article>`;
    }).join("") || `<p class="hint">New posts are on the way.</p>`}</div>
    </div></section>`; }

  if (on.subscribe && S.subscribe){ const U = S.subscribe; h += `<section class="block" id="subscribe"><div class="wrap sub">
    <div class="intro"><div class="sec-head" style="grid-template-columns:1fr;gap:10px;margin:0"><span class="label">Subscribe</span><h2>${esc(U.heading)}</h2></div><p>${esc(U.text)}</p></div>
    <form class="signup" id="signup" novalidate>
      <label class="field" for="sub-name">First name<input type="text" id="sub-name" name="name" autocomplete="given-name" placeholder="Your first name"></label>
      <label class="field" for="sub-email">Email<input type="email" id="sub-email" name="email" autocomplete="email" placeholder="you@example.com" required></label>
      <fieldset><legend>How often?</legend><div class="freq">
        <div><input type="radio" id="freq-daily" name="frequency" value="daily"><label for="freq-daily"><strong>Daily</strong><span>${esc(U.dailyNote)}</span></label></div>
        <div><input type="radio" id="freq-weekly" name="frequency" value="weekly" checked><label for="freq-weekly"><strong>Weekly</strong><span>${esc(U.weeklyNote)}</span></label></div>
      </div></fieldset>
      <button class="btn" type="submit" id="sub-btn">Subscribe</button>
      <p class="msg" id="sub-msg" role="status" aria-live="polite"></p>
    </form></div></section>`; }

  document.getElementById("top").innerHTML = h;
  document.getElementById("foot-line").textContent = `© ${new Date().getFullYear()} ${plain(P.name)} · ${(P.kicker || "").split("·")[0].trim()}`;
  document.getElementById("foot-socials").innerHTML = socialsHTML(false);
  renderReplies();
}

/* reader / lightbox */
const reader = document.getElementById("reader");
function showReader(wide){ document.getElementById("reader-body").classList.toggle("wide", wide); reader.hidden = false; document.body.style.overflow = "hidden"; document.getElementById("reader-close").focus(); }
function closeReader(){ reader.hidden = true; document.body.style.overflow = ""; }
function openPost(i){
  const p = arr(S.journal && S.journal.posts)[i]; if (!p) return;
  document.getElementById("reader-body").innerHTML = `<span class="meta">${esc([fmtDate(p.date), p.category].filter(Boolean).join(" · "))}</span><h2 id="reader-title">${esc(p.title)}</h2>${paras(p.body)}`;
  showReader(false);
}
function openPhoto(i){
  const g = arr(S.gallery && S.gallery.items)[i]; if (!g) return;
  document.getElementById("reader-body").innerHTML = `<figure class="lb"><img src="${esc(imgSrc(g.src))}" alt="${esc(g.caption)}">${g.caption ? `<figcaption id="reader-title">${esc(g.caption)}</figcaption>` : ""}</figure>`;
  showReader(true);
}
document.getElementById("reader-close").addEventListener("click", closeReader);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !reader.hidden) closeReader(); });

/* replies */
const timeAgo = iso => { const d = new Date(iso); if (isNaN(d)) return ""; const s = (Date.now() - d) / 1000;
  if (s < 60) return "just now"; if (s < 3600) return Math.floor(s/60) + "m"; if (s < 86400) return Math.floor(s/3600) + "h";
  return d.toLocaleDateString("en-US",{month:"short",day:"numeric"}); };
function renderReplies(){
  document.querySelectorAll("[data-replies]").forEach(ul => {
    const tid = ul.dataset.replies, list = REPLIES.filter(r => r.thought_id === tid);
    ul.innerHTML = list.map(r => `<li><p class="who"><strong>${esc(r.name)}</strong> <span class="mut">· ${esc(timeAgo(r.created_at))}</span></p><p>${esc(r.body)}</p></li>`).join("");
    const c = document.querySelector(`[data-count="${CSS.escape(tid)}"]`);
    if (c) c.textContent = list.length ? `${list.length} ${list.length === 1 ? "reply" : "replies"}` : "";
  });
}
async function loadReplies(){
  if (!fb) return;
  try {
    const snap = await fb.collection("replies").orderBy("createdAt", "asc").limit(1000).get();
    REPLIES = snap.docs.map(d => { const r = d.data(); return {id: d.id, thought_id: r.thoughtId, name: r.name, body: r.body, created_at: r.createdAt && r.createdAt.toDate ? r.createdAt.toDate().toISOString() : ""}; });
    renderReplies();
  } catch {}
}
async function postReply(form){
  const tid = form.dataset.replyForm, msg = form.querySelector(".rmsg"), btn = form.querySelector("button");
  if (form.querySelector(".hp").value) return;
  const name = form.querySelector(".rname").value.trim().slice(0,60), body = form.querySelector("textarea").value.trim().slice(0,500);
  if (!name || !body) { msg.textContent = "Add your name and a reply."; return; }
  btn.disabled = true; msg.textContent = "Posting…";
  try { await fb.collection("replies").add({thoughtId: tid, name, body, createdAt: firebase.firestore.FieldValue.serverTimestamp()}); }
  catch { btn.disabled = false; msg.textContent = "That didn't post. Please try again."; return; }
  btn.disabled = false;
  try { localStorage.setItem("reply-name", name); } catch {}
  form.querySelector("textarea").value = ""; form.hidden = true; msg.textContent = "";
  loadReplies();
}

/* clicks and forms */
const main = document.getElementById("top");
main.addEventListener("click", e => {
  const b = e.target.closest("[data-read],[data-photo],[data-reply-toggle]"); if (!b) return;
  if (b.dataset.read) openPost(+b.dataset.read);
  if (b.dataset.photo) openPhoto(+b.dataset.photo);
  if (b.dataset.replyToggle) {
    const f = document.querySelector(`[data-reply-form="${CSS.escape(b.dataset.replyToggle)}"]`);
    if (f) { f.hidden = !f.hidden; if (!f.hidden) { const n = f.querySelector(".rname"); try { n.value = n.value || localStorage.getItem("reply-name") || ""; } catch {} (n.value ? f.querySelector("textarea") : n).focus(); } }
  }
});
main.addEventListener("submit", async e => {
  e.preventDefault();
  if (e.target.dataset.replyForm) return postReply(e.target);
  if (e.target.id !== "signup") return;
  const email = document.getElementById("sub-email").value.trim();
  const msg = document.getElementById("sub-msg");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = "Please enter a valid email address."; document.getElementById("sub-email").focus(); return; }
  const frequency = document.querySelector("input[name=frequency]:checked").value;
  const name = document.getElementById("sub-name").value.trim();
  const btn = document.getElementById("sub-btn");
  const url = (S.subscribe || {}).url;
  if (!url && !sb) { msg.textContent = "Subscriptions open soon. Check back shortly!"; return; }
  btn.disabled = true; msg.textContent = "Signing you up…";
  try {
    if (url) {
      const r = await fetch(url, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({email, name, frequency})});
      if (!r.ok) throw 0;
    } else {
      const em = email.toLowerCase();
      try { await fb.collection("subscribers").doc(em).set({email: em, name: name.slice(0,80), frequency, createdAt: firebase.firestore.FieldValue.serverTimestamp()}); }
      catch (err) { if (err && err.code !== "permission-denied") throw err; /* already subscribed */ }
    }
    msg.textContent = "You're on the list. Thank you!"; e.target.reset();
  } catch { msg.textContent = "That didn't go through. Please try again in a moment."; }
  finally { btn.disabled = false; }
});

render();

/* Load the latest content (and any uploaded photos) from the database. */
async function loadMedia(obj){
  const ids = [...new Set((JSON.stringify(obj).match(/"media:[\w-]+"/g) || []).map(m => m.slice(7, -1)))].filter(id => !(id in MEDIA));
  await Promise.all(ids.map(id => fb.collection("media").doc(id).get().then(d => { MEDIA[id] = d.exists ? d.data().data : ""; }).catch(() => {})));
}
if (fb) {
  (async () => {
    try {
      const snap = await fb.doc("site/content").get();
      const d = snap.exists ? snap.data().data : null;
      if (d && typeof d === "object") {
        await loadMedia(d);
        S = {...FALLBACK, ...d, sections: {...FALLBACK.sections, ...(d.sections || {})}};
        render();
      }
    } catch {}
    loadReplies();
  })();
}
})();
