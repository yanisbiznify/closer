/* Biznify — tout est relié : chiffres business du tableau de bord, activité récente, argent par prospect, alertes en direct */
const ACT = { last: null, timer: null };
const eur0 = (c) => ((c || 0) / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const eur2 = (c) => ((c || 0) / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
const ACT_ICON = {
  payment: '<path d="M4 10h12M4 14h9"/><path d="M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2"/>',
  invoice: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  booking: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  reply: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  prospect: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  site_lead: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
};
const actIcon = (t) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ACT_ICON[t] || ACT_ICON.invoice}</svg>`;
const ago = (d) => {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return new Date(d).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
};

/* ---------- Tableau de bord : chiffres business + activité ---------- */
async function loadBusiness() {
  const box = $("#biz"); if (!box) return;
  let b, a;
  try { [b, a] = await Promise.all([api("/dashboard/business"), api("/activity?limit=8")]); }
  catch (e) { box.innerHTML = ""; return; }
  const m = b.month;
  const pct = !m || m.pct == null ? null : Math.min(100, m.pct);
  box.innerHTML = `
    <div class="biz-grid">
      ${m ? `<button class="kpi biz-main" data-go="revenue">
        <div class="l">Encaissé ce mois-ci</div>
        <div class="v">${eur0(m.collected)}</div>
        ${m.goal ? `<div class="biz-bar" role="img" aria-label="${m.pct} % de l'objectif"><span style="width:${pct}%"></span><i style="left:${Math.min(100, m.expectedPct)}%" title="Où tu devrais être aujourd'hui"></i></div>
          <div class="d">${m.pct} % de ${eur0(m.goal)} · ${m.payments} paiement${m.payments > 1 ? "s" : ""}</div>` : `<div class="d">${m.payments} paiement${m.payments > 1 ? "s" : ""}</div>`}
      </button>
      <button class="kpi" data-go="billing"><div class="l">À encaisser</div><div class="v">${eur0(b.pending.cents)}</div><div class="d">${b.pending.count} facture${b.pending.count > 1 ? "s" : ""}${b.pending.late ? ` · <span class="c-bad">${b.pending.late} en retard</span>` : ""}</div></button>` : ""}
      <button class="kpi" data-go="calendar"><div class="l">RDV, 7 prochains jours</div><div class="v">${b.upcomingAppointments}</div><div class="d">${b.wonThisMonth} client${b.wonThisMonth > 1 ? "s" : ""} signé${b.wonThisMonth > 1 ? "s" : ""} ce mois</div></button>
      <button class="kpi" data-go="pipeline"><div class="l">Nouveaux prospects</div><div class="v">${b.newLeads7d}</div><div class="d">ces 7 derniers jours</div></button>
    </div>
    <div class="panel act-panel">
      <div class="panel-h"><div><h2>Activité récente</h2><div class="sub">${m ? "Paiements, factures, réservations et demandes des sites, en direct" : "Réservations, prospects et messages, en direct"}</div></div></div>
      <div id="act-list">${actList(a.items)}</div>
    </div>`;
  bindActList();
}
function actList(items) {
  if (!items || !items.length) return `<div class="panel-b muted small">Rien pour l'instant : les paiements, factures, réservations et demandes de tes sites apparaîtront ici.</div>`;
  return `<ul class="act">${items.map((x) => `<li class="act-${esc(x.type)}" ${x.lead_id ? `data-lead="${x.lead_id}" tabindex="0" role="button"` : ""}>
    <span class="act-i">${actIcon(x.type)}</span>
    <div class="act-t"><b>${esc(x.title)}</b>${x.detail ? `<span>${esc(x.detail)}</span>` : ""}</div>
    <div class="act-r">${x.amount_cents ? `<b class="${x.type === "payment" ? "c-good" : ""}">${x.type === "payment" ? "+" : ""}${eur2(x.amount_cents)}</b>` : ""}<span>${esc(ago(x.created_at))}</span></div></li>`).join("")}</ul>`;
}
function bindActList() {
  $$("#act-list [data-lead]").forEach((li) => {
    const go = () => openLead(Number(li.dataset.lead));
    li.onclick = go; li.onkeydown = (e) => { if (e.key === "Enter") go(); };
  });
}

/* ---------- Fiche prospect : factures, liens et paiements ---------- */
async function loadLeadMoney(leadId) {
  const box = $("#ld-money"); if (!box) return;
  let r;
  try { r = await api(`/leads/${leadId}/money`); } catch (e) { box.innerHTML = `<p class="small muted">${esc(e.message)}</p>`; return; }
  if (!LD.lead || LD.lead.id !== leadId) return;
  const st = { payee: ["good", "Payée"], emise: ["mid", "À payer"], annulee: ["", "Annulée"] };
  const rows = [
    ...r.invoices.map((i) => `<li><a href="/facture/${esc(i.token)}" target="_blank" rel="noopener"><b>${esc(i.number)}</b> ${esc(i.title || "")}</a><span class="badge ${st[i.status][0]}">${st[i.status][1]}${i.status === "payee" && i.paid_at ? " le " + new Date(i.paid_at).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) : ""}</span><b>${eur2(i.total_cents)}</b></li>`),
    ...r.links.map((l) => `<li><span><b>Lien</b> ${esc(l.label)}</span><span class="badge ${l.paid_count ? "good" : l.active ? "mid" : ""}">${l.paid_count ? `Payé${l.paid_count > 1 ? ` ×${l.paid_count}` : ""}` : l.active ? "En attente" : "Désactivé"}</span><b>${eur2(l.paid_count ? l.paid_cents : l.amount_cents)}</b></li>`),
  ];
  box.innerHTML = `
    <div class="ldm-tot"><div><span>Payé</span><b class="c-good">${eur2(r.totals.paid)}</b></div><div><span>À payer</span><b>${eur2(r.totals.due)}</b></div></div>
    ${rows.length ? `<ul class="ldm">${rows.join("")}</ul>` : `<p class="small muted" style="margin:8px 0 0">Aucune facture pour l'instant. Clique sur « Facturer » pour en créer une.</p>`}
    ${r.activity.length ? `<details class="ldm-act"><summary>Historique (${r.activity.length})</summary>${actList(r.activity)}</details>` : ""}`;
}

/* ---------- Alertes en direct : un paiement arrive, tout se met à jour ---------- */
async function actPoll() {
  try {
    const r = await api(`/activity?since=${ACT.last || 0}`);
    if (ACT.last === null) { ACT.last = r.last; return; }
    if (!r.items.length) return;
    ACT.last = r.items[r.items.length - 1].id;
    const pays = r.items.filter((x) => x.type === "payment");
    const first = pays[0] || r.items[0];
    toast(pays.length ? `💰 ${eur2(first.amount_cents)} encaissés : ${first.title}` : first.title);
    if (pays.length && typeof window.confetti === "function") { window.confetti(140); try { navigator.vibrate && navigator.vibrate([30, 50, 30]); } catch (_) {} }
    // on rafraîchit l'écran ouvert pour que tout reste cohérent
    const on = ($("section.view.on") || {}).id || "";
    if (on === "v-dashboard") loadBusiness();
    if (on === "v-revenue" && typeof loadRevenue === "function") loadRevenue();
    if (on === "v-billing" && typeof loadBilling === "function") loadBilling();
    if (on === "v-pipeline" && typeof loadPipeline === "function") loadPipeline();
    if (on === "v-calendar" && typeof loadCalendar === "function") loadCalendar();
    if (LD.lead && r.items.some((x) => x.lead_id === LD.lead.id)) loadLeadMoney(LD.lead.id);
  } catch (_) {}
}
function actStart() {
  clearInterval(ACT.timer);
  actPoll();
  ACT.timer = setInterval(() => { if (document.visibilityState === "visible") actPoll(); }, 25000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") actPoll(); });
}
window.addEventListener("load", () => { actStart(); if ($("#v-dashboard") && $("#v-dashboard").classList.contains("on")) loadBusiness(); });
