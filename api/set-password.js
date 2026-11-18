/* Lets a super admin set a new password for someone on the team.
   Needs one Vercel environment variable: FIREBASE_SERVICE_ACCOUNT (the whole service-account JSON from
   Firebase -> Project settings -> Service accounts -> Generate new private key). Until it's set this does nothing.
   Security: the caller's Firebase sign-in is checked with Google, and their role is read from Firestore as
   them, so only a super admin gets through. No extra packages are needed. */
const {serviceAccount, googleToken, PROJECT} = require("./_google");
const API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyA3koDeC2XMSgkpz_zuJamd9orGBNczD2s";

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({error: "Use POST"});
  const sa = serviceAccount();
  if (!sa) return res.status(503).json({error: "not-set-up"});

  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const target = String(body.uid || ""), password = String(body.password || "");
  if (!token || !/^[\w-]{6,128}$/.test(target)) return res.status(400).json({error: "Missing details"});
  if (password.length < 8 || password.length > 128) return res.status(400).json({error: "Passwords need 8 or more characters."});

  // 1. Who is asking?
  const look = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({idToken: token})});
  const caller = look.ok ? ((await look.json()).users || [])[0] : null;
  if (!caller) return res.status(401).json({error: "Not signed in"});

  // 2. Are they a super admin? (read as the caller, so the database rules apply)
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/users/${caller.localId}`, {headers: {Authorization: `Bearer ${token}`}});
  const me = r.ok ? ((await r.json()).fields || {}) : {};
  if (!(me.role && me.role.stringValue === "super_admin")) return res.status(403).json({error: "Only super admins can do this."});

  // 3. Set the password
  try {
    const access = await googleToken(sa);
    const up = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
      method: "POST", headers: {"Content-Type": "application/json", Authorization: `Bearer ${access}`},
      body: JSON.stringify({localId: target, password})});
    if (!up.ok) return res.status(502).json({error: "Firebase didn't accept the new password."});
    return res.json({ok: true});
  } catch {
    return res.status(502).json({error: "Couldn't reach Firebase with the service account. Check FIREBASE_SERVICE_ACCOUNT in Vercel."});
  }
};
