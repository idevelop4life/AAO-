/* Guided tour of the admin.
   Walks through the real screens with a spotlight and a small card (Back / Next / Skip).
   Starts by itself the first time someone signs in on a device; restart it anytime with
   "Take the tour" on My overview or the "?" button in the top bar.
   Steps someone has no access to are skipped automatically. */
(() => {
  const A = () => window.__ADMIN;
  const KEY = () => "aao-tour-done-" + (A().me ? A().me.uid : "");
  const isSuper = () => A().role === "super_admin";
  const has = k => A().can(k);
  const firstSiteTab = () => ["profile", "socials", "about", "building", "interests", "gallery", "thoughts", "quote", "journal", "subscribe"].find(has);
  const wide = () => window.innerWidth > 900;

  /* tab: page to open first; el: what to point at (falls back to a centred card when it's not on screen) */
  const STEPS = [
    {tab: "account", el: null, title: "Welcome to the A·A·O admin 👋", text: "This quick tour shows you around. It takes about a minute. Use Next and Back, or press the arrow keys. You can skip at any time."},
    {tab: "account", el: ".me-hero", title: "My overview", text: "This is your home base. You land here every time you sign in."},
    {tab: "account", el: "#me-summary", title: "Your week", text: "Your tasks, upcoming events and new messages, all in one place. Click any item to open it.", need: () => has("ws_tasks") || has("ws_calendar") || has("ws_chat")},
    {tab: "account", el: "#side .mark", title: "Back to your overview", text: "Click the A·A·O ADMIN logo anytime to come back here.", desk: true},
    {tab: "account", el: "#tabs", title: "The menu", text: "Workspace, Website and Access. You only see the sections you've been given.", desk: true},
    {tab: "account", el: "#menu-btn", title: "The menu", text: "Tap Menu to see the sections you've been given: Workspace, Website and Access.", mobile: true},
    {tab: "account", el: "#me-bubble", title: "Your status", text: "Click your photo to show if you're online, busy or away, and add a short note like “Filming till 3”.", need: () => !!document.querySelector("#me-bubble-wrap:not([hidden])")},
    {tab: "account", el: "#bell", title: "Notifications", text: "New tasks, messages, notices and reminders show up here. Click one to jump straight to it."},
    {tab: "ws_notices", el: "#content", title: "Notices", text: "The team notice board for announcements, schedules and policies. Notices can include videos and photos. Click “Got it” once you've read one.", need: () => has("ws_notices")},
    {tab: "ws_tasks", el: ".board", title: "Tasks", text: "Our project board. Work moves from Ideas → To do → In progress → Review → Scheduled → Done. Drag cards, or open one to update it.", need: () => has("ws_tasks")},
    {tab: "ws_tasks", el: "[data-new-task]", title: "New task", text: "Add a title, who it's for and a due date. For content, tick the platforms and set a post date so it shows on the content calendar.", need: () => has("ws_tasks")},
    {tab: "ws_tasks", el: null, title: "Working on a task", text: "Open a task to tick off its checklist, attach drafts or Canva links, and click “Submit for review”. Only the person who created a task can edit or reassign it.", need: () => has("ws_tasks")},
    {tab: "ws_calendar", el: "[data-cal-show]", title: "Calendar", text: "Meetings, due dates and content going out. Switch to “Content calendar” to see what's posting where. Times always show in your own time zone.", need: () => has("ws_calendar")},
    {tab: "ws_chat", el: "#content", title: "Chat", text: "Message one person or a group. Use 😊 for emojis and press Enter to send.", need: () => has("ws_chat")},
    {tab: "ws_tasks", el: ".cd-launch", title: "Chat from anywhere", text: "The tiger button opens your chats from any page, in small windows, so you can keep working.", need: () => has("ws_chat") && has("ws_tasks")},
    {tab: "ws_docs", el: "#content", title: "Documents", text: "Shared files, organised in folders. 🔒 means a folder is private, so only the people chosen can see it.", need: () => has("ws_docs")},
    {tab: "ws_team", el: "#content", title: "Team", text: "Everyone on the team, whether they're online, and their local time. Message them or give them a task from here.", need: () => has("ws_team")},
    {tab: () => firstSiteTab(), el: "#content", title: "Editing the website", text: "Website sections change the public site. Make your edits, then click Publish at the bottom. The live site updates within seconds.", need: () => !!firstSiteTab()},
    {tab: "users", el: "#content", title: "Users & access", text: "As a super admin you approve new people, set their role and category, and tick exactly what each person can use.", need: isSuper},
    {tab: "account", el: ".me-security", title: "Your profile & security", text: "Add your photo and display name above. Here you can change your password, or ask to change your email."},
    {tab: "account", el: "#tour-btn", title: "You're all set! 🎉", text: "Take this tour again anytime with the ? button. If you get stuck, message a super admin in chat."},
  ];

  let steps = [], i = 0, root = null, target = null;
  const avail = () => STEPS.filter(s => (!s.need || s.need()) && !(s.desk && !wide()) && !(s.mobile && wide()));

  function build(){
    root = document.createElement("div"); root.id = "tour";
    root.innerHTML = `<div class="tour-spot" hidden></div><div class="tour-dim"></div>
      <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title">
        <p class="tour-step"></p><h3 id="tour-title"></h3><p class="tour-text"></p>
        <div class="tour-btns"><button class="btn ghost sm" type="button" data-tour="skip">Skip tour</button>
          <span><button class="btn ghost sm" type="button" data-tour="back">Back</button> <button class="btn sm" type="button" data-tour="next">Next</button></span></div></div>`;
    document.body.appendChild(root);
    root.addEventListener("click", e => { const b = e.target.closest("[data-tour]"); if (!b) return;
      ({next, back, skip: () => end(true)})[b.dataset.tour](); });
  }
  function next(){ if (i >= steps.length - 1) return end(true); show(i + 1); }
  function back(){ if (i > 0) show(i - 1); }
  function keys(e){ if (!root) return; if (e.key === "Escape") end(true); else if (e.key === "ArrowRight") next(); else if (e.key === "ArrowLeft") back(); }

  function show(n){
    i = n; const s = steps[i];
    const t = typeof s.tab === "function" ? s.tab() : s.tab;
    document.getElementById("side")?.classList.remove("open");
    document.getElementById("ws-modal")?.remove();
    const go = () => {
      if (t) A().goto(t);
      setTimeout(() => place(s), 220);
    };
    go();
    root.querySelector(".tour-step").textContent = `Step ${i + 1} of ${steps.length}`;
    root.querySelector("#tour-title").textContent = s.title;
    root.querySelector(".tour-text").textContent = s.text;
    root.querySelector('[data-tour="back"]').hidden = i === 0;
    root.querySelector('[data-tour="next"]').textContent = i === steps.length - 1 ? "Finish" : i === 0 ? "Start the tour" : "Next";
    root.querySelector('[data-tour="skip"]').hidden = i === steps.length - 1;
  }
  function visible(el){ if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; }
  function place(s){
    if (!root) return;
    const card = root.querySelector(".tour-card"), spot = root.querySelector(".tour-spot"), dim = root.querySelector(".tour-dim");
    target = s.el ? document.querySelector(s.el) : null;
    if (target && visible(target)) {
      const big = target.getBoundingClientRect().height > window.innerHeight * .7;
      if (!big) target.scrollIntoView({block: "center"});
    }
    const ok = target && visible(target);
    spot.hidden = !ok; dim.hidden = ok;
    card.classList.toggle("center", !ok);
    if (!ok) { card.style.left = card.style.top = ""; card.focus?.(); return; }
    const r = target.getBoundingClientRect(), pad = 8, vw = window.innerWidth, vh = window.innerHeight;
    const top = Math.max(4, r.top - pad), left = Math.max(4, r.left - pad);
    const h = Math.min(r.height + pad * 2, vh - top - 4), w = Math.min(r.width + pad * 2, vw - left - 4);
    Object.assign(spot.style, {top: top + "px", left: left + "px", width: w + "px", height: h + "px"});
    const cw = Math.min(360, vw - 24), ch = card.offsetHeight || 190;
    let cx, cy;
    if (top + h + ch + 16 < vh) { cy = top + h + 12; cx = left; }                     /* below */
    else if (top - ch - 12 > 0) { cy = top - ch - 12; cx = left; }                   /* above */
    else if (left + w + cw + 16 < vw) { cx = left + w + 12; cy = Math.max(12, Math.min(top, vh - ch - 12)); }   /* right */
    else if (left - cw - 12 > 0) { cx = left - cw - 12; cy = Math.max(12, Math.min(top, vh - ch - 12)); }      /* left */
    else { cx = (vw - cw) / 2; cy = vh - ch - 16; }                                  /* bottom of screen */
    cx = Math.max(12, Math.min(cx, vw - cw - 12));
    Object.assign(card.style, {left: cx + "px", top: cy + "px", width: cw + "px"});
  }
  const relayout = () => { if (root && steps[i]) place(steps[i]); };

  function start(){
    if (!A() || !A().me) return;
    if (root) end(false);
    steps = avail(); if (!steps.length) return;
    build(); document.body.classList.add("touring");
    document.addEventListener("keydown", keys); window.addEventListener("resize", relayout); window.addEventListener("scroll", relayout, true);
    show(0);
  }
  function end(done){
    if (done) { try { localStorage.setItem(KEY(), "1"); } catch {} }
    document.removeEventListener("keydown", keys); window.removeEventListener("resize", relayout); window.removeEventListener("scroll", relayout, true);
    root?.remove(); root = null; document.body.classList.remove("touring");
    if (done && A()) A().goto("account");
  }
  function maybeStart(){
    let seen = false; try { seen = !!localStorage.getItem(KEY()); } catch {}
    if (!seen) setTimeout(start, 900);
  }
  document.addEventListener("click", e => { if (e.target.closest("[data-start-tour]")) start(); });
  window.TOUR = {start, maybeStart, end};
})();
