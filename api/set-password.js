/* Lets a super admin set a new password for someone on the team.
   Needs one Vercel environment variable: FIREBASE_SERVICE_ACCOUNT (the whole service-account JSON from
   Firebase -> Project settings -> Service accounts -> Generate new private key). Until it's set this does nothing.
   Security: the caller's Firebase sign-in is checked with Google, and their role is read from Firestore as
   them, so only a super admin gets through. No extra packages are needed. */
const crypto = require("crypto");

const API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyA3koDeC2XMSgkpz_zuJamd9orGBNczD2s";
const PROJECT = process.env.FIREBASE_PROJECT_ID || "aao---project";
const b64url = b => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function googleToken(sa){
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({alg: "RS256", typ: "JWT"}));
  const claim = b64url(JSON.stringify({iss: sa.client_email, scope: "https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600}));
  const sig = b64url(crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key));
  const r = await fetch("https://oauth2.googleapis.com/token", {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}`})});
  if (!r.ok) throw new Error("token");
  return (await r.json()).access_token;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({error: "Use POST"});
  let sa;
  try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || ""); } catch { sa = null; }
  if (!sa || !sa.private_key || !sa.client_email) return res.status(503).json({error: "not-set-up"});

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
