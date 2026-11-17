// Téléphonie Twilio : jeton navigateur, TwiML, enregistrement, configuration automatique
const twilio = require("twilio");
const config = require("./config");
const { q } = require("./db");

const enabled = () => !!(config.twilioSid && config.twilioToken && config.twilioCallerId);
const missing = () =>
  ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_CALLER_ID"].filter((k) => !process.env[k]);

function publicUrl() {
  if (config.publicUrl) return config.publicUrl.replace(/\/$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return "https://" + process.env.RAILWAY_PUBLIC_DOMAIN;
  return null;
}

let _client = null;
const client = () => (_client ||= twilio(config.twilioSid, config.twilioToken));

async function getStored() {
  const r = await q(`SELECT value FROM settings WHERE key='twilio'`);
  return r.rows[0] ? r.rows[0].value : {};
}
async function store(v) {
  await q(`INSERT INTO settings (key, value) VALUES ('twilio', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [v]);
}

/**
 * Crée (une seule fois) l'application TwiML et la clé API nécessaires au dialer,
 * et garde l'URL de l'application à jour si le domaine change.
 */
let setupPromise = null;
function ensureSetup() {
  if (!enabled()) return Promise.resolve(null);
  return (setupPromise ||= (async () => {
    const base = publicUrl();
    if (!base) throw new Error("Adresse publique inconnue : définis PUBLIC_URL");
    const voiceUrl = `${base}/api/twilio/voice`;
    const cur = await getStored();
    const next = { ...cur };
    if (!next.appSid) {
      const app = await client().applications.create({ friendlyName: "CLOSER PRO", voiceUrl, voiceMethod: "POST" });
      next.appSid = app.sid;
    } else if (next.voiceUrl !== voiceUrl) {
      await client().applications(next.appSid).update({ voiceUrl, voiceMethod: "POST" });
    }
    next.voiceUrl = voiceUrl;
    if (!next.keySid || !next.keySecret) {
      const key = await client().newKeys.create({ friendlyName: "CLOSER PRO dialer" });
      next.keySid = key.sid;
      next.keySecret = key.secret;
    }
    await store(next);
    return next;
  })().catch((e) => { setupPromise = null; throw e; }));
}

async function token() {
  const s = await ensureSetup();
  const { AccessToken } = twilio.jwt;
  const t = new AccessToken(config.twilioSid, s.keySid, s.keySecret, { identity: "closer", ttl: 3600 });
  t.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: s.appSid, incomingAllow: false }));
  return t.toJwt();
}

// Numéro au format international (+33…)
function normalizePhone(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/[^\d+]/g, "");
  if (p.startsWith("00")) p = "+" + p.slice(2);
  if (/^0\d{9}$/.test(p)) p = "+33" + p.slice(1);
  if (/^33\d{9}$/.test(p)) p = "+" + p;
  if (!p.startsWith("+")) p = "+" + p;
  return /^\+\d{8,15}$/.test(p) ? p : null;
}

// Vérifie que la requête vient bien de Twilio
function validRequest(req) {
  if (process.env.TWILIO_SKIP_VALIDATION === "true") return true;
  const base = publicUrl();
  const sig = req.headers["x-twilio-signature"];
  if (!sig || !base) return false;
  return twilio.validateRequest(config.twilioToken, sig, base + req.originalUrl, req.body || {});
}

function voiceTwiml(to) {
  const base = publicUrl();
  const vr = new twilio.twiml.VoiceResponse();
  const dial = vr.dial({
    callerId: config.twilioCallerId,
    answerOnBridge: true,
    timeout: 30,
    record: "record-from-answer-dual",
    recordingStatusCallback: `${base}/api/twilio/recording`,
    recordingStatusCallbackEvent: ["completed"],
    recordingStatusCallbackMethod: "POST",
    action: `${base}/api/twilio/dial-status`,
    method: "POST",
  });
  dial.number(to);
  return vr.toString();
}

function rejectTwiml(msg) {
  const vr = new twilio.twiml.VoiceResponse();
  vr.say({ language: "fr-FR" }, msg);
  vr.hangup();
  return vr.toString();
}

async function downloadRecording(url) {
  const res = await fetch(url.replace(/\.(json|wav|mp3)$/, "") + ".mp3", {
    headers: { Authorization: "Basic " + Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString("base64") },
  });
  if (!res.ok) throw new Error(`Twilio : enregistrement inaccessible (${res.status})`);
  return { buffer: Buffer.from(await res.arrayBuffer()), type: "audio/mpeg" };
}

module.exports = { enabled, missing, ensureSetup, token, normalizePhone, validRequest, voiceTwiml, rejectTwiml, downloadRecording, publicUrl };
