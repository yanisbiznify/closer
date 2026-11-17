// Dialer : prospects, listes, file d'appels, qualifications, webhooks Twilio
const express = require("express");
const { q, getSettings } = require("./db");
const ghl = require("./ghl");
const tw = require("./twilio");
const worker = require("./worker");
const config = require("./config");

const OUTCOMES = {
  rdv:            { label: "Rendez-vous",     status: "rdv",            tag: "closer-rdv" },
  rappel:         { label: "À rappeler",      status: "rappel",         tag: "closer-rappel" },
  pas_interesse:  { label: "Pas intéressé",   status: "pas_interesse",  tag: "closer-pas-interesse" },
  messagerie:     { label: "Messagerie",      status: "messagerie",     tag: null },
  barrage:        { label: "Barrage",         status: "barrage",        tag: null },
  injoignable:    { label: "Pas de réponse",  status: "injoignable",    tag: null },
  mauvais_numero: { label: "Mauvais numéro",  status: "mauvais_numero", tag: "closer-mauvais-numero" },
};
const RETRY = ["messagerie", "barrage", "injoignable"];

/* ---------- Webhooks Twilio (sans session, signature vérifiée) ---------- */
const hooks = express.Router();
hooks.use(express.urlencoded({ extended: false }));

hooks.post("/voice", async (req, res) => {
  res.type("text/xml");
  if (!tw.validRequest(req)) return res.status(403).send(tw.rejectTwiml("Requête refusée."));
  const to = tw.normalizePhone(req.body.To);
  if (!to || req.body.From !== "client:closer") return res.send(tw.rejectTwiml("Numéro invalide."));
  const leadId = parseInt(req.body.LeadId) || null;
  let lead = null;
  if (leadId) lead = (await q(`SELECT * FROM leads WHERE id=$1`, [leadId])).rows[0] || null;
  await q(
    `INSERT INTO calls (id, source, date, direction, phone, lead_id, contact_id, contact_name, label, status, twilio_call_sid, has_recording)
     VALUES ($1,'dialer',now(),'outbound',$2,$3,$4,$5,$6,'calling',$7,false) ON CONFLICT (id) DO NOTHING`,
    ["d-" + req.body.CallSid, to, leadId, lead && lead.ghl_contact_id, lead && lead.name, lead && lead.company, req.body.CallSid]
  );
  if (lead) await q(`UPDATE leads SET attempts=attempts+1, last_call_at=now(), updated_at=now() WHERE id=$1`, [lead.id]);
  res.send(tw.voiceTwiml(to));
});

hooks.post("/dial-status", async (req, res) => {
  res.type("text/xml");
  if (!tw.validRequest(req)) return res.status(403).send("<Response/>");
  const st = req.body.DialCallStatus;
  const dur = parseInt(req.body.DialCallDuration) || null;
  await q(
    `UPDATE calls SET call_status=$2, duration=COALESCE($3,duration), status=CASE WHEN $2='completed' THEN 'pending' ELSE 'skipped' END, updated_at=now()
     WHERE twilio_call_sid=$1 AND status='calling'`,
    [req.body.CallSid, st, dur]
  );
  res.send("<Response/>");
});

hooks.post("/recording", async (req, res) => {
  if (!tw.validRequest(req)) return res.status(403).end();
  if (req.body.RecordingStatus && req.body.RecordingStatus !== "completed") return res.status(204).end();
  const s = await getSettings();
  const dur = parseInt(req.body.RecordingDuration) || 0;
  const status = dur < (s.minDuree || 0) ? "short" : "queued";
  await q(
    `UPDATE calls SET recording_url=$2, has_recording=true, duration=COALESCE(duration,$3), call_status='completed', status=$4, updated_at=now() WHERE twilio_call_sid=$1`,
    [req.body.CallSid, req.body.RecordingUrl, dur, status]
  );
  if (status === "queued") worker.kick();
  res.status(204).end();
});

/* ---------- API du dialer (session requise) ---------- */
const api = express.Router();

api.get("/dialer/config", async (req, res) => {
  const s = await getSettings();
  let error = null;
  if (tw.enabled()) { try { await tw.ensureSetup(); } catch (e) { error = e.message; } }
  res.json({ enabled: tw.enabled() && !error, missing: tw.missing(), error, callerId: config.twilioCallerId || null, script: s.script, prenom: s.prenom });
});

api.get("/dialer/token", async (req, res) => {
  if (!tw.enabled()) return res.status(400).json({ error: "Dialer non configuré : ajoute les variables Twilio." });
  try { res.json({ token: await tw.token() }); } catch (e) { res.status(502).json({ error: e.message }); }
});

// File d'appels : rappels dus d'abord, puis jamais appelés, puis à retenter
api.get("/dialer/queue", async (req, res) => {
  const s = await getSettings();
  const list = parseInt(req.query.list) || null;
  const r = await q(
    `SELECT l.*, li.name AS list_name,
       CASE WHEN l.status='rappel' THEN 0 WHEN l.status='a_appeler' THEN 1 ELSE 2 END AS prio
     FROM leads l LEFT JOIN lists li ON li.id=l.list_id
     WHERE ($1::int IS NULL OR l.list_id=$1)
       AND (
         l.status='a_appeler'
         OR (l.status='rappel' AND (l.callback_at IS NULL OR l.callback_at <= now() + interval '15 minutes'))
         OR (l.status = ANY($2) AND l.attempts < $3 AND (l.last_call_at IS NULL OR l.last_call_at < now() - interval '2 hours'))
       )
     ORDER BY prio, l.callback_at NULLS LAST, l.attempts, l.id
     LIMIT 300`,
    [list, RETRY, s.maxTentatives || 3]
  );
  res.json({ leads: r.rows });
});

api.get("/dialer/stats", async (req, res) => {
  const s = await getSettings();
  const tz = "Europe/Paris";
  const r = await q(
    `SELECT
       count(*) FILTER (WHERE source='dialer')::int AS appels,
       count(*) FILTER (WHERE source='dialer' AND call_status='completed' AND duration >= 30)::int AS conversations,
       (SELECT count(*) FROM leads WHERE status='rdv' AND (outcome_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date)::int AS rdv
     FROM calls WHERE (date AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
    [tz]
  );
  const cb = await q(`SELECT count(*)::int AS n FROM leads WHERE status='rappel' AND callback_at::date <= (now() AT TIME ZONE $1)::date`, [tz]);
  res.json({ ...r.rows[0], rappels: cb.rows[0].n, objectifAppels: s.objectifAppels, objectifRdv: s.objectifRdv });
});

// Qualification après l'appel
api.post("/leads/:id/outcome", async (req, res) => {
  const o = OUTCOMES[req.body.outcome];
  if (!o) return res.status(400).json({ error: "Résultat inconnu" });
  const id = parseInt(req.params.id);
  const notes = typeof req.body.notes === "string" ? req.body.notes.slice(0, 5000) : undefined;
  const callbackAt = req.body.outcome === "rappel" && req.body.callbackAt ? new Date(req.body.callbackAt) : null;
  const r = await q(
    `UPDATE leads SET status=$2, callback_at=$3, notes=COALESCE($4,notes), outcome_at=now(), updated_at=now() WHERE id=$1 RETURNING *`,
    [id, o.status, callbackAt && !isNaN(callbackAt) ? callbackAt : null, notes]
  );
  const lead = r.rows[0];
  if (!lead) return res.status(404).json({ error: "Prospect introuvable" });
  if (req.body.callSid) {
    await q(`UPDATE calls SET outcome=$2 WHERE twilio_call_sid=$1`, [req.body.callSid, req.body.outcome]);
  } else {
    await q(`UPDATE calls SET outcome=$2 WHERE id = (SELECT id FROM calls WHERE lead_id=$1 ORDER BY date DESC LIMIT 1)`, [id, req.body.outcome]);
  }
  let ghlResult = null;
  if (lead.ghl_contact_id && config.ghlApiKey) {
    const when = callbackAt ? ` le ${callbackAt.toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" })}` : "";
    ghlResult = await ghl.logOutcome(lead.ghl_contact_id, {
      title: `CLOSER : ${o.label}`,
      body: `Appel CLOSER : ${o.label}${when}.${lead.notes ? "\n\nNotes : " + lead.notes : ""}`,
      tag: o.tag,
    });
  }
  res.json({ lead, ghl: ghlResult });
});

api.patch("/leads/:id", async (req, res) => {
  const b = req.body || {};
  const r = await q(
    `UPDATE leads SET notes=COALESCE($2,notes), status=COALESCE($3,status), name=COALESCE($4,name), company=COALESCE($5,company), updated_at=now() WHERE id=$1 RETURNING *`,
    [parseInt(req.params.id), typeof b.notes === "string" ? b.notes.slice(0, 5000) : null, b.status && (OUTCOMES[b.status] || b.status === "a_appeler") ? (OUTCOMES[b.status] ? OUTCOMES[b.status].status : b.status) : null, b.name || null, b.company || null]
  );
  if (!r.rows.length) return res.status(404).json({ error: "Prospect introuvable" });
  res.json(r.rows[0]);
});

api.get("/leads/:id/calls", async (req, res) => {
  const r = await q(`SELECT id, date, duration, status, score, issue, outcome FROM calls WHERE lead_id=$1 ORDER BY date DESC LIMIT 20`, [parseInt(req.params.id)]);
  res.json({ calls: r.rows });
});

/* ---------- Listes et import ---------- */
api.get("/lists", async (req, res) => {
  const r = await q(
    `SELECT li.*, count(l.id)::int AS total,
       count(l.id) FILTER (WHERE l.status='a_appeler')::int AS a_appeler,
       count(l.id) FILTER (WHERE l.status='rdv')::int AS rdv
     FROM lists li LEFT JOIN leads l ON l.list_id=li.id GROUP BY li.id ORDER BY li.created_at DESC`
  );
  res.json({ lists: r.rows });
});

api.delete("/lists/:id", async (req, res) => {
  await q(`DELETE FROM lists WHERE id=$1`, [parseInt(req.params.id)]);
  res.json({ ok: true });
});

api.get("/leads", async (req, res) => {
  const list = parseInt(req.query.list) || null;
  const r = await q(
    `SELECT l.*, li.name AS list_name FROM leads l LEFT JOIN lists li ON li.id=l.list_id
     WHERE ($1::int IS NULL OR l.list_id=$1) ORDER BY l.updated_at DESC LIMIT 3000`,
    [list]
  );
  res.json({ leads: r.rows });
});

async function insertLeads(listId, rows) {
  let added = 0, invalid = 0, dup = 0;
  for (const x of rows) {
    const phone = tw.normalizePhone(x.phone);
    if (!phone) { invalid++; continue; }
    const r = await q(
      `INSERT INTO leads (list_id, name, company, phone, email, city, ghl_contact_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (list_id, phone) DO NOTHING RETURNING id`,
      [listId, (x.name || "").slice(0, 200) || null, (x.company || "").slice(0, 200) || null, phone,
       (x.email || "").slice(0, 200) || null, (x.city || "").slice(0, 120) || null, x.ghl_contact_id || null, (x.notes || "").slice(0, 2000) || null]
    );
    if (r.rows.length) added++; else dup++;
  }
  return { added, invalid, dup };
}

api.post("/leads/import", async (req, res) => {
  const { listName, leads } = req.body || {};
  if (!Array.isArray(leads) || !leads.length) return res.status(400).json({ error: "Aucun prospect à importer" });
  if (leads.length > 5000) return res.status(400).json({ error: "5 000 prospects maximum par import" });
  const li = await q(`INSERT INTO lists (name, source) VALUES ($1,'csv') RETURNING id`, [(listName || "Import CSV").slice(0, 120)]);
  res.json({ listId: li.rows[0].id, ...(await insertLeads(li.rows[0].id, leads)) });
});

api.get("/ghl/tags", async (req, res) => {
  try { res.json({ tags: await ghl.listTags() }); } catch (e) { res.status(502).json({ error: e.message }); }
});

api.post("/leads/import-ghl", async (req, res) => {
  const { tag, listName } = req.body || {};
  if (!tag) return res.status(400).json({ error: "Choisis un tag GHL" });
  try {
    const contacts = await ghl.contactsByTag(tag);
    if (!contacts.length) return res.status(404).json({ error: "Aucun contact avec ce tag" });
    const li = await q(`INSERT INTO lists (name, source, source_ref) VALUES ($1,'ghl',$2) RETURNING id`, [(listName || tag).slice(0, 120), tag]);
    res.json({ listId: li.rows[0].id, ...(await insertLeads(li.rows[0].id, contacts)) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ---------- Bibliothèque d'objections (tirée des analyses) ---------- */
api.get("/objections", async (req, res) => {
  const r = await q(
    `SELECT c.id, c.date, o->>'objection' AS objection, o->>'boucle' AS boucle, o->>'reponse' AS reponse
     FROM calls c, jsonb_array_elements(COALESCE(c.analysis->'objections','[]'::jsonb)) o
     WHERE c.status='done' ORDER BY c.date DESC LIMIT 300`
  );
  res.json({ objections: r.rows });
});

module.exports = { hooks, api, OUTCOMES };
