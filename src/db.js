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
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS lead_id INTEGER;
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS twilio_call_sid TEXT;
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS recording_url TEXT;
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS outcome TEXT;
    CREATE INDEX IF NOT EXISTS calls_lead_idx ON calls (lead_id);
    CREATE TABLE IF NOT EXISTS lists (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      source     TEXT NOT NULL DEFAULT 'csv',      -- csv | ghl | manuel
      source_ref TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS leads (
      id             SERIAL PRIMARY KEY,
      list_id        INTEGER REFERENCES lists(id) ON DELETE CASCADE,
      name           TEXT,
      company        TEXT,
      phone          TEXT NOT NULL,
      email          TEXT,
      city           TEXT,
      ghl_contact_id TEXT,
      status         TEXT NOT NULL DEFAULT 'a_appeler', -- a_appeler | rappel | rdv | pas_interesse | messagerie | injoignable | barrage | mauvais_numero
      callback_at    TIMESTAMPTZ,
      notes          TEXT,
      attempts       INTEGER NOT NULL DEFAULT 0,
      last_call_at   TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (list_id, phone)
    );
    CREATE INDEX IF NOT EXISTS leads_status_idx ON leads (status);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS outcome_at TIMESTAMPTZ;
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
  objectifAppels: 50,
  objectifRdv: 3,
  maxTentatives: 3,
  script: `OUVERTURE (4 secondes pour convaincre)
Bonjour {prénom}, {ton prénom} de Biznify. Je serai bref : j'aide les entreprises du BTP à ne plus perdre de chantiers à cause des appels manqués. Je vous prends 30 secondes ?

QUALIFICATION (questions ouvertes)
- Aujourd'hui, qui répond au téléphone quand vous êtes sur un chantier ?
- Combien d'appels vous manquez par semaine, à peu près ?
- Un chantier moyen, ça représente combien pour vous ?

PRÉSENTATION (relier à sa douleur)
On a une IA qui répond à vos appels 24 h/24, qualifie le client et vous cale le rendez-vous directement dans votre agenda.

CLOSING
Le plus simple, c'est que je vous montre en 15 minutes. Mardi 10 h ou jeudi 14 h, qu'est-ce qui vous arrange le mieux ?`,
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
