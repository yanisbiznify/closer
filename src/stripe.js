// Stripe : appels REST directs (pas de SDK), webhook créé automatiquement
const crypto = require("crypto");
const config = require("./config");
const { q } = require("./db");
const tw = require("./twilio");

const API = "https://api.stripe.com/v1";
// Clé : variable Railway STRIPE_SECRET_KEY, sinon celle connectée depuis l'app (chiffrée en base)
let dbKey = null;
let account = null;
const secretKey = () => config.stripeSecretKey || dbKey;
const enabled = () => !!secretKey();
const mode = () => (/^(sk|rk)_live_/.test(String(secretKey() || "")) ? "live" : "test");
const source = () => (config.stripeSecretKey ? "railway" : dbKey ? "app" : null);

const cipherKey = () => crypto.createHash("sha256").update("stripe-key:" + (config.sessionSecret || "closer")).digest();
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", cipherKey(), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}
function unseal(s) {
  const [iv, tag, enc] = String(s).split(".").map((x) => Buffer.from(x, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", cipherKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

// Encodage application/x-www-form-urlencoded avec objets et tableaux imbriqués (format Stripe)
function encode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === "object" ? encode(x, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(x)}`)));
    else if (typeof v === "object") encode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out;
}

async function call(method, path, params) {
  return callWith(secretKey(), method, path, params);
}
async function callWith(key, method, path, params) {
  if (!key) { const e = new Error("Connecte Stripe dans Facturation pour activer les paiements."); e.code = "stripe_off"; throw e; }
  const body = params && method !== "GET" ? encode(params).join("&") : undefined;
  const url = API + path + (params && method === "GET" ? "?" + encode(params).join("&") : "");
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": "2024-06-20" },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `Stripe ${r.status}`);
  return j;
}

async function getState() {
  const r = await q(`SELECT value FROM settings WHERE key='stripe'`);
  return r.rows.length ? r.rows[0].value : {};
}
async function setState(v) {
  await q(`INSERT INTO settings (key, value) VALUES ('stripe', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [v]);
}

const hookUrl = () => (tw.publicUrl() || "") + "/api/stripe/webhook";

// Crée (ou recrée) l'endpoint webhook Stripe et garde son secret de signature
async function ensureWebhook() {
  if (!enabled()) return;
  const url = hookUrl();
  if (!/^https:\/\//.test(url)) return;
  const st = await getState();
  const m = mode();
  if (st.webhookId && st.webhookSecret && st.webhookUrl === url && st.mode === m) {
    try { const w = await call("GET", `/webhook_endpoints/${st.webhookId}`); if (w && w.status === "enabled") return; } catch {}
  }
  // On retire les anciens endpoints CLOSER PRO pour cette URL (secret perdu), puis on en crée un neuf
  try {
    const list = await call("GET", "/webhook_endpoints", { limit: 100 });
    for (const w of list.data || []) if (w.url === url) await call("DELETE", `/webhook_endpoints/${w.id}`).catch(() => {});
  } catch {}
  const w = await call("POST", "/webhook_endpoints", {
    url,
    description: "CLOSER PRO — paiements des factures",
    enabled_events: ["checkout.session.completed", "checkout.session.async_payment_succeeded"],
  });
  await setState({ ...st, webhookId: w.id, webhookSecret: w.secret, webhookUrl: url, mode: m });
}

async function webhookSecret() {
  return config.stripeWebhookSecret || (await getState()).webhookSecret || null;
}

// Vérifie l'en-tête Stripe-Signature (HMAC SHA-256, tolérance 5 min)
async function verify(raw, header) {
  const secret = await webhookSecret();
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")).filter((x) => x.length === 2).map(([k, v]) => [k, v]));
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

// Charge la clé connectée depuis l'app au démarrage
async function load() {
  const st = await getState();
  dbKey = null; account = st.account || null;
  if (st.sealedKey) { try { dbKey = unseal(st.sealedKey); } catch { console.warn("Stripe : clé enregistrée illisible (SESSION_SECRET changé ?)"); } }
}

// Connexion depuis l'app : vérifie la clé, l'enregistre chiffrée, crée le webhook
async function connect(rawKey) {
  const key = String(rawKey || "").trim();
  if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(key)) throw new Error("Colle une clé Stripe qui commence par sk_live_ ou rk_live_ (ou _test_ pour essayer)");
  let acct = null;
  try {
    const a = await callWith(key, "GET", "/account");
    acct = { id: a.id, name: (a.settings && a.settings.dashboard && a.settings.dashboard.display_name) || (a.business_profile && a.business_profile.name) || a.email || a.id, country: a.country, charges: !!a.charges_enabled };
  } catch (e) {
    if (/Invalid API Key|No such|expired/i.test(e.message)) throw new Error("Stripe refuse cette clé : vérifie que tu l'as copiée en entier");
    // clé restreinte sans accès « Account » : on vérifie avec une lecture autorisée
    await callWith(key, "GET", "/payment_links", { limit: 1 });
  }
  for (const [path, label] of [["/webhook_endpoints", "Webhook endpoints"], ["/prices", "Prices"], ["/checkout/sessions", "Checkout Sessions"]]) {
    try { await callWith(key, "GET", path, { limit: 1 }); }
    catch (e) { if (/permission|restricted/i.test(e.message)) throw new Error(`Il manque une autorisation à cette clé : ${label} (écriture). Crée-la avec « toutes les autorisations ».`); }
  }
  const st = await getState();
  await setState({ ...st, sealedKey: seal(key), account: acct, connectedAt: new Date().toISOString(), webhookId: null, webhookSecret: null });
  await load();
  await ensureWebhook();
  return status();
}
async function disconnect() {
  const st = await getState();
  if (st.webhookId && dbKey) await call("DELETE", `/webhook_endpoints/${st.webhookId}`).catch(() => {});
  await setState({});
  dbKey = null; account = null;
}
function status() {
  return { enabled: enabled(), mode: enabled() ? mode() : null, source: source(), account };
}

module.exports = { enabled, mode, call, ensureWebhook, verify, getState, load, connect, disconnect, status };
