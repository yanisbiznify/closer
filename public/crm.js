/* CLOSER PRO — CRM : pipeline, fiche prospect, import Excel */
const CRM = { stages: [], leads: [], list: "", q: "", more: {}, drag: null };
const PER_COL = 60;
const crmName = (l) => [l.first_name, l.last_name].filter(Boolean).join(" ") || l.name || "";
const crmTitle = (l) => crmName(l) || l.company || fmtPhone(l.phone) || "Sans nom";
const mapsSearch = (l) => (l.company ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([l.company, l.city].filter(Boolean).join(" "))}` : null);
const ICON_MAP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>`;
const ICON_PHONE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>`;
const ICON_NOTE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>`;

/* ---------- Pipeline ---------- */
async function loadPipeline() {
  if (typeof loadLists === "function") { await loadLists(); const o = $("#dl-list").innerHTML; $("#pl-list").innerHTML = o; $("#pl-list").value = CRM.list; }
  try {
    const d = await api("/pipeline" + (CRM.list ? "?list=" + CRM.list : ""));
    CRM.stages = d.stages; CRM.leads = d.leads;
  } catch (e) { toast(e.message); }
  renderPipeline();
}
$("#pl-list").onchange = (e) => { CRM.list = e.target.value; loadPipeline(); };
$("#pl-q").addEventListener("input", (e) => { CRM.q = e.target.value.trim().toLowerCase(); renderPipeline(); });

function plFiltered() {
  if (!CRM.q) return CRM.leads;
  return CRM.leads.filter((l) => [crmName(l), l.company, l.activity, l.phone, l.city].filter(Boolean).join(" ").toLowerCase().includes(CRM.q));
}

function cardHTML(l) {
  const name = crmName(l);
  const maps = l.maps_url || null;
  return `<div class="card" draggable="true" data-id="${l.id}">
    <div class="card-h"><b>${esc(name || l.company || fmtPhone(l.phone) || "Sans nom")}</b>${l.best_score != null ? `<span class="score c-${tone(l.best_score)}" style="font-size:12.5px;min-width:0">${l.best_score}</span>` : ""}</div>
    <dl class="card-d">
      ${name && l.company ? `<dt>Entreprise</dt><dd>${esc(l.company)}</dd>` : ""}
      ${l.activity ? `<dt>Activité</dt><dd>${esc(l.activity)}</dd>` : ""}
      ${l.city ? `<dt>Ville</dt><dd>${esc(l.city)}</dd>` : ""}
      <dt>Valeur</dt><dd class="${Number(l.value) ? "" : "muted"}">${esc(fmtEur(l.value))}</dd>
    </dl>
    ${l.status === "rappel" && l.callback_at ? `<div class="card-cb">Rappel ${esc(dt(l.callback_at))}</div>` : ""}
    <div class="card-f">
      <button class="ic call" data-act="call" title="Appeler ${esc(fmtPhone(l.phone))}" ${l.phone ? "" : "disabled"}>${ICON_PHONE}</button>
      ${maps ? `<a class="ic" href="${esc(maps)}" target="_blank" rel="noopener" title="Fiche Google Maps" data-act="maps">${ICON_MAP}</a>` : ""}
      ${l.notes ? `<span class="ic" title="${esc(l.notes.slice(0, 200))}">${ICON_NOTE}</span>` : ""}
      ${l.attempts ? `<span class="small muted" style="margin-left:auto">${l.attempts} appel${l.attempts > 1 ? "s" : ""}</span>` : ""}
    </div></div>`;
}

function renderPipeline() {
  const leads = plFiltered();
  const total = leads.reduce((s, l) => s + Number(l.value || 0), 0);
  $("#pl-sum").textContent = `${leads.length} prospect${leads.length > 1 ? "s" : ""}, ${fmtEur(total)}`;
  if (!CRM.leads.length) {
    $("#board").innerHTML = `<div class="panel" style="width:100%">${emptyState("Ton pipeline est vide", "Importe un fichier Excel, tes contacts GoHighLevel, ou ajoute un prospect à la main.")}</div>`;
    return;
  }
  $("#board").innerHTML = CRM.stages.map((st) => {
    const col = leads.filter((l) => (l.stage || "nouveau") === st.id);
    const sum = col.reduce((s, l) => s + Number(l.value || 0), 0);
    const lim = CRM.more[st.id] || PER_COL;
    return `<div class="col" data-stage="${st.id}">
      <div class="col-h"><div><b>${esc(st.label)}</b><span>${col.length} prospect${col.length > 1 ? "s" : ""}, ${esc(fmtEur(sum))}</span></div></div>
      <div class="col-b" data-stage="${st.id}">${col.slice(0, lim).map(cardHTML).join("")}
        ${col.length > lim ? `<button class="btn quiet" data-more="${st.id}" style="width:100%">Afficher ${Math.min(PER_COL, col.length - lim)} de plus</button>` : ""}
        ${!col.length ? `<div class="col-empty">Glisse un prospect ici</div>` : ""}</div></div>`;
  }).join("");
}

const board = $("#board");
board.addEventListener("click", (e) => {
  const more = e.target.closest("[data-more]");
  if (more) { CRM.more[more.dataset.more] = (CRM.more[more.dataset.more] || PER_COL) + PER_COL; renderPipeline(); return; }
  const card = e.target.closest(".card"); if (!card) return;
  const l = CRM.leads.find((x) => String(x.id) === card.dataset.id); if (!l) return;
  const act = e.target.closest("[data-act]");
  if (act && act.dataset.act === "maps") return;
  if (act && act.dataset.act === "call") { e.preventDefault(); phoneCall(l, { onDone: () => loadPipeline() }); return; }
  openLead(l.id);
});
board.addEventListener("dragstart", (e) => {
  const c = e.target.closest(".card"); if (!c) return;
  CRM.drag = c.dataset.id; c.classList.add("dragging"); e.dataTransfer.effectAllowed = "move";
  try { e.dataTransfer.setData("text/plain", c.dataset.id); } catch {}
});
board.addEventListener("dragend", (e) => { const c = e.target.closest(".card"); if (c) c.classList.remove("dragging"); $$(".col-b.over").forEach((x) => x.classList.remove("over")); });
board.addEventListener("dragover", (e) => { const b = e.target.closest(".col-b"); if (!b || !CRM.drag) return; e.preventDefault(); $$(".col-b.over").forEach((x) => x !== b && x.classList.remove("over")); b.classList.add("over"); });
board.addEventListener("drop", async (e) => {
  const b = e.target.closest(".col-b"); if (!b || !CRM.drag) return;
  e.preventDefault(); b.classList.remove("over");
  const id = CRM.drag; CRM.drag = null;
  const l = CRM.leads.find((x) => String(x.id) === id);
  if (!l || l.stage === b.dataset.stage) return;
  const prev = l.stage; l.stage = b.dataset.stage; renderPipeline();
  try { Object.assign(l, await api(`/leads/${id}`, { method: "PATCH", body: JSON.stringify({ stage: b.dataset.stage }) })); toast(`Déplacé vers « ${CRM.stages.find((s) => s.id === b.dataset.stage).label} »`); }
  catch (err) { l.stage = prev; renderPipeline(); toast(err.message); }
});
document.addEventListener("lead-updated", (e) => {
  const u = e.detail; if (!u) return;
  const i = CRM.leads.findIndex((x) => x.id === u.id);
  if (i >= 0) { CRM.leads[i] = { ...CRM.leads[i], ...u }; if ($("#v-pipeline").classList.contains("on")) renderPipeline(); }
  if (LD.lead && LD.lead.id === u.id) { LD.lead = { ...LD.lead, ...u }; renderLead(); }
});

/* ---------- Fiche prospect ---------- */
const LD = { lead: null };
const FIELDS_UI = [
  ["first_name", "Prénom du dirigeant"], ["last_name", "Nom du dirigeant"], ["company", "Entreprise"], ["activity", "Type d'activité"],
  ["phone", "Téléphone"], ["email", "Email"], ["city", "Ville"], ["value", "Valeur du lead (€)"], ["maps_url", "Lien Google Maps"], ["website", "Site web"],
];
function closeLead() { $("#ldrawer").classList.remove("on"); $("#lscrim").classList.remove("on"); LD.lead = null; }
$("#lscrim").onclick = closeLead;
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && LD.lead) closeLead(); });

async function openLead(id) {
  $("#ldrawer").classList.add("on"); $("#lscrim").classList.add("on");
  $("#ld-body").innerHTML = `<div class="skeleton" style="width:60%"></div><div class="skeleton" style="width:85%;margin-top:12px"></div>`;
  let l = CRM.leads.find((x) => x.id === id) || (D.queue || []).find((x) => x.id === id) || (LV.leads || []).find((x) => x.id === id);
  if (!l) { try { l = (await api("/pipeline")).leads.find((x) => x.id === id); } catch {} }
  if (!l) { $("#ld-body").innerHTML = `<div class="callout err"><div>Prospect introuvable.</div></div>`; return; }
  LD.lead = { ...l };
  renderLead();
}

async function renderLead() {
  const l = LD.lead; if (!l) return;
  const stages = CRM.stages.length ? CRM.stages : (await api("/pipeline?list=-1").catch(() => ({ stages: [] }))).stages;
  if (!CRM.stages.length) CRM.stages = stages;
  $("#ld-title").textContent = crmTitle(l);
  $("#ld-sub").textContent = [crmName(l) && l.company ? l.company : "", l.activity, l.city].filter(Boolean).join(", ");
  const maps = l.maps_url || mapsSearch(l);
  $("#ld-body").innerHTML = `
    <div class="ld-actions">
      <button class="btn primary" id="ld-call" ${l.phone ? "" : "disabled"}>${ICON_PHONE.replace("<svg", '<svg width="15" height="15"')}Appeler ${esc(fmtPhone(l.phone))}</button>
      ${maps ? `<a class="btn ghost" href="${esc(maps)}" target="_blank" rel="noopener">${ICON_MAP.replace("<svg", '<svg width="15" height="15"')}${l.maps_url ? "Fiche Google Maps" : "Chercher sur Google Maps"}</a>` : ""}
      <button class="btn ghost" id="ld-book">Planifier un RDV</button>
      <button class="btn ghost" id="ld-msg">Message</button>
      <button class="btn ghost" id="ld-bill">Facturer</button>
      ${l.website ? `<a class="btn ghost" href="${esc(/^https?:/.test(l.website) ? l.website : "https://" + l.website)}" target="_blank" rel="noopener">Site web</a>` : ""}
    </div>
    <div class="ld-stage"><label for="ld-stage">Étape du pipeline</label>
      <select id="ld-stage">${CRM.stages.map((s) => `<option value="${s.id}" ${s.id === (l.stage || "nouveau") ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select>
      <span>${leadBadge(l.status)}${l.status === "rappel" && l.callback_at ? ` <span class="small muted">${esc(dt(l.callback_at))}</span>` : ""}</span></div>
    <div class="ld-grid">${FIELDS_UI.map(([k, lab]) => `<div class="field ${k === "maps_url" || k === "website" ? "wide" : ""}"><label for="lf-${k}">${lab}</label>
      <input id="lf-${k}" data-f="${k}" value="${esc(k === "value" ? (Number(l.value) ? Number(l.value) : "") : l[k] && k === "phone" ? fmtPhone(l[k]) : l[k] || "")}" ${k === "value" ? 'inputmode="decimal"' : ""} ${k === "maps_url" ? 'placeholder="https://maps.google.com/…"' : ""}></div>`).join("")}
      <div class="field wide"><label for="lf-notes">Notes</label><textarea id="lf-notes" data-f="notes" style="min-height:90px">${esc(l.notes || "")}</textarea></div>
    </div>
    <div class="block"><h3>Tags</h3><div class="ld-tags" id="ld-tags"></div>
      <p class="small muted" style="margin:6px 0 0">Ajouter un tag peut lancer une automatisation (ex. « questionnaire-recu », « en-ligne »).</p></div>
    <div class="block"><h3>Historique des appels</h3><div id="ld-hist"><div class="skeleton" style="width:50%"></div></div></div>
    <div class="ld-meta small muted">${l.list_name ? `Liste « ${esc(l.list_name)} », ` : ""}${l.source ? `source ${esc(l.source)}, ` : ""}ajouté le ${esc(fmtDate(l.created_at))}</div>
    <div style="margin-top:16px"><button class="btn danger" id="ld-del">Supprimer ce prospect</button></div>`;
  $("#ld-call").onclick = () => phoneCall(LD.lead, { onDone: () => { if ($("#v-pipeline").classList.contains("on")) loadPipeline(); } });
  $("#ld-stage").onchange = (e) => saveLead({ stage: e.target.value });
  const drawTags = (tags) => {
    $("#ld-tags").innerHTML = (tags || []).map((t) => `<span class="ld-tag">${esc(t)}<button type="button" data-rmtag="${esc(t)}" aria-label="Retirer le tag ${esc(t)}">×</button></span>`).join("") +
      `<input id="ld-tag-in" placeholder="+ tag" aria-label="Ajouter un tag" list="ld-tag-sug"><datalist id="ld-tag-sug">${["questionnaire-recu", "appel-lancement-fait", "en-ligne", "client-actif"].map((x) => `<option value="${x}"></option>`).join("")}</datalist>`;
    $$("#ld-tags [data-rmtag]").forEach((b) => (b.onclick = async () => { const r = await api(`/leads/${l.id}/tags`, { method: "POST", body: JSON.stringify({ remove: b.dataset.rmtag }) }); l.tags = r.tags; drawTags(r.tags); }));
    $("#ld-tag-in").onkeydown = async (e) => {
      if (e.key !== "Enter" || !e.target.value.trim()) return;
      e.preventDefault();
      const r = await api(`/leads/${l.id}/tags`, { method: "POST", body: JSON.stringify({ add: e.target.value }) }); l.tags = r.tags; drawTags(r.tags); $("#ld-tag-in").focus();
    };
  };
  drawTags(l.tags);
  $("#ld-book").onclick = () => { const lead = LD.lead; closeLead(); openBooking({ lead }); };
  $("#ld-msg").onclick = () => { const lead = LD.lead; closeLead(); openConversation(lead.id); };
  $("#ld-bill").onclick = () => { const lead = LD.lead; closeLead(); openInvoiceEditor({ lead }); };
  $$("#ld-body [data-f]").forEach((inp) => inp.addEventListener("change", () => {
    const k = inp.dataset.f; let v = inp.value;
    saveLead({ [k]: v });
  }));
  $("#ld-del").onclick = async () => {
    if (!(await confirmBox("Supprimer ce prospect ? Ses appels analysés restent dans l'onglet Appels.", "Supprimer"))) return;
    await api(`/leads/${l.id}`, { method: "DELETE" });
    CRM.leads = CRM.leads.filter((x) => x.id !== l.id); closeLead(); renderPipeline(); toast("Prospect supprimé");
  };
  try {
    const { calls } = await api(`/leads/${l.id}/calls`);
    $("#ld-hist").innerHTML = calls.length
      ? calls.map((c) => `<div class="hist" data-open="${esc(c.id)}" style="cursor:pointer"><span>${esc(dt(c.date))}${c.outcome && OUT[c.outcome] ? ", " + OUT[c.outcome].label.toLowerCase() : ""}${c.duration ? `, ${esc(fmtDur(c.duration))}` : ""}</span>${c.status === "done" ? `<span class="score c-${tone(c.score)}">${c.score}</span>` : `<span class="muted small">${c.status === "short" ? "Trop court" : ""}</span>`}</div>`).join("")
      : `<p class="muted small" style="margin:0">Pas encore d'appel avec ce prospect.</p>`;
    $("#ld-hist").onclick = (e) => { const h = e.target.closest("[data-open]"); if (h) { closeLead(); openDrawer(h.dataset.open); } };
  } catch {}
}

async function saveLead(patch) {
  const l = LD.lead; if (!l) return;
  try {
    const u = await api(`/leads/${l.id}`, { method: "PATCH", body: JSON.stringify(patch) });
    LD.lead = { ...l, ...u };
    const i = CRM.leads.findIndex((x) => x.id === u.id); if (i >= 0) CRM.leads[i] = { ...CRM.leads[i], ...u };
    if ($("#v-pipeline").classList.contains("on")) renderPipeline();
    if (patch.stage || patch.maps_url !== undefined || patch.first_name !== undefined || patch.last_name !== undefined || patch.company !== undefined) renderLead();
    toast("Enregistré");
  } catch (e) { toast(e.message); renderLead(); }
}

/* ---------- Ajout manuel ---------- */
function openAddLead() {
  openImport("Ajouter un prospect", "Il arrive dans la colonne « Nouveau lead » et dans la file du dialer.",
    `<div class="ld-grid">${FIELDS_UI.map(([k, lab]) => `<div class="field ${k === "maps_url" || k === "website" ? "wide" : ""}"><label for="af-${k}">${lab}</label><input id="af-${k}" ${k === "value" ? 'inputmode="decimal"' : ""}></div>`).join("")}</div>`,
    async () => {
      const body = {}; FIELDS_UI.forEach(([k]) => { const v = $("#af-" + k).value.trim(); if (v) body[k] = v; });
      const l = await api("/leads", { method: "POST", body: JSON.stringify(body) });
      toast("Prospect ajouté"); loadPipeline(); D.loaded && loadQueue();
      return l;
    });
  $("#imp-go").textContent = "Ajouter";
}
$("#pl-add").onclick = openAddLead;

/* ---------- Import Excel / CSV ---------- */
const IMPORT_FIELDS = [
  ["company", "Entreprise", ["nom entreprise", "nom de l'entreprise", "entreprise", "societe", "company", "raison sociale", "business", "etablissement", "enseigne"]],
  ["full_name", "Nom complet du dirigeant", ["nom prenom", "prenom nom", "nom et prenom", "dirigeant", "gerant", "nom complet", "contact", "full name"]],
  ["first_name", "Prénom du dirigeant", ["prenom", "first name", "firstname"]],
  ["last_name", "Nom du dirigeant", ["nom", "last name", "lastname"]],
  ["activity", "Type d'activité", ["activite", "type", "metier", "categorie", "category", "secteur", "specialite"]],
  ["phone", "Téléphone", ["telephone", "phone", "tel", "mobile", "portable", "numero"]],
  ["email", "Email", ["email", "e-mail", "mail"]],
  ["city", "Ville", ["ville", "city", "commune", "localite"]],
  ["maps_url", "Lien Google Maps", ["maps", "google", "fiche", "lien", "url"]],
  ["website", "Site web", ["site", "website", "web"]],
  ["value", "Valeur du lead", ["valeur", "value", "montant", "prix", "budget"]],
  ["notes", "Notes", ["note", "commentaire", "remarque"]],
];
const normH = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[_\-]/g, " ").replace(/\s+/g, " ").trim();

function autoMap(headers) {
  const h = headers.map(normH), used = new Set(), map = {};
  for (const [k, , keys] of IMPORT_FIELDS) {
    let best = -1;
    for (const key of keys) {
      const i = h.findIndex((x, j) => !used.has(j) && (key.length <= 4 ? x.split(" ").includes(key) || x === key : x.includes(key)));
      if (i >= 0) { best = i; break; }
    }
    if (best >= 0) { map[k] = best; used.add(best); }
  }
  // une colonne qui contient des liens Google Maps
  return map;
}
function detectMapsColumn(rows, map) {
  if (map.maps_url != null) return;
  const n = rows[0].length;
  for (let j = 0; j < n; j++) {
    if (Object.values(map).includes(j)) continue;
    if (rows.slice(1, 20).some((r) => /google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps/i.test(String(r[j] || "")))) { map.maps_url = j; return; }
  }
}

async function readSheet(file) {
  if (/\.(csv|txt)$/i.test(file.name)) return parseCSV(await file.text());
  if (!window.XLSX) throw new Error("Le lecteur Excel ne s'est pas chargé. Recharge la page.");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" }).filter((r) => r.some((c) => String(c).trim()));
}

function rowsToLeads(rows, map) {
  const get = (r, k) => (map[k] != null && map[k] !== "" ? String(r[map[k]] ?? "").trim() : "");
  return rows.slice(1).map((r) => {
    let first = get(r, "first_name"), last = get(r, "last_name");
    const full = get(r, "full_name");
    if (full && !first && !last) { const p = full.split(/\s+/); first = p.shift() || ""; last = p.join(" "); }
    return { first_name: first, last_name: last, company: get(r, "company"), activity: get(r, "activity"), phone: get(r, "phone"), email: get(r, "email"),
      city: get(r, "city"), maps_url: get(r, "maps_url"), website: get(r, "website"), value: get(r, "value"), notes: get(r, "notes") };
  });
}

function openFileImport() {
  let rows = null, map = {};
  openImport("Importer un fichier", "Excel (.xlsx, .xls) ou CSV. Les colonnes sont reconnues automatiquement ; corrige si besoin.",
    `<div class="field"><label for="imp-file">Fichier</label><input type="file" id="imp-file" accept=".xlsx,.xls,.csv,.txt"></div>
     <div class="field"><label for="imp-cname">Nom de la liste</label><input id="imp-cname" placeholder="Chauffagistes Tours"></div>
     <div id="imp-map"></div>`,
    async () => {
      if (!rows) { toast("Choisis un fichier"); return false; }
      if (map.phone == null || map.phone === "") { toast("Indique la colonne du téléphone"); return false; }
      const leads = rowsToLeads(rows, map);
      importDone(await api("/leads/import", { method: "POST", body: JSON.stringify({ listName: $("#imp-cname").value.trim() || "Import", leads }) }));
      if ($("#v-pipeline").classList.contains("on")) loadPipeline();
    });
  $("#imp").querySelector(".box").style.maxWidth = "620px";
  $("#imp-file").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { rows = await readSheet(f); } catch (err) { $("#imp-map").innerHTML = `<div class="callout err"><div>${esc(err.message)}</div></div>`; rows = null; return; }
    if (!rows || rows.length < 2) { $("#imp-map").innerHTML = `<p class="c-bad small">Fichier vide ou illisible.</p>`; rows = null; return; }
    if (rows.length > 5001) rows = rows.slice(0, 5001);
    map = autoMap(rows[0]); detectMapsColumn(rows, map);
    if (!$("#imp-cname").value) $("#imp-cname").value = f.name.replace(/\.[^.]+$/, "");
    renderMap();
  };
  function renderMap() {
    const opts = (k) => `<option value="">Ignorer</option>` + rows[0].map((h, j) => `<option value="${j}" ${map[k] === j ? "selected" : ""}>${esc(h || "Colonne " + (j + 1))}</option>`).join("");
    const ex = rowsToLeads(rows.slice(0, 2), map)[0] || {};
    $("#imp-map").innerHTML = `<div class="small muted" style="margin-bottom:10px">${rows.length - 1} ligne${rows.length > 2 ? "s" : ""} détectée${rows.length > 2 ? "s" : ""}. Correspondance des colonnes :</div>
      <div class="map-grid">${IMPORT_FIELDS.map(([k, lab]) => `<label for="m-${k}">${lab}</label><select id="m-${k}" data-m="${k}">${opts(k)}</select>`).join("")}</div>
      <div class="imp-prev">Exemple : <b>${esc([ex.first_name, ex.last_name].filter(Boolean).join(" ") || "—")}</b>, ${esc(ex.company || "—")}, ${esc(ex.activity || "—")}, ${esc(ex.phone || "pas de téléphone")}${ex.maps_url ? ", lien Maps ✓" : ""}${ex.value ? `, ${esc(ex.value)} €` : ""}</div>`;
    $$("#imp-map [data-m]").forEach((s) => s.onchange = () => { map[s.dataset.m] = s.value === "" ? null : parseInt(s.value); renderMap(); });
  }
}
$("#pl-import").onclick = openFileImport;
$("#btn-imp-csv").onclick = openFileImport;
$("#btn-imp-csv").textContent = "Importer un fichier Excel";

// Prospects (tableau) : ouvrir la fiche et appeler en pop-up
$("#leads").addEventListener("click", (e) => {
  const c = e.target.closest("[data-call]");
  if (c) {
    e.stopImmediatePropagation();
    const l = LV.leads.find((x) => String(x.id) === c.dataset.call);
    if (l) phoneCall(l, { onDone: () => loadLeadsView() });
    return;
  }
  const r = e.target.closest("tr[data-lead]");
  if (r) openLead(parseInt(r.dataset.lead));
}, true);
