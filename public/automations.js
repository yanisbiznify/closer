/* CLOSER PRO — Automatisations */
const AU = { meta: null, list: [], installed: [], tasks: [], edit: null };

const AU_ICON = {
  wait: `<path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="9"/>`,
  wait_until: `<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/>`,
  send_sms: `<path d="M4 5h16v11H9l-5 4z"/>`,
  send_email: `<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5 12 13l8.5-6.5"/>`,
  set_stage: `<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="10" rx="1.5"/><path d="M17 9h4m-2-2 2 2-2 2"/>`,
  add_tag: `<path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>`,
  remove_tag: `<path d="M3 12V4h8l9 9-8 8z"/><path d="M6 6l4 4"/>`,
  add_note: `<path d="M5 3h10l4 4v14H5z"/><path d="M9 11h6M9 15h4"/>`,
  create_task: `<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/>`,
  condition: `<path d="M6 3v6a6 6 0 0 0 6 6h6M15 12l3 3-3 3M6 21v-4"/>`,
};
const auSvg = (t) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${AU_ICON[t] || AU_ICON.wait}</svg>`;
const AU_EXAMPLES = [
  "Après un RDV pris, envoie un SMS de confirmation puis un rappel 2 heures avant",
  "Si un prospect passe en Perdu, relance-le par email dans 3 mois",
  "Quand une facture est payée, ajoute le tag client et crée-moi une tâche pour l'appel de lancement",
];

async function auMeta() { if (!AU.meta) AU.meta = await api("/automations/meta"); return AU.meta; }
const stageLabel = (id) => ((AU.meta && AU.meta.stages.find((s) => s.id === id)) || {}).label || id;

function triggerText(t) {
  const m = AU.meta; if (!m || !t) return "";
  if (t.type === "stage_changed") return `Le prospect passe en « ${stageLabel(t.to)} »`;
  if (t.type === "call_outcome") return `Résultat d'appel : ${(t.outcomes || []).map((o) => m.outcomes[o]).join(", ")}`;
  if (t.type === "tag_added") return `Le tag « ${t.tag} » est ajouté`;
  if (t.type === "message_received") return `Le prospect répond${t.channel === "sms" ? " par SMS" : t.channel === "email" ? " par email" : ""}`;
  return (m.triggers[t.type] || {}).label || t.type;
}
function stepText(s) {
  const m = AU.meta;
  switch (s.type) {
    case "wait": return `Attendre ${s.amount} ${{ minutes: "minute", hours: "heure", days: "jour" }[s.unit]}${s.amount > 1 ? "s" : ""}`;
    case "wait_until": {
      const o = s.offset_minutes, abs = Math.abs(o), what = s.anchor === "appointment_start" ? "le RDV" : "l'échéance de la facture";
      const d = abs % 1440 === 0 ? `${abs / 1440} jour${abs / 1440 > 1 ? "s" : ""}` : abs % 60 === 0 ? `${abs / 60} h` : `${abs} min`;
      return o === 0 ? `Attendre ${what}` : `Attendre ${d} ${o < 0 ? "avant" : "après"} ${what}`;
    }
    case "send_sms": return `SMS : ${s.body || "…"}`;
    case "send_email": return `Email : ${s.subject || "…"}`;
    case "set_stage": return `Passer en « ${stageLabel(s.stage)} »`;
    case "add_tag": return `Ajouter le tag « ${s.tag} »`;
    case "remove_tag": return `Retirer le tag « ${s.tag} »`;
    case "add_note": return `Note : ${s.text || "…"}`;
    case "create_task": return `Tâche : ${s.title || "…"}`;
    case "condition": return `Seulement si le prospect ${m.conditions[s.check]}${s.value != null ? ` « ${["stage_is", "stage_is_not"].includes(s.check) ? stageLabel(s.value) : s.value} »` : ""}`;
  }
  return s.type;
}

/* ---------- Vue ---------- */
async function loadAutomations() {
  try { await auMeta(); } catch (e) { $("#au-list").innerHTML = `<div class="panel-b muted">${esc(e.message)}</div>`; return; }
  $("#au-ex").innerHTML = AU_EXAMPLES.map((x) => `<button class="au-chip" type="button">${esc(x)}</button>`).join("");
  $$("#au-ex .au-chip").forEach((b) => (b.onclick = () => { $("#au-prompt").value = b.textContent; $("#au-prompt").focus(); }));
  $("#au-callout").innerHTML = AU.meta.ai ? "" : `<div class="callout" style="margin-bottom:16px"><div class="grow"><b>L'IA a besoin de ta clé Anthropic.</b><p>Ajoute <code>ANTHROPIC_API_KEY</code> dans Railway pour créer des automatisations en une phrase. L'éditeur et les modèles marchent déjà.</p></div></div>`;
  const [r, t] = await Promise.all([api("/automations"), api("/tasks")]);
  AU.list = r.automations; AU.installed = r.installed; AU.tasks = t.tasks;
  renderAuList(); renderTasks(); auBadge(t.open);
}
function auBadge(n) { $("#nav-tasks").textContent = n || ""; }

function renderAuList() {
  const on = AU.list.filter((a) => a.enabled).length;
  $("#au-count").textContent = AU.list.length ? `${on} active${on > 1 ? "s" : ""} sur ${AU.list.length}` : "";
  if (!AU.list.length) {
    $("#au-list").innerHTML = `<div class="au-empty"><b>Aucune automatisation pour l'instant</b><p class="muted">Décris-en une à l'IA ci-dessus, ou installe tes automatisations GHL recréées depuis les modèles.</p><button class="btn primary" id="au-empty-tpl">Voir les modèles</button></div>`;
    $("#au-empty-tpl").onclick = openTemplates; return;
  }
  $("#au-list").innerHTML = AU.list.map((a) => `<div class="au-row ${a.enabled ? "" : "off"}" data-id="${a.id}">
      <label class="switch" title="${a.enabled ? "Désactiver" : "Activer"}"><input type="checkbox" ${a.enabled ? "checked" : ""} data-tg="${a.id}" aria-label="Activer ${esc(a.name)}"><span></span></label>
      <button class="au-main" data-open="${a.id}">
        <b>${esc(a.name)}</b>
        <span class="au-trig">${esc(triggerText(a.trigger))}</span>
        <span class="au-steps">${(a.steps || []).slice(0, 12).map((s) => `<span class="au-si ${s.type}" title="${esc(stepText(s))}">${auSvg(s.type)}</span>`).join("")}</span>
      </button>
      <div class="au-stat"><b class="num">${a.active_runs}</b><span>en cours</span><span class="muted small">${a.total_runs} au total</span></div>
    </div>`).join("");
  $$("#au-list [data-tg]").forEach((x) => (x.onchange = async () => {
    try { const r = await api(`/automations/${x.dataset.tg}/toggle`, { method: "POST" }); toast(r.automation.enabled ? "Automatisation activée" : "Automatisation désactivée"); loadAutomations(); }
    catch (e) { toast(e.message); x.checked = !x.checked; }
  }));
  $$("#au-list [data-open]").forEach((b) => (b.onclick = () => openAutomation(Number(b.dataset.open))));
}

function renderTasks() {
  const t = AU.tasks;
  $("#au-tasks").innerHTML = t.length ? `<ul class="au-tasks">${t.map((x) => {
    const who = [x.first_name, x.last_name].filter(Boolean).join(" ") || x.lead_name || x.company || "";
    const late = !x.done_at && new Date(x.due_at) <= new Date();
    return `<li class="${x.done_at ? "done" : ""}"><label class="au-check"><input type="checkbox" ${x.done_at ? "checked" : ""} data-task="${x.id}" aria-label="Marquer comme fait"><span></span></label>
      <div class="grow"><b>${esc(x.title)}</b>${x.body ? `<p>${esc(x.body)}</p>` : ""}<span class="small muted">${esc(x.source || "")}${who ? ` · ${esc(who)}` : ""}${!x.done_at && !late ? ` · pour le ${new Date(x.due_at).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}` : ""}</span></div>
      ${x.lead_id ? `<button class="btn quiet" data-lead="${x.lead_id}">Fiche</button>` : ""}</li>`;
  }).join("")}</ul>` : `<div class="panel-b muted">Rien à faire pour l'instant. Les tâches créées par tes automatisations arrivent ici.</div>`;
  $$("#au-tasks [data-task]").forEach((c) => (c.onchange = async () => { await api(`/tasks/${c.dataset.task}/done`, { method: "POST" }).catch(() => {}); loadAutomations(); }));
  $$("#au-tasks [data-lead]").forEach((b) => (b.onclick = () => openLead(Number(b.dataset.lead))));
}

/* ---------- Modèles ---------- */
async function openTemplates() {
  await auMeta();
  const close = bModal({
    title: "Modèles d'automatisations", sub: "Tes automatisations GoHighLevel recréées pour CLOSER PRO, plus les indispensables. Elles s'installent désactivées : relis les messages, puis active-les.", width: 680, cancel: "Fermer",
    body: `<ul class="au-tpls">${AU.meta.templates.map((t) => {
      const done = AU.installed.includes(t.key);
      return `<li><div class="grow"><b>${esc(t.name)}</b><p>${esc(t.description)}</p></div>${done ? `<span class="badge good">Installé</span>` : `<button class="btn ghost" data-key="${t.key}">Installer</button>`}</li>`;
    }).join("")}</ul>
    <div class="au-tpl-all"><button class="btn primary" id="au-tpl-all">Tout installer</button></div>`,
  });
  const install = async (key) => { await api(`/automations/templates/${key}`, { method: "POST" }); AU.installed.push(key); };
  $$("#bm [data-key]").forEach((b) => (b.onclick = async () => {
    b.disabled = true; try { await install(b.dataset.key); b.outerHTML = `<span class="badge good">Installé</span>`; loadAutomations(); } catch (e) { toast(e.message); b.disabled = false; }
  }));
  $("#au-tpl-all").onclick = async (e) => {
    e.currentTarget.disabled = true;
    for (const t of AU.meta.templates) if (!AU.installed.includes(t.key)) await install(t.key).catch(() => {});
    toast("Modèles installés, désactivés. Relis-les puis active-les."); close(); loadAutomations();
  };
}

/* ---------- Éditeur ---------- */
const blankAuto = () => ({ name: "", description: "", trigger: { type: "stage_changed", to: "rdv" }, steps: [], options: { stop_on_reply: true, allow_reentry: false, quiet_hours: true }, enabled: false });

async function openAutomation(id) {
  await auMeta();
  let a, runs = [];
  if (id) { const r = await api(`/automations/${id}`); a = r.automation; runs = r.runs; } else a = blankAuto();
  openEditor(JSON.parse(JSON.stringify(a)), runs);
}

function openEditor(a, runs = [], explanation = "") {
  AU.edit = a;
  const m = AU.meta;
  const close = bModal({
    title: a.id ? "Modifier l'automatisation" : "Nouvelle automatisation", sub: "", width: 860,
    go: a.id ? "Enregistrer" : (a.enabled ? "Créer" : "Créer"),
    body: `${explanation ? `<div class="au-expl"><b>Proposition de l'IA</b><p>${esc(explanation)}</p><p class="small muted">Relis-la, ajuste si besoin, puis enregistre. Elle reste désactivée tant que tu ne l'actives pas.</p></div>` : ""}
      <div class="au-ed-top">
        <div class="field grow" style="margin:0"><label for="ae-name">Nom</label><input id="ae-name" value="${esc(a.name)}" placeholder="Ex. Relance après pas de réponse"></div>
        <div class="toggle au-en"><div><b>Active</b></div><label class="switch"><input type="checkbox" id="ae-on" ${a.enabled ? "checked" : ""}><span></span></label></div>
      </div>
      ${a.id ? `<div class="seg au-tabs"><button class="on" data-tab="ed">Étapes</button><button data-tab="runs">Historique (${runs.length})</button></div>` : ""}
      <div id="ae-ed">
        <div class="au-ai-mini"><input id="ae-ai" placeholder="Modifier avec l'IA : « ajoute un email de relance 2 jours après »"><button class="btn ghost" id="ae-ai-go">Appliquer</button></div>
        <ol class="au-flow" id="ae-flow"></ol>
        <details class="au-opts"><summary>Réglages</summary>
          <label class="au-opt"><input type="checkbox" id="ae-o-reply" ${a.options.stop_on_reply !== false ? "checked" : ""}> Arrêter dès que le prospect répond</label>
          <label class="au-opt"><input type="checkbox" id="ae-o-quiet" ${a.options.quiet_hours !== false ? "checked" : ""}> Envoyer les SMS et emails seulement entre 8h30 et 20h (heure de Paris)</label>
          <label class="au-opt"><input type="checkbox" id="ae-o-re" ${a.options.allow_reentry ? "checked" : ""}> Un prospect peut repasser plusieurs fois dans l'automatisation</label>
          <p class="small muted" style="margin:8px 0 0">Variables pour tes messages : ${m.variables.map((v) => `<code>{${esc(v)}}</code>`).join(" ")}</p>
        </details>
        ${a.id ? `<div class="au-danger"><button class="btn quiet" id="ae-runlead">Lancer sur un prospect…</button><button class="btn quiet bl-del" id="ae-del">Supprimer</button></div>` : ""}
      </div>
      <div id="ae-runs" hidden>${renderRuns(runs)}</div>`,
    onGo: async () => {
      readEditor();
      const body = { ...AU.edit, enabled: $("#ae-on").checked };
      if (!body.steps.length) { toast("Ajoute au moins une étape"); return false; }
      const r = a.id ? await api(`/automations/${a.id}`, { method: "PUT", body: JSON.stringify(body) }) : await api("/automations", { method: "POST", body: JSON.stringify(body) });
      toast(r.automation.enabled ? "Automatisation enregistrée et active" : "Automatisation enregistrée (désactivée)");
      loadAutomations();
    },
  });
  drawFlow();
  $$("#bm .au-tabs button").forEach((b) => (b.onclick = () => {
    $$("#bm .au-tabs button").forEach((x) => x.classList.toggle("on", x === b));
    $("#ae-ed").hidden = b.dataset.tab !== "ed"; $("#ae-runs").hidden = b.dataset.tab !== "runs";
  }));
  $$("#ae-runs [data-stop]").forEach((b) => (b.onclick = async () => { await api(`/automations/runs/${b.dataset.stop}/stop`, { method: "POST" }); b.closest("li").querySelector(".au-rs").textContent = "Arrêtée"; b.remove(); }));
  $("#ae-ai-go").onclick = async (e) => {
    const p = $("#ae-ai").value.trim(); if (!p) return;
    const b = e.currentTarget; b.disabled = true; b.innerHTML = `<span class="spin"></span>IA`;
    try { readEditor(); const r = await api("/automations/ai", { method: "POST", body: JSON.stringify({ prompt: p, current: AU.edit }) }); Object.assign(AU.edit, { ...r.draft, id: AU.edit.id, enabled: AU.edit.enabled }); $("#ae-name").value = AU.edit.name; $("#ae-ai").value = ""; drawFlow(); toast(r.draft.explanation || "Modifié"); }
    catch (err) { toast(err.message); }
    b.disabled = false; b.textContent = "Appliquer";
  };
  const del = $("#ae-del"); if (del) del.onclick = async () => {
    if (!(await confirmBox(`Supprimer « ${a.name} » ? Les prospects en cours sortent de l'automatisation.`, "Supprimer"))) return;
    await api(`/automations/${a.id}`, { method: "DELETE" }); toast("Automatisation supprimée"); close(); loadAutomations();
  };
  const rl = $("#ae-runlead"); if (rl) rl.onclick = () => runOnLead(a, close);
}

function renderRuns(runs) {
  if (!runs.length) return `<p class="muted">Aucun prospect n'est encore passé dans cette automatisation.</p>`;
  const st = { active: "En cours", done: "Terminée", stopped: "Arrêtée", failed: "Erreur" };
  return `<ul class="au-runs">${runs.map((r) => {
    const who = [r.first_name, r.last_name].filter(Boolean).join(" ") || r.lead_name || r.company || "Prospect";
    const last = (r.log || []).slice(-1)[0] || {};
    const errs = (r.log || []).filter((x) => x.ok === false);
    return `<li><div class="grow"><b>${esc(who)}</b>${r.company && who !== r.company ? `<span class="muted small"> · ${esc(r.company)}</span>` : ""}
      <p class="small muted">${esc(last.info || last.error || "")}${errs.length ? ` · <span class="cv-fail">${errs.length} erreur${errs.length > 1 ? "s" : ""} : ${esc(errs[errs.length - 1].error)}</span>` : ""}</p></div>
      <span class="badge ${r.status === "active" ? "or" : r.status === "done" ? "good" : r.status === "failed" ? "bad" : ""} au-rs">${st[r.status]}</span>
      ${r.status === "active" ? `<button class="btn quiet" data-stop="${r.id}">Arrêter</button>` : ""}</li>`;
  }).join("")}</ul>`;
}

function readEditor() {
  const a = AU.edit;
  a.name = $("#ae-name").value.trim();
  a.options = { stop_on_reply: $("#ae-o-reply").checked, quiet_hours: $("#ae-o-quiet").checked, allow_reentry: $("#ae-o-re").checked };
  const t = { type: $("#ae-t-type").value };
  if (t.type === "stage_changed") t.to = $("#ae-t-to").value;
  if (t.type === "call_outcome") t.outcomes = $$("#ae-t-outs input:checked").map((x) => x.value);
  if (t.type === "tag_added") t.tag = $("#ae-t-tag").value;
  if (t.type === "message_received") t.channel = $("#ae-t-ch").value;
  a.trigger = t;
  $$("#ae-flow .au-step").forEach((li) => {
    const s = a.steps[Number(li.dataset.i)];
    li.querySelectorAll("[data-f]").forEach((el) => {
      const f = el.dataset.f;
      let v = el.value;
      if (f === "amount" || f === "due_in_hours") v = Number(v);
      if (f === "offset") { const n = Number(li.querySelector('[data-f="offset"]').value) || 0, u = Number(li.querySelector('[data-f="ou"]').value), dir = li.querySelector('[data-f="odir"]').value; s.offset_minutes = n * u * (dir === "before" ? -1 : 1); return; }
      if (f === "ou" || f === "odir") return;
      s[f] = v;
    });
    if (s.type === "condition" && !["stage_is", "stage_is_not", "has_tag", "not_has_tag", "attempts_gte"].includes(s.check)) delete s.value;
  });
}

function sel(f, opts, val) { return `<select data-f="${f}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`; }
function stepFields(s) {
  const m = AU.meta, stages = m.stages.map((x) => [x.id, x.label]);
  switch (s.type) {
    case "wait": return `<div class="au-inl"><input data-f="amount" type="number" min="1" value="${s.amount || 1}" style="width:80px">${sel("unit", [["minutes", "minutes"], ["hours", "heures"], ["days", "jours"]], s.unit || "days")}</div>`;
    case "wait_until": {
      const o = s.offset_minutes || 0, abs = Math.abs(o);
      const u = abs && abs % 1440 === 0 ? 1440 : abs && abs % 60 === 0 ? 60 : 1;
      return `<div class="au-inl"><input data-f="offset" type="number" min="0" value="${abs / u}" style="width:70px">${sel("ou", [[1, "minutes"], [60, "heures"], [1440, "jours"]], u)}${sel("odir", [["before", "avant"], ["after", "après"]], o < 0 ? "before" : "after")}${sel("anchor", [["appointment_start", "le RDV"], ["invoice_due", "l'échéance de la facture"]], s.anchor)}</div>`;
    }
    case "send_sms": return `<textarea data-f="body" rows="3" placeholder="Bonjour {prénom}, …">${esc(s.body || "")}</textarea>`;
    case "send_email": return `<input data-f="subject" placeholder="Objet" value="${esc(s.subject || "")}"><textarea data-f="body" rows="5" placeholder="Bonjour {prénom}, …">${esc(s.body || "")}</textarea>`;
    case "set_stage": return sel("stage", stages, s.stage);
    case "add_tag": case "remove_tag": return `<input data-f="tag" placeholder="mot-cle" value="${esc(s.tag || "")}">`;
    case "add_note": return `<input data-f="text" value="${esc(s.text || "")}">`;
    case "create_task": return `<input data-f="title" placeholder="Titre de la tâche" value="${esc(s.title || "")}"><div class="au-inl"><input data-f="body" placeholder="Détail (facultatif)" value="${esc(s.body || "")}"><span class="small muted">dans</span><input data-f="due_in_hours" type="number" min="0" value="${s.due_in_hours || 0}" style="width:70px"><span class="small muted">h</span></div>`;
    case "condition": {
      const needs = ["stage_is", "stage_is_not"].includes(s.check) ? sel("value", stages, s.value) : ["has_tag", "not_has_tag"].includes(s.check) ? `<input data-f="value" placeholder="mot-cle" value="${esc(s.value || "")}">` : s.check === "attempts_gte" ? `<input data-f="value" type="number" min="1" value="${s.value || 1}" style="width:70px">` : "";
      return `<div class="au-inl"><span class="small muted">le prospect</span>${sel("check", Object.entries(m.conditions), s.check)}${needs}</div><p class="small muted" style="margin:0">Sinon, l'automatisation s'arrête pour ce prospect.</p>`;
    }
  }
  return "";
}

function drawFlow() {
  const a = AU.edit, m = AU.meta, t = a.trigger || {};
  const outs = Object.entries(m.outcomes);
  $("#ae-flow").innerHTML = `<li class="au-trigger"><span class="au-si trig"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg></span>
      <div class="grow"><div class="au-st-h">Quand…</div>
        <div class="au-inl">${`<select id="ae-t-type">${Object.entries(m.triggers).map(([k, v]) => `<option value="${k}" ${t.type === k ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select>`}
        ${t.type === "stage_changed" ? `<span class="small muted">vers</span><select id="ae-t-to">${m.stages.map((s) => `<option value="${s.id}" ${t.to === s.id ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select>` : ""}
        ${t.type === "tag_added" ? `<input id="ae-t-tag" placeholder="mot-cle" value="${esc(t.tag || "")}">` : ""}
        ${t.type === "message_received" ? `<select id="ae-t-ch"><option value="any">SMS ou email</option><option value="sms" ${t.channel === "sms" ? "selected" : ""}>SMS</option><option value="email" ${t.channel === "email" ? "selected" : ""}>Email</option></select>` : ""}</div>
        ${t.type === "call_outcome" ? `<div class="au-outs" id="ae-t-outs">${outs.map(([k, l]) => `<label><input type="checkbox" value="${k}" ${(t.outcomes || []).includes(k) ? "checked" : ""}> ${esc(l)}</label>`).join("")}</div>` : ""}
      </div></li>
    ${a.steps.map((s, i) => `<li class="au-step" data-i="${i}"><span class="au-si ${s.type}">${auSvg(s.type)}</span>
      <div class="grow"><div class="au-st-h"><span>${i + 1}. ${esc(m.steps[s.type])}</span><span class="au-st-act">
        <button class="btn quiet" data-mv="-1" aria-label="Monter" ${i ? "" : "disabled"}>↑</button><button class="btn quiet" data-mv="1" aria-label="Descendre" ${i < a.steps.length - 1 ? "" : "disabled"}>↓</button><button class="btn quiet" data-rm aria-label="Supprimer l'étape">×</button></span></div>
        ${stepFields(s)}</div></li>`).join("")}
    <li class="au-add"><select id="ae-add" aria-label="Ajouter une étape"><option value="">+ Ajouter une étape</option>${Object.entries(m.steps).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select></li>`;
  $("#ae-t-type").onchange = () => { readEditor(); const ty = $("#ae-t-type").value; AU.edit.trigger = { type: ty, ...(ty === "stage_changed" ? { to: "rdv" } : ty === "call_outcome" ? { outcomes: ["messagerie", "injoignable"] } : ty === "tag_added" ? { tag: "" } : ty === "message_received" ? { channel: "any" } : {}) }; drawFlow(); };
  $("#ae-add").onchange = (e) => {
    const ty = e.target.value; if (!ty) return; readEditor();
    const d = { wait: { amount: 1, unit: "days" }, wait_until: { anchor: "appointment_start", offset_minutes: -1440 }, send_sms: { body: "" }, send_email: { subject: "", body: "" }, set_stage: { stage: "rappel" }, add_tag: { tag: "" }, remove_tag: { tag: "" }, add_note: { text: "" }, create_task: { title: "", body: "", due_in_hours: 0 }, condition: { check: "not_replied" } }[ty];
    AU.edit.steps.push({ id: "s" + Date.now().toString(36), type: ty, ...d }); drawFlow();
    const last = $$("#ae-flow .au-step"); const el = last[last.length - 1].querySelector("input,textarea,select"); if (el) el.focus();
  };
  $$("#ae-flow .au-step").forEach((li) => {
    const i = Number(li.dataset.i);
    li.querySelector("[data-rm]").onclick = () => { readEditor(); AU.edit.steps.splice(i, 1); drawFlow(); };
    li.querySelectorAll("[data-mv]").forEach((b) => (b.onclick = () => { readEditor(); const j = i + Number(b.dataset.mv); const st = AU.edit.steps; [st[i], st[j]] = [st[j], st[i]]; drawFlow(); }));
    const ck = li.querySelector('[data-f="check"]'); if (ck) ck.onchange = () => { readEditor(); drawFlow(); };
  });
}

async function runOnLead(a, closeEditor) {
  if (!a.enabled) { toast("Active d'abord l'automatisation"); return; }
  const leads = (CRM.leads && CRM.leads.length ? CRM.leads : (await api("/pipeline").catch(() => ({ leads: [] }))).leads) || [];
  if (!CRM.leads.length) CRM.leads = leads;
  const label = (l) => `${[l.first_name, l.last_name].filter(Boolean).join(" ") || l.name || l.company}${l.company ? " — " + l.company : ""} #${l.id}`;
  closeEditor();
  bModal({
    title: `Lancer « ${a.name} »`, sub: "Le prospect choisi entre tout de suite dans l'automatisation.", go: "Lancer", width: 460,
    body: `<div class="field" style="margin:0"><label for="ar-pick">Prospect</label><input id="ar-pick" list="ar-picks" placeholder="Nom, entreprise…"><datalist id="ar-picks">${leads.map((l) => `<option value="${esc(label(l))}"></option>`).join("")}</datalist></div>`,
    onGo: async () => {
      const m = $("#ar-pick").value.match(/#(\d+)\s*$/); if (!m) { toast("Choisis un prospect dans la liste"); return false; }
      const r = await api(`/automations/${a.id}/run`, { method: "POST", body: JSON.stringify({ leadId: Number(m[1]) }) });
      toast(r.started ? "Prospect ajouté à l'automatisation" : "Ce prospect y est déjà"); loadAutomations();
    },
  });
}

/* ---------- IA ---------- */
$("#au-ai-go").onclick = async () => {
  const p = $("#au-prompt").value.trim(); if (!p) { toast("Décris l'automatisation que tu veux"); $("#au-prompt").focus(); return; }
  const b = $("#au-ai-go"); b.disabled = true; b.innerHTML = `<span class="spin"></span>L'IA prépare ton automatisation…`;
  try { await auMeta(); const r = await api("/automations/ai", { method: "POST", body: JSON.stringify({ prompt: p }) }); openEditor({ ...r.draft, enabled: false }, [], r.draft.explanation); $("#au-prompt").value = ""; }
  catch (e) { toast(e.message); }
  b.disabled = false; b.textContent = "Créer avec l'IA";
};
$("#au-prompt").onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#au-ai-go").click(); };
$("#au-new").onclick = () => openAutomation(null);
$("#au-tpl").onclick = openTemplates;

// badge des tâches à faire dans le menu
setTimeout(() => api("/tasks").then((t) => auBadge(t.open)).catch(() => {}), 1500);
setInterval(() => { if (document.visibilityState === "visible") api("/tasks").then((t) => auBadge(t.open)).catch(() => {}); }, 120000);
