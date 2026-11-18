/* Biznify — Objectifs : cap à 3 mois, mois, semaine */
const OB = { data: null };
const OB_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Paris"; } catch { return "Europe/Paris"; } })();

const OB_H = {
  trimestre: { label: "Cap à 3 mois", short: "3 mois", empty: "Fixe ton grand cap : par exemple 10 000 € encaissés par mois." },
  mois: { label: "Ce mois-ci", short: "Mois", empty: "Découpe ton cap en objectifs pour ce mois." },
  semaine: { label: "Cette semaine", short: "Semaine", empty: "Qu'est-ce qui doit être fait d'ici dimanche ?" },
};
const OB_M = {
  check: { label: "Je coche quand c'est fait", auto: false },
  nombre: { label: "Un chiffre que je mets à jour (kg, reels, posts…)", auto: false },
  ca: { label: "CA encaissé sur la période", auto: true, unit: "€" },
  ca_mois: { label: "CA encaissé par mois (rythme mensuel)", auto: true, unit: "€" },
  appels: { label: "Appels passés", auto: true, unit: "appels" },
  conversations: { label: "Conversations de 30 s et plus", auto: true, unit: "conversations" },
  rdv: { label: "Rendez-vous pris", auto: true, unit: "RDV" },
  clients: { label: "Nouveaux clients", auto: true, unit: "clients" },
};

/* ---------- Dates ---------- */
const obAdd = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
function obAddMonths(d, n) {
  const [y, m, day] = d.split("-").map(Number);
  const x = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return x.toISOString().slice(0, 10);
}
function obPeriod(h, d) {
  if (h === "semaine") { const wd = (new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7; const s = obAdd(d, -wd); return { start: s, end: obAdd(s, 6) }; }
  if (h === "mois") { const s = d.slice(0, 8) + "01"; return { start: s, end: obAdd(obAddMonths(s, 1), -1) }; }
  return { start: d, end: obAdd(obAddMonths(d, 3), -1) };
}
const obDay = (d, opts = { day: "numeric", month: "short" }) => new Date(d + "T12:00:00Z").toLocaleDateString("fr-FR", { ...opts, timeZone: "UTC" }).replace(".", "");
const obRange = (s, e) => `${obDay(s)} → ${obDay(e, s.slice(0, 4) === e.slice(0, 4) ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" })}`;
const obMonthName = (d) => { const t = new Date(d + "T12:00:00Z").toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }); return t; };

/* ---------- Valeurs ---------- */
const obNum = (v) => Number(v || 0).toLocaleString("fr-FR", { maximumFractionDigits: 1 });
function obFmt(g, v) {
  const m = OB_M[g.metric] || {};
  if (m.unit === "€") return Number(v || 0).toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  const unit = g.metric === "nombre" ? g.unit || "" : m.unit || "";
  return `${obNum(v)}${unit ? " " + unit : ""}`;
}

async function loadGoals() {
  if (!OB.data) $("#ob-sections").innerHTML = `<div class="panel"><div class="panel-b"><div class="skeleton" style="width:40%"></div></div></div>`;
  try { OB.data = await api("/goals?tz=" + encodeURIComponent(OB_TZ)); } catch (e) { $("#ob-sections").innerHTML = `<div class="panel"><div class="panel-b muted">${esc(e.message)}</div></div>`; return; }
  renderGoals();
}

function obRow(g) {
  const m = OB_M[g.metric] || OB_M.check;
  const dom = `<span class="badge ${g.domain === "perso" ? "" : "or"}">${g.domain === "perso" ? "Perso" : "Pro"}</span>`;
  const future = g.start_date > OB.data.today;
  let meta = "";
  if (g.metric === "check") {
    meta = g.done_at ? `Fait le ${fmtDate(g.done_at)}` : "";
  } else {
    const down = g.metric === "nombre" && g.direction === "down";
    // « 2 sur 200 appels » plutôt que « 2 appels sur 200 appels » (sauf en €, et pour un objectif à la baisse)
    const now = `<b class="num">${m.unit === "€" || down ? obFmt(g, g.value) : obNum(g.value)}</b>`;
    meta = down
      ? `${now} · cible ${obFmt(g, g.target)}${g.baseline != null ? ` <span class="muted">(départ ${obFmt(g, g.baseline)})</span>` : ""}`
      : `${now} sur ${obFmt(g, g.target)}`;
    if (g.metric === "ca_mois" && g.range) meta += ` <span class="muted">· ${obMonthName(g.range.start)}</span>`;
  }
  const pct = Math.min(100, g.pct || 0);
  const state = g.reached ? "good" : g.past ? "bad" : "";
  const icon = g.metric === "check"
    ? `<button class="ob-chk ${g.done_at ? "on" : ""}" data-act="toggle" aria-pressed="${g.done_at ? "true" : "false"}" aria-label="${g.done_at ? "Marquer comme pas fait" : "Marquer comme fait"}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></button>`
    : `<span class="ob-ring ${state}" style="--p:${pct}" aria-hidden="true"><span>${g.reached ? "✓" : pct + "%"}</span></span>`;
  return `<li class="ob-row ${g.reached ? "done" : ""}" data-id="${g.id}">
    ${icon}
    <div class="ob-main">
      <div class="ob-top"><span class="ob-title">${esc(g.title)}</span>${dom}${m.auto ? `<span class="badge" title="Calculé tout seul à partir de tes appels, de ton agenda et de tes paiements">Auto</span>` : ""}${future ? `<span class="badge">À partir du ${obDay(g.start_date)}</span>` : ""}</div>
      ${g.metric !== "check" ? `<div class="ob-bar ${state}"><span style="width:${pct}%"></span></div>` : ""}
      <div class="ob-meta">${meta}${g.notes ? `${meta ? " · " : ""}<span class="muted">${esc(g.notes.split("\n")[0].slice(0, 120))}</span>` : ""}</div>
    </div>
    <div class="ob-acts">
      ${g.metric === "nombre" ? `<button class="btn ghost ob-sm" data-act="value">Mettre à jour</button>` : ""}
      <button class="btn quiet ob-sm" data-act="edit" aria-label="Modifier « ${esc(g.title)} »">Modifier</button>
    </div>
  </li>`;
}

function renderGoals() {
  const d = OB.data, today = d.today;
  const active = d.goals.filter((g) => g.end_date >= today);
  const past = d.goals.filter((g) => g.end_date < today);

  // Bandeau : la semaine en un coup d'œil
  const wk = active.filter((g) => g.horizon === "semaine" && g.start_date <= today);
  const wkDone = wk.filter((g) => g.reached).length;
  const left = Math.round((Date.parse(d.periods.semaine.end) - Date.parse(today)) / 864e5) + 1;
  $("#ob-sum").textContent = wk.length
    ? `Cette semaine : ${wkDone} objectif${wkDone > 1 ? "s" : ""} atteint${wkDone > 1 ? "s" : ""} sur ${wk.length}, ${left} jour${left > 1 ? "s" : ""} restant${left > 1 ? "s" : ""}.`
    : "Du cap à 3 mois jusqu'à ce que tu fais cette semaine.";

  $("#ob-sections").innerHTML = ["trimestre", "mois", "semaine"].map((h) => {
    const list = active.filter((g) => g.horizon === h).sort((a, b) => (a.start_date > today) - (b.start_date > today) || a.position - b.position || a.id - b.id);
    const cur = list.filter((g) => g.start_date <= today);
    const n = cur.filter((g) => g.reached).length;
    let sub = "";
    if (h === "semaine") sub = obRange(d.periods.semaine.start, d.periods.semaine.end);
    else if (h === "mois") sub = obMonthName(today);
    else if (cur.length) { const s = cur.reduce((a, g) => (g.start_date < a ? g.start_date : a), cur[0].start_date); const e = cur.reduce((a, g) => (g.end_date > a ? g.end_date : a), cur[0].end_date); sub = obRange(s, e); }
    return `<div class="panel ob-sec">
      <div class="panel-h"><div><h2>${OB_H[h].label}</h2><div class="sub">${sub}${cur.length ? ` · ${n} sur ${cur.length} atteint${n > 1 ? "s" : ""}` : ""}</div></div>
        <button class="btn quiet" data-add="${h}">+ Ajouter</button></div>
      ${list.length ? `<ul class="ob-list">${list.map(obRow).join("")}</ul>` : `<div class="panel-b muted">${OB_H[h].empty}</div>`}
    </div>`;
  }).join("");

  // Périodes passées : le bilan, avec la possibilité de reporter
  const groups = {};
  past.forEach((g) => { const k = `${g.horizon}|${g.start_date}|${g.end_date}`; (groups[k] = groups[k] || []).push(g); });
  const keys = Object.keys(groups).sort((a, b) => (a.split("|")[2] < b.split("|")[2] ? 1 : -1));
  $("#ob-past").innerHTML = keys.length ? `<div class="panel">
    <div class="panel-h"><div><h2>Bilan des périodes passées</h2><div class="sub">Ce qui a été atteint, et ce que tu peux reporter</div></div></div>
    ${keys.map((k, i) => {
      const [h, s, e] = k.split("|"); const gs = groups[k]; const ok = gs.filter((g) => g.reached).length;
      return `<details class="ob-past" ${i === 0 ? "open" : ""}><summary><span>${OB_H[h].short} · ${obRange(s, e)}</span><span class="badge ${ok === gs.length ? "good" : ok ? "mid" : "bad"}">${ok} / ${gs.length}</span></summary>
        <ul>${gs.map((g) => `<li data-id="${g.id}"><span class="${g.reached ? "c-good" : "c-bad"}" aria-label="${g.reached ? "Atteint" : "Pas atteint"}">${g.reached ? "✓" : "✕"}</span>
          <span class="ob-pt">${esc(g.title)}${g.metric !== "check" ? ` <span class="muted small">· ${obFmt(g, g.value)} sur ${obFmt(g, g.target)}</span>` : ""}</span>
          ${g.reached ? "" : `<button class="btn quiet ob-sm" data-act="report">Reporter</button>`}<button class="btn quiet ob-sm" data-act="edit">Modifier</button></li>`).join("")}</ul></details>`;
    }).join("")}</div>` : "";
}

/* ---------- Formulaire ---------- */
function goalForm(g = null, horizon = "semaine") {
  const today = OB.data ? OB.data.today : new Date().toISOString().slice(0, 10);
  const x = g || { horizon, domain: "pro", metric: "check", title: "", target: null, unit: "", notes: "", direction: "up", current: 0, ...obPeriod(horizon, today) };
  const start = g ? g.start_date : x.start, end = g ? g.end_date : x.end;
  bModal({
    title: g ? "Modifier l'objectif" : "Nouvel objectif",
    sub: g ? "" : "Les objectifs « Auto » se mettent à jour tout seuls avec tes appels, ton agenda et tes paiements.",
    go: g ? "Enregistrer" : "Ajouter", width: 560,
    body: `
      <div class="field"><label for="ob-t">Objectif</label><input id="ob-t" maxlength="200" value="${esc(x.title)}" placeholder="Ex. : 200 appels de prospection"></div>
      <div class="ob-2">
        <div class="field"><label for="ob-h">Horizon</label><select id="ob-h">${Object.entries(OB_H).map(([k, v]) => `<option value="${k}" ${x.horizon === k ? "selected" : ""}>${v.short}</option>`).join("")}</select></div>
        <div class="field"><label for="ob-d">Domaine</label><select id="ob-d"><option value="pro" ${x.domain !== "perso" ? "selected" : ""}>Pro</option><option value="perso" ${x.domain === "perso" ? "selected" : ""}>Perso</option></select></div>
      </div>
      <div class="field"><label for="ob-m">Comment le mesurer</label><select id="ob-m">${Object.entries(OB_M).map(([k, v]) => `<option value="${k}" ${x.metric === k ? "selected" : ""}>${v.auto ? "Auto · " : ""}${v.label}</option>`).join("")}</select></div>
      <div class="ob-2" id="ob-num">
        <div class="field"><label for="ob-c">Cible</label><input id="ob-c" inputmode="decimal" value="${x.target != null ? x.target : ""}" placeholder="Ex. : 200"></div>
        <div class="field" id="ob-u-f"><label for="ob-u">Unité</label><input id="ob-u" maxlength="30" value="${esc(x.unit || "")}" placeholder="kg, reels, posts…"></div>
      </div>
      <div class="ob-2" id="ob-nb">
        <div class="field"><label for="ob-dir">Sens</label><select id="ob-dir"><option value="up" ${x.direction !== "down" ? "selected" : ""}>Monter jusqu'à la cible</option><option value="down" ${x.direction === "down" ? "selected" : ""}>Descendre jusqu'à la cible (poids…)</option></select></div>
        <div class="field"><label for="ob-v">Où tu en es aujourd'hui</label><input id="ob-v" inputmode="decimal" value="${x.current != null ? x.current : 0}"></div>
      </div>
      <div class="ob-2">
        <div class="field"><label for="ob-s">Début</label><input id="ob-s" type="date" value="${start}"></div>
        <div class="field"><label for="ob-e">Fin</label><input id="ob-e" type="date" value="${end}"></div>
      </div>
      <div class="field" style="margin-bottom:0"><label for="ob-n">Notes <span class="muted">(facultatif)</span></label><textarea id="ob-n" rows="3" maxlength="4000" placeholder="Le pourquoi, les étapes, à quoi il sert…">${esc(x.notes || "")}</textarea></div>
      ${g ? `<div class="ob-danger"><button class="btn danger ob-sm" id="ob-del" type="button">Supprimer</button>${g.past && !g.reached ? `<button class="btn ghost ob-sm" id="ob-rep" type="button">Reporter sur la période suivante</button>` : ""}</div>` : ""}`,
    onGo: async () => {
      const body = {
        tz: OB_TZ, title: $("#ob-t").value, horizon: $("#ob-h").value, domain: $("#ob-d").value, metric: $("#ob-m").value,
        start_date: $("#ob-s").value, end_date: $("#ob-e").value, notes: $("#ob-n").value,
      };
      if (body.metric !== "check") body.target = parseNum($("#ob-c").value);
      if (body.metric === "nombre") { body.unit = $("#ob-u").value; body.direction = $("#ob-dir").value; body.current = parseNum($("#ob-v").value); }
      if (g && body.metric === "nombre" && body.direction === "down" && g.baseline == null) body.baseline = body.current;
      await api(g ? `/goals/${g.id}` : "/goals", { method: g ? "PUT" : "POST", body: JSON.stringify(body) });
      toast(g ? "Objectif enregistré" : "Objectif ajouté");
      loadGoals();
    },
  });
  const sync = () => {
    const m = $("#ob-m").value;
    $("#ob-num").style.display = m === "check" ? "none" : "";
    $("#ob-u-f").style.display = m === "nombre" ? "" : "none";
    $("#ob-nb").style.display = m === "nombre" ? "" : "none";
  };
  sync();
  $("#ob-m").onchange = sync;
  // Changer d'horizon recale les dates sur la période en cours (semaine, mois, 3 mois)
  $("#ob-h").onchange = () => { const p = obPeriod($("#ob-h").value, today); $("#ob-s").value = p.start; $("#ob-e").value = p.end; };
  if (g) {
    $("#ob-del").onclick = async () => {
      if (!(await confirmBox(`Supprimer « ${g.title} » ?`, "Supprimer"))) return;
      await api(`/goals/${g.id}`, { method: "DELETE" }); $("#bm").classList.remove("on"); toast("Objectif supprimé"); loadGoals();
    };
    if ($("#ob-rep")) $("#ob-rep").onclick = () => obReport(g).then(() => $("#bm").classList.remove("on"));
  }
}

function valueForm(g) {
  bModal({
    title: g.title, sub: `Cible : ${obFmt(g, g.target)}`, go: "Enregistrer", width: 380,
    body: `<div class="field" style="margin-bottom:0"><label for="ob-nv">Où tu en es aujourd'hui${g.unit ? ` (${esc(g.unit)})` : ""}</label><input id="ob-nv" inputmode="decimal" value="${g.current}" style="max-width:180px"></div>`,
    onGo: async () => {
      await api(`/goals/${g.id}`, { method: "PUT", body: JSON.stringify({ tz: OB_TZ, current: parseNum($("#ob-nv").value) }) });
      toast("C'est noté"); loadGoals();
    },
  });
  setTimeout(() => { const i = $("#ob-nv"); if (i) i.select(); }, 40);
}

async function obReport(g) {
  try {
    const r = await api(`/goals/${g.id}/report`, { method: "POST", body: JSON.stringify({ tz: OB_TZ }) });
    toast(`Reporté : ${obRange(r.start_date, r.end_date)}`); loadGoals();
  } catch (e) { toast(e.message); }
}

/* ---------- Événements ---------- */
$("#ob-add").onclick = () => goalForm(null, "semaine");
$("#v-goals").addEventListener("click", async (e) => {
  const add = e.target.closest("[data-add]");
  if (add) return goalForm(null, add.dataset.add);
  const b = e.target.closest("[data-act]"); if (!b) return;
  const row = b.closest("[data-id]"); const g = OB.data && OB.data.goals.find((x) => String(x.id) === row.dataset.id); if (!g) return;
  if (b.dataset.act === "edit") return goalForm(g);
  if (b.dataset.act === "value") return valueForm(g);
  if (b.dataset.act === "report") return obReport(g);
  if (b.dataset.act === "toggle") {
    b.disabled = true;
    try { await api(`/goals/${g.id}`, { method: "PUT", body: JSON.stringify({ tz: OB_TZ, done: !g.done_at }) }); if (!g.done_at) toast("Bien joué ✓"); loadGoals(); }
    catch (err) { toast(err.message); b.disabled = false; }
  }
});
