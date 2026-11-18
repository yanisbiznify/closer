// Automatisations CLOSER PRO : déclencheurs, étapes, exécution, modèles et création par IA
const express = require("express");
const config = require("./config");
const { q, getSettings } = require("./db");
const inbox = require("./inbox");
const tw = require("./twilio");
const { STAGES, OUTCOMES } = require("./dialer");

const TZ = "Europe/Paris";
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------- Ce que l'éditeur et l'IA connaissent ---------- */
const TRIGGERS = {
  lead_created: { label: "Nouveau prospect ajouté" },
  stage_changed: { label: "Le prospect change d'étape", fields: ["to"] },
  call_outcome: { label: "Résultat d'un appel", fields: ["outcomes"] },
  appointment_booked: { label: "RDV pris dans l'agenda" },
  message_received: { label: "Le prospect répond (SMS ou email)", fields: ["channel"] },
  tag_added: { label: "Tag ajouté au prospect", fields: ["tag"] },
  invoice_created: { label: "Facture créée" },
  invoice_paid: { label: "Facture payée" },
  manual: { label: "Lancement manuel" },
};
const STEPS = {
  wait: "Attendre",
  wait_until: "Attendre jusqu'à une date (RDV, échéance)",
  send_sms: "Envoyer un SMS",
  send_email: "Envoyer un email",
  set_stage: "Changer l'étape",
  add_tag: "Ajouter un tag",
  remove_tag: "Retirer un tag",
  add_note: "Ajouter une note",
  create_task: "Créer une tâche pour moi",
  condition: "Continuer seulement si…",
};
const CONDITIONS = {
  stage_is: "est à l'étape",
  stage_is_not: "n'est pas à l'étape",
  has_tag: "a le tag",
  not_has_tag: "n'a pas le tag",
  replied: "a répondu depuis le début",
  not_replied: "n'a pas répondu depuis le début",
  invoice_paid: "a payé la facture",
  invoice_unpaid: "n'a pas payé la facture",
  has_email: "a un email",
  has_phone: "a un numéro",
  attempts_gte: "a eu au moins N tentatives d'appel",
  appointment_upcoming: "a un RDV à venir",
  no_appointment_upcoming: "n'a pas de RDV à venir",
};
const VARIABLES = ["prénom", "nom", "entreprise", "téléphone", "email", "ton_prénom", "date_rdv", "heure_rdv", "lien_meet", "numéro_facture", "montant_facture", "lien_facture", "échéance_facture"];
const STAGE_IDS = STAGES.map((s) => s.id);

/* ---------- Nettoyage d'une automatisation (éditeur ou IA) ---------- */
const str = (v, n = 2000) => (v == null ? "" : String(v)).slice(0, n);
const tagOf = (v) => str(v, 60).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
function cleanTrigger(t) {
  t = t || {};
  const type = TRIGGERS[t.type] ? t.type : "manual";
  const out = { type };
  if (type === "stage_changed") out.to = STAGE_IDS.includes(t.to) ? t.to : "rdv";
  if (type === "call_outcome") out.outcomes = (Array.isArray(t.outcomes) ? t.outcomes : [t.outcomes]).filter((o) => OUTCOMES[o]);
  if (type === "call_outcome" && !out.outcomes.length) out.outcomes = ["messagerie", "injoignable"];
  if (type === "message_received") out.channel = ["sms", "email"].includes(t.channel) ? t.channel : "any";
  if (type === "tag_added") out.tag = tagOf(t.tag) || "tag";
  return out;
}
function cleanStep(s, i) {
  s = s || {};
  const type = STEPS[s.type] ? s.type : null;
  if (!type) return null;
  const st = { id: str(s.id, 40) || `s${Date.now().toString(36)}${i}`, type };
  if (type === "wait") { st.amount = Math.max(1, Math.min(365, Math.round(Number(s.amount) || 1))); st.unit = ["minutes", "hours", "days"].includes(s.unit) ? s.unit : "days"; }
  if (type === "wait_until") { st.anchor = ["appointment_start", "invoice_due"].includes(s.anchor) ? s.anchor : "appointment_start"; st.offset_minutes = Math.max(-60 * 24 * 30, Math.min(60 * 24 * 60, Math.round(Number(s.offset_minutes) || 0))); }
  if (type === "send_sms") st.body = str(s.body, 1500);
  if (type === "send_email") { st.subject = str(s.subject, 200); st.body = str(s.body, 10000); }
  if (type === "set_stage") st.stage = STAGE_IDS.includes(s.stage) ? s.stage : "rappel";
  if (type === "add_tag" || type === "remove_tag") st.tag = tagOf(s.tag) || "tag";
  if (type === "add_note") st.text = str(s.text, 2000);
  if (type === "create_task") { st.title = str(s.title, 200) || "À faire"; st.body = str(s.body, 2000); st.due_in_hours = Math.max(0, Math.min(24 * 90, Number(s.due_in_hours) || 0)); }
  if (type === "condition") {
    st.check = CONDITIONS[s.check] ? s.check : "not_replied";
    if (["stage_is", "stage_is_not"].includes(st.check)) st.value = STAGE_IDS.includes(s.value) ? s.value : "nouveau";
    else if (["has_tag", "not_has_tag"].includes(st.check)) st.value = tagOf(s.value) || "tag";
    else if (st.check === "attempts_gte") st.value = Math.max(1, Math.round(Number(s.value) || 1));
  }
  return st;
}
function cleanAutomation(a) {
  a = a || {};
  const steps = (Array.isArray(a.steps) ? a.steps : []).slice(0, 40).map(cleanStep).filter(Boolean);
  const o = a.options || {};
  return {
    name: str(a.name, 120).trim() || "Nouvelle automatisation",
    description: str(a.description, 500),
    trigger: cleanTrigger(a.trigger),
    steps,
    options: { stop_on_reply: o.stop_on_reply !== false, allow_reentry: !!o.allow_reentry, quiet_hours: o.quiet_hours !== false },
  };
}

/* ---------- Variables dans les messages ---------- */
const fmtDate = (d) => new Date(d).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
const fmtTime = (d) => new Date(d).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: TZ }).replace(":", "h");
const euro = (c) => ((c || 0) / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });

async function appointmentFor(run) {
  if (run.context.appointment_id) {
    const r = (await q(`SELECT * FROM appointments WHERE id=$1`, [run.context.appointment_id])).rows[0];
    if (r) return r;
  }
  return (await q(`SELECT * FROM appointments WHERE lead_id=$1 AND status <> 'annule' AND start_at > now() - interval '2 hours' ORDER BY start_at LIMIT 1`, [run.lead_id])).rows[0] || null;
}
async function invoiceFor(run) {
  if (run.context.invoice_id) {
    const r = (await q(`SELECT * FROM invoices WHERE id=$1`, [run.context.invoice_id])).rows[0];
    if (r) return r;
  }
  return (await q(`SELECT * FROM invoices WHERE lead_id=$1 ORDER BY (status='emise') DESC, created_at DESC LIMIT 1`, [run.lead_id])).rows[0] || null;
}
async function render(text, lead, run) {
  if (!text) return "";
  const s = await getSettings();
  const need = (k) => text.includes("{" + k + "}");
  const appt = need("date_rdv") || need("heure_rdv") || need("lien_meet") ? await appointmentFor(run) : null;
  const inv = ["numéro_facture", "montant_facture", "lien_facture", "échéance_facture"].some(need) ? await invoiceFor(run) : null;
  const first = lead.first_name || (lead.name || "").split(" ")[0] || "";
  const vals = {
    "prénom": first, nom: lead.last_name || "", entreprise: lead.company || "", "téléphone": lead.phone || "", email: lead.email || "",
    "ton_prénom": s.prenom || "Yanis",
    date_rdv: appt ? fmtDate(appt.start_at) : "", heure_rdv: appt ? fmtTime(appt.start_at) : "", lien_meet: appt && appt.meet_url ? appt.meet_url : "",
    "numéro_facture": inv ? inv.number : "", montant_facture: inv ? euro(inv.total_cents) : "",
    lien_facture: inv ? `${tw.publicUrl() || ""}/facture/${inv.token}` : "", "échéance_facture": inv && inv.due_date ? fmtDate(inv.due_date) : "",
  };
  return text.replace(/\{([a-zàâçéèêëîïôûùüÿ_]+)\}/gi, (m, k) => (k in vals ? vals[k] : m))
    .replace(/Bonjour ,/g, "Bonjour,").replace(/ {2,}/g, " ");
}

/* ---------- Heures calmes : pas de SMS ni d'email la nuit (heure de Paris) ---------- */
function parisParts(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { h: Number(p.hour), m: Number(p.minute) };
}
function nextSendWindow(now = new Date()) {
  const { h, m } = parisParts(now);
  const mins = h * 60 + m;
  if (mins >= 8 * 60 + 30 && mins < 20 * 60) return null; // on peut envoyer
  const wait = mins < 8 * 60 + 30 ? 8 * 60 + 30 - mins : 24 * 60 - mins + 8 * 60 + 30;
  return new Date(now.getTime() + wait * 60000);
}

/* ---------- Conditions ---------- */
async function checkCondition(st, lead, run) {
  switch (st.check) {
    case "stage_is": return lead.stage === st.value;
    case "stage_is_not": return lead.stage !== st.value;
    case "has_tag": return (lead.tags || []).includes(st.value);
    case "not_has_tag": return !(lead.tags || []).includes(st.value);
    case "replied":
    case "not_replied": {
      const r = await q(`SELECT 1 FROM messages WHERE lead_id=$1 AND direction='in' AND created_at >= $2 LIMIT 1`, [lead.id, run.started_at]);
      return st.check === "replied" ? r.rows.length > 0 : r.rows.length === 0;
    }
    case "invoice_paid":
    case "invoice_unpaid": {
      const inv = await invoiceFor(run);
      const paid = !!inv && inv.status === "payee";
      return st.check === "invoice_paid" ? paid : !!inv && inv.status === "emise";
    }
    case "has_email": return !!lead.email;
    case "has_phone": return !!lead.phone;
    case "attempts_gte": return (lead.attempts || 0) >= st.value;
    case "appointment_upcoming":
    case "no_appointment_upcoming": {
      const r = await q(`SELECT 1 FROM appointments WHERE lead_id=$1 AND status <> 'annule' AND start_at > now() LIMIT 1`, [lead.id]);
      return st.check === "appointment_upcoming" ? r.rows.length > 0 : r.rows.length === 0;
    }
  }
  return true;
}

/* ---------- Exécution ---------- */
const log = (run, entry) => run.log.push({ at: new Date().toISOString(), ...entry });

async function finish(run, status, note) {
  if (note) log(run, { info: note });
  await q(`UPDATE automation_runs SET status=$2, step=$3, log=$4, ended_at=now() WHERE id=$1`, [run.id, status, run.step, JSON.stringify(run.log.slice(-60))]);
}

async function advance(run) {
  const a = (await q(`SELECT * FROM automations WHERE id=$1`, [run.automation_id])).rows[0];
  if (!a) return;
  if (!a.enabled) { await finish(run, "stopped", "Automatisation désactivée"); return; }
  const steps = a.steps || [];
  if (run.context.appointment_id) {
    const ap = (await q(`SELECT status FROM appointments WHERE id=$1`, [run.context.appointment_id])).rows[0];
    if (!ap || ap.status === "annule") { await finish(run, "stopped", "RDV annulé"); return; }
  }
  for (let guard = 0; guard < 50; guard++) {
    if (run.step >= steps.length) { await finish(run, "done"); return; }
    const lead = run.lead_id ? (await q(`SELECT * FROM leads WHERE id=$1`, [run.lead_id])).rows[0] : null;
    if (!lead) { await finish(run, "stopped", "Prospect supprimé"); return; }
    const st = steps[run.step];
    // les attentes reportent la suite
    if (st.type === "wait" || st.type === "wait_until") {
      let until;
      if (st.type === "wait") {
        const ms = { minutes: 60e3, hours: 3600e3, days: 86400e3 }[st.unit] * st.amount;
        until = new Date(Date.now() + ms);
      } else {
        const base = st.anchor === "appointment_start" ? await appointmentFor(run) : await invoiceFor(run);
        const at = base ? (st.anchor === "appointment_start" ? base.start_at : base.due_date) : null;
        if (!at) { log(run, { step: run.step, type: st.type, info: st.anchor === "appointment_start" ? "Pas de RDV : étape ignorée" : "Pas d'échéance : étape ignorée" }); run.step++; continue; }
        until = new Date(new Date(at).getTime() + st.offset_minutes * 60000);
        if (until <= new Date()) { log(run, { step: run.step, type: st.type, info: "Date déjà passée : on continue" }); run.step++; continue; }
      }
      run.step++;
      log(run, { step: run.step - 1, type: st.type, info: `Reprise le ${until.toLocaleString("fr-FR", { timeZone: TZ, dateStyle: "short", timeStyle: "short" })}` });
      await q(`UPDATE automation_runs SET step=$2, next_at=$3, log=$4 WHERE id=$1`, [run.id, run.step, until, JSON.stringify(run.log.slice(-60))]);
      return;
    }
    if ((st.type === "send_sms" || st.type === "send_email") && (a.options || {}).quiet_hours !== false) {
      const later = nextSendWindow();
      if (later) {
        await q(`UPDATE automation_runs SET next_at=$2, log=$3 WHERE id=$1`, [run.id, later, JSON.stringify(run.log.slice(-60))]);
        return;
      }
    }
    try {
      switch (st.type) {
        case "send_sms": {
          const body = await render(st.body, lead, run);
          if (!body.trim()) throw new Error("SMS vide");
          await inbox.sendSms(lead, body);
          log(run, { step: run.step, type: st.type, ok: true, info: body.slice(0, 160) });
          break;
        }
        case "send_email": {
          const subject = await render(st.subject, lead, run), body = await render(st.body, lead, run);
          await inbox.sendEmail(lead, subject || "Biznify", body);
          log(run, { step: run.step, type: st.type, ok: true, info: subject });
          break;
        }
        case "set_stage": {
          const status = { nouveau: "a_appeler", rappel: "rappel", rdv: "rdv", gagne: "rdv", perdu: "pas_interesse" }[st.stage];
          await q(`UPDATE leads SET stage=$2, stage_at=now(), status=COALESCE($3, status), updated_at=now() WHERE id=$1`, [lead.id, st.stage, status || null]);
          log(run, { step: run.step, type: st.type, ok: true, info: (STAGES.find((x) => x.id === st.stage) || {}).label });
          break;
        }
        case "add_tag":
          await q(`UPDATE leads SET tags = array_append(tags, $2::text), updated_at=now() WHERE id=$1 AND NOT ($2 = ANY(tags))`, [lead.id, st.tag]);
          log(run, { step: run.step, type: st.type, ok: true, info: st.tag }); break;
        case "remove_tag":
          await q(`UPDATE leads SET tags = array_remove(tags, $2::text), updated_at=now() WHERE id=$1`, [lead.id, st.tag]);
          log(run, { step: run.step, type: st.type, ok: true, info: st.tag }); break;
        case "add_note": {
          const text = await render(st.text, lead, run);
          const stamp = new Date().toLocaleDateString("fr-FR", { timeZone: TZ });
          await q(`UPDATE leads SET notes = concat_ws(E'\\n', NULLIF(notes,''), $2::text), updated_at=now() WHERE id=$1`, [lead.id, `[${stamp}] ${text}`]);
          log(run, { step: run.step, type: st.type, ok: true }); break;
        }
        case "create_task": {
          const title = await render(st.title, lead, run), body = await render(st.body, lead, run);
          await q(`INSERT INTO tasks (lead_id, title, body, due_at, source) VALUES ($1,$2,$3, now() + ($4 || ' hours')::interval, $5)`, [lead.id, title, body || null, String(st.due_in_hours || 0), a.name]);
          log(run, { step: run.step, type: st.type, ok: true, info: title }); break;
        }
        case "condition": {
          const ok = await checkCondition(st, lead, run);
          log(run, { step: run.step, type: st.type, ok, info: `${CONDITIONS[st.check]}${st.value != null ? " " + st.value : ""} : ${ok ? "oui" : "non, arrêt"}` });
          if (!ok) { run.step++; await finish(run, "done", "Condition non remplie"); return; }
          break;
        }
      }
    } catch (e) {
      log(run, { step: run.step, type: st.type, ok: false, error: e.message });
    }
    run.step++;
  }
  await q(`UPDATE automation_runs SET step=$2, log=$3 WHERE id=$1`, [run.id, run.step, JSON.stringify(run.log.slice(-60))]);
}

async function enroll(a, leadId, context = {}) {
  if (!leadId) return null;
  if (!(a.options || {}).allow_reentry) {
    const ex = await q(`SELECT 1 FROM automation_runs WHERE automation_id=$1 AND lead_id=$2 AND (status='active' OR started_at > now() - interval '1 minute') LIMIT 1`, [a.id, leadId]);
    if (ex.rows.length) return null;
  }
  const r = await q(`INSERT INTO automation_runs (automation_id, lead_id, context, log) VALUES ($1,$2,$3,$4) RETURNING *`,
    [a.id, leadId, context, JSON.stringify([{ at: new Date().toISOString(), info: "Démarrée" }])]);
  return r.rows[0];
}

function matches(trigger, ev) {
  if (trigger.type !== ev.type) return false;
  const d = ev.data || {};
  if (ev.type === "stage_changed") return trigger.to === d.to;
  if (ev.type === "call_outcome") return (trigger.outcomes || []).includes(d.outcome);
  if (ev.type === "message_received") return !trigger.channel || trigger.channel === "any" || trigger.channel === d.channel;
  if (ev.type === "tag_added") return trigger.tag === d.tag;
  return true;
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    // 1. événements → nouvelles exécutions
    const evs = (await q(`SELECT * FROM automation_events WHERE NOT processed ORDER BY id LIMIT 300`)).rows;
    if (evs.length) {
      const autos = (await q(`SELECT * FROM automations WHERE enabled`)).rows;
      for (const ev of evs) {
        if (ev.type === "message_received" && ev.lead_id) {
          // une réponse arrête les séquences qui le demandent
          await q(`UPDATE automation_runs r SET status='stopped', ended_at=now(),
                     log = r.log || jsonb_build_array(jsonb_build_object('at', now(), 'info', 'Arrêtée : le prospect a répondu'))
                   FROM automations a WHERE a.id=r.automation_id AND r.lead_id=$1 AND r.status='active'
                     AND COALESCE((a.options->>'stop_on_reply')::boolean, true) AND a.trigger->>'type' <> 'message_received'`, [ev.lead_id]);
        }
        for (const a of autos) {
          if (!matches(a.trigger, ev)) continue;
          const ctx = {};
          if (ev.data.appointment_id) ctx.appointment_id = ev.data.appointment_id;
          if (ev.data.invoice_id) ctx.invoice_id = ev.data.invoice_id;
          await enroll(a, ev.lead_id, ctx).catch((e) => console.warn("Automatisation :", e.message));
        }
      }
      await q(`UPDATE automation_events SET processed=true WHERE id = ANY($1)`, [evs.map((e) => e.id)]);
    }
    // 2. exécutions dues
    const due = (await q(`SELECT * FROM automation_runs WHERE status='active' AND next_at <= now() ORDER BY next_at LIMIT 100`)).rows;
    for (const run of due) {
      try { await advance(run); } catch (e) { console.warn("Automatisation", run.id, e.message); await q(`UPDATE automation_runs SET status='failed', ended_at=now() WHERE id=$1`, [run.id]); }
    }
    // ménage : les vieux événements traités
    if (Math.random() < 0.01) await q(`DELETE FROM automation_events WHERE processed AND created_at < now() - interval '30 days'`);
  } catch (e) {
    console.warn("Automatisations :", e.message);
  } finally { ticking = false; }
}
function start() { setInterval(tick, 20000); setTimeout(tick, 5000); }

/* ---------- Modèles (tes automatisations GHL, recréées) ---------- */
const T = (name, description, trigger, steps, options = {}) => ({ name, description, trigger, steps: steps.map((s, i) => ({ id: `t${i}`, ...s })), options });
const TEMPLATES = {
  sms_x1: T("Cold calling — SMS après 1 appel sans réponse", "Remplace l'étape GHL « no contact x1 text 1 ». Le prospect ne décroche pas une première fois : il reçoit un SMS court.",
    { type: "stage_changed", to: "tentative1" },
    [{ type: "wait", amount: 5, unit: "minutes" },
     { type: "send_sms", body: "Bonjour {prénom}, c'est {ton_prénom} de Biznify. Je viens d'essayer de vous joindre au sujet des appels que vous manquez sur vos chantiers. Quand puis-je vous rappeler ?" }]),
  sms_x2: T("Cold calling — SMS après 2 appels sans réponse", "Remplace l'étape GHL « No contact 2x text 2 ».",
    { type: "stage_changed", to: "tentative2" },
    [{ type: "wait", amount: 5, unit: "minutes" },
     { type: "send_sms", body: "{prénom}, deuxième essai de ma part 🙂 En 2 minutes je vous montre comment ne plus perdre un seul appel client, même quand vous êtes sur un chantier. Vous préférez demain matin ou en fin de journée ?" }]),
  sms_x3: T("Cold calling — SMS après 3 appels sans réponse puis relance dans 8 semaines", "Remplace « No contact 3x text 3 » et « No contact → Long Term Nurture » : dernier SMS, puis le prospect revient dans ta file d'appels 8 semaines plus tard s'il n'a pas répondu.",
    { type: "stage_changed", to: "tentative3" },
    [{ type: "wait", amount: 5, unit: "minutes" },
     { type: "send_sms", body: "Bonjour {prénom}, je ne vais pas vous embêter plus longtemps. Si un jour vous voulez qu'une IA réponde à vos appels et prenne vos rendez-vous à votre place, répondez simplement « OK » et je vous rappelle. {ton_prénom}, Biznify" },
     { type: "wait", amount: 2, unit: "days" },
     { type: "condition", check: "stage_is", value: "tentative3" },
     { type: "add_tag", tag: "nurture-8-semaines" },
     { type: "set_stage", stage: "perdu" },
     { type: "wait", amount: 56, unit: "days" },
     { type: "condition", check: "stage_is", value: "perdu" },
     { type: "remove_tag", tag: "nurture-8-semaines" },
     { type: "set_stage", stage: "nouveau" },
     { type: "add_note", text: "Revenu dans la file d'appels après 8 semaines sans contact." }]),
  rdv_confirm: T("RDV pris — confirmation et rappels", "Confirme le RDV par SMS et email, puis rappelle le prospect la veille et 1 heure avant. Réduit les no-shows.",
    { type: "appointment_booked" },
    [{ type: "send_sms", body: "Bonjour {prénom}, c'est confirmé : on se voit {date_rdv} à {heure_rdv} en visio. Le lien : {lien_meet} À très vite, {ton_prénom} de Biznify" },
     { type: "send_email", subject: "Notre rendez-vous {date_rdv} à {heure_rdv}", body: "Bonjour {prénom},\n\nMerci pour notre échange. Je vous confirme notre rendez-vous {date_rdv} à {heure_rdv}, en visio Google Meet :\n{lien_meet}\n\nEn 30 minutes, je vous montre comment notre IA répond à vos appels, qualifie vos clients et remplit votre agenda, même quand vous êtes sur un chantier.\n\nÀ très vite,\n{ton_prénom}\nBiznify" },
     { type: "wait_until", anchor: "appointment_start", offset_minutes: -1440 },
     { type: "send_sms", body: "Bonjour {prénom}, petit rappel de notre RDV demain à {heure_rdv}. Le lien : {lien_meet} Un empêchement ? Répondez à ce SMS." },
     { type: "wait_until", anchor: "appointment_start", offset_minutes: -60 },
     { type: "send_sms", body: "{prénom}, on se retrouve dans 1 heure ({heure_rdv}) : {lien_meet} À tout de suite !" }],
    { stop_on_reply: false }),
  invoice_reminders: T("Facture — relances de paiement", "Relance automatiquement une facture non payée après l'échéance, par email puis par SMS, et te crée une tâche si elle reste impayée.",
    { type: "invoice_created" },
    [{ type: "wait_until", anchor: "invoice_due", offset_minutes: 60 * 24 + 600 },
     { type: "condition", check: "invoice_unpaid" },
     { type: "send_email", subject: "Facture {numéro_facture} — petit rappel", body: "Bonjour {prénom},\n\nSauf erreur de ma part, la facture {numéro_facture} de {montant_facture} arrivait à échéance {échéance_facture}.\nVous pouvez la régler en un clic par carte ici :\n{lien_facture}\n\nMerci et belle journée,\n{ton_prénom}\nBiznify" },
     { type: "wait", amount: 3, unit: "days" },
     { type: "condition", check: "invoice_unpaid" },
     { type: "send_sms", body: "Bonjour {prénom}, c'est {ton_prénom} de Biznify. La facture {numéro_facture} ({montant_facture}) est toujours en attente. Le lien pour la régler : {lien_facture} Merci !" },
     { type: "wait", amount: 4, unit: "days" },
     { type: "condition", check: "invoice_unpaid" },
     { type: "create_task", title: "Appeler {prénom} ({entreprise}) : facture {numéro_facture} impayée", body: "{montant_facture} en retard depuis plus d'une semaine.", due_in_hours: 0 }],
    { stop_on_reply: false }),
  invoice_thanks: T("Facture payée — remerciement", "Remercie le client dès que Stripe confirme le paiement.",
    { type: "invoice_paid" },
    [{ type: "send_email", subject: "Paiement bien reçu, merci !", body: "Bonjour {prénom},\n\nJe vous confirme la bonne réception de votre paiement de {montant_facture} pour la facture {numéro_facture}. Merci pour votre confiance !\n\nVous retrouvez votre facture ici : {lien_facture}\n\n{ton_prénom}\nBiznify" }],
    { stop_on_reply: false }),
  onboarding_1: T("Onboarding 1 — Bienvenue et relances", "Recréé depuis GHL. Le prospect passe en « Client signé » : bienvenue par email et SMS, questionnaire envoyé, relance à J+2, puis tâche pour l'appeler à J+4 s'il n'a pas répondu.",
    { type: "stage_changed", to: "gagne" },
    [{ type: "add_tag", tag: "onboarding-en-cours" },
     { type: "send_email", subject: "Bienvenue chez Biznify, {prénom} !", body: "Bonjour {prénom},\n\nBienvenue chez Biznify, et merci pour votre confiance !\n\nPour lancer la mise en place de votre réceptionniste IA, la première étape est de remplir ce questionnaire (10 minutes) :\n[LIEN DU QUESTIONNAIRE]\n\nDès réception, je vous propose un appel de lancement pour tout caler ensemble. Mise en ligne prévue sous 7 jours.\n\nÀ très vite,\n{ton_prénom}\nBiznify" },
     { type: "send_sms", body: "Bienvenue chez Biznify {prénom} ! Je viens de vous envoyer par email le questionnaire pour lancer votre réceptionniste IA (10 min). {ton_prénom}" },
     { type: "add_tag", tag: "questionnaire-envoye" },
     { type: "create_task", title: "Nouveau client : {entreprise}", body: "Onboarding lancé, questionnaire envoyé.", due_in_hours: 0 },
     { type: "wait", amount: 2, unit: "days" },
     { type: "condition", check: "not_has_tag", value: "questionnaire-recu" },
     { type: "send_email", subject: "Votre questionnaire Biznify", body: "Bonjour {prénom},\n\nPetit rappel : pour lancer votre réceptionniste IA, il me manque votre questionnaire :\n[LIEN DU QUESTIONNAIRE]\n\nÇa prend 10 minutes, et ensuite je m'occupe de tout.\n\n{ton_prénom}\nBiznify" },
     { type: "wait", amount: 2, unit: "days" },
     { type: "condition", check: "not_has_tag", value: "questionnaire-recu" },
     { type: "create_task", title: "Appeler {prénom} pour le questionnaire", body: "Questionnaire toujours pas reçu 4 jours après la signature.", due_in_hours: 0 }],
    { stop_on_reply: false }),
  onboarding_2: T("Onboarding 2 — Questionnaire reçu", "Recréé depuis GHL. Ajoute le tag « questionnaire-recu » au client : tâche du dossier numéro français, puis invitation à réserver l'appel de lancement s'il n'a pas de RDV.",
    { type: "tag_added", tag: "questionnaire-recu" },
    [{ type: "add_note", text: "Questionnaire d'onboarding reçu." },
     { type: "create_task", title: "Dossier du numéro français : {entreprise}", body: "Questionnaire reçu, lancer la demande de numéro.", due_in_hours: 0 },
     { type: "condition", check: "no_appointment_upcoming" },
     { type: "send_sms", body: "Merci {prénom}, questionnaire bien reçu ! Prochaine étape : notre appel de lancement (30 min). Réservez votre créneau ici : [LIEN DE RÉSERVATION] {ton_prénom}" }],
    { stop_on_reply: false }),
  onboarding_3: T("Onboarding 3 — Après l'appel de lancement", "Recréé depuis GHL. Ajoute le tag « appel-lancement-fait » : tâche pour envoyer le récap, puis passage en construction.",
    { type: "tag_added", tag: "appel-lancement-fait" },
    [{ type: "create_task", title: "Envoyer le récap à {prénom} et fixer les dates", body: "Appel de lancement fait.", due_in_hours: 0 },
     { type: "wait", amount: 1, unit: "hours" },
     { type: "add_tag", tag: "en-construction" }],
    { stop_on_reply: false }),
  onboarding_4: T("Onboarding 4 — Mise en ligne et suivi", "Recréé depuis GHL. Ajoute le tag « en-ligne » : message de mise en ligne, point de suivi à J+7, bilan à J+23, puis le client passe « client-actif ».",
    { type: "tag_added", tag: "en-ligne" },
    [{ type: "remove_tag", tag: "en-construction" },
     { type: "send_email", subject: "Votre réceptionniste IA est en ligne !", body: "Bonjour {prénom},\n\nC'est officiel : votre réceptionniste IA est en ligne. À partir de maintenant, chaque appel est décroché, chaque client est qualifié et vos rendez-vous arrivent directement dans votre agenda.\n\nJe fais un point avec vous dans une semaine pour ajuster ce qui doit l'être.\n\n{ton_prénom}\nBiznify" },
     { type: "send_sms", body: "{prénom}, votre réceptionniste IA est en ligne ! Faites un appel test sur votre numéro pour l'entendre. Je vous recontacte dans une semaine. {ton_prénom}" },
     { type: "wait", amount: 7, unit: "days" },
     { type: "create_task", title: "Point de suivi avec {prénom} ({entreprise})", body: "Suivi J14 de la mise en ligne.", due_in_hours: 0 },
     { type: "wait", amount: 16, unit: "days" },
     { type: "create_task", title: "Bilan J30 avec {prénom} ({entreprise})", body: "Bilan du premier mois.", due_in_hours: 0 },
     { type: "remove_tag", tag: "onboarding-en-cours" },
     { type: "add_tag", tag: "client-actif" }],
    { stop_on_reply: false }),
  reply_alert: T("Le prospect répond — me prévenir", "Te crée une tâche dès qu'un prospect répond par SMS ou email, pour ne jamais laisser un message sans réponse.",
    { type: "message_received", channel: "any" },
    [{ type: "create_task", title: "Répondre à {prénom} ({entreprise})", body: "Nouveau message dans Conversations.", due_in_hours: 0 }],
    { stop_on_reply: false, allow_reentry: true }),
};

/* ---------- IA : une phrase → une automatisation ---------- */
async function aiDraft(prompt, current) {
  if (!config.anthropicApiKey) { const e = new Error("Ajoute ANTHROPIC_API_KEY dans Railway pour créer des automatisations avec l'IA"); e.code = "no_key"; throw e; }
  const s = await getSettings();
  const system = `Tu es l'assistant automatisations de CLOSER PRO, le CRM de ${s.prenom || "Yanis"} (agence Biznify : IA réceptionniste pour les entreprises du BTP en France).
Tu transformes une demande en français en UNE automatisation, au format JSON strict, sans texte autour.

Format :
{"name": "...", "description": "une phrase", "trigger": {...}, "steps": [...], "options": {"stop_on_reply": true, "allow_reentry": false, "quiet_hours": true}, "explanation": "2 phrases max pour expliquer ce que fait l'automatisation et les hypothèses prises"}

Déclencheurs (trigger.type) :
${Object.entries(TRIGGERS).map(([k, v]) => `- ${k} : ${v.label}`).join("\n")}
Paramètres : stage_changed → "to" (étape) ; call_outcome → "outcomes" (liste) ; message_received → "channel" ("sms" | "email" | "any") ; tag_added → "tag".

Étapes du pipeline : ${STAGES.map((x) => `${x.id} (${x.label})`).join(", ")}
Résultats d'appel : ${Object.entries(OUTCOMES).map(([k, v]) => `${k} (${v.label})`).join(", ")}

Étapes (steps[].type) :
- wait : {"amount": nombre, "unit": "minutes"|"hours"|"days"}
- wait_until : {"anchor": "appointment_start"|"invoice_due", "offset_minutes": nombre (négatif = avant, ex. -1440 = la veille)}
- send_sms : {"body": "..."} (court, < 300 caractères)
- send_email : {"subject": "...", "body": "..."}
- set_stage : {"stage": id d'étape}
- add_tag / remove_tag : {"tag": "mot-cle"}
- add_note : {"text": "..."}
- create_task : {"title": "...", "body": "...", "due_in_hours": nombre}
- condition : {"check": un de ${Object.keys(CONDITIONS).join(", ")}, "value": selon le cas (étape, tag ou nombre)} — si la condition est fausse, l'automatisation s'arrête.

Variables utilisables dans les textes : ${VARIABLES.map((v) => `{${v}}`).join(" ")}

Règles :
- Messages en français, ton professionnel et chaleureux, vouvoiement pour les prospects, signés {ton_prénom} de Biznify.
- N'invente pas de lien : écris [LIEN …] entre crochets si un lien externe est nécessaire.
- Utilise wait_until pour tout ce qui dépend de l'heure d'un RDV ou de l'échéance d'une facture.
- Ajoute des conditions pour éviter d'envoyer un message devenu inutile (ex. facture déjà payée, prospect qui a répondu).`;
  const user = current
    ? `Voici l'automatisation actuelle :\n${JSON.stringify(cleanAutomation(current))}\n\nModifie-la selon cette demande : ${prompt}`
    : `Crée l'automatisation suivante : ${prompt}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": config.anthropicApiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: config.anthropicModel, max_tokens: 4000, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status} : ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = await res.json();
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const t = text.replace(/```json|```/g, "");
  const raw = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
  return { ...cleanAutomation(raw), explanation: str(raw.explanation, 600) };
}

/* ---------- API ---------- */
const api = express.Router();

api.get("/automations/meta", (req, res) => {
  res.json({ triggers: TRIGGERS, steps: STEPS, conditions: CONDITIONS, variables: VARIABLES, stages: STAGES,
    outcomes: Object.fromEntries(Object.entries(OUTCOMES).map(([k, v]) => [k, v.label])),
    templates: Object.entries(TEMPLATES).map(([key, t]) => ({ key, name: t.name, description: t.description })),
    ai: !!config.anthropicApiKey });
});

api.get("/automations", wrap(async (req, res) => {
  const r = await q(`SELECT a.*,
      (SELECT count(*) FROM automation_runs r WHERE r.automation_id=a.id AND r.status='active')::int AS active_runs,
      (SELECT count(*) FROM automation_runs r WHERE r.automation_id=a.id)::int AS total_runs,
      (SELECT max(started_at) FROM automation_runs r WHERE r.automation_id=a.id) AS last_run
    FROM automations a ORDER BY a.enabled DESC, a.created_at`);
  res.json({ automations: r.rows, installed: r.rows.map((a) => a.template).filter(Boolean) });
}));

api.get("/automations/:id", wrap(async (req, res) => {
  const a = (await q(`SELECT * FROM automations WHERE id=$1`, [req.params.id])).rows[0];
  if (!a) return res.status(404).json({ error: "Automatisation introuvable" });
  const runs = await q(`SELECT r.*, l.name AS lead_name, l.first_name, l.last_name, l.company FROM automation_runs r LEFT JOIN leads l ON l.id=r.lead_id
                        WHERE r.automation_id=$1 ORDER BY r.started_at DESC LIMIT 100`, [a.id]);
  res.json({ automation: a, runs: runs.rows });
}));

api.post("/automations", wrap(async (req, res) => {
  const a = cleanAutomation(req.body);
  const r = await q(`INSERT INTO automations (name, description, trigger, steps, options, enabled) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [a.name, a.description, a.trigger, JSON.stringify(a.steps), a.options, !!req.body.enabled]);
  res.json({ automation: r.rows[0] });
}));

api.put("/automations/:id", wrap(async (req, res) => {
  const a = cleanAutomation(req.body);
  const r = await q(`UPDATE automations SET name=$2, description=$3, trigger=$4, steps=$5, options=$6, enabled=COALESCE($7, enabled), updated_at=now() WHERE id=$1 RETURNING *`,
    [req.params.id, a.name, a.description, a.trigger, JSON.stringify(a.steps), a.options, typeof req.body.enabled === "boolean" ? req.body.enabled : null]);
  if (!r.rows[0]) return res.status(404).json({ error: "Automatisation introuvable" });
  res.json({ automation: r.rows[0] });
}));

api.post("/automations/:id/toggle", wrap(async (req, res) => {
  const r = await q(`UPDATE automations SET enabled = NOT enabled, updated_at=now() WHERE id=$1 RETURNING *`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Automatisation introuvable" });
  if (!r.rows[0].enabled) await q(`UPDATE automation_runs SET status='stopped', ended_at=now() WHERE automation_id=$1 AND status='active'`, [req.params.id]);
  res.json({ automation: r.rows[0] });
}));

api.delete("/automations/:id", wrap(async (req, res) => {
  await q(`DELETE FROM automations WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

api.post("/automations/:id/run", wrap(async (req, res) => {
  const a = (await q(`SELECT * FROM automations WHERE id=$1`, [req.params.id])).rows[0];
  if (!a) return res.status(404).json({ error: "Automatisation introuvable" });
  if (!a.enabled) return res.status(409).json({ error: "Active d'abord l'automatisation" });
  const ids = (Array.isArray(req.body.leadIds) ? req.body.leadIds : [req.body.leadId]).map(Number).filter(Boolean).slice(0, 500);
  let started = 0;
  for (const id of ids) if (await enroll({ ...a, options: { ...a.options, allow_reentry: true } }, id, {})) started++;
  setTimeout(tick, 500);
  res.json({ started });
}));

api.post("/automations/runs/:runId/stop", wrap(async (req, res) => {
  await q(`UPDATE automation_runs SET status='stopped', ended_at=now(), log = log || jsonb_build_array(jsonb_build_object('at', now(), 'info', 'Arrêtée à la main')) WHERE id=$1 AND status='active'`, [req.params.runId]);
  res.json({ ok: true });
}));

api.post("/automations/templates/:key", wrap(async (req, res) => {
  const t = TEMPLATES[req.params.key];
  if (!t) return res.status(404).json({ error: "Modèle introuvable" });
  const a = cleanAutomation(t);
  const r = await q(`INSERT INTO automations (name, description, trigger, steps, options, enabled, template) VALUES ($1,$2,$3,$4,$5,false,$6) RETURNING *`,
    [a.name, a.description, a.trigger, JSON.stringify(a.steps), a.options, req.params.key]);
  res.json({ automation: r.rows[0] });
}));

api.post("/automations/ai", wrap(async (req, res) => {
  const prompt = str(req.body && req.body.prompt, 2000).trim();
  if (!prompt) return res.status(400).json({ error: "Décris l'automatisation que tu veux" });
  try { res.json({ draft: await aiDraft(prompt, req.body.current || null) }); }
  catch (e) { res.status(e.code === "no_key" ? 409 : 502).json({ error: e.message }); }
}));

/* Tâches créées par les automatisations */
api.get("/tasks", wrap(async (req, res) => {
  const r = await q(`SELECT t.*, l.name AS lead_name, l.first_name, l.last_name, l.company, l.phone FROM tasks t LEFT JOIN leads l ON l.id=t.lead_id
                     WHERE t.done_at IS NULL OR t.done_at > now() - interval '2 days' ORDER BY (t.done_at IS NOT NULL), t.due_at LIMIT 200`);
  res.json({ tasks: r.rows, open: r.rows.filter((t) => !t.done_at && new Date(t.due_at) <= new Date()).length });
}));
api.post("/tasks/:id/done", wrap(async (req, res) => {
  await q(`UPDATE tasks SET done_at = CASE WHEN done_at IS NULL THEN now() ELSE NULL END WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

/* Tags d'un prospect (utilisés par les automatisations d'onboarding) */
api.post("/leads/:id/tags", wrap(async (req, res) => {
  const add = tagOf(req.body && req.body.add), remove = tagOf(req.body && req.body.remove);
  if (add) await q(`UPDATE leads SET tags = array_append(tags, $2::text), updated_at=now() WHERE id=$1 AND NOT ($2 = ANY(tags))`, [req.params.id, add]);
  if (remove) await q(`UPDATE leads SET tags = array_remove(tags, $2::text), updated_at=now() WHERE id=$1`, [req.params.id, remove]);
  const r = await q(`SELECT tags FROM leads WHERE id=$1`, [req.params.id]);
  setTimeout(tick, 500);
  res.json({ tags: r.rows[0] ? r.rows[0].tags : [] });
}));

module.exports = { api, start, tick, TEMPLATES, cleanAutomation, nextSendWindow };
