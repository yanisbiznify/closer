// Chiffre d'affaires : encaissé par mois, taux de closing, revenus par source, objectif mensuel
const express = require("express");
const { q, getSettings } = require("./db");

const TZ = "Europe/Paris";
const api = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const SOURCE_LABEL = { import: "Cold call — fichier importé", ghl: "Cold call — GoHighLevel", manuel: "Ajout manuel" };
const sourceLabel = (s) => SOURCE_LABEL[s] || s;

// Tous les encaissements : factures payées + liens de paiement payés
const PAYMENTS = `
  SELECT i.paid_at AS at, i.total_cents AS cents, i.lead_id, 'facture' AS kind,
         COALESCE(NULLIF(l.source, ''), CASE WHEN i.lead_id IS NULL THEN '__none' ELSE 'manuel' END) AS source,
         li.name AS list_name, COALESCE('L' || i.lead_id::text, 'I' || i.id::text) AS client_key
    FROM invoices i LEFT JOIN leads l ON l.id = i.lead_id LEFT JOIN lists li ON li.id = l.list_id
   WHERE i.status = 'payee' AND i.paid_at IS NOT NULL
  UNION ALL
  SELECT p.paid_at, p.amount_cents, pl.lead_id, 'lien',
         COALESCE(NULLIF(l.source, ''), '__link'), li.name, COALESCE('L' || pl.lead_id::text, 'P' || p.id::text)
    FROM link_payments p LEFT JOIN payment_links pl ON pl.id = p.link_id LEFT JOIN leads l ON l.id = pl.lead_id LEFT JOIN lists li ON li.id = l.list_id`;

function monthRange(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || "");
  const now = new Date();
  const y = m ? Number(m[1]) : Number(now.toLocaleString("en-CA", { timeZone: TZ, year: "numeric" }));
  const mo = m ? Number(m[2]) : Number(now.toLocaleString("en-CA", { timeZone: TZ, month: "2-digit" }));
  if (mo < 1 || mo > 12) return monthRange(null);
  const pad = (n) => String(n).padStart(2, "0");
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${pad(mo + 1)}`;
  return { key: `${y}-${pad(mo)}`, start: `${y}-${pad(mo)}-01`, end: `${next}-01`, y, mo };
}

api.get("/revenue", wrap(async (req, res) => {
  const r = monthRange(req.query.month);
  const s = await getSettings();
  const goal = Number(s.objectifCA) || 0;
  // bornes du mois, en heure de Paris
  const B = [r.start, r.end, TZ];
  const inMonth = (col) => `${col} >= ($1::timestamp AT TIME ZONE $3) AND ${col} < ($2::timestamp AT TIME ZONE $3)`;

  const [month, series, bySource, byList, funnel, pending, prev] = await Promise.all([
    q(`SELECT COALESCE(sum(cents),0)::bigint AS cents, count(*)::int AS n, count(DISTINCT client_key)::int AS clients
         FROM (${PAYMENTS}) p WHERE ${inMonth("at")}`, B),
    // 12 mois glissants jusqu'au mois affiché
    q(`WITH m AS (SELECT generate_series(($1::date - interval '11 months'), $1::date, interval '1 month')::date AS d)
       SELECT to_char(m.d, 'YYYY-MM') AS month, COALESCE(sum(p.cents),0)::bigint AS cents, count(p.cents)::int AS n
         FROM m LEFT JOIN (${PAYMENTS}) p ON date_trunc('month', p.at AT TIME ZONE $2)::date = m.d
        GROUP BY m.d ORDER BY m.d`, [r.start, TZ]),
    q(`SELECT source, sum(cents)::bigint AS cents, count(*)::int AS n FROM (${PAYMENTS}) p
        WHERE at >= (($1::date - interval '11 months')::timestamp AT TIME ZONE $3) AND at < ($2::timestamp AT TIME ZONE $3)
        GROUP BY source ORDER BY 2 DESC`, B),
    q(`SELECT list_name, sum(cents)::bigint AS cents, count(*)::int AS n FROM (${PAYMENTS}) p
        WHERE list_name IS NOT NULL AND at >= (($1::date - interval '11 months')::timestamp AT TIME ZONE $3) AND at < ($2::timestamp AT TIME ZONE $3)
        GROUP BY list_name ORDER BY 2 DESC LIMIT 8`, B),
    q(`SELECT
         (SELECT count(*) FROM calls WHERE ${inMonth("date")})::int AS appels,
         (SELECT count(*) FROM calls WHERE ${inMonth("date")} AND duration >= 30)::int AS conversations,
         (SELECT count(*) FROM (
            SELECT 'L' || lead_id::text AS k FROM appointments WHERE lead_id IS NOT NULL AND ${inMonth("created_at")}
            UNION SELECT 'A' || id::text FROM appointments WHERE lead_id IS NULL AND ${inMonth("created_at")}
            UNION SELECT 'L' || id::text FROM leads WHERE status = 'rdv' AND ${inMonth("outcome_at")}
         ) x)::int AS rdv,
         (SELECT count(*) FROM (
            SELECT 'L' || id::text AS k FROM leads WHERE stage = 'gagne' AND ${inMonth("stage_at")}
            UNION SELECT client_key FROM (${PAYMENTS}) p WHERE ${inMonth("at")}
         ) y)::int AS clients`, B),
    q(`SELECT COALESCE(sum(total_cents) FILTER (WHERE status='emise'),0)::bigint AS pending,
              COALESCE(sum(total_cents) FILTER (WHERE status='emise' AND due_date < CURRENT_DATE),0)::bigint AS overdue
         FROM invoices`),
    q(`SELECT COALESCE(sum(cents),0)::bigint AS cents FROM (${PAYMENTS}) p
        WHERE at >= (($1::date - interval '1 month')::timestamp AT TIME ZONE $2) AND at < ($1::timestamp AT TIME ZONE $2)`, [r.start, TZ]),
  ]);

  // Taux de closing : parmi les prospects qui ont eu un RDV sur la période, la part devenue cliente (signé ou payé)
  const cohort = (from, to) => `
    WITH rdv AS (
      SELECT lead_id AS id FROM appointments WHERE lead_id IS NOT NULL AND created_at >= ${from} AND created_at < ${to}
      UNION SELECT id FROM leads WHERE status = 'rdv' AND outcome_at >= ${from} AND outcome_at < ${to}
      UNION SELECT id FROM leads WHERE stage = 'gagne' AND stage_at >= ${from} AND stage_at < ${to}
    ), won AS (
      SELECT id FROM leads WHERE stage = 'gagne'
      UNION SELECT lead_id FROM invoices WHERE status = 'payee' AND lead_id IS NOT NULL
      UNION SELECT pl.lead_id FROM link_payments p JOIN payment_links pl ON pl.id = p.link_id WHERE pl.lead_id IS NOT NULL
    )
    SELECT (SELECT count(*) FROM rdv)::int AS rdv, (SELECT count(*) FROM rdv WHERE id IN (SELECT id FROM won))::int AS won`;
  const M = ["($1::timestamp AT TIME ZONE $3)", "($2::timestamp AT TIME ZONE $3)"];
  const Y = ["(($1::date - interval '11 months')::timestamp AT TIME ZONE $3)", "($2::timestamp AT TIME ZONE $3)"];
  const [cm, cy] = await Promise.all([q(cohort(...M), B), q(cohort(...Y), B)]);
  const rate = (x) => (x.rdv ? Math.round((x.won / x.rdv) * 1000) / 10 : null);

  // Rythme du mois en cours
  const todayParis = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const isCurrent = todayParis.slice(0, 7) === r.key;
  const daysInMonth = new Date(r.y, r.mo, 0).getDate();
  const day = isCurrent ? Number(todayParis.slice(8, 10)) : daysInMonth;
  const cents = Number(month.rows[0].cents);

  const label = (src) => (src === "__none" ? "Sans prospect lié" : src === "__link" ? "Liens de paiement" : sourceLabel(src));
  res.json({
    month: r.key,
    isCurrent,
    day, daysInMonth,
    goalCents: goal * 100,
    collected: cents,
    payments: month.rows[0].n,
    clients: month.rows[0].clients,
    avgCents: month.rows[0].n ? Math.round(cents / month.rows[0].n) : 0,
    previous: Number(prev.rows[0].cents),
    projection: isCurrent && day > 0 ? Math.round((cents / day) * daysInMonth) : null,
    pending: Number(pending.rows[0].pending),
    overdue: Number(pending.rows[0].overdue),
    series: series.rows.map((x) => ({ month: x.month, cents: Number(x.cents), n: x.n })),
    bySource: bySource.rows.map((x) => ({ source: label(x.source), cents: Number(x.cents), n: x.n })),
    byList: byList.rows.map((x) => ({ list: x.list_name, cents: Number(x.cents), n: x.n })),
    funnel: funnel.rows[0],
    closing: { month: rate(cm.rows[0]), monthRdv: cm.rows[0].rdv, monthWon: cm.rows[0].won, year: rate(cy.rows[0]), yearRdv: cy.rows[0].rdv, yearWon: cy.rows[0].won },
  });
}));

module.exports = { api };
