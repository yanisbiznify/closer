// Synchronisation GHL + file de traitement (transcription → analyse)
const config = require("./config");
const { q, getSettings } = require("./db");
const ghl = require("./ghl");
const { transcribe } = require("./transcribe");
const { analyzeCall } = require("./analyze");
const tw = require("./twilio");

const MIN_WORDS = 25; // en dessous : messagerie, barrage ou raccroché → pas d'analyse

let running = false;
let syncing = false;
let lastSync = null;
let lastSyncError = null;

const log = (...a) => console.log(new Date().toISOString(), "[worker]", ...a);

function callFields(m) {
  const call = (m.meta && m.meta.call) || {};
  return {
    id: m.id,
    date: m.dateAdded,
    direction: m.direction || null,
    phone: m.direction === "inbound" ? m.from : m.to,
    contact_id: m.contactId || null,
    duration: call.duration ?? null,
    call_status: call.status || m.status || null,
    has_recording: Array.isArray(m.attachments) && m.attachments.length > 0,
  };
}

/**
 * Récupère les appels GHL et les enregistre.
 * full=true : parcourt tout l'historique ; sinon s'arrête dès qu'une page ne contient plus de nouveaux appels.
 */
async function sync({ full = false } = {}) {
  if (syncing) return { skipped: true };
  if (!config.ghlApiKey || !config.ghlLocationId) return { skipped: true, reason: "GHL non configuré" };
  syncing = true;
  let added = 0, queued = 0, pages = 0, cursor = null;
  try {
    const settings = await getSettings();
    const autoSince = settings.autoSince ? new Date(settings.autoSince) : null;
    const nameCache = new Map();
    do {
      const page = await ghl.listCalls({ cursor, limit: 100 });
      pages++;
      let newOnPage = 0;
      for (const m of page.messages) {
        const f = callFields(m);
        const exists = await q(`SELECT status FROM calls WHERE id=$1`, [f.id]);
        if (exists.rows.length) {
          await q(
            `UPDATE calls SET duration=COALESCE($2,duration), call_status=$3, has_recording=$4, updated_at=now() WHERE id=$1`,
            [f.id, f.duration, f.call_status, f.has_recording]
          );
          continue;
        }
        newOnPage++;
        let status = "new";
        const answered = f.call_status === "completed";
        const longEnough = f.duration == null || f.duration >= (settings.minDuree || 0);
        if (!answered || !f.has_recording || !longEnough) status = "skipped";
        else if (settings.autoAnalyze && autoSince && new Date(f.date) >= autoSince) status = "queued";

        let name = null;
        if (f.contact_id && status !== "skipped") {
          if (!nameCache.has(f.contact_id)) {
            const known = await q(`SELECT contact_name FROM calls WHERE contact_id=$1 AND contact_name IS NOT NULL LIMIT 1`, [f.contact_id]);
            nameCache.set(f.contact_id, known.rows[0] ? known.rows[0].contact_name : await ghl.getContactName(f.contact_id));
          }
          name = nameCache.get(f.contact_id);
        }
        await q(
          `INSERT INTO calls (id, source, date, direction, phone, contact_id, contact_name, duration, call_status, has_recording, status)
           VALUES ($1,'ghl',$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
          [f.id, f.date, f.direction, f.phone, f.contact_id, name, f.duration, f.call_status, f.has_recording, status]
        );
        added++;
        if (status === "queued") queued++;
      }
      cursor = page.nextCursor;
      if (!full && newOnPage === 0) break;
    } while (cursor && pages < 50);
    lastSync = new Date().toISOString();
    lastSyncError = null;
    if (added) log(`sync : ${added} nouveaux appels, ${queued} en file`);
    if (queued) kick();
    return { added, queued };
  } catch (e) {
    lastSyncError = e.message;
    log("erreur sync :", e.message);
    throw e;
  } finally {
    syncing = false;
  }
}

async function processCall(id) {
  const settings = await getSettings();
  const r = await q(`SELECT * FROM calls WHERE id=$1`, [id]);
  const c = r.rows[0];
  if (!c) return;
  let transcript = c.transcript;
  let duration = c.duration;

  if (!transcript) {
    await q(`UPDATE calls SET status='transcribing', error=NULL, updated_at=now() WHERE id=$1`, [id]);
    let audio;
    if (c.source === "ghl") audio = await ghl.getRecording(id);
    else if (c.source === "dialer" && c.recording_url) audio = await tw.downloadRecording(c.recording_url);
    else if (c.audio) audio = { buffer: c.audio, type: c.audio_type };
    else throw new Error("Aucun audio ni transcription pour cet appel");
    const t = await transcribe(audio.buffer, audio.type);
    transcript = t.text;
    duration = duration || t.duration;
    await q(`UPDATE calls SET transcript=$2, duration=COALESCE(duration,$3), audio=NULL, updated_at=now() WHERE id=$1`, [id, transcript, t.duration]);
    if (t.words < MIN_WORDS) {
      await q(`UPDATE calls SET status='short', updated_at=now() WHERE id=$1`, [id]);
      return;
    }
  }

  await q(`UPDATE calls SET status='analyzing', error=NULL, updated_at=now() WHERE id=$1`, [id]);
  const analysis = await analyzeCall(transcript, { source: c.source, direction: c.direction, duration }, settings);
  const label = c.contact_name || c.label;
  await q(
    `UPDATE calls SET status='done', analysis=$2, score=$3, issue=$4, label=COALESCE(label,$5), analyzed_at=now(), updated_at=now() WHERE id=$1`,
    [id, analysis, analysis.score, analysis.issue || null, label ? null : analysis.prospect || null]
  );
}

async function loop() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const r = await q(`SELECT id FROM calls WHERE status='queued' ORDER BY date DESC LIMIT 1`);
      if (!r.rows.length) break;
      const id = r.rows[0].id;
      try {
        await processCall(id);
        log("traité :", id);
      } catch (e) {
        log("erreur sur", id, ":", e.message);
        await q(`UPDATE calls SET status='error', error=$2, updated_at=now() WHERE id=$1`, [id, e.message.slice(0, 500)]);
      }
    }
  } finally {
    running = false;
  }
}

function kick() {
  loop().catch((e) => log("boucle :", e.message));
}

function start() {
  kick();
  const every = Math.max(2, config.syncIntervalMin) * 60 * 1000;
  const tick = () => sync().catch(() => {});
  setTimeout(tick, 5000);
  setInterval(tick, every);
}

const state = () => ({ running, syncing, lastSync, lastSyncError });

module.exports = { start, sync, kick, state };
