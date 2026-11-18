const { Pool, types } = require("pg");

// Les colonnes DATE restent des chaînes « AAAA-MM-JJ » (pas de décalage de fuseau)
types.setTypeParser(1082, (v) => v);
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
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS first_name TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_name TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS activity TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS maps_url TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS website TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS value NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS source TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS stage TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS stage_at TIMESTAMPTZ;
    ALTER TABLE leads ALTER COLUMN phone DROP NOT NULL;
    UPDATE leads SET stage = CASE status
        WHEN 'rdv' THEN 'rdv' WHEN 'rappel' THEN 'rappel'
        WHEN 'pas_interesse' THEN 'perdu' WHEN 'mauvais_numero' THEN 'perdu'
        WHEN 'a_appeler' THEN 'nouveau'
        ELSE CASE WHEN attempts >= 3 THEN 'tentative3' WHEN attempts = 2 THEN 'tentative2' ELSE 'tentative1' END END
      WHERE stage IS NULL;
    CREATE INDEX IF NOT EXISTS leads_stage_idx ON leads (stage);
    CREATE TABLE IF NOT EXISTS appointments (
      id              SERIAL PRIMARY KEY,
      lead_id         INTEGER REFERENCES leads(id) ON DELETE SET NULL,
      google_event_id TEXT,
      title           TEXT,
      start_at        TIMESTAMPTZ NOT NULL,
      end_at          TIMESTAMPTZ NOT NULL,
      meet_url        TEXT,
      attendee_email  TEXT,
      status          TEXT NOT NULL DEFAULT 'planifie',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id                SERIAL PRIMARY KEY,
      number            TEXT NOT NULL UNIQUE,
      token             TEXT NOT NULL UNIQUE,
      lead_id           INTEGER,
      title             TEXT,
      client            JSONB NOT NULL DEFAULT '{}',
      items             JSONB NOT NULL DEFAULT '[]',
      currency          TEXT NOT NULL DEFAULT 'eur',
      vat_rate          NUMERIC(5,2) NOT NULL DEFAULT 0,
      subtotal_cents    INTEGER NOT NULL DEFAULT 0,
      vat_cents         INTEGER NOT NULL DEFAULT 0,
      total_cents       INTEGER NOT NULL DEFAULT 0,
      issue_date        DATE NOT NULL DEFAULT CURRENT_DATE,
      due_date          DATE,
      notes             TEXT,
      status            TEXT NOT NULL DEFAULT 'emise',   -- emise | payee | annulee
      payment_link_id   TEXT,
      payment_link_url  TEXT,
      stripe_session_id TEXT,
      paid_at           TIMESTAMPTZ,
      paid_via          TEXT,
      viewed_at         TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS payment_links (
      id           SERIAL PRIMARY KEY,
      label        TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency     TEXT NOT NULL DEFAULT 'eur',
      lead_id      INTEGER,
      stripe_id    TEXT,
      url          TEXT,
      active       BOOLEAN NOT NULL DEFAULT true,
      paid_count   INTEGER NOT NULL DEFAULT 0,
      paid_cents   INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS link_payments (
      id           SERIAL PRIMARY KEY,
      link_id      INTEGER REFERENCES payment_links(id) ON DELETE SET NULL,
      session_id   TEXT UNIQUE,
      amount_cents INTEGER NOT NULL,
      paid_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id           SERIAL PRIMARY KEY,
      lead_id      INTEGER REFERENCES leads(id) ON DELETE CASCADE,
      channel      TEXT NOT NULL,              -- sms | email
      direction    TEXT NOT NULL,              -- in | out
      address      TEXT,                       -- numéro ou email du prospect
      subject      TEXT,
      body         TEXT NOT NULL DEFAULT '',
      status       TEXT,                       -- sent | delivered | failed | received…
      error        TEXT,
      external_id  TEXT UNIQUE,                -- SID Twilio ou id Gmail
      thread_id    TEXT,
      mid_header   TEXT,                       -- en-tête Message-ID (réponses email)
      read_at      TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS messages_lead_idx ON messages (lead_id, created_at);
    CREATE TABLE IF NOT EXISTS bilans (
      id         SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      data       JSONB NOT NULL
    );
  `);
  // Les traitements interrompus par un redémarrage repartent dans la file
  await q(`UPDATE calls SET status='queued' WHERE status IN ('transcribing','analyzing')`);
  await migrateAutomations();
}

// Automatisations : tables + déclencheurs Postgres qui transforment chaque changement en événement
async function migrateAutomations() {
  await q(`
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
    CREATE TABLE IF NOT EXISTS automations (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      enabled     BOOLEAN NOT NULL DEFAULT false,
      trigger     JSONB NOT NULL,
      steps       JSONB NOT NULL DEFAULT '[]',
      options     JSONB NOT NULL DEFAULT '{}',
      template    TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS automation_events (
      id         BIGSERIAL PRIMARY KEY,
      type       TEXT NOT NULL,
      lead_id    INTEGER,
      data       JSONB NOT NULL DEFAULT '{}',
      processed  BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS automation_events_todo ON automation_events (id) WHERE NOT processed;
    CREATE TABLE IF NOT EXISTS automation_runs (
      id            SERIAL PRIMARY KEY,
      automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      lead_id       INTEGER REFERENCES leads(id) ON DELETE CASCADE,
      context       JSONB NOT NULL DEFAULT '{}',
      step          INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'active',   -- active | done | stopped | failed
      next_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      log           JSONB NOT NULL DEFAULT '[]',
      started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS automation_runs_due ON automation_runs (next_at) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS automation_runs_lead ON automation_runs (lead_id, automation_id);
    CREATE TABLE IF NOT EXISTS tasks (
      id         SERIAL PRIMARY KEY,
      lead_id    INTEGER REFERENCES leads(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      body       TEXT,
      due_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      done_at    TIMESTAMPTZ,
      source     TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE OR REPLACE FUNCTION closer_ev_leads() RETURNS trigger AS $f$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO automation_events (type, lead_id, data) VALUES ('lead_created', NEW.id, jsonb_build_object('source', NEW.source, 'list_id', NEW.list_id, 'stage', NEW.stage));
      ELSE
        IF NEW.stage IS DISTINCT FROM OLD.stage THEN
          INSERT INTO automation_events (type, lead_id, data) VALUES ('stage_changed', NEW.id, jsonb_build_object('from', OLD.stage, 'to', NEW.stage));
        END IF;
        IF NEW.outcome_at IS DISTINCT FROM OLD.outcome_at AND NEW.outcome_at IS NOT NULL THEN
          INSERT INTO automation_events (type, lead_id, data) VALUES ('call_outcome', NEW.id, jsonb_build_object('outcome', NEW.status, 'attempts', NEW.attempts));
        END IF;
        IF NEW.tags IS DISTINCT FROM OLD.tags THEN
          INSERT INTO automation_events (type, lead_id, data)
            SELECT 'tag_added', NEW.id, jsonb_build_object('tag', t) FROM unnest(NEW.tags) t WHERE NOT (t = ANY(COALESCE(OLD.tags, '{}')));
        END IF;
      END IF;
      RETURN NEW;
    END $f$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS closer_ev_leads ON leads;
    CREATE TRIGGER closer_ev_leads AFTER INSERT OR UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION closer_ev_leads();

    CREATE OR REPLACE FUNCTION closer_ev_messages() RETURNS trigger AS $f$
    BEGIN
      IF NEW.direction = 'in' AND NEW.lead_id IS NOT NULL THEN
        INSERT INTO automation_events (type, lead_id, data) VALUES ('message_received', NEW.lead_id, jsonb_build_object('channel', NEW.channel, 'message_id', NEW.id));
      END IF;
      RETURN NEW;
    END $f$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS closer_ev_messages ON messages;
    CREATE TRIGGER closer_ev_messages AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION closer_ev_messages();

    CREATE TABLE IF NOT EXISTS booking_calendars (
      id            SERIAL PRIMARY KEY,
      slug          TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      description   TEXT,
      duration_min  INTEGER NOT NULL DEFAULT 30,
      interval_min  INTEGER NOT NULL DEFAULT 30,
      buffer_min    INTEGER NOT NULL DEFAULT 0,
      notice_hours  INTEGER NOT NULL DEFAULT 2,
      days_ahead    INTEGER NOT NULL DEFAULT 30,
      max_per_day   INTEGER,
      hours         JSONB NOT NULL DEFAULT '{}',
      timezone      TEXT NOT NULL DEFAULT 'Europe/Paris',
      event_title   TEXT,
      thanks        TEXT,
      consent       TEXT,
      color         TEXT NOT NULL DEFAULT '#1877F2',
      meet          BOOLEAN NOT NULL DEFAULT true,
      active        BOOLEAN NOT NULL DEFAULT true,
      ghl_id        TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS calendar_id INTEGER REFERENCES booking_calendars(id) ON DELETE SET NULL;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS manage_token TEXT;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'app';
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS notes TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS appointments_manage_token ON appointments (manage_token) WHERE manage_token IS NOT NULL;

    CREATE OR REPLACE FUNCTION closer_ev_appointments() RETURNS trigger AS $f$
    BEGIN
      IF NEW.lead_id IS NULL THEN RETURN NEW; END IF;
      IF TG_OP = 'INSERT' THEN
        INSERT INTO automation_events (type, lead_id, data) VALUES ('appointment_booked', NEW.lead_id, jsonb_build_object('appointment_id', NEW.id, 'calendar_id', NEW.calendar_id));
      ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO automation_events (type, lead_id, data) VALUES ('appointment_status', NEW.lead_id, jsonb_build_object('appointment_id', NEW.id, 'calendar_id', NEW.calendar_id, 'status', NEW.status));
      END IF;
      RETURN NEW;
    END $f$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS closer_ev_appointments ON appointments;
    CREATE TRIGGER closer_ev_appointments AFTER INSERT OR UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION closer_ev_appointments();

    CREATE OR REPLACE FUNCTION closer_ev_invoices() RETURNS trigger AS $f$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO automation_events (type, lead_id, data) VALUES ('invoice_created', NEW.lead_id, jsonb_build_object('invoice_id', NEW.id));
      ELSIF NEW.status = 'payee' AND OLD.status IS DISTINCT FROM 'payee' THEN
        INSERT INTO automation_events (type, lead_id, data) VALUES ('invoice_paid', NEW.lead_id, jsonb_build_object('invoice_id', NEW.id));
      END IF;
      RETURN NEW;
    END $f$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS closer_ev_invoices ON invoices;
    CREATE TRIGGER closer_ev_invoices AFTER INSERT OR UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION closer_ev_invoices();
  `);
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
  objectifCA: 10000, // objectif de chiffre d'affaires encaissé par mois, en euros
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
