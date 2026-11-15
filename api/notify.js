/* Sends a Workspace email (new task, comment, invite...) from the Gmail account set in Vercel.
   Needs Vercel environment variables GMAIL_USER and GMAIL_APP_PASSWORD. Until they're set it does nothing.
   Security: the caller must send their Firebase sign-in token; we check it with Google, then read both
   profiles from Firestore *as the caller*, so the database rules still decide who can see whom. */
const nodemailer = require("nodemailer");

const API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyA3koDeC2XMSgkpz_zuJamd9orGBNczD2s";
const PROJECT = process.env.FIREBASE_PROJECT_ID || "aao---project";
const esc = s => String(s || "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({error: "Use POST"});
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return res.status(503).json({error: "Email isn't set up yet"});

  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const to = String(body.to || ""), text = String(body.text || "").slice(0, 300);
  if (!token || !/^[\w-]{6,128}$/.test(to) || !text) return res.status(400).json({error: "Missing details"});

  // 1. Who is asking? (Google checks the sign-in token)
  const look = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({idToken: token})
  });
  if (!look.ok) return res.status(401).json({error: "Not signed in"});
  const caller = ((await look.json()).users || [])[0];
  if (!caller) return res.status(401).json({error: "Not signed in"});

  // 2. Read profiles from Firestore as the caller (database rules apply)
  const read = async path => {
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, {headers: {Authorization: `Bearer ${token}`}});
    return r.ok ? ((await r.json()).fields || {}) : null;
  };
  const me = await read(`users/${caller.localId}`);
  const myRole = me && me.role && me.role.stringValue;
  if (myRole !== "admin" && myRole !== "super_admin") return res.status(403).json({error: "Not on the team"});
  const them = await read(`users/${to}`);
  const email = them && them.email && them.email.stringValue;
  const theirRole = them && them.role && them.role.stringValue;
  if (!email || (theirRole !== "admin" && theirRole !== "super_admin")) return res.status(404).json({error: "No such teammate"});
  if (them.emailOff && them.emailOff.booleanValue) return res.json({ok: true, skipped: "turned off"});

  // 3. Send it
  const fromName = (me.name && me.name.stringValue) || caller.email;
  const site = process.env.SITE_URL || `https://${req.headers.host}`;
  const open = `${site}/admin/`;
  try {
    await nodemailer.createTransport({service: "gmail", auth: {user, pass}}).sendMail({
      from: `"A·A·O Workspace" <${user}>`,
      to: email,
      replyTo: caller.email,
      subject: text.length > 110 ? text.slice(0, 107) + "…" : text,
      text: `${text}\n\nOpen the workspace: ${open}\n\nSent by ${fromName} through the A·A·O Workspace.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;background:#0b0a08;color:#f2ece0;border:1px solid #a88b4a">
        <p style="font-family:Georgia,serif;color:#d4af5a;letter-spacing:4px;margin:0 0 16px">A · A · O</p>
        <p style="font-size:17px;line-height:1.5;margin:0 0 20px">${esc(text)}</p>
        <a href="${esc(open)}" style="display:inline-block;background:#d4af5a;color:#0b0a08;padding:12px 18px;text-decoration:none;font-weight:bold;letter-spacing:1px">OPEN THE WORKSPACE</a>
        <p style="color:#a59d8e;font-size:13px;margin:22px 0 0">Sent by ${esc(fromName)} through the A·A·O Workspace.</p></div>`
    });
    return res.json({ok: true});
  } catch (e) {
    return res.status(502).json({error: "Gmail didn't accept the message. Check GMAIL_USER and GMAIL_APP_PASSWORD."});
  }
};
