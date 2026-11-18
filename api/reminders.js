/* Daily reminder email for each person on the team (runs every morning via a Vercel scheduled job).
   Lists: overdue tasks, tasks due today/tomorrow, content going out today, tasks waiting for your review,
   and today's events — all in that person's own time zone. Nothing is sent to people with nothing on.
   Needs Vercel environment variables: CRON_SECRET, GMAIL_USER, GMAIL_APP_PASSWORD, FIREBASE_SERVICE_ACCOUNT. */
const nodemailer = require("nodemailer");
const {serviceAccount, googleToken, listAll} = require("./_google");

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const dayIn = (ms, tz) => new Intl.DateTimeFormat("en-CA", {timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date(ms));
const timeIn = (ms, tz) => new Date(ms).toLocaleTimeString("en-US", {timeZone: tz, hour: "numeric", minute: "2-digit"});
const prettyDay = s => new Date(s + "T12:00:00Z").toLocaleDateString("en-US", {weekday: "short", month: "short", day: "numeric", timeZone: "UTC"});
function tzOffsetMin(ms, tz){
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"}).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms) / 60000;
}
function zonedToUtc(date, time, tz){
  const [y, mo, d] = date.split("-").map(Number), [h, mi] = (time || "00:00").split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi); const t = guess - tzOffsetMin(guess, tz) * 60000;
  return guess - tzOffsetMin(t, tz) * 60000;
}
const startMs = e => e.allDay || !e.start ? null : e.startAt ? Date.parse(e.startAt) : zonedToUtc(e.date, e.start, e.tz || "America/New_York");

function digestFor(u, tasks, events, people, now){
  const tz = u.tz || "America/New_York", today = dayIn(now, tz), tomorrow = dayIn(now + 864e5, tz);
  const open = tasks.filter(t => t.assignee === u.id && t.status !== "done");
  const name = id => (people[id] && (people[id].name || people[id].email)) || "someone";
  const out = {
    overdue: open.filter(t => t.due && t.due < today),
    dueToday: open.filter(t => t.due === today),
    dueTomorrow: open.filter(t => t.due === tomorrow),
    posting: tasks.filter(t => t.postDate === today && t.status !== "idea" && (t.assignee === u.id || t.reporter === u.id)),
    review: tasks.filter(t => t.reporter === u.id && t.assignee !== u.id && t.status === "review"),
    events: events.filter(e => (e.attendees || []).includes(u.id) && (startMs(e) ? dayIn(startMs(e), tz) === today : e.date === today))
      .sort((a, b) => (startMs(a) || 0) - (startMs(b) || 0))
  };
  const count = Object.values(out).reduce((n, l) => n + l.length, 0);
  if (!count) return null;
  const sec = (title, items) => !items.length ? "" : `<h3 style="font-family:Georgia,serif;color:#d4af5a;font-size:16px;margin:20px 0 6px">${title}</h3><ul style="margin:0;padding-left:18px;line-height:1.7">${items.join("")}</ul>`;
  const li = s => `<li>${s}</li>`;
  const html = sec("⚠️ Overdue", out.overdue.map(t => li(`${esc(t.title)} <span style="color:#a59d8e">(was due ${esc(prettyDay(t.due))})</span>`)))
    + sec("⏰ Due today", out.dueToday.map(t => li(esc(t.title))))
    + sec("📅 Today's events", out.events.map(e => li(`${startMs(e) ? `<strong>${esc(timeIn(startMs(e), tz))}</strong> · ` : "All day · "}${esc(e.title)}`)))
    + sec("📣 Going out today", out.posting.map(t => li(`${esc(t.title)}${(t.platforms || []).length ? ` <span style="color:#a59d8e">(${esc(t.platforms.join(", "))})</span>` : ""}`)))
    + sec("👀 Waiting for your review", out.review.map(t => li(`${esc(t.title)} <span style="color:#a59d8e">from ${esc(name(t.assignee))}</span>`)))
    + sec("Coming up tomorrow", out.dueTomorrow.map(t => li(`${esc(t.title)} is due`)));
  const subject = out.overdue.length ? `${out.overdue.length} overdue · your A·A·O day` : `Your A·A·O day: ${count} thing${count === 1 ? "" : "s"} on`;
  return {subject, html, count, today};
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || String(req.headers.authorization || "") !== `Bearer ${secret}`) return res.status(401).json({error: "Not allowed"});
  const sa = serviceAccount(), user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
  if (!sa || !user || !pass) return res.status(503).json({error: "Reminders need FIREBASE_SERVICE_ACCOUNT, GMAIL_USER and GMAIL_APP_PASSWORD in Vercel."});
  let token, users, tasks, events;
  try { token = await googleToken(sa); [users, tasks, events] = await Promise.all([listAll(token, "users"), listAll(token, "tasks"), listAll(token, "events")]); }
  catch (e) { return res.status(502).json({error: "Couldn't read the workspace. Check FIREBASE_SERVICE_ACCOUNT."}); }
  const people = Object.fromEntries(users.map(u => [u.id, u]));
  const site = process.env.SITE_URL || `https://${req.headers.host}`;
  const mail = nodemailer.createTransport({service: "gmail", auth: {user, pass}});
  const now = Date.now(); let sent = 0, skipped = 0;
  for (const u of users) {
    if (!["admin", "super_admin"].includes(u.role) || !u.email || u.emailOff) { skipped++; continue; }
    const d = digestFor(u, tasks, events, people, now);
    if (!d) { skipped++; continue; }
    try {
      await mail.sendMail({from: `"A·A·O Workspace" <${user}>`, to: u.email, subject: d.subject,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;background:#0b0a08;color:#f2ece0;border:1px solid #a88b4a">
          <p style="font-family:Georgia,serif;color:#d4af5a;letter-spacing:4px;margin:0 0 6px">A · A · O</p>
          <p style="margin:0;color:#a59d8e">Good morning${u.name ? ", " + esc(u.name.split(" ")[0]) : ""}. Here's ${esc(prettyDay(d.today))}.</p>${d.html}
          <p style="margin:26px 0 0"><a href="${esc(site)}/admin/" style="display:inline-block;background:#d4af5a;color:#0b0a08;padding:12px 18px;text-decoration:none;font-weight:bold;letter-spacing:1px">OPEN THE WORKSPACE</a></p></div>`,
        text: `Your A·A·O day (${d.today}). Open the workspace: ${site}/admin/`});
      sent++;
    } catch { skipped++; }
  }
  return res.json({ok: true, sent, skipped});
};
module.exports.digestFor = digestFor;
