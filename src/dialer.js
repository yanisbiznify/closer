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

// Étapes du pipeline (CRM)
const STAGES = [
  { id: "nouveau", label: "Nouveau lead" },
  { id: "tentative1", label: "Pas de contact x1" },
  { id: "tentative2", label: "Pas de contact x2" },
  { id: "tentative3", label: "Pas de contact x3" },
  { id: "rappel", label: "À rappeler" },
  { id: "rdv", label: "RDV pris" },
  { id: "gagne", label: "Client signé" },
  { id: "perdu", label: "Perdu" },
];
const STAGE_IDS = STAGES.map((x) => x.id);
function stageAfter(outcome, attempts) {
  if (outcome === "rdv") return "rdv";
  if (outcome === "rappel") return "rappel";
  if (outcome === "pas_interesse" || outcome === "mauvais_numero") return "perdu";
  const n = Math.max(1, Math.min(3, attempts || 1));
  return "tentative" + n;
}
const clean = (v, n = 200) => (v == null ? null : String(v).trim().slice(0, n) || null);
function money(v) {
  if (v == null || v === "") return 0;
  const n = parseFloat(String(v).replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
  return isFinite(n) ? Math.max(0, Math.min(1e9, n)) : 0;
}
function mapsUrl(v) {
  const u = clean(v, 1000);
  if (!u) return null;
  return /^https?:\/\//i.test(u) ? u : null;
}

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
    `UPDATE leads SET status=$2, callback_at=$3, notes=COALESCE($4,notes), outcome_at=now(), updated_at=now(),
       stage = CASE WHEN stage = 'gagne' THEN stage ELSE $5 END,
       stage_at = CASE WHEN stage = 'gagne' OR stage = $5 THEN stage_at ELSE now() END
     WHERE id=$1 RETURNING *`,
    [id, o.status, callbackAt && !isNaN(callbackAt) ? callbackAt : null, notes,
     stageAfter(req.body.outcome, ((await q(`SELECT attempts FROM leads WHERE id=$1`, [id])).rows[0] || {}).attempts)]
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
      title: `Biznify : ${o.label}`,
      body: `Appel Biznify : ${o.label}${when}.${lead.notes ? "\n\nNotes : " + lead.notes : ""}`,
      tag: o.tag,
    });
  }
  res.json({ lead, ghl: ghlResult });
});

const EDITABLE = {
  first_name: (v) => clean(v, 80), last_name: (v) => clean(v, 80), company: (v) => clean(v, 200),
  activity: (v) => clean(v, 120), email: (v) => clean(v, 200), city: (v) => clean(v, 120),
  website: (v) => clean(v, 500), maps_url: mapsUrl, value: money, notes: (v) => (v == null ? null : String(v).slice(0, 5000)),
  source: (v) => clean(v, 80),
};
api.patch("/leads/:id", async (req, res) => {
  const b = req.body || {};
  const id = parseInt(req.params.id);
  const sets = [], vals = [id];
  for (const [k, fn] of Object.entries(EDITABLE)) {
    if (b[k] !== undefined) { vals.push(fn(b[k])); sets.push(`${k}=$${vals.length}`); }
  }
  if (b.phone !== undefined) {
    const ph = b.phone ? tw.normalizePhone(b.phone) : null;
    if (b.phone && !ph) return res.status(400).json({ error: "Numéro de téléphone invalide" });
    vals.push(ph); sets.push(`phone=$${vals.length}`);
  }
  if (b.stage !== undefined) {
    if (!STAGE_IDS.includes(b.stage)) return res.status(400).json({ error: "Étape inconnue" });
    vals.push(b.stage); sets.push(`stage=$${vals.length}`, "stage_at=now()");
    // garder la file d'appels cohérente avec l'étape choisie à la main
    const st = { nouveau: "a_appeler", rappel: "rappel", rdv: "rdv", gagne: "rdv", perdu: "pas_interesse" }[b.stage];
    if (st) { vals.push(st); sets.push(`status=$${vals.length}`); }
  }
  if (b.status !== undefined && b.stage === undefined) {
    const st = OUTCOMES[b.status] ? OUTCOMES[b.status].status : b.status === "a_appeler" ? "a_appeler" : null;
    if (st) { vals.push(st); sets.push(`status=$${vals.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: "Rien à modifier" });
  sets.push("updated_at=now()");
  const r = await q(`UPDATE leads SET ${sets.join(", ")} WHERE id=$1 RETURNING *`, vals);
  if (!r.rows.length) return res.status(404).json({ error: "Prospect introuvable" });
  // nom complet recalculé proprement
  const l = r.rows[0];
  if (b.first_name !== undefined || b.last_name !== undefined) {
    const full = [l.first_name, l.last_name].filter(Boolean).join(" ") || null;
    const r2 = await q(`UPDATE leads SET name=$2 WHERE id=$1 RETURNING *`, [id, full]);
    return res.json(r2.rows[0]);
  }
  res.json(l);
});

api.post("/leads", async (req, res) => {
  const b = req.body || {};
  const phone = b.phone ? tw.normalizePhone(b.phone) : null;
  if (b.phone && !phone) return res.status(400).json({ error: "Numéro de téléphone invalide" });
  if (!b.company && !b.first_name && !b.last_name) return res.status(400).json({ error: "Indique au moins une entreprise ou un nom" });
  let listId = parseInt(b.list_id) || null;
  if (!listId) {
    const ex = await q(`SELECT id FROM lists WHERE source='manuel' ORDER BY id LIMIT 1`);
    listId = ex.rows[0] ? ex.rows[0].id : (await q(`INSERT INTO lists (name, source) VALUES ('Ajouts manuels','manuel') RETURNING id`)).rows[0].id;
  }
  const stage = STAGE_IDS.includes(b.stage) ? b.stage : "nouveau";
  const full = [clean(b.first_name, 80), clean(b.last_name, 80)].filter(Boolean).join(" ") || null;
  try {
    const r = await q(
      `INSERT INTO leads (list_id, first_name, last_name, name, company, activity, phone, email, city, maps_url, website, value, source, notes, stage, stage_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now()) RETURNING *`,
      [listId, clean(b.first_name, 80), clean(b.last_name, 80), full, clean(b.company), clean(b.activity, 120), phone, clean(b.email), clean(b.city, 120),
       mapsUrl(b.maps_url), clean(b.website, 500), money(b.value), clean(b.source, 80) || "manuel", b.notes ? String(b.notes).slice(0, 5000) : null, stage]
    );
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Ce numéro existe déjà dans cette liste" });
    throw e;
  }
});

api.delete("/leads/:id", async (req, res) => {
  await q(`DELETE FROM leads WHERE id=$1`, [parseInt(req.params.id)]);
  res.json({ ok: true });
});

api.get("/pipeline", async (req, res) => {
  const list = parseInt(req.query.list) || null;
  const r = await q(
    `SELECT l.*, li.name AS list_name,
       (SELECT max(score) FROM calls c WHERE c.lead_id=l.id AND c.status='done') AS best_score
     FROM leads l LEFT JOIN lists li ON li.id=l.list_id
     WHERE ($1::int IS NULL OR l.list_id=$1)
     ORDER BY l.stage_at DESC NULLS LAST, l.updated_at DESC LIMIT 5000`,
    [list]
  );
  res.json({ stages: STAGES, leads: r.rows });
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

async function insertLeads(listId, rows, source) {
  let added = 0, invalid = 0, dup = 0;
  for (const x of rows) {
    const phone = tw.normalizePhone(x.phone);
    if (!phone) { invalid++; continue; }
    const first = clean(x.first_name, 80), last = clean(x.last_name, 80);
    const full = [first, last].filter(Boolean).join(" ") || clean(x.name);
    const r = await q(
      `INSERT INTO leads (list_id, first_name, last_name, name, company, activity, phone, email, city, maps_url, website, value, source, ghl_contact_id, notes, stage, stage_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'nouveau',now()) ON CONFLICT (list_id, phone) DO NOTHING RETURNING id`,
      [listId, first, last, full, clean(x.company), clean(x.activity, 120), phone, clean(x.email), clean(x.city, 120),
       mapsUrl(x.maps_url), clean(x.website, 500), money(x.value), source, x.ghl_contact_id || null, x.notes ? String(x.notes).slice(0, 2000) : null]
    );
    if (r.rows.length) added++; else dup++;
  }
  return { added, invalid, dup };
}

api.post("/leads/import", async (req, res) => {
  const { listName, leads } = req.body || {};
  if (!Array.isArray(leads) || !leads.length) return res.status(400).json({ error: "Aucun prospect à importer" });
  if (leads.length > 5000) return res.status(400).json({ error: "5 000 prospects maximum par import" });
  const li = await q(`INSERT INTO lists (name, source) VALUES ($1,'csv') RETURNING id`, [(listName || "Import").slice(0, 120)]);
  res.json({ listId: li.rows[0].id, ...(await insertLeads(li.rows[0].id, leads, "import")) });
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
    res.json({ listId: li.rows[0].id, ...(await insertLeads(li.rows[0].id, contacts, "ghl")) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Étape GHL → étape CLOSER PRO, d'après le nom de l'étape et le statut de l'opportunité
function mapGhlStage(stageName, status) {
  if (status === "won") return "gagne";
  if (status === "lost" || status === "abandoned") return "perdu";
  const n = String(stageName || "").toLowerCase();
  if (/clos(ed|ing)? ?(won)?|won|gagn|sign|client actif|client closed/.test(n) && !/ready to close/.test(n)) return "gagne";
  if (/\blos[et]\b|perdu|pas int|not interested|résili/.test(n)) return "perdu";
  if (/zoom|booked|rdv|rendez|meeting|ready to close|no.?show|cancel|resched|call finished|démo|demo/.test(n)) return "rdv";
  if (/nurture|follow|rappel|answer|relance|callback/.test(n)) return "rappel";
  if (/3x|x3|text 3|3e|troisi/.test(n)) return "tentative3";
  if (/2x|x2|text 2|2e|deuxi/.test(n)) return "tentative2";
  if (/1x|x1|text 1|1re|premi|no contact/.test(n)) return "tentative1";
  return "nouveau";
}
const STAGE_TO_STATUS = { nouveau: "a_appeler", tentative1: "a_appeler", tentative2: "a_appeler", tentative3: "a_appeler", rappel: "rappel", rdv: "rdv", gagne: "rdv", perdu: "pas_interesse" };
const STAGE_ATTEMPTS = { tentative1: 1, tentative2: 2, tentative3: 3 };

api.get("/ghl/pipelines", async (req, res) => {
  try { res.json({ pipelines: await ghl.listPipelines() }); }
  catch (e) { res.status(502).json({ error: e.status === 401 || e.status === 403 ? "Ta clé GHL n'a pas accès aux opportunités : ajoute les droits « opportunities.readonly » à ton intégration privée dans GHL." : e.message }); }
});

api.post("/leads/import-ghl-pipeline", async (req, res) => {
  const { pipelineId } = req.body || {};
  if (!pipelineId) return res.status(400).json({ error: "Choisis un pipeline GHL" });
  try {
    const pipes = await ghl.listPipelines();
    const pipe = pipes.find((p) => p.id === pipelineId);
    if (!pipe) return res.status(404).json({ error: "Pipeline introuvable" });
    const stageName = Object.fromEntries(pipe.stages.map((s) => [s.id, s.name]));
    const opps = await ghl.opportunitiesByPipeline(pipelineId);
    // une seule liste par pipeline : un nouvel import complète la même liste
    let li = (await q(`SELECT id FROM lists WHERE source='ghl' AND source_ref=$1 LIMIT 1`, ["pipeline:" + pipelineId])).rows[0];
    if (!li) li = (await q(`INSERT INTO lists (name, source, source_ref) VALUES ($1,'ghl',$2) RETURNING id`, [`GHL · ${pipe.name}`.slice(0, 120), "pipeline:" + pipelineId])).rows[0];
    let added = 0, dup = 0, invalid = 0;
    const byStage = {};
    for (const o of opps) {
      const c = o.contact || {};
      let phone = tw.normalizePhone(c.phone);
      let full = null;
      if (!phone && o.contactId) { try { full = await ghl.getContact(o.contactId); phone = tw.normalizePhone(full && full.phone); } catch {} }
      if (!phone) { invalid++; continue; }
      // déjà dans CLOSER PRO (même numéro, n'importe quelle liste) : on garde ce que tu y as fait
      const exists = (await q(`SELECT id, ghl_contact_id FROM leads WHERE phone=$1 LIMIT 1`, [phone])).rows[0];
      if (exists) {
        if (!exists.ghl_contact_id && o.contactId) await q(`UPDATE leads SET ghl_contact_id=$2 WHERE id=$1`, [exists.id, o.contactId]);
        dup++; continue;
      }
      const f = full || {};
      const first = clean(f.firstName || null, 80), last = clean(f.lastName || null, 80);
      const name = [first, last].filter(Boolean).join(" ") || clean(c.name) || clean(o.name);
      const company = c.companyName ? clean(String(c.companyName).split(/\s[|·]\s|·|\s\|/)[0].trim()) : null;
      const stage = mapGhlStage(stageName[o.pipelineStageId], o.status);
      const notes = [`Importé du pipeline GHL « ${pipe.name} »`, stageName[o.pipelineStageId] ? `Étape GHL : ${stageName[o.pipelineStageId]}` : null, c.tags && c.tags.length ? `Tags : ${c.tags.join(", ")}` : null].filter(Boolean).join("\n");
      const r = await q(
        `INSERT INTO leads (list_id, first_name, last_name, name, company, phone, email, value, source, ghl_contact_id, notes, stage, stage_at, status, attempts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ghl',$9,$10,$11,COALESCE($12::timestamptz, now()),$13,$14) ON CONFLICT (list_id, phone) DO NOTHING RETURNING id`,
        [li.id, first, last, name, company, phone, clean(c.email || f.email || null), Number(o.monetaryValue) || 0, o.contactId || null, notes,
         stage, o.lastStageChangeAt || null, STAGE_TO_STATUS[stage], STAGE_ATTEMPTS[stage] || 0]
      );
      if (r.rows.length) { added++; byStage[stage] = (byStage[stage] || 0) + 1; } else dup++;
    }
    res.json({ listId: li.id, list: `GHL · ${pipe.name}`, total: opps.length, added, dup, invalid, byStage });
  } catch (e) {
    res.status(502).json({ error: e.status === 401 || e.status === 403 ? "Ta clé GHL n'a pas accès aux opportunités : ajoute les droits « opportunities.readonly » à ton intégration privée dans GHL." : e.message });
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

module.exports = { hooks, api, OUTCOMES, STAGES };
