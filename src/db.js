const { Pool } = require("pg");
const config = require("./config");

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.pgSsl ? { rejectUnauthorized: false } : false,
  max: 5,
});

const q = (text, params) => pool.query(text, params);

async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS calls (
      id            TEXT PRIMARY KEY,
      source        TEXT NOT NULL DEFAULT 'ghl',      -- ghl | upload | paste
      date          TIMESTAMPTZ NOT NULL DEFAULT now(),
      direction     TEXT,
      phone         TEXT,
      contact_id    TEXT,
      contact_name  TEXT,
      label         TEXT,
      duration      INTEGER,
      call_status   TEXT,
      has_recording BOOLEAN NOT NULL DEFAULT false,
      status        TEXT NOT NULL DEFAULT 'new',      -- new | queued | transcribing | analyzing | done | short | skipped | error
      error         TEXT,
      audio         BYTEA,
      audio_type    TEXT,
      transcript    TEXT,
      analysis      JSONB,
      score         INTEGER,
      issue         TEXT,
      analyzed_at   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS calls_date_idx ON calls (date DESC);
    CREATE INDEX IF NOT EXISTS calls_status_idx ON calls (status);
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bilans (
      id         SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      data       JSONB NOT NULL
    );
  `);
  // Les traitements interrompus par un redémarrage repartent dans la file
  await q(`UPDATE calls SET status='queued' WHERE status IN ('transcribing','analyzing')`);
}

const DEFAULT_SETTINGS = {
  prenom: "Yanis",
  offre:
    "Agence Biznify. Cible : entreprises du BTP. Offre : une IA qui répond aux appels de l'entreprise, prend les rendez-vous et évite de perdre des leads et des chantiers. Objectif de l'appel : décrocher un rendez-vous de démo avec le décideur.",
  minDuree: 20,
  autoAnalyze: true,
  autoSince: null, // date à partir de laquelle les nouveaux appels sont analysés automatiquement
};

async function getSettings() {
  const r = await q(`SELECT value FROM settings WHERE key='main'`);
  if (!r.rows.length) {
    const s = { ...DEFAULT_SETTINGS, autoSince: new Date().toISOString() };
    await q(`INSERT INTO settings (key, value) VALUES ('main', $1) ON CONFLICT (key) DO NOTHING`, [s]);
    return s;
  }
  return { ...DEFAULT_SETTINGS, ...r.rows[0].value };
}

async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  if (patch.autoAnalyze && !cur.autoAnalyze) next.autoSince = new Date().toISOString();
  await q(
    `INSERT INTO settings (key, value) VALUES ('main', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [next]
  );
  return next;
}

module.exports = { pool, q, migrate, getSettings, saveSettings };
