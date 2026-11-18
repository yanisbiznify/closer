/* Biznify — Chiffre d'affaires */
const RV = { month: null, data: null, table: false };
const rvEuro = (c, dec = false) => ((c || 0) / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: dec ? 2 : 0, minimumFractionDigits: dec ? 2 : 0 });
const rvMonthName = (ym, short = false) => { const [y, m] = ym.split("-").map(Number); const s = new Date(y, m - 1, 15).toLocaleDateString("fr-FR", short ? { month: "short" } : { month: "long", year: "numeric" }); return short ? s.replace(".", "") : s.charAt(0).toUpperCase() + s.slice(1); };
const rvShift = (ym, d) => { const [y, m] = ym.split("-").map(Number); const x = new Date(y, m - 1 + d, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`; };
const rvPct = (v) => (v == null ? "—" : `${String(v).replace(".", ",")} %`);

async function loadRevenue() {
  if (!RV.data) $("#rv-hero").innerHTML = `<div class="panel-b"><div class="skeleton" style="width:30%;height:40px"></div></div>`;
  try { RV.data = await api("/revenue" + (RV.month ? `?month=${RV.month}` : "")); } catch (e) { $("#rv-hero").innerHTML = `<div class="panel-b muted">${esc(e.message)}</div>`; return; }
  RV.month = RV.data.month;
  renderRevenue();
}

function renderRevenue() {
  const d = RV.data;
  $("#rv-label").textContent = rvMonthName(d.month);
  $("#rv-next").disabled = d.isCurrent;
  $("#rv-goal-btn").textContent = `Objectif : ${rvEuro(d.goalCents)} / mois`;

  /* --- Bandeau objectif --- */
  const goal = d.goalCents;
  const pct = goal ? Math.round((d.collected / goal) * 100) : null;
  const delta = d.previous ? Math.round(((d.collected - d.previous) / d.previous) * 100) : null;
  const left = Math.max(0, goal - d.collected);
  const daysLeft = d.daysInMonth - d.day;
  let pace = "";
  if (goal && d.isCurrent) {
    pace = d.collected >= goal
      ? `Objectif atteint, ${rvEuro(d.collected - goal)} au-dessus.`
      : `Il reste ${rvEuro(left)} à encaisser en ${daysLeft} jour${daysLeft > 1 ? "s" : ""}${daysLeft ? `, soit ${rvEuro(Math.ceil(left / Math.max(1, daysLeft)))} par jour` : ""}. Au rythme actuel, tu finis le mois à ${rvEuro(d.projection)}.`;
  } else if (goal) {
    pace = d.collected >= goal ? `Objectif atteint, ${rvEuro(d.collected - goal)} au-dessus.` : `${rvEuro(left)} sous l'objectif ce mois-là.`;
  }
  $("#rv-hero").innerHTML = `<div class="rv-hero-in">
      <div class="rv-big">
        <span class="l">Encaissé ${d.isCurrent ? "ce mois-ci" : "en " + rvMonthName(d.month).toLowerCase()}</span>
        <span class="v num">${rvEuro(d.collected)}</span>
        <span class="d">${delta == null ? "Pas d'encaissement le mois précédent" : `${delta >= 0 ? "+" : "−"}${Math.abs(delta)} % par rapport au mois précédent (${rvEuro(d.previous)})`}</span>
      </div>
      <div class="rv-goal">
        <div class="rv-goal-top"><span>${goal ? `<b class="num">${pct} %</b> de l'objectif de ${rvEuro(goal)}` : "Aucun objectif fixé"}</span>${d.isCurrent ? `<span class="muted">Jour ${d.day} sur ${d.daysInMonth}</span>` : ""}</div>
        <div class="rv-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, pct || 0)}" aria-label="Progression vers l'objectif">
          <span class="fill" style="width:${Math.min(100, pct || 0)}%"></span>
          ${d.isCurrent && goal ? `<span class="today" style="left:${(d.day / d.daysInMonth) * 100}%" title="Où tu devrais être aujourd'hui pour tenir l'objectif"></span>` : ""}
        </div>
        <p class="rv-pace">${esc(pace)}${d.isCurrent && goal ? ` <span class="muted">Le trait marque où tu devrais être aujourd'hui.</span>` : ""}</p>
      </div>
    </div>`;

  /* --- Indicateurs --- */
  const c = d.closing;
  $("#rv-kpis").innerHTML = `
    <div class="kpi"><div class="l">Taux de closing</div><div class="v">${rvPct(c.month)}</div><div class="d">${c.monthRdv ? `${c.monthWon} client${c.monthWon > 1 ? "s" : ""} sur ${c.monthRdv} RDV ce mois` : "Pas de RDV ce mois"} · ${rvPct(c.year)} sur 12 mois</div></div>
    <div class="kpi"><div class="l">Clients encaissés</div><div class="v">${d.clients}</div><div class="d">${d.payments} paiement${d.payments > 1 ? "s" : ""} ce mois</div></div>
    <div class="kpi"><div class="l">Panier moyen</div><div class="v">${d.payments ? rvEuro(d.avgCents) : "—"}</div><div class="d">par paiement</div></div>
    <div class="kpi"><div class="l">À encaisser</div><div class="v">${rvEuro(d.pending)}</div><div class="d">${d.overdue ? `dont ${rvEuro(d.overdue)} en retard` : "factures en attente"}</div></div>`;

  renderRvChart();

  /* --- Entonnoir du mois --- */
  const f = d.funnel;
  const steps = [["Appels passés", f.appels], ["Conversations de 30 s et plus", f.conversations], ["Prospects en RDV", c.monthRdv], ["Devenus clients", c.monthWon]];
  const top = Math.max(1, ...steps.map((s) => s[1]));
  $("#rv-funnel-sub").textContent = rvMonthName(d.month);
  $("#rv-funnel").innerHTML = `<ol class="rv-funnel">${steps.map(([l, v], i) => {
    const prev = i ? steps[i - 1][1] : null;
    const conv = i && prev && v <= prev ? Math.round((v / prev) * 100) : null;
    return `<li><div class="rv-f-top"><span>${l}</span><span><b class="num">${v}</b>${conv != null ? `<span class="muted small"> · ${conv} %</span>` : ""}</span></div>
      <div class="rv-f-bar"><span style="width:${Math.max(v ? 2 : 0, (v / top) * 100)}%"></span></div></li>`;
  }).join("")}</ol>
  <p class="small muted" style="margin:14px 0 0">Le pourcentage compare chaque étape à la précédente. Un prospect devient client quand il est passé en « Client signé » ou qu'il a payé.</p>`;

  /* --- Par source et par liste --- */
  const bars = (rows, key) => {
    if (!rows.length) return `<p class="muted" style="margin:0">Aucun encaissement sur les 12 derniers mois.</p>`;
    const tot = rows.reduce((s, r) => s + r.cents, 0); const mx = Math.max(...rows.map((r) => r.cents));
    return `<ul class="rv-hbars">${rows.map((r) => `<li><div class="rv-h-top"><span>${esc(r[key])}</span><span><b class="num">${rvEuro(r.cents)}</b><span class="muted small"> · ${Math.round((r.cents / tot) * 100)} %</span></span></div>
      <div class="rv-f-bar"><span style="width:${(r.cents / mx) * 100}%"></span></div><div class="small muted">${r.n} paiement${r.n > 1 ? "s" : ""}</div></li>`).join("")}</ul>`;
  };
  $("#rv-source").innerHTML = bars(d.bySource, "source");
  $("#rv-list").innerHTML = d.byList.length ? bars(d.byList, "list") : `<p class="muted" style="margin:0">Relie tes factures à un prospect pour voir quelle liste d'appels rapporte le plus.</p>`;
}

function renderRvChart() {
  const d = RV.data, s = d.series, goal = d.goalCents;
  $("#rv-table-btn").textContent = RV.table ? "Voir le graphique" : "Voir en tableau";
  $("#rv-table-btn").setAttribute("aria-pressed", RV.table ? "true" : "false");
  if (RV.table) {
    $("#rv-chart").innerHTML = `<table class="table rv-tbl"><thead><tr><th>Mois</th><th class="r">Encaissé</th><th class="r">Paiements</th><th class="r">Objectif</th></tr></thead><tbody>
      ${s.slice().reverse().map((x) => `<tr><td>${rvMonthName(x.month)}</td><td class="r num">${rvEuro(x.cents)}</td><td class="r">${x.n}</td><td class="r">${goal ? Math.round((x.cents / goal) * 100) + " %" : "—"}</td></tr>`).join("")}</tbody></table>`;
    return;
  }
  const max = Math.max(goal, ...s.map((x) => x.cents), 1) * 1.08;
  const gy = goal ? (goal / max) * 100 : null;
  $("#rv-chart").innerHTML = `<div class="rv-chart" role="img" aria-label="Encaissé par mois sur 12 mois, objectif ${rvEuro(goal)}">
      <div class="rv-cols">${gy != null ? `<div class="rv-goal-line" style="bottom:${gy}%"><span>Objectif ${rvEuro(goal)}</span></div>` : ""}${s.map((x, i) => `<button class="rv-col ${x.month === d.month ? "on" : ""}" data-i="${i}" aria-label="${rvMonthName(x.month)} : ${rvEuro(x.cents)}">
        ${x.month === d.month && x.cents ? `<span class="rv-val num">${rvEuro(x.cents)}</span>` : ""}
        <span class="rv-b" style="height:${x.cents ? Math.max(1, (x.cents / max) * 100) : 0}%"></span></button>`).join("")}</div>
      <div class="rv-x">${s.map((x) => `<span class="${x.month === d.month ? "on" : ""}">${rvMonthName(x.month, true)}</span>`).join("")}</div>
      <div class="rv-tip" id="rv-tip" hidden></div>
    </div>`;
  const tip = $("#rv-tip"), wrap = $("#rv-chart .rv-chart");
  $$("#rv-chart .rv-col").forEach((b) => {
    const x = s[Number(b.dataset.i)];
    const showTip = () => {
      tip.innerHTML = `<b>${rvMonthName(x.month)}</b><span class="num">${rvEuro(x.cents)}</span><span class="muted">${x.n} paiement${x.n > 1 ? "s" : ""}${goal ? ` · ${Math.round((x.cents / goal) * 100)} % de l'objectif` : ""}</span>`;
      tip.hidden = false;
      const r = b.getBoundingClientRect(), w = wrap.getBoundingClientRect();
      tip.style.left = Math.min(w.width - 170, Math.max(0, r.left - w.left + r.width / 2 - 85)) + "px";
    };
    b.onmouseenter = showTip; b.onfocus = showTip;
    b.onmouseleave = b.onblur = () => (tip.hidden = true);
    b.onclick = () => { if (x.month !== RV.month) { RV.month = x.month; loadRevenue(); } };
  });
}

$("#rv-prev").onclick = () => { RV.month = rvShift(RV.month || RV.data.month, -1); loadRevenue(); };
$("#rv-next").onclick = () => { if (RV.data && !RV.data.isCurrent) { RV.month = rvShift(RV.month, 1); loadRevenue(); } };
$("#rv-table-btn").onclick = () => { RV.table = !RV.table; renderRvChart(); };
$("#rv-goal-btn").onclick = () => bModal({
  title: "Objectif mensuel", sub: "Le chiffre d'affaires que tu veux encaisser chaque mois.", go: "Enregistrer", width: 420,
  body: `<div class="field" style="margin-bottom:0"><label for="rv-goal">Objectif (€ encaissés par mois)</label><input id="rv-goal" inputmode="numeric" value="${RV.data ? RV.data.goalCents / 100 : 10000}" style="max-width:200px"></div>`,
  onGo: async () => {
    const v = Math.round(parseNum($("#rv-goal").value));
    await api("/settings", { method: "PUT", body: JSON.stringify({ objectifCA: v }) });
    toast("Objectif enregistré"); loadRevenue();
  },
});
