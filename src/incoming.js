// Appels entrants : le numéro Twilio sonne dans l'app Biznify, puis portable ou messagerie
const express = require("express");
const twilio = require("twilio");
const config = require("./config");
const { q, getSettings } = require("./db");
const tw = require("./twilio");
const activity = require("./activity");

const DEFAULTS = { enabled: false, forwardTo: "", ringMobile: "after", voicemail: true, greeting: "", ringSeconds: 25 };

async function cfg() {
  const r = await q(`SELECT value FROM settings WHERE key='incoming'`);
  return { ...DEFAULTS, ...(r.rows[0] ? r.rows[0].value : {}) };
}
async function save(v) {
  await q(`INSERT INTO settings (key, value) VALUES ('incoming', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [v]);
}
async function findNumber() {
  const nums = await tw.client().incomingPhoneNumbers.list({ phoneNumber: config.twilioCallerId, limit: 1 });
  if (!nums[0]) throw new Error(`Le numéro ${config.twilioCallerId} n'est pas dans ce compte Twilio`);
  return nums[0];
}
const hookUrl = () => `${tw.publicUrl()}/api/twilio/incoming`;

// Branche (ou débranche) le numéro sur Biznify, en gardant l'ancien réglage pour pouvoir revenir en arrière
async function route(on) {
  const c = await cfg();
  const n = await findNumber();
  if (on) {
    if (n.voiceUrl !== hookUrl()) {
      c.prev = { voiceUrl: n.voiceUrl || "", voiceMethod: n.voiceMethod || "POST", voiceApplicationSid: n.voiceApplicationSid || "" };
    }
    await tw.client().incomingPhoneNumbers(n.sid).update({ voiceUrl: hookUrl(), voiceMethod: "POST", voiceApplicationSid: "" });
  } else if (n.voiceUrl === hookUrl()) {
    const p = c.prev || {};
    await tw.client().incomingPhoneNumbers(n.sid).update(p.voiceApplicationSid ? { voiceApplicationSid: p.voiceApplicationSid } : { voiceUrl: p.voiceUrl || "", voiceMethod: p.voiceMethod || "POST" });
  }
  c.enabled = on;
  await save(c);
  return c;
}

const digits = (p) => String(p || "").replace(/\D/g, "").slice(-9);
async function leadByPhone(phone) {
  const d = digits(phone);
  if (d.length < 9) return null;
  const r = await q(`SELECT id, name, company, first_name, last_name, phone, city, stage, notes FROM leads
    WHERE right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 9) = $1 ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [d]);
  return r.rows[0] || null;
}
const who = (l, phone) => (l ? l.company || [l.first_name, l.last_name].filter(Boolean).join(" ") || l.name : null) || String(phone || "Numéro masqué").replace(/^\+33(\d)(\d{2})(\d{2})(\d{2})(\d{2})$/, "0$1 $2 $3 $4 $5");

function voicemailTwiml(c, s) {
  const vr = new twilio.twiml.VoiceResponse();
  if (!c.voicemail) { vr.say({ language: "fr-FR" }, "Nous ne sommes pas disponibles pour le moment. Merci de rappeler plus tard."); vr.hangup(); return vr.toString(); }
  const msg = c.greeting || `Bonjour, vous êtes bien chez ${s.entreprise || "Biznify"}. Nous ne pouvons pas répondre pour le moment. Laissez votre nom et votre numéro après le bip, nous vous rappelons rapidement.`;
  vr.say({ language: "fr-FR", voice: "Polly.Lea" }, msg);
  vr.record({ action: `${tw.publicUrl()}/api/twilio/vm-done`, method: "POST", maxLength: 120, playBeep: true, timeout: 5, recordingStatusCallback: `${tw.publicUrl()}/api/twilio/voicemail`, recordingStatusCallbackMethod: "POST", recordingStatusCallbackEvent: ["completed"] });
  vr.hangup();
  return vr.toString();
}

/* ---------- Webhooks Twilio ---------- */
const hooks = express.Router();
hooks.use(express.urlencoded({ extended: false }));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

hooks.post("/incoming", wrap(async (req, res) => {
  res.type("text/xml");
  if (!tw.validRequest(req)) return res.status(403).send(tw.rejectTwiml("Requête refusée."));
  const c = await cfg();
  const from = req.body.From;
  const lead = await leadByPhone(from);
  await q(`INSERT INTO calls (id, source, date, direction, phone, lead_id, contact_name, label, status, call_status, twilio_call_sid, has_recording)
    VALUES ($1,'inbound',now(),'inbound',$2,$3,$4,$5,'skipped','ringing',$6,false) ON CONFLICT (id) DO NOTHING`,
    ["in-" + req.body.CallSid, from, lead && lead.id, lead && (lead.name || null), lead && lead.company, req.body.CallSid]);
  require("./mobile").notify({ title: "📞 Appel entrant", body: `${who(lead, from)} t'appelle. Ouvre Biznify pour répondre.`, url: lead ? `/#lead-${lead.id}` : "/#dashboard", tag: `call-${req.body.CallSid}` });
  const vr = new twilio.twiml.VoiceResponse();
  const dial = vr.dial({ answerOnBridge: true, timeout: Math.max(10, Math.min(60, Number(c.ringSeconds) || 25)), action: `${tw.publicUrl()}/api/twilio/incoming-status?step=1`, method: "POST" });
  const cl = dial.client();
  cl.identity("closer");
  if (lead) cl.parameter({ name: "LeadId", value: String(lead.id) });
  cl.parameter({ name: "Caller", value: from || "" });
  const fwd = tw.normalizePhone(c.forwardTo);
  if (fwd && c.ringMobile === "together") dial.number(fwd);
  res.send(vr.toString());
}));

hooks.post("/incoming-status", wrap(async (req, res) => {
  res.type("text/xml");
  if (!tw.validRequest(req)) return res.status(403).send("<Response/>");
  const c = await cfg();
  const st = req.body.DialCallStatus;
  const step = Number(req.query.step) || 1;
  const sid = req.body.CallSid;
  if (st === "completed" || st === "answered") {
    const dur = parseInt(req.body.DialCallDuration) || null;
    const r = await q(`UPDATE calls SET call_status='completed', duration=$2, updated_at=now() WHERE twilio_call_sid=$1 RETURNING lead_id, phone`, [sid, dur]);
    const x = r.rows[0];
    if (x) {
      const lead = x.lead_id ? (await q(`SELECT * FROM leads WHERE id=$1`, [x.lead_id])).rows[0] : null;
      await activity.log("call_in", { leadId: x.lead_id, title: `Appel reçu de ${who(lead, x.phone)}`, detail: dur ? `${Math.floor(dur / 60)} min ${dur % 60} s` : null, ref: `call-in:${sid}` });
      if (x.lead_id) await activity.noteLead(x.lead_id, `Appel entrant${dur ? ` (${Math.round(dur / 60)} min)` : ""}`);
    }
    return res.send("<Response/>");
  }
  const fwd = tw.normalizePhone(c.forwardTo);
  if (step === 1 && fwd && c.ringMobile === "after") {
    const vr = new twilio.twiml.VoiceResponse();
    const d = vr.dial({ answerOnBridge: true, timeout: 20, action: `${tw.publicUrl()}/api/twilio/incoming-status?step=2`, method: "POST" });
    d.number(fwd);
    return res.send(vr.toString());
  }
  const r = await q(`UPDATE calls SET call_status='no-answer', updated_at=now() WHERE twilio_call_sid=$1 RETURNING lead_id, phone`, [sid]);
  const x = r.rows[0] || {};
  const lead = x.lead_id ? (await q(`SELECT * FROM leads WHERE id=$1`, [x.lead_id])).rows[0] : null;
  if (!c.voicemail) await activity.log("call_missed", { leadId: x.lead_id, title: `Appel manqué de ${who(lead, x.phone || req.body.From)}`, ref: `call-missed:${sid}` });
  res.send(voicemailTwiml(c, await getSettings()));
}));

hooks.post("/vm-done", (req, res) => { res.type("text/xml").send("<Response><Hangup/></Response>"); });

hooks.post("/voicemail", wrap(async (req, res) => {
  if (!tw.validRequest(req)) return res.status(403).end();
  const sid = req.body.CallSid;
  const dur = parseInt(req.body.RecordingDuration) || 0;
  const r = await q(`UPDATE calls SET recording_url=$2, has_recording=true, duration=$3, call_status='voicemail', updated_at=now() WHERE twilio_call_sid=$1 RETURNING id, lead_id, phone`, [sid, req.body.RecordingUrl, dur]);
  const x = r.rows[0];
  if (!x) return res.status(204).end();
  const lead = x.lead_id ? (await q(`SELECT * FROM leads WHERE id=$1`, [x.lead_id])).rows[0] : null;
  if (dur < 2) {
    await activity.log("call_missed", { leadId: x.lead_id, title: `Appel manqué de ${who(lead, x.phone)}`, detail: "Sans message", ref: `call-missed:${sid}` });
  } else {
    await activity.log("voicemail", { leadId: x.lead_id, title: `Message vocal de ${who(lead, x.phone)}`, detail: `${dur} s`, ref: `vm:${x.id}` });
    if (x.lead_id) await activity.noteLead(x.lead_id, `Message vocal reçu (${dur} s)`);
  }
  res.status(204).end();
}));

/* ---------- API ---------- */
const api = express.Router();
api.get("/incoming/config", wrap(async (req, res) => {
  const c = await cfg();
  let routed = null, error = null;
  if (tw.enabled()) { try { routed = (await findNumber()).voiceUrl === hookUrl(); } catch (e) { error = e.message; } }
  res.json({ ...c, prev: undefined, routed, error, number: config.twilioCallerId || null, twilio: tw.enabled() });
}));
api.put("/incoming/config", wrap(async (req, res) => {
  if (!tw.enabled()) return res.status(400).json({ error: "Twilio n'est pas connecté" });
  const b = req.body || {};
  const c = await cfg();
  if (b.forwardTo !== undefined) {
    const f = String(b.forwardTo || "").trim();
    if (f && !tw.normalizePhone(f)) return res.status(400).json({ error: "Numéro de portable invalide" });
    if (f && tw.normalizePhone(f) === tw.normalizePhone(config.twilioCallerId)) return res.status(400).json({ error: "Mets ton numéro de portable personnel, pas le numéro Biznify" });
    c.forwardTo = f;
  }
  if (["together", "after", "never"].includes(b.ringMobile)) c.ringMobile = b.ringMobile;
  if (b.voicemail !== undefined) c.voicemail = !!b.voicemail;
  if (b.greeting !== undefined) c.greeting = String(b.greeting).slice(0, 400);
  if (b.ringSeconds !== undefined) c.ringSeconds = Math.max(10, Math.min(60, Number(b.ringSeconds) || 25));
  await save(c);
  try {
    const out = b.enabled !== undefined && !!b.enabled !== c.enabled ? await route(!!b.enabled) : c;
    res.json({ ...out, prev: undefined, routed: out.enabled });
  } catch (e) { res.status(502).json({ error: `Twilio : ${e.message}` }); }
}));
api.get("/incoming/lookup", wrap(async (req, res) => res.json({ lead: await leadByPhone(req.query.phone) })));
api.get("/incoming/voicemail/:id/audio", wrap(async (req, res) => {
  const c = (await q(`SELECT recording_url FROM calls WHERE id=$1 AND source='inbound' AND has_recording`, [req.params.id])).rows[0];
  if (!c) return res.status(404).json({ error: "Message introuvable" });
  const a = await tw.downloadRecording(c.recording_url);
  res.setHeader("Content-Type", a.type); res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(a.buffer);
}));

module.exports = { hooks, api, cfg };
