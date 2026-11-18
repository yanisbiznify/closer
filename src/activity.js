// Journal d'activité commun à toute l'app : paiements, factures, RDV, demandes des sites…
// Chaque module y écrit ; le tableau de bord, la fiche prospect et les alertes en direct le lisent.
const express = require("express");
const { q, getSettings } = require("./db");

async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS activity (
      id           BIGSERIAL PRIMARY KEY,
      type         TEXT NOT NULL,
      lead_id      INTEGER,
      title        TEXT NOT NULL,
      detail       TEXT,
      amount_cents INTEGER,
      ref          TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS activity_lead ON activity (lead_id, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS activity_ref ON activity (type, ref) WHERE ref IS NOT NULL;
  `);
  // reprise de l'historique : les paiements déjà encaissés apparaissent aussi dans le journal
  await q(`INSERT INTO activity (type, lead_id, title, detail, amount_cents, ref, created_at)
    SELECT 'payment', i.lead_id, COALESCE(NULLIF(i.client->>'company',''), NULLIF(i.client->>'name',''), 'Client') || ' a payé la facture ' || i.number, i.title, i.total_cents, 'invoice:' || i.id, i.paid_at
      FROM invoices i WHERE i.status='payee' AND i.paid_at IS NOT NULL
    ON CONFLICT DO NOTHING`);
}

// ref : identifiant unique (ex. facture, session Stripe) pour ne jamais enregistrer deux fois le même évènement
async function log(type, { leadId = null, title, detail = null, amountCents = null, ref = null } = {}) {
  try {
    const r = await q(`INSERT INTO activity (type, lead_id, title, detail, amount_cents, ref) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
      [type, leadId || null, String(title).slice(0, 300), detail ? String(detail).slice(0, 1000) : null, amountCents, ref ? String(ref).slice(0, 200) : null]);
    const id = r.rows[0] ? r.rows[0].id : null;
    // notification push sur le téléphone pour ce qui compte
    const PUSH = { payment: "/#revenue", booking: "/#calendar", site_lead: "/#sites", reply: "/#conversations", prospect: "/#pipeline" };
    if (id && PUSH[type]) {
      const head = type === "payment" ? `💰 ${euro(amountCents)} encaissés` : type === "booking" ? "📅 Nouveau rendez-vous" : type === "reply" ? "💬 Nouveau message" : type === "site_lead" ? "🌐 Nouvelle demande" : "🎯 Nouveaux prospects";
      require("./mobile").notify({ title: head, body: [title, detail].filter(Boolean).join(" · ").slice(0, 180), url: leadId ? `/#lead-${leadId}` : PUSH[type], tag: `${type}-${id}` });
    }
    return id;
  } catch (e) { console.warn("Activité :", e.message); return null; }
}

// Ajoute une ligne datée dans les notes du prospect
async function noteLead(leadId, text) {
  if (!leadId) return;
  const stamp = new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", day: "numeric", month: "short", year: "numeric" });
  await q(`UPDATE leads SET notes=CONCAT_WS(E'\\n', NULLIF(notes,''), $2::text), updated_at=now() WHERE id=$1`, [leadId, `[${stamp}] ${text}`]).catch(() => {});
}

const euro = (c) => ((c || 0) / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });

/* ---------- API ---------- */
const api = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

api.get("/activity", wrap(async (req, res) => {
  const since = Number(req.query.since) || 0;
  const limit = Math.min(50, Number(req.query.limit) || 20);
  const r = since
    ? await q(`SELECT a.*, l.first_name, l.last_name, l.name, l.company FROM activity a LEFT JOIN leads l ON l.id=a.lead_id WHERE a.id > $1 ORDER BY a.id LIMIT 30`, [since])
    : await q(`SELECT a.*, l.first_name, l.last_name, l.name, l.company FROM activity a LEFT JOIN leads l ON l.id=a.lead_id ORDER BY a.id DESC LIMIT $1`, [limit]);
  const last = (await q(`SELECT COALESCE(max(id),0)::bigint AS id FROM activity`)).rows[0].id;
  res.json({ items: r.rows, last: Number(last) });
}));

// Chiffres business pour le tableau de bord (même calcul que l'onglet Chiffre d'affaires)
api.get("/dashboard/business", wrap(async (req, res) => {
  const s = await getSettings();
  const goal = (Number(s.objectifCA) || 0) * 100;
  const M = `date_trunc('month', now() AT TIME ZONE 'Europe/Paris') AT TIME ZONE 'Europe/Paris'`;
  const [paid, pending, rdv, leads, won] = await Promise.all([
    q(`SELECT COALESCE(sum(c),0)::bigint AS c, count(*)::int AS n FROM (
         SELECT total_cents AS c FROM invoices WHERE status='payee' AND paid_at >= ${M}
         UNION ALL SELECT amount_cents FROM link_payments WHERE paid_at >= ${M}) x`),
    q(`SELECT COALESCE(sum(total_cents),0)::bigint AS c, count(*)::int AS n, count(*) FILTER (WHERE due_date < CURRENT_DATE)::int AS late FROM invoices WHERE status='emise'`),
    q(`SELECT count(*)::int AS n FROM appointments WHERE status <> 'annule' AND start_at >= now() AND start_at < now() + interval '7 days'`),
    q(`SELECT count(*)::int AS n FROM leads WHERE created_at >= now() - interval '7 days'`),
    q(`SELECT count(*)::int AS n FROM leads WHERE stage='gagne' AND stage_at >= ${M}`),
  ]);
  const day = Number(new Date().toLocaleString("en-GB", { timeZone: "Europe/Paris", day: "numeric" }));
  const dim = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  res.json({
    month: { collected: Number(paid.rows[0].c), payments: paid.rows[0].n, goal, pct: goal ? Math.round((Number(paid.rows[0].c) / goal) * 100) : null, expectedPct: Math.round((day / dim) * 100) },
    pending: { cents: Number(pending.rows[0].c), count: pending.rows[0].n, late: pending.rows[0].late },
    upcomingAppointments: rdv.rows[0].n, newLeads7d: leads.rows[0].n, wonThisMonth: won.rows[0].n,
  });
}));

// Tout l'argent et l'activité d'un prospect (fiche prospect)
api.get("/leads/:id/money", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const [inv, links, act] = await Promise.all([
    q(`SELECT id, number, title, status, total_cents, issue_date, due_date, paid_at, paid_via, token FROM invoices WHERE lead_id=$1 ORDER BY created_at DESC`, [id]),
    q(`SELECT pl.id, pl.label, pl.amount_cents, pl.active, pl.paid_count, pl.paid_cents, pl.created_at FROM payment_links pl WHERE pl.lead_id=$1 ORDER BY pl.created_at DESC`, [id]),
    q(`SELECT id, type, title, detail, amount_cents, created_at FROM activity WHERE lead_id=$1 ORDER BY id DESC LIMIT 30`, [id]),
  ]);
  const paid = inv.rows.filter((i) => i.status === "payee").reduce((s, i) => s + i.total_cents, 0) + links.rows.reduce((s, l) => s + (l.paid_cents || 0), 0);
  const due = inv.rows.filter((i) => i.status === "emise").reduce((s, i) => s + i.total_cents, 0);
  res.json({ invoices: inv.rows, links: links.rows, activity: act.rows, totals: { paid, due } });
}));

module.exports = { migrate, log, noteLead, euro, api };
