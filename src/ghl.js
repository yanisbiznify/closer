// Client minimal de l'API GoHighLevel (LeadConnector)
const config = require("./config");

const BASE = "https://services.leadconnectorhq.com";

async function ghl(path, { version = "2021-04-15", raw = false, method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${config.ghlApiKey}`,
      Version: version,
      Accept: raw ? "*/*" : "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
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

async function listTags() {
  const d = await ghl(`/locations/${encodeURIComponent(config.ghlLocationId)}/tags`, { version: "2021-07-28" });
  return (d.tags || []).map((t) => t.name).sort((a, b) => a.localeCompare(b, "fr"));
}

const cap = (s) => (s ? String(s).replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase()) : "");

// Tous les contacts portant un tag (jusqu'à `max`)
async function contactsByTag(tag, max = 3000) {
  const out = [];
  let searchAfter = null;
  for (let i = 0; i < 40 && out.length < max; i++) {
    const body = {
      locationId: config.ghlLocationId,
      pageLimit: 100,
      filters: [{ field: "tags", operator: "contains", value: tag }],
    };
    if (searchAfter) body.searchAfter = searchAfter; else body.page = 1;
    const d = await ghl(`/contacts/search`, { method: "POST", body, version: "2021-07-28" });
    const list = d.contacts || [];
    for (const c of list) {
      const first = c.firstName || cap(c.firstNameLowerCase);
      const last = c.lastName || cap(c.lastNameLowerCase);
      out.push({
        ghl_contact_id: c.id,
        first_name: first || null,
        last_name: last || null,
        name: [first, last].filter(Boolean).join(" ") || c.contactName || null,
        company: c.companyName ? String(c.companyName).split(/\s[|·]\s|·/)[0].trim() : null,
        phone: c.phone,
        email: c.email || null,
        city: c.city || null,
      });
    }
    if (list.length < 100) break;
    searchAfter = list[list.length - 1].searchAfter;
    if (!searchAfter) break;
  }
  return out;
}

// Note + tag sur le contact après un appel (nécessite le droit contacts.write)
async function logOutcome(contactId, { title, body, tag }) {
  if (!contactId) return { ok: false };
  const res = { ok: true };
  try {
    await ghl(`/contacts/${encodeURIComponent(contactId)}/notes`, { method: "POST", body: { title, body }, version: "2021-07-28" });
  } catch (e) { res.ok = false; res.error = e.message; }
  if (tag) {
    try { await ghl(`/contacts/${encodeURIComponent(contactId)}/tags`, { method: "POST", body: { tags: [tag] }, version: "2021-07-28" }); }
    catch (e) { res.ok = false; res.error = e.message; }
  }
  return res;
}

// Pipelines (opportunités) du sous-compte
async function listPipelines() {
  const d = await ghl(`/opportunities/pipelines?locationId=${encodeURIComponent(config.ghlLocationId)}`, { version: "2021-07-28" });
  return (d.pipelines || []).map((p) => ({ id: p.id, name: p.name, stages: (p.stages || []).map((s) => ({ id: s.id, name: s.name, position: s.position })) }));
}

// Toutes les opportunités d'un pipeline, avec le contact associé
async function opportunitiesByPipeline(pipelineId, max = 5000) {
  const out = [];
  let startAfter = null, startAfterId = null;
  for (let i = 0; i < 60 && out.length < max; i++) {
    const qs = new URLSearchParams({ location_id: config.ghlLocationId, pipeline_id: pipelineId, limit: "100" });
    if (startAfterId) { qs.set("startAfter", String(startAfter)); qs.set("startAfterId", startAfterId); }
    const d = await ghl(`/opportunities/search?${qs}`, { version: "2021-07-28" });
    const list = d.opportunities || [];
    out.push(...list);
    const meta = d.meta || {};
    if (list.length < 100 || !meta.startAfterId) break;
    startAfter = meta.startAfter; startAfterId = meta.startAfterId;
  }
  return out;
}

async function getContact(id) {
  const d = await ghl(`/contacts/${id}`, { version: "2021-07-28" });
  return d.contact || null;
}

module.exports = { listCalls, getRecording, getContactName, listTags, contactsByTag, logOutcome, listPipelines, opportunitiesByPipeline, getContact };
