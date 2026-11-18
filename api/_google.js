/* Shared helpers for server functions that act with the Firebase service account.
   (Files starting with "_" are not turned into web addresses by Vercel.) */
const crypto = require("crypto");
const PROJECT = process.env.FIREBASE_PROJECT_ID || "aao---project";
const b64url = b => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

function serviceAccount(){
  try { const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || ""); return sa && sa.private_key && sa.client_email ? sa : null; } catch { return null; }
}
async function googleToken(sa){
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({alg: "RS256", typ: "JWT"}));
  const claim = b64url(JSON.stringify({iss: sa.client_email, scope: "https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600}));
  const sig = b64url(crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key));
  const r = await fetch("https://oauth2.googleapis.com/token", {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: new URLSearchParams({grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}`})});
  if (!r.ok) throw new Error("token");
  return (await r.json()).access_token;
}
/* Firestore REST values -> plain JS */
function plain(v){
  if (!v || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(plain);
  if ("mapValue" in v) return fields(v.mapValue.fields || {});
  return null;
}
const fields = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, plain(v)]));
async function listAll(token, collection){
  const out = []; let page = "";
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${collection}?pageSize=300${page ? "&pageToken=" + encodeURIComponent(page) : ""}`, {headers: {Authorization: `Bearer ${token}`}});
    if (!r.ok) throw new Error("firestore " + r.status);
    const j = await r.json();
    (j.documents || []).forEach(d => out.push({id: d.name.split("/").pop(), ...fields(d.fields)}));
    if (!j.nextPageToken) break; page = j.nextPageToken;
  }
  return out;
}
module.exports = {PROJECT, serviceAccount, googleToken, listAll};
