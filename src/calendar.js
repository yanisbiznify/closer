// Agenda : connexion Google et prise de rendez-vous avec lien Meet
const express = require("express");
const { q } = require("./db");
const google = require("./google");
const ghl = require("./ghl");
const config = require("./config");

const api = express.Router();

api.get("/google/status", async (req, res) => res.json(await google.status()));

api.get("/google/auth", (req, res) => {
  if (!google.configured()) return res.status(400).send("Ajoute GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans Railway.");
  const ret = ["conversations", "calendar"].includes(req.query.ret) ? req.query.ret : "calendar";
  res.setHeader("Set-Cookie", `closer_gret=${ret}; Path=/api/google; Max-Age=900; HttpOnly; SameSite=Lax; Secure`);
  res.redirect(google.authUrl());
});
const gret = (req) => (/(?:^|;\s*)closer_gret=(conversations|calendar)/.exec(req.headers.cookie || "") || [])[1] || "calendar";

api.get("/google/callback", async (req, res) => {
  const ret = gret(req);
  if (req.query.error) return res.redirect(ret === "calendar" ? "/#calendar-refus" : "/#" + ret);
  if (!google.validState(req.query.state)) return res.status(400).send("Lien de connexion expiré, recommence depuis l'application.");
  try { await google.exchangeCode(req.query.code); res.redirect("/#" + ret); }
  catch (e) { res.status(502).send("Connexion Google impossible : " + e.message); }
});

api.post("/google/disconnect", async (req, res) => { await google.disconnect(); res.json({ ok: true }); });

function fail(res, e) {
  res.status(e.code === "not_connected" ? 409 : 502).json({ error: e.message, code: e.code || null });
}

api.get("/calendar/events", async (req, res) => {
  const from = new Date(req.query.from), to = new Date(req.query.to);
  if (isNaN(from) || isNaN(to) || to - from > 62 * 864e5 || to <= from) return res.status(400).json({ error: "Période invalide" });
  try {
    const events = await google.listEvents(from.toISOString(), to.toISOString());
    // noms des prospects liés
    const ids = [...new Set(events.map((e) => e.leadId).filter(Boolean))];
    if (ids.length) {
      const r = await q(`SELECT id, name, company, phone FROM leads WHERE id = ANY($1)`, [ids]);
      const m = new Map(r.rows.map((l) => [l.id, l]));
      events.forEach((e) => { if (e.leadId && m.get(e.leadId)) e.lead = m.get(e.leadId); });
    }
    res.json({ events });
  } catch (e) { fail(res, e); }
});

api.post("/calendar/events", async (req, res) => {
  const b = req.body || {};
  const start = new Date(b.start), end = new Date(b.end);
  if (isNaN(start) || isNaN(end) || end <= start) return res.status(400).json({ error: "Date ou durée invalide" });
  const email = b.email ? String(b.email).trim().slice(0, 200) : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Adresse email invalide" });
  const leadId = parseInt(b.leadId) || null;
  let lead = null;
  if (leadId) lead = (await q(`SELECT * FROM leads WHERE id=$1`, [leadId])).rows[0] || null;
  const title = String(b.title || (lead ? `Rendez-vous ${lead.company || lead.name || ""}` : "Rendez-vous")).trim().slice(0, 200);
  try {
    const ev = await google.createEvent({
      title, start: start.toISOString(), end: end.toISOString(), email,
      description: b.description ? String(b.description).slice(0, 4000) : null,
      meet: b.meet !== false, notify: b.notify !== false, leadId,
    });
    await q(
      `INSERT INTO appointments (lead_id, google_event_id, title, start_at, end_at, meet_url, attendee_email, calendar_id, manage_token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [leadId, ev.id, title, start, end, ev.meet, email, parseInt(b.calendarId) || null, require("crypto").randomBytes(18).toString("base64url")]
    );
    let ghlResult = null;
    if (lead) {
      await q(
        `UPDATE leads SET status='rdv', stage=CASE WHEN stage='gagne' THEN stage ELSE 'rdv' END, stage_at=now(), outcome_at=COALESCE(outcome_at, now()),
           email=COALESCE(email,$2), updated_at=now() WHERE id=$1`,
        [lead.id, email]
      );
      if (lead.ghl_contact_id && config.ghlApiKey) {
        const when = start.toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "full", timeStyle: "short" });
        ghlResult = await ghl.logOutcome(lead.ghl_contact_id, {
          title: "Biznify : rendez-vous planifié",
          body: `Rendez-vous le ${when} (heure de Paris).${ev.meet ? "\nGoogle Meet : " + ev.meet : ""}`,
          tag: "closer-rdv",
        });
      }
    }
    res.json({ event: ev, ghl: ghlResult });
  } catch (e) { fail(res, e); }
});

api.delete("/calendar/events/:id", async (req, res) => {
  try {
    await google.deleteEvent(req.params.id, req.query.notify !== "0");
    const r = await q(`UPDATE appointments SET status='annule' WHERE google_event_id=$1 RETURNING id`, [req.params.id]);
    for (const a of r.rows) await q(`UPDATE automation_runs SET status='stopped', ended_at=now() WHERE status='active' AND (context->>'appointment_id')::int = $1`, [a.id]);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

module.exports = { api };
