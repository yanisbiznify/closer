// Calendriers de réservation : pages publiques façon GHL/Calendly, créneaux libres, gestion du RDV par le prospect
const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { q } = require("./db");
const google = require("./google");
const tw = require("./twilio");
const mailer = require("./mailer");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const DAYS = ["1", "2", "3", "4", "5", "6", "7"]; // lundi … dimanche (ISO)
const DEFAULT_HOURS = { 1: [["11:30", "14:00"], ["15:00", "20:00"]], 2: [["11:30", "14:00"], ["15:00", "20:00"]], 3: [["11:30", "14:00"], ["15:00", "20:00"]], 4: [["11:30", "14:00"], ["15:00", "20:00"]], 5: [["11:30", "14:00"], ["15:00", "20:00"]], 6: [["11:30", "14:00"], ["15:00", "20:00"]], 7: [] };

/* ---------- Fuseaux horaires ---------- */
function tzOffsetMs(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - date.getTime();
}
// heure locale (dans tz) → instant UTC
function zoned(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  t = guess - tzOffsetMs(new Date(t), tz);
  return new Date(t);
}
function localDay(date, tz) { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date); }
function isoWeekday(y, m, d) { const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return w === 0 ? 7 : w; }

/* ---------- Nettoyage d'un calendrier ---------- */
const str = (v, n = 500) => (v == null ? "" : String(v)).slice(0, n);
const slugOf = (v) => str(v, 60).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const hm = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null);
function cleanHours(h) {
  const out = {};
  for (const d of DAYS) {
    const ranges = Array.isArray(h && h[d]) ? h[d] : [];
    out[d] = ranges.map((r) => [hm(r && r[0]), hm(r && r[1])]).filter((r) => r[0] && r[1] && r[0] < r[1]).slice(0, 4);
  }
  return out;
}
function cleanCalendar(b) {
  b = b || {};
  const int = (v, min, max, def) => { const n = Math.round(Number(v)); return isNaN(n) ? def : Math.max(min, Math.min(max, n)); };
  return {
    name: str(b.name, 120).trim() || "Rendez-vous",
    slug: slugOf(b.slug || b.name) || "rdv",
    description: str(b.description, 1500),
    duration_min: int(b.duration_min, 10, 480, 30),
    interval_min: int(b.interval_min, 5, 240, 30),
    buffer_min: int(b.buffer_min, 0, 240, 0),
    notice_hours: int(b.notice_hours, 0, 24 * 14, 2),
    days_ahead: int(b.days_ahead, 1, 180, 30),
    max_per_day: b.max_per_day ? int(b.max_per_day, 1, 50, null) : null,
    hours: cleanHours(b.hours || DEFAULT_HOURS),
    timezone: "Europe/Paris",
    event_title: str(b.event_title, 200) || null,
    thanks: str(b.thanks, 600) || null,
    consent: str(b.consent, 600) || null,
    color: /^#[0-9a-fA-F]{6}$/.test(b.color || "") ? b.color : "#1877F2",
    meet: b.meet !== false,
    active: b.active !== false,
  };
}

/* ---------- Créneaux libres ---------- */
async function busyBetween(from, to) {
  const busy = [];
  try { if ((await google.status()).connected) busy.push(...(await google.freeBusy(from.toISOString(), to.toISOString()))); } catch (e) { console.warn("Disponibilités Google :", e.message); }
  const r = await q(`SELECT start_at, end_at FROM appointments WHERE status NOT IN ('annule') AND end_at > $1 AND start_at < $2`, [from, to]);
  r.rows.forEach((a) => busy.push({ start: new Date(a.start_at), end: new Date(a.end_at) }));
  return busy;
}
async function slotsFor(cal, fromDay, days, { ignoreAppointmentId } = {}) {
  const tz = cal.timezone || "Europe/Paris";
  const now = new Date();
  const earliest = new Date(now.getTime() + cal.notice_hours * 3600e3);
  const latest = new Date(now.getTime() + cal.days_ahead * 864e5);
  const [y0, m0, d0] = fromDay.split("-").map(Number);
  const start = zoned(y0, m0, d0, 0, 0, tz);
  const end = new Date(start.getTime() + days * 864e5 + 864e5);
  let busy = await busyBetween(start, end);
  if (ignoreAppointmentId) {
    const a = (await q(`SELECT start_at, end_at FROM appointments WHERE id=$1`, [ignoreAppointmentId])).rows[0];
    if (a) busy = busy.filter((b) => !(b.start.getTime() === new Date(a.start_at).getTime() && b.end.getTime() === new Date(a.end_at).getTime()));
  }
  const perDay = {};
  if (cal.max_per_day) {
    const r = await q(`SELECT start_at FROM appointments WHERE calendar_id=$1 AND status <> 'annule' AND start_at >= $2 AND start_at < $3`, [cal.id, start, end]);
    r.rows.forEach((a) => { const k = localDay(new Date(a.start_at), tz); perDay[k] = (perDay[k] || 0) + 1; });
  }
  const buf = cal.buffer_min * 60e3, dur = cal.duration_min * 60e3, step = cal.interval_min * 60e3;
  const out = {};
  for (let i = 0; i < days; i++) {
    const dt = new Date(Date.UTC(y0, m0 - 1, d0 + i));
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate();
    const key = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (cal.max_per_day && (perDay[key] || 0) >= cal.max_per_day) continue;
    const ranges = (cal.hours || {})[String(isoWeekday(y, m, d))] || [];
    const list = [];
    for (const [a, b] of ranges) {
      const [ah, am] = a.split(":").map(Number), [bh, bm] = b.split(":").map(Number);
      const rs = zoned(y, m, d, ah, am, tz).getTime(), re = zoned(y, m, d, bh, bm, tz).getTime();
      for (let t = rs; t + dur <= re; t += step) {
        const s = new Date(t), e = new Date(t + dur);
        if (s < earliest || s > latest) continue;
        if (busy.some((x) => x.start.getTime() < e.getTime() + buf && x.end.getTime() > s.getTime() - buf)) continue;
        list.push(s.toISOString());
      }
    }
    if (list.length) out[key] = list;
  }
  return out;
}

/* ---------- Réservation ---------- */
async function bookingList() {
  const ex = await q(`SELECT id FROM lists WHERE source='manuel' AND name='Réservations en ligne' LIMIT 1`);
  return ex.rows[0] ? ex.rows[0].id : (await q(`INSERT INTO lists (name, source) VALUES ('Réservations en ligne','manuel') RETURNING id`)).rows[0].id;
}
async function findOrCreateLead({ first_name, last_name, company, email, phone }) {
  let lead = (await q(`SELECT * FROM leads WHERE phone=$1 ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [phone])).rows[0];
  if (!lead && email) lead = (await q(`SELECT * FROM leads WHERE lower(email)=lower($1) ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [email])).rows[0];
  if (lead) {
    await q(`UPDATE leads SET email=COALESCE(NULLIF(email,''),$2), first_name=COALESCE(first_name,$3), last_name=COALESCE(last_name,$4), company=COALESCE(company,$5), updated_at=now() WHERE id=$1`,
      [lead.id, email, first_name, last_name, company]);
    return lead;
  }
  const name = [first_name, last_name].filter(Boolean).join(" ") || null;
  return (await q(`INSERT INTO leads (list_id, first_name, last_name, name, company, phone, email, source, stage, stage_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'réservation','nouveau',now()) RETURNING *`,
    [await bookingList(), first_name, last_name, name, company, phone, email])).rows[0];
}

const base = () => tw.publicUrl() || "";
const manageUrl = (a) => tw.manageLink(a.manage_token);
const fmtWhen = (d) => { const t = new Date(d).toLocaleString("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }); return t.charAt(0).toUpperCase() + t.slice(1); };

async function book(cal, b, ip) {
  const start = new Date(b.start);
  if (isNaN(start)) throw Object.assign(new Error("Créneau invalide"), { status: 400 });
  const first_name = str(b.first_name, 80).trim(), last_name = str(b.last_name, 80).trim(), company = str(b.company, 160).trim() || null;
  const email = str(b.email, 200).trim().toLowerCase();
  const phone = tw.normalizePhone(b.phone);
  if (!first_name) throw Object.assign(new Error("Indiquez votre prénom"), { status: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error("Adresse email invalide"), { status: 400 });
  if (!phone) throw Object.assign(new Error("Numéro de téléphone invalide"), { status: 400 });
  if (cal.consent && !b.consent) throw Object.assign(new Error("Merci de cocher la case d'accord pour être recontacté"), { status: 400 });
  // le créneau est-il toujours libre ?
  const day = localDay(start, cal.timezone);
  const free = await slotsFor(cal, day, 1);
  if (!(free[day] || []).includes(start.toISOString())) throw Object.assign(new Error("Ce créneau vient d'être pris. Choisissez-en un autre."), { status: 409 });
  const lead = await findOrCreateLead({ first_name, last_name: last_name || null, company, email, phone });
  const end = new Date(start.getTime() + cal.duration_min * 60e3);
  const token = crypto.randomBytes(18).toString("base64url");
  const who = [first_name, last_name].filter(Boolean).join(" ");
  const title = (cal.event_title || `${cal.name} · {nom}`).replace(/\{\{contact\.name\}\}|\{nom\}/g, who + (company ? ` (${company})` : "")).slice(0, 200);
  const note = str(b.notes, 1000).trim();
  const desc = [cal.description, "", `Téléphone : ${phone}`, `Email : ${email}`, company ? `Entreprise : ${company}` : null, note ? `\nMessage : ${note}` : null, "", `Besoin de déplacer ou d'annuler ? ${tw.manageLink(token)}`].filter((x) => x !== null).join("\n");
  let ev = null;
  try { if ((await google.status()).connected) ev = await google.createEvent({ title, start: start.toISOString(), end: end.toISOString(), email, description: desc, meet: cal.meet, notify: true, leadId: lead.id }); }
  catch (e) { console.warn("Réservation → Google :", e.message); }
  const a = (await q(`INSERT INTO appointments (lead_id, google_event_id, title, start_at, end_at, meet_url, attendee_email, calendar_id, manage_token, source, notes)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'booking',$10) RETURNING *`,
    [lead.id, ev && ev.id, title, start, end, ev && ev.meet, email, cal.id, token, note || null])).rows[0];
  await q(`UPDATE leads SET status='rdv', stage=CASE WHEN stage='gagne' THEN stage ELSE 'rdv' END, stage_at=now(), updated_at=now(),
             notes = concat_ws(E'\\n', NULLIF(notes,''), $2::text) WHERE id=$1`,
    [lead.id, `[${new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" })}] RDV réservé en ligne (${cal.name}) : ${fmtWhen(start)}${note ? ` — « ${note} »` : ""}`]);
  const fresh = (await q(`SELECT * FROM leads WHERE id=$1`, [lead.id])).rows[0] || lead;
  mailer.fire(() => mailer.bookingCreated(a, fresh, cal));
  return { appointment: a, lead, meet: ev && ev.meet };
}

// un RDV annulé ou déplacé arrête tout de suite les automatisations qui en dépendent (rappels…)
async function stopRunsFor(appointmentId) {
  await q(`UPDATE automation_runs SET status='stopped', ended_at=now(), log = log || jsonb_build_array(jsonb_build_object('at', now(), 'info', 'Arrêtée : RDV annulé ou déplacé'))
           WHERE status='active' AND (context->>'appointment_id')::int = $1`, [appointmentId]);
}

/* ---------- API (connecté) ---------- */
const api = express.Router();
const withUrl = (c) => ({ ...c, url: tw.bookingLink(c.slug) });

api.get("/booking/calendars", wrap(async (req, res) => {
  const r = await q(`SELECT c.*, (SELECT count(*) FROM appointments a WHERE a.calendar_id=c.id AND a.status <> 'annule' AND a.start_at > now())::int AS upcoming,
                       (SELECT count(*) FROM appointments a WHERE a.calendar_id=c.id)::int AS total FROM booking_calendars c ORDER BY c.created_at`);
  res.json({ calendars: r.rows.map(withUrl), defaultHours: DEFAULT_HOURS, prefix: tw.bookingPrefix() });
}));
api.post("/booking/calendars", wrap(async (req, res) => {
  const c = cleanCalendar(req.body);
  try {
    const r = await q(`INSERT INTO booking_calendars (slug, name, description, duration_min, interval_min, buffer_min, notice_hours, days_ahead, max_per_day, hours, timezone, event_title, thanks, consent, color, meet, active, ghl_id)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [c.slug, c.name, c.description, c.duration_min, c.interval_min, c.buffer_min, c.notice_hours, c.days_ahead, c.max_per_day, c.hours, c.timezone, c.event_title, c.thanks, c.consent, c.color, c.meet, c.active, str(req.body.ghl_id, 60) || null]);
    res.json({ calendar: withUrl(r.rows[0]) });
  } catch (e) { if (e.code === "23505") return res.status(409).json({ error: "Ce lien est déjà utilisé par un autre calendrier" }); throw e; }
}));
api.put("/booking/calendars/:id", wrap(async (req, res) => {
  const c = cleanCalendar(req.body);
  try {
    const r = await q(`UPDATE booking_calendars SET slug=$2, name=$3, description=$4, duration_min=$5, interval_min=$6, buffer_min=$7, notice_hours=$8, days_ahead=$9, max_per_day=$10, hours=$11, event_title=$12, thanks=$13, consent=$14, color=$15, meet=$16, active=$17 WHERE id=$1 RETURNING *`,
      [req.params.id, c.slug, c.name, c.description, c.duration_min, c.interval_min, c.buffer_min, c.notice_hours, c.days_ahead, c.max_per_day, c.hours, c.event_title, c.thanks, c.consent, c.color, c.meet, c.active]);
    if (!r.rows[0]) return res.status(404).json({ error: "Calendrier introuvable" });
    res.json({ calendar: withUrl(r.rows[0]) });
  } catch (e) { if (e.code === "23505") return res.status(409).json({ error: "Ce lien est déjà utilisé par un autre calendrier" }); throw e; }
}));
api.delete("/booking/calendars/:id", wrap(async (req, res) => {
  await q(`DELETE FROM booking_calendars WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

// Statut d'un RDV depuis l'agenda : présent, absent (no-show)
api.post("/calendar/events/:id/status", wrap(async (req, res) => {
  const st = req.body && req.body.status;
  if (!["present", "absent", "planifie"].includes(st)) return res.status(400).json({ error: "Statut invalide" });
  const r = await q(`UPDATE appointments SET status=$2 WHERE google_event_id=$1 RETURNING *`, [req.params.id, st]);
  if (!r.rows[0]) return res.status(404).json({ error: "Ce RDV n'a pas été créé depuis Biznify" });
  res.json({ appointment: r.rows[0] });
}));
api.get("/calendar/appointments", wrap(async (req, res) => {
  const ids = String(req.query.events || "").split(",").filter(Boolean).slice(0, 300);
  if (!ids.length) return res.json({ appointments: [] });
  const r = await q(`SELECT a.google_event_id, a.status, a.calendar_id, a.source, c.name AS calendar_name, c.color FROM appointments a LEFT JOIN booking_calendars c ON c.id=a.calendar_id WHERE a.google_event_id = ANY($1)`, [ids]);
  res.json({ appointments: r.rows });
}));

/* ---------- Pages publiques ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DEFAULT_LOGO = (() => { try { return "data:image/svg+xml;base64," + fs.readFileSync(path.join(__dirname, "..", "public", "brand", "biznify-logo.svg")).toString("base64"); } catch { return null; } })();
async function brand() {
  const r = await q(`SELECT value FROM settings WHERE key='billing'`);
  const b = r.rows[0] ? r.rows[0].value : {};
  return { logo: b.logo || DEFAULT_LOGO, company: b.company || "Biznify", accent: /^#[0-9a-fA-F]{6}$/.test(b.accent || "") ? b.accent : "#1877F2" };
}

function shell(title, accent, body, script = "") {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--a:${accent};--ink:#0B1220;--mut:#5B6475;--line:#E4E7EE;--soft:#F5F7FB}
*{box-sizing:border-box}body{margin:0;background:var(--soft);color:var(--ink);font:15px/1.55 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:40px 20px 60px}
.card{background:#fff;border:1px solid var(--line);border-radius:18px;box-shadow:0 1px 2px rgba(11,18,32,.04),0 12px 40px rgba(11,18,32,.06);display:grid;grid-template-columns:300px 1fr;overflow:hidden;min-height:540px}
.info{padding:30px 28px;border-right:1px solid var(--line)}
.logo{height:34px;width:auto;display:block;margin-bottom:26px}
.info h1{font-size:22px;letter-spacing:-.02em;margin:0 0 12px;line-height:1.25}
.meta{display:flex;flex-direction:column;gap:8px;color:var(--mut);font-size:14px;margin-bottom:18px}
.meta span{display:flex;gap:9px;align-items:center}.meta svg{width:17px;height:17px;flex:none}
.info p{color:var(--mut);font-size:14px;margin:0;white-space:pre-line}
.pick{padding:28px 30px;display:grid;grid-template-columns:minmax(0,1fr) 210px;gap:28px}
.pick h2,.form h2{font-size:16px;margin:0 0 16px}
.mhead{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.mhead b{font-size:15px}
.nav{display:flex;gap:6px}.nav button{width:34px;height:34px;border-radius:50%;border:1px solid var(--line);background:#fff;cursor:pointer;font-size:16px;color:var(--ink)}
.nav button:disabled{opacity:.35;cursor:default}
.grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;text-align:center}
.grid .dow{font-size:11.5px;color:var(--mut);font-weight:600;padding:6px 0}
.grid button{aspect-ratio:1;border:0;border-radius:50%;background:none;font:500 14px Inter,system-ui,sans-serif;color:#B5BCC8;cursor:default}
.grid button.av{background:color-mix(in srgb,var(--a) 10%,#fff);color:var(--a);cursor:pointer;font-weight:600}
.grid button.av:hover{background:color-mix(in srgb,var(--a) 18%,#fff)}
.grid button.sel{background:var(--a);color:#fff}
.grid button:focus-visible,.slots button:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
.tz{font-size:12.5px;color:var(--mut);margin-top:14px}
.slots{display:flex;flex-direction:column;gap:8px;max-height:430px;overflow:auto;padding-right:4px}
.slots .day{font-size:14px;font-weight:600;margin:0 0 6px}
.slots button{border:1px solid color-mix(in srgb,var(--a) 45%,#fff);color:var(--a);background:#fff;border-radius:10px;padding:11px;font:600 14px Inter,system-ui,sans-serif;cursor:pointer}
.slots button:hover{border-color:var(--a);background:color-mix(in srgb,var(--a) 6%,#fff)}
.empty{color:var(--mut);font-size:14px}
.form{padding:28px 30px;max-width:560px}
.back{background:none;border:0;color:var(--a);font:600 14px Inter,system-ui,sans-serif;cursor:pointer;padding:0;margin-bottom:14px}
.chosen{background:var(--soft);border-radius:12px;padding:12px 14px;font-size:14px;margin-bottom:18px}

.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
label{display:block;font-size:13px;font-weight:600;margin:0 0 6px}
.f{margin-bottom:14px}
input,textarea{width:100%;border:1px solid var(--line);border-radius:10px;padding:11px 12px;font:15px Inter,system-ui,sans-serif;color:var(--ink);background:#fff}
input:focus,textarea:focus{outline:2px solid var(--a);outline-offset:0;border-color:transparent}
textarea{min-height:80px;resize:vertical}
.consent{display:flex;gap:10px;align-items:flex-start;font-size:12.5px;color:var(--mut);margin:4px 0 18px;font-weight:400}
.consent input{width:18px;height:18px;margin-top:1px;flex:none}
.go{width:100%;border:0;background:var(--a);color:#fff;border-radius:12px;padding:14px;font:600 15px Inter,system-ui,sans-serif;cursor:pointer}
.go:disabled{opacity:.6}
.err{color:#A12A2A;background:#FDECEC;border-radius:10px;padding:10px 12px;font-size:13.5px;margin-bottom:14px}
.done{padding:40px 34px;max-width:560px}
.done .ok{width:46px;height:46px;border-radius:50%;background:#E9F8F0;color:#11643C;display:flex;align-items:center;justify-content:center;margin-bottom:16px}
.done h2{margin:0 0 8px;font-size:22px}.done p{color:var(--mut);margin:0 0 14px}
.done .box{background:var(--soft);border-radius:12px;padding:14px 16px;margin:16px 0;font-size:14px}
.done a{color:var(--a);font-weight:600}
.hp{position:absolute;left:-9999px}
.spin{width:16px;height:16px;border:2px solid #fff;border-right-color:transparent;border-radius:50%;display:inline-block;animation:s .7s linear infinite;vertical-align:-3px;margin-right:8px}
@keyframes s{to{transform:rotate(360deg)}}
.foot{text-align:center;color:var(--mut);font-size:12px;margin-top:18px}
@media (max-width:860px){.card{grid-template-columns:1fr}.info{border-right:0;border-bottom:1px solid var(--line)}.pick{grid-template-columns:1fr}.slots{max-height:none}.row{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
</style></head><body><main class="wrap">${body}</main>${script}</body></html>`;
}

const ICONS = {
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/></svg>`,
};

function bookingPage(cal, br, manage) {
  const dur = cal.duration_min >= 60 && cal.duration_min % 60 === 0 ? `${cal.duration_min / 60} h` : `${cal.duration_min} min`;
  const body = `<article class="card" aria-label="${esc(cal.name)}">
    <aside class="info">
      ${br.logo ? `<img class="logo" src="${br.logo}" alt="${esc(br.company)}">` : `<b>${esc(br.company)}</b>`}
      <h1>${esc(cal.name)}</h1>
      <div class="meta"><span>${ICONS.clock}${dur}</span>${cal.meet ? `<span>${ICONS.video}Visio Google Meet</span>` : ""}</div>
      ${cal.description ? `<p>${esc(cal.description)}</p>` : ""}
      ${manage ? `<div class="chosen" style="margin-top:18px">Rendez-vous actuel :<br><b>${esc(fmtWhen(manage.start_at))}</b></div>` : ""}
    </aside>
    <section id="app"></section>
  </article>
  <p class="foot">${esc(br.company)}</p>`;
  const cfg = { slug: cal.slug, consent: cal.consent || "", thanks: cal.thanks || "Votre rendez-vous est confirmé. Vous allez recevoir une invitation par email.", manage: manage ? manage.manage_token : null, days: cal.days_ahead };
  const script = `<script>
const C=${JSON.stringify(cfg).replace(/</g, "\\u003c")};
const $=(s)=>document.querySelector(s);const app=$("#app");
const e=(s)=>String(s??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const TZ="Europe/Paris";
const fmtD=(iso)=>{const t=new Date(iso).toLocaleDateString("fr-FR",{timeZone:TZ,weekday:"long",day:"numeric",month:"long"});return t.charAt(0).toUpperCase()+t.slice(1);};
const fmtT=(iso)=>new Date(iso).toLocaleTimeString("fr-FR",{timeZone:TZ,hour:"2-digit",minute:"2-digit"});
const pad=(n)=>String(n).padStart(2,"0");
const today=new Date(new Date().toLocaleString("en-US",{timeZone:TZ}));
let month=new Date(today.getFullYear(),today.getMonth(),1), slots={}, sel=null, chosen=null;
async function load(){
  const first=\`\${month.getFullYear()}-\${pad(month.getMonth()+1)}-01\`;
  const days=new Date(month.getFullYear(),month.getMonth()+1,0).getDate();
  app.innerHTML=draw(true);
  try{const r=await fetch(\`/r/\${C.slug}/slots?from=\${first}&days=\${days}\${C.manage?"&manage="+C.manage:""}\`);slots=(await r.json()).days||{};}catch{slots={};}
  if(!sel||!slots[sel]){sel=Object.keys(slots).sort()[0]||null;}
  app.innerHTML=draw();bind();
}
function draw(loading){
  const y=month.getFullYear(),m=month.getMonth(),n=new Date(y,m+1,0).getDate(),off=(new Date(y,m,1).getDay()+6)%7;
  const canPrev=month>new Date(today.getFullYear(),today.getMonth(),1);
  const canNext=new Date(y,m+1,1)<=new Date(today.getTime()+C.days*864e5);
  let cells="";for(let i=0;i<off;i++)cells+="<span></span>";
  for(let d=1;d<=n;d++){const k=\`\${y}-\${pad(m+1)}-\${pad(d)}\`;const av=!!slots[k];cells+=\`<button type="button" class="\${av?"av":""} \${k===sel?"sel":""}" \${av?'data-d="'+k+'"':"disabled"} aria-label="\${d} \${av?"disponible":"indisponible"}">\${d}</button>\`;}
  const list=sel&&slots[sel]?slots[sel]:[];
  return \`<div class="pick"><div><h2>\${C.manage?"Choisissez un nouveau créneau":"Choisissez une date et une heure"}</h2>
    <div class="mhead"><b>\${(t=>t.charAt(0).toUpperCase()+t.slice(1))(month.toLocaleDateString("fr-FR",{month:"long",year:"numeric"}))}</b><div class="nav"><button type="button" id="pv" \${canPrev?"":"disabled"} aria-label="Mois précédent">‹</button><button type="button" id="nx" \${canNext?"":"disabled"} aria-label="Mois suivant">›</button></div></div>
    <div class="grid">\${["lun","mar","mer","jeu","ven","sam","dim"].map(x=>'<span class="dow">'+x+'</span>').join("")}\${cells}</div>
    <p class="tz">Heures affichées : heure de Paris</p></div>
    <div class="slots" aria-live="polite">\${loading?'<p class="empty">Chargement des disponibilités…</p>':sel?'<p class="day">'+e(fmtD(list[0]))+'</p>'+list.map(s=>'<button type="button" data-s="'+s+'">'+fmtT(s)+'</button>').join(""):'<p class="empty">Aucun créneau libre ce mois-ci. Essayez le mois suivant.</p>'}</div></div>\`;
}
function bind(){
  const pv=$("#pv"),nx=$("#nx");
  if(pv)pv.onclick=()=>{month=new Date(month.getFullYear(),month.getMonth()-1,1);sel=null;load();};
  if(nx)nx.onclick=()=>{month=new Date(month.getFullYear(),month.getMonth()+1,1);sel=null;load();};
  document.querySelectorAll("[data-d]").forEach(b=>b.onclick=()=>{sel=b.dataset.d;app.innerHTML=draw();bind();});
  document.querySelectorAll("[data-s]").forEach(b=>b.onclick=()=>{chosen=b.dataset.s;C.manage?confirmMove():form();});
}
function form(err){
  app.innerHTML=\`<form class="form" id="f" novalidate><button type="button" class="back" id="bk">‹ Changer de créneau</button>
    <div class="chosen"><b>\${e(fmtD(chosen))}</b> à <b>\${fmtT(chosen)}</b> (heure de Paris)</div>
    <h2>Vos coordonnées</h2>\${err?'<div class="err" role="alert">'+e(err)+'</div>':""}
    <div class="row"><div class="f"><label for="fn">Prénom</label><input id="fn" name="first_name" autocomplete="given-name" required></div><div class="f"><label for="ln">Nom</label><input id="ln" name="last_name" autocomplete="family-name"></div></div>
    <div class="f"><label for="co">Entreprise</label><input id="co" name="company" autocomplete="organization"></div>
    <div class="row"><div class="f"><label for="em">Email</label><input id="em" name="email" type="email" autocomplete="email" required></div><div class="f"><label for="ph">Téléphone</label><input id="ph" name="phone" type="tel" autocomplete="tel" required placeholder="06 12 34 56 78"></div></div>
    <div class="f"><label for="nt">Un mot sur votre besoin (facultatif)</label><textarea id="nt" name="notes"></textarea></div>
    <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
    \${C.consent?'<label class="consent"><input type="checkbox" name="consent" required><span>'+e(C.consent)+'</span></label>':""}
    <button class="go" id="go">Confirmer le rendez-vous</button></form>\`;
  if(window.__v)Object.entries(window.__v).forEach(([k,v])=>{const el=document.querySelector('[name="'+k+'"]');if(el&&el.type!=="checkbox")el.value=v;});
  $("#bk").onclick=()=>{app.innerHTML=draw();bind();};
  $("#f").onsubmit=async(ev)=>{ev.preventDefault();const fd=Object.fromEntries(new FormData(ev.target));window.__v=fd;fd.consent=!!fd.consent;fd.start=chosen;
    const b=$("#go");b.disabled=true;b.innerHTML='<span class="spin"></span>Réservation…';
    try{const r=await fetch(\`/r/\${C.slug}/book\`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(fd)});const j=await r.json();
      if(!r.ok){if(r.status===409){await load();}form(j.error||"Réservation impossible");return;}
      done(j);}catch{form("Connexion impossible, réessayez.");}};
  $("#fn").focus();
}
function done(j){
  app.innerHTML=\`<div class="done"><div class="ok" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg></div>
    <h2>\${j.moved?"Rendez-vous déplacé":"C'est réservé !"}</h2><p>\${e(j.moved?"Votre nouveau créneau est confirmé.":C.thanks)}</p>
    <div class="box"><b>\${e(fmtD(j.start))}</b> à <b>\${fmtT(j.start)}</b> (heure de Paris)\${j.meet?'<br>Visio : <a href="'+e(j.meet)+'">'+e(j.meet)+'</a>':""}</div>
    \${j.manage?'<p>Un empêchement ? <a href="'+e(j.manage)+'">Déplacer ou annuler le rendez-vous</a></p>':""}</div>\`;
}
async function confirmMove(){
  app.innerHTML=\`<div class="form"><button type="button" class="back" id="bk">‹ Changer de créneau</button><div class="chosen">Nouveau créneau : <b>\${e(fmtD(chosen))}</b> à <b>\${fmtT(chosen)}</b></div>
    <button class="go" id="go">Confirmer le nouveau créneau</button></div>\`;
  $("#bk").onclick=()=>{app.innerHTML=draw();bind();};
  $("#go").onclick=async()=>{const b=$("#go");b.disabled=true;b.innerHTML='<span class="spin"></span>Déplacement…';
    const r=await fetch(\`/r/m/\${C.manage}/move\`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({start:chosen})});const j=await r.json();
    if(!r.ok){alertBox(j.error);return;}done({...j,moved:true});};
}
function alertBox(msg){app.insertAdjacentHTML("afterbegin",'<div class="err" role="alert" style="margin:20px 30px 0">'+e(msg||"Erreur")+'</div>');load();}
load();
</script>`;
  return shell(`${cal.name} — ${br.company}`, br.accent, body, script);
}

function managePage(a, cal, br) {
  const past = new Date(a.start_at) < new Date();
  const cancelled = a.status === "annule";
  const body = `<article class="card" style="grid-template-columns:1fr;min-height:0"><div class="done" style="max-width:640px">
    ${br.logo ? `<img class="logo" src="${br.logo}" alt="${esc(br.company)}">` : ""}
    <h2>${cancelled ? "Rendez-vous annulé" : esc(cal ? cal.name : a.title)}</h2>
    <div class="box"><b>${esc(fmtWhen(a.start_at))}</b> (heure de Paris)${a.meet_url && !cancelled ? `<br>Visio : <a href="${esc(a.meet_url)}">${esc(a.meet_url)}</a>` : ""}</div>
    ${cancelled ? `<p>Ce rendez-vous a bien été annulé.${cal && cal.active ? ` <a href="/r/${esc(cal.slug)}">Reprendre un rendez-vous</a>` : ""}</p>`
      : past ? `<p>Ce rendez-vous est passé.</p>`
      : `<div style="display:flex;gap:10px;flex-wrap:wrap">${cal ? `<a class="go" style="width:auto;padding:12px 20px;text-decoration:none;color:#fff" href="/r/${esc(cal.slug)}?m=${esc(a.manage_token)}">Déplacer</a>` : ""}
         <form method="post" action="/r/m/${esc(a.manage_token)}/cancel" onsubmit="return confirm('Annuler ce rendez-vous ?')"><button class="go" style="width:auto;padding:12px 20px;background:#fff;color:#A12A2A;border:1px solid #F3C5C5">Annuler le rendez-vous</button></form></div>`}
  </div></article>`;
  return shell(`Votre rendez-vous — ${br.company}`, br.accent, body);
}

// petite protection contre les abus : 8 réservations par heure et par adresse IP
const hits = new Map();
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  list.push(now); hits.set(ip, list);
  return list.length > 8;
}

function publicRoutes() {
  const r = express.Router();
  r.use("/r", express.json({ limit: "20kb" }));
  r.get("/r/m/:token", wrap(async (req, res) => {
    const a = (await q(`SELECT * FROM appointments WHERE manage_token=$1`, [req.params.token])).rows[0];
    if (!a) return res.status(404).send(shell("Rendez-vous introuvable", "#1877F2", `<p>Ce lien n'est plus valable.</p>`));
    const cal = a.calendar_id ? (await q(`SELECT * FROM booking_calendars WHERE id=$1`, [a.calendar_id])).rows[0] : null;
    res.setHeader("Cache-Control", "no-store");
    res.send(managePage(a, cal, await brand()));
  }));
  r.post("/r/m/:token/cancel", express.urlencoded({ extended: false }), wrap(async (req, res) => {
    const a = (await q(`SELECT * FROM appointments WHERE manage_token=$1`, [req.params.token])).rows[0];
    if (!a) return res.status(404).send("Introuvable");
    if (a.status !== "annule" && new Date(a.start_at) > new Date()) {
      if (a.google_event_id) await google.deleteEvent(a.google_event_id, true).catch((e) => console.warn("Annulation Google :", e.message));
      await q(`UPDATE appointments SET status='annule' WHERE id=$1`, [a.id]);
      await stopRunsFor(a.id);
      { const cal = a.calendar_id ? (await q(`SELECT * FROM booking_calendars WHERE id=$1`, [a.calendar_id])).rows[0] : null;
        const lead = a.lead_id ? (await q(`SELECT * FROM leads WHERE id=$1`, [a.lead_id])).rows[0] : null;
        mailer.fire(() => mailer.bookingChanged(a, lead, cal, "cancelled")); }
      if (a.lead_id) await q(`UPDATE leads SET stage=CASE WHEN stage='rdv' THEN 'rappel' ELSE stage END, status=CASE WHEN status='rdv' THEN 'rappel' ELSE status END, stage_at=now(), updated_at=now(),
                                notes = concat_ws(E'\\n', NULLIF(notes,''), $2::text) WHERE id=$1`, [a.lead_id, `[${new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" })}] RDV annulé par le prospect.`]);
    }
    res.redirect(303, `/r/m/${a.manage_token}`);
  }));
  r.post("/r/m/:token/move", wrap(async (req, res) => {
    const a = (await q(`SELECT * FROM appointments WHERE manage_token=$1`, [req.params.token])).rows[0];
    if (!a || a.status === "annule") return res.status(404).json({ error: "Rendez-vous introuvable" });
    const cal = (await q(`SELECT * FROM booking_calendars WHERE id=$1`, [a.calendar_id])).rows[0];
    if (!cal) return res.status(404).json({ error: "Calendrier introuvable" });
    const start = new Date(req.body.start);
    const day = localDay(start, cal.timezone);
    const free = await slotsFor(cal, day, 1, { ignoreAppointmentId: a.id });
    if (!(free[day] || []).includes(start.toISOString())) return res.status(409).json({ error: "Ce créneau n'est plus libre" });
    const end = new Date(start.getTime() + cal.duration_min * 60e3);
    if (a.google_event_id) await google.moveEvent(a.google_event_id, start.toISOString(), end.toISOString(), true).catch((e) => console.warn("Déplacement Google :", e.message));
    // un RDV déplacé redevient un nouveau RDV pour les automatisations (rappels recalculés)
    await q(`UPDATE appointments SET status='annule' WHERE id=$1`, [a.id]);
    await stopRunsFor(a.id);
    const n = (await q(`INSERT INTO appointments (lead_id, google_event_id, title, start_at, end_at, meet_url, attendee_email, calendar_id, manage_token, source, notes)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'booking',$10) RETURNING *`,
      [a.lead_id, a.google_event_id, a.title, start, end, a.meet_url, a.attendee_email, a.calendar_id, crypto.randomBytes(18).toString("base64url"), a.notes])).rows[0];
    await q(`UPDATE appointments SET google_event_id=NULL, manage_token=NULL WHERE id=$1`, [a.id]);
    if (a.lead_id) await q(`UPDATE leads SET notes = concat_ws(E'\\n', NULLIF(notes,''), $2::text), updated_at=now() WHERE id=$1`, [a.lead_id, `[${new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" })}] RDV déplacé par le prospect au ${fmtWhen(start)}.`]);
    { const lead = a.lead_id ? (await q(`SELECT * FROM leads WHERE id=$1`, [a.lead_id])).rows[0] : null;
      mailer.fire(() => mailer.bookingChanged({ ...a, meet_url: n.meet_url }, lead, cal, "moved", start)); }
    res.json({ start: start.toISOString(), meet: n.meet_url, manage: manageUrl(n) });
  }));
  r.get("/r/:slug", wrap(async (req, res, next) => {
    const cal = (await q(`SELECT * FROM booking_calendars WHERE slug=$1`, [req.params.slug])).rows[0];
    if (!cal || !cal.active) return res.status(404).send(shell("Calendrier introuvable", "#1877F2", `<div class="card" style="grid-template-columns:1fr;min-height:0"><div class="done"><h2>Ce calendrier n'est pas disponible</h2><p>Le lien a peut-être changé.</p></div></div>`));
    let manage = null;
    if (req.query.m) manage = (await q(`SELECT * FROM appointments WHERE manage_token=$1 AND calendar_id=$2 AND status <> 'annule'`, [String(req.query.m), cal.id])).rows[0] || null;
    res.setHeader("Cache-Control", "no-store");
    res.send(bookingPage(cal, await brand(), manage));
  }));
  r.get("/r/:slug/slots", wrap(async (req, res) => {
    const cal = (await q(`SELECT * FROM booking_calendars WHERE slug=$1 AND active`, [req.params.slug])).rows[0];
    if (!cal) return res.status(404).json({ error: "Calendrier introuvable" });
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "") ? req.query.from : localDay(new Date(), cal.timezone);
    const days = Math.max(1, Math.min(42, Number(req.query.days) || 31));
    let ignore = null;
    if (req.query.manage) { const a = (await q(`SELECT id FROM appointments WHERE manage_token=$1`, [String(req.query.manage)])).rows[0]; if (a) ignore = a.id; }
    res.setHeader("Cache-Control", "no-store");
    res.json({ days: await slotsFor(cal, from, days, { ignoreAppointmentId: ignore }) });
  }));
  r.post("/r/:slug/book", wrap(async (req, res) => {
    const cal = (await q(`SELECT * FROM booking_calendars WHERE slug=$1 AND active`, [req.params.slug])).rows[0];
    if (!cal) return res.status(404).json({ error: "Calendrier introuvable" });
    if (req.body && req.body.website) return res.status(400).json({ error: "Réservation refusée" }); // robot
    if (limited(req.ip)) return res.status(429).json({ error: "Trop de réservations, réessayez plus tard" });
    try {
      const out = await book(cal, req.body || {}, req.ip);
      res.json({ start: out.appointment.start_at, meet: out.meet, manage: manageUrl(out.appointment) });
    } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : "Réservation impossible, réessayez" }); if (!e.status) console.warn("Réservation :", e.message); }
  }));
  return r;
}

module.exports = { api, publicRoutes, slotsFor, cleanCalendar, DEFAULT_HOURS, stopRunsFor };
