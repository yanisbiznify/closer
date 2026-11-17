// Client minimal de l'API GoHighLevel (LeadConnector)
const config = require("./config");

const BASE = "https://services.leadconnectorhq.com";

async function ghl(path, { version = "2021-04-15", raw = false } = {}) {
  const res = await fetch(BASE + path, {
    headers: {
      Authorization: `Bearer ${config.ghlApiKey}`,
      Version: version,
      Accept: raw ? "*/*" : "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`GHL ${res.status} : ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return raw ? res : res.json();
}

// Liste paginée des appels (canal Call), du plus récent au plus ancien
async function listCalls({ cursor, limit = 100 } = {}) {
  const p = new URLSearchParams({ locationId: config.ghlLocationId, channel: "Call", limit: String(limit) });
  if (cursor) p.set("cursor", cursor);
  const d = await ghl(`/conversations/messages/export?${p}`);
  return { messages: d.messages || [], nextCursor: d.nextCursor || null, total: d.total ?? null };
}

// Fichier audio de l'enregistrement
async function getRecording(messageId) {
  const res = await ghl(
    `/conversations/messages/${encodeURIComponent(messageId)}/locations/${encodeURIComponent(config.ghlLocationId)}/recording`,
    { raw: true }
  );
  const type = (res.headers.get("content-type") || "").split(";")[0];
  if (type.includes("json")) {
    const j = await res.json();
    const url = j.url || j.recordingUrl;
    if (!url) throw new Error("Enregistrement introuvable dans la réponse GHL");
    const r2 = await fetch(url);
    if (!r2.ok) throw new Error(`Téléchargement de l'enregistrement impossible (${r2.status})`);
    return { buffer: Buffer.from(await r2.arrayBuffer()), type: r2.headers.get("content-type") || "audio/wav" };
  }
  return { buffer: Buffer.from(await res.arrayBuffer()), type: type || "audio/wav" };
}

async function getContactName(contactId) {
  if (!contactId) return null;
  try {
    const d = await ghl(`/contacts/${encodeURIComponent(contactId)}`, { version: "2021-07-28" });
    const c = d.contact || {};
    const name = [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || c.contactName || c.name || "";
    const company = c.companyName || "";
    if (name && company) return `${name} (${company})`;
    return name || company || null;
  } catch {
    return null;
  }
}

module.exports = { listCalls, getRecording, getContactName };
