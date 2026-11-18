/* Biznify — Factures et liens de paiement Stripe */
const BL = { data: null, settings: null };
const euro = (c) => ((c || 0) / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
const dShort = (d) => (d ? new Date(d).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : "—");
const isoDay = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
const parseNum = (v) => Number(String(v ?? "").replace(/\s/g, "").replace(",", ".")) || 0;

function copy(text, msg = "Lien copié") {
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast(msg), () => window.prompt("Copie ce lien :", text));
  else window.prompt("Copie ce lien :", text);
}

/* ---------- Fenêtre ---------- */
function bModal({ title, sub = "", body, go = "Enregistrer", width = 560, onGo, cancel = "Annuler" }) {
  $("#bm-title").textContent = title; $("#bm-sub").textContent = sub; $("#bm-sub").style.display = sub ? "" : "none";
  $("#bm-body").innerHTML = body; $("#bm .box").style.maxWidth = width + "px";
  const goB = $("#bm-go"), noB = $("#bm-no");
  goB.textContent = go; goB.style.display = onGo ? "" : "none"; goB.disabled = false; noB.textContent = cancel;
  $("#bm").classList.add("on");
  const close = () => { $("#bm").classList.remove("on"); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  noB.onclick = close;
  goB.onclick = async () => {
    goB.disabled = true; const lab = goB.textContent; goB.innerHTML = `<span class="spin"></span>${esc(lab)}`;
    try { const r = await onGo(); if (r !== false) close(); } catch (e) { toast(e.message); }
    goB.disabled = false; goB.textContent = lab;
  };
  const first = $("#bm-body input, #bm-body select, #bm-body textarea"); if (first) setTimeout(() => first.focus(), 30);
  return close;
}

/* ---------- Vue ---------- */
async function loadBilling() {
  if (!$("#bl-list").innerHTML) $("#bl-list").innerHTML = `<div class="panel-b"><div class="skeleton" style="width:40%"></div></div>`;
  try { BL.data = await api("/invoices"); } catch (e) { $("#bl-list").innerHTML = `<div class="panel-b muted">${esc(e.message)}</div>`; return; }
  renderBilling();
}

function invStatus(i) {
  if (i.status === "payee") return `<span class="badge good">Payée</span>`;
  if (i.status === "annulee") return `<span class="badge">Annulée</span>`;
  if (i.due_date && new Date(i.due_date) < new Date(new Date().toDateString())) return `<span class="badge bad">En retard</span>`;
  return `<span class="badge or">À payer</span>`;
}
const clientOf = (i) => (i.client && (i.client.company || i.client.name)) || i.lead_company || i.lead_name || "Client";

function renderBilling() {
  const d = BL.data; if (!d) return;
  $("#bl-k-paid").textContent = euro(d.totals.paid);
  $("#bl-k-pending").textContent = euro(d.totals.pending);
  $("#bl-k-late").textContent = euro(d.totals.overdue);
  $("#bl-k-count").textContent = d.totals.count;
  window.BL_STRIPE = d.stripe;
  const sb = $("#bl-stripe");
  sb.className = d.stripe.enabled ? "btn ghost" : "btn ghost";
  sb.innerHTML = d.stripe.enabled ? `<span class="dot-ok"></span>Stripe connecté` : "Connecter Stripe";
  sb.onclick = openStripeConnect;
  $("#bl-callout").innerHTML = !d.stripe.enabled
    ? `<div class="callout"><div class="grow"><b>Connecte Stripe pour encaisser en ligne.</b><p>Une fois connecté, le bouton « Payer » de tes factures et tes liens de paiement fonctionnent tout de suite.</p></div><button class="btn primary" id="bl-stripe-cta">Connecter Stripe</button></div>`
    : d.stripe.mode === "test" ? `<div class="callout"><div class="grow"><b>Stripe est en mode test.</b><p>Les paiements sont fictifs (carte 4242 4242 4242 4242). Reconnecte Stripe avec ta clé « live » pour encaisser pour de vrai.</p></div><button class="btn ghost" id="bl-stripe-cta">Passer en live</button></div>` : "";
  const cta = $("#bl-stripe-cta"); if (cta) cta.onclick = openStripeConnect;

  const inv = d.invoices;
  $("#bl-list").innerHTML = inv.length
    ? `<table class="table"><thead><tr><th>N°</th><th>Client</th><th class="hide-m">Émise</th><th class="hide-m">Échéance</th><th class="r">Montant</th><th>Statut</th></tr></thead><tbody>
      ${inv.map((i) => `<tr data-inv="${i.id}" tabindex="0"><td class="nowrap num">${esc(i.number)}</td><td class="who"><b>${esc(clientOf(i))}</b><span>${esc(i.title || (i.client && i.client.company && i.client.name) || "")}</span></td>
        <td class="hide-m nowrap">${dShort(i.issue_date)}</td><td class="hide-m nowrap">${i.due_date ? dShort(i.due_date) : "—"}</td>
        <td class="r num nowrap">${euro(i.total_cents)}</td><td>${invStatus(i)}${i.status === "emise" && i.viewed_at ? ` <span class="small muted">vue</span>` : ""}</td></tr>`).join("")}
      </tbody></table>`
    : emptyState("Aucune facture pour l'instant", "Crée ta première facture : ton client reçoit un lien et paie par carte.");
  $$("#bl-list tr[data-inv]").forEach((tr) => {
    const open = () => openInvoice(Number(tr.dataset.inv));
    tr.onclick = open; tr.onkeydown = (e) => { if (e.key === "Enter") open(); };
  });

  const links = d.links;
  $("#bl-links").innerHTML = links.length
    ? `<table class="table bl-links"><thead><tr><th>Pour</th><th class="r">Montant</th><th class="r hide-m">Payé</th><th></th></tr></thead><tbody>
      ${links.map((l) => `<tr data-link="${l.id}"><td class="who"><b>${esc(l.label)}</b><span>${dShort(l.created_at)}${l.active ? "" : " · désactivé"}</span></td>
        <td class="r num nowrap">${euro(l.amount_cents)}</td><td class="r hide-m nowrap">${l.paid_count ? `${l.paid_count} fois · ${euro(l.paid_cents)}` : "—"}</td>
        <td class="r nowrap">${l.active ? `<button class="btn ghost" data-copy="${esc(l.url)}">Copier le lien</button> <button class="btn quiet" data-off="${l.id}">Désactiver</button>` : ""}</td></tr>`).join("")}
      </tbody></table>`
    : `<div class="panel-b muted">Pas encore de lien. « Lien de paiement » crée un lien Stripe pour un montant, à envoyer par SMS ou WhatsApp.</div>`;
  $$("#bl-links [data-copy]").forEach((b) => (b.onclick = () => copy(b.dataset.copy)));
  $$("#bl-links [data-off]").forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox("Désactiver ce lien ? Il ne pourra plus être payé.", "Désactiver"))) return;
    try { await api(`/payment-links/${b.dataset.off}/disable`, { method: "POST" }); toast("Lien désactivé"); loadBilling(); } catch (e) { toast(e.message); }
  }));
}

/* ---------- Détail d'une facture ---------- */
function openInvoice(id) {
  const i = BL.data.invoices.find((x) => x.id === id); if (!i) return;
  const c = i.client || {};
  const open = i.status === "emise";
  const mail = c.email ? `mailto:${encodeURIComponent(c.email)}?subject=${encodeURIComponent(`Facture ${i.number}`)}&body=${encodeURIComponent(`Bonjour${c.name ? " " + c.name.split(" ")[0] : ""},\n\nVoici votre facture ${i.number} d'un montant de ${euro(i.total_cents)}${i.title ? " (" + i.title + ")" : ""}.\nVous pouvez la consulter et la régler par carte bancaire ici :\n${i.url}\n\nMerci et à bientôt,\n`)}` : null;
  const close = bModal({
    title: `Facture ${i.number}`,
    sub: `${clientOf(i)} · ${euro(i.total_cents)} TTC`,
    width: 560, cancel: "Fermer",
    body: `<div class="bl-detail">
      <div class="bl-st">${invStatus(i)}<span class="small muted">${i.status === "payee" ? `Payée le ${dShort(i.paid_at)}${i.paid_via ? " · " + esc(i.paid_via) : ""}` : i.viewed_at ? `Vue par le client le ${dShort(i.viewed_at)}` : "Pas encore ouverte par le client"}</span></div>
      <div class="bl-url"><input readonly value="${esc(i.url)}" aria-label="Lien de la facture"><button class="btn ghost" id="bi-copy">Copier</button></div>
      <div class="bl-acts">
        <a class="btn primary" href="${esc(i.url)}" target="_blank" rel="noopener">Voir la facture</a>
        <a class="btn ghost" href="/facture/${esc(i.token)}/pdf">Télécharger le PDF</a>
        ${c.email ? `<button class="btn ghost" id="bi-send">Envoyer par email</button>` : ""}
        ${open ? `<button class="btn ghost" id="bi-stripe">${i.payment_link_url ? "Copier le lien Stripe" : "Créer un lien Stripe direct"}</button>` : ""}
      </div>
      <div class="bl-acts sec">
        ${open ? `<button class="btn quiet" id="bi-edit">Modifier</button><button class="btn quiet" id="bi-paid">Marquer comme payée</button><button class="btn quiet" id="bi-cancel">Annuler la facture</button>` : ""}
        ${i.status === "annulee" ? `<button class="btn quiet" id="bi-reopen">Remettre à payer</button>` : ""}
        ${i.status !== "payee" ? `<button class="btn quiet bl-del" id="bi-del">Supprimer</button>` : ""}
      </div>
      <p class="small muted" style="margin:14px 0 0">Le lien de la facture affiche le bouton « Payer ». Le lien Stripe direct mène tout de suite au paiement, pratique par SMS ou WhatsApp.</p>
    </div>`,
  });
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  on("#bi-copy", () => copy(i.url));
  on("#bi-send", async (e) => {
    const b = e.currentTarget; b.disabled = true; b.innerHTML = `<span class="spin"></span>Envoi`;
    try { await api(`/invoices/${i.id}/send`, { method: "POST", body: "{}" }); toast(`Facture envoyée à ${c.email}`); b.textContent = "Renvoyer par email"; }
    catch (err) { toast(err.message); if (mail) { b.outerHTML = `<a class="btn ghost" href="${mail}">Envoyer depuis ma messagerie</a>`; return; } b.textContent = "Envoyer par email"; }
    b.disabled = false;
  });
  on("#bi-stripe", async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { const r = await api(`/invoices/${i.id}/payment-link`, { method: "POST" }); i.payment_link_url = r.url; copy(r.url, "Lien Stripe copié"); b.textContent = "Copier le lien Stripe"; }
    catch (err) { toast(err.message); }
    b.disabled = false;
  });
  on("#bi-edit", () => { close(); openInvoiceEditor({ invoice: i }); });
  const setStatus = async (status, msg) => {
    try { await api(`/invoices/${i.id}/status`, { method: "POST", body: JSON.stringify({ status }) }); toast(msg); close(); loadBilling(); } catch (e) { toast(e.message); }
  };
  on("#bi-paid", async () => { if (await confirmBox(`Marquer la facture ${i.number} comme payée (virement, espèces…) ?`, "Marquer payée")) setStatus("payee", "Facture marquée payée"); });
  on("#bi-cancel", async () => { if (await confirmBox(`Annuler la facture ${i.number} ? Le client ne pourra plus la payer.`, "Annuler la facture")) setStatus("annulee", "Facture annulée"); });
  on("#bi-reopen", () => setStatus("emise", "Facture remise à payer"));
  on("#bi-del", async () => {
    if (!(await confirmBox(`Supprimer définitivement la facture ${i.number} ?`, "Supprimer"))) return;
    try { await api(`/invoices/${i.id}`, { method: "DELETE" }); toast("Facture supprimée"); close(); loadBilling(); } catch (e) { toast(e.message); }
  });
}

/* ---------- Création / modification ---------- */
async function openInvoiceEditor({ lead = null, invoice = null } = {}) {
  if (!BL.settings) { try { BL.settings = await api("/billing/settings"); } catch { BL.settings = { vatRate: 0 }; } }
  const leads = (CRM.leads && CRM.leads.length ? CRM.leads : (await api("/pipeline").catch(() => ({ leads: [] }))).leads) || [];
  if (!CRM.leads.length) CRM.leads = leads;
  const label = (l) => (l ? `${l.company || crmName(l) || ""}${l.company && crmName(l) ? " — " + crmName(l) : ""} #${l.id}` : "");
  if (!lead && invoice && invoice.lead_id) lead = leads.find((l) => l.id === invoice.lead_id) || null;
  const c = invoice ? invoice.client || {} : {
    name: lead ? crmName(lead) : "", company: lead ? lead.company || "" : "", email: lead ? lead.email || "" : "", address: lead && lead.city ? lead.city : "", vat: "",
  };
  const items = invoice ? invoice.items.map((it) => ({ label: it.label, qty: it.qty, unit: it.unit_cents / 100 })) : [{ label: "", qty: 1, unit: "" }];
  const due = new Date(Date.now() + 7 * 864e5);
  bModal({
    title: invoice ? `Modifier la facture ${invoice.number}` : "Nouvelle facture",
    sub: invoice ? "" : "Ton client recevra un lien vers la facture, avec un bouton pour payer par carte.",
    go: invoice ? "Enregistrer" : "Créer la facture", width: 760,
    body: `<div class="field"><label for="bi-lead">Prospect (facultatif)</label><input id="bi-lead" list="bi-leads" placeholder="Rechercher un prospect…" value="${esc(label(lead))}"><datalist id="bi-leads">${leads.map((l) => `<option value="${esc(label(l))}"></option>`).join("")}</datalist></div>
      <div class="bi-2">
        <div class="field"><label for="bi-company">Entreprise du client</label><input id="bi-company" value="${esc(c.company)}"></div>
        <div class="field"><label for="bi-name">Nom du contact</label><input id="bi-name" value="${esc(c.name)}"></div>
        <div class="field"><label for="bi-email">Email</label><input id="bi-email" type="email" value="${esc(c.email)}" placeholder="client@entreprise.fr"></div>
        <div class="field"><label for="bi-vatno">N° TVA du client</label><input id="bi-vatno" value="${esc(c.vat)}" placeholder="Facultatif"></div>
      </div>
      <div class="field"><label for="bi-addr">Adresse</label><textarea id="bi-addr" style="min-height:58px">${esc(c.address)}</textarea></div>
      <div class="field"><label for="bi-title">Objet</label><input id="bi-title" value="${esc(invoice ? invoice.title : "")}" placeholder="Ex. Réceptionniste IA — mise en place et 1er mois"></div>
      <div class="field"><label>Prestations</label>
        <div class="bi-lines" id="bi-lines"></div>
        <button class="btn quiet" type="button" id="bi-add">+ Ajouter une ligne</button>
      </div>
      <div class="bi-3">
        <div class="field"><label for="bi-vat">TVA (%)</label><input id="bi-vat" inputmode="decimal" value="${esc(String(invoice ? invoice.vat_rate : BL.settings.vatRate ?? 0).replace(".", ","))}"></div>
        <div class="field"><label for="bi-issue">Date d'émission</label><input id="bi-issue" type="date" value="${invoice ? isoDay(invoice.issue_date) : isoDay(new Date())}"></div>
        <div class="field"><label for="bi-due">Échéance</label><input id="bi-due" type="date" value="${invoice ? (invoice.due_date ? isoDay(invoice.due_date) : "") : isoDay(due)}"></div>
      </div>
      <div class="bi-total" id="bi-total"></div>
      <div class="field" style="margin-bottom:0"><label for="bi-notes">Note sur la facture</label><textarea id="bi-notes" style="min-height:58px" placeholder="Facultatif">${esc(invoice ? invoice.notes : "")}</textarea></div>`,
    onGo: async () => {
      const l = pick();
      const body = {
        leadId: l ? l.id : null,
        client: { company: $("#bi-company").value, name: $("#bi-name").value, email: $("#bi-email").value, address: $("#bi-addr").value, vat: $("#bi-vatno").value },
        title: $("#bi-title").value, items: readLines(), vatRate: $("#bi-vat").value,
        issueDate: $("#bi-issue").value, dueDate: $("#bi-due").value || null, notes: $("#bi-notes").value,
      };
      const r = invoice
        ? await api(`/invoices/${invoice.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : await api("/invoices", { method: "POST", body: JSON.stringify(body) });
      toast(invoice ? "Facture enregistrée" : `Facture ${r.invoice.number} créée`);
      if (!$("#v-billing").classList.contains("on")) show("billing");
      await loadBilling();
      openInvoice(r.invoice.id);
      return false; // la fenêtre de détail remplace l'éditeur
    },
  });
  function pick() { const m = $("#bi-lead").value.match(/#(\d+)\s*$/); return m ? leads.find((x) => x.id === Number(m[1])) || null : null; }
  function lineRow(it, k) {
    return `<div class="bi-line" data-k="${k}">
      <input class="bi-l" aria-label="Description" placeholder="Description" value="${esc(it.label)}">
      <input class="bi-q" aria-label="Quantité" inputmode="decimal" value="${esc(String(it.qty).replace(".", ","))}">
      <input class="bi-u" aria-label="Prix unitaire HT en euros" inputmode="decimal" placeholder="Prix HT" value="${esc(it.unit === "" ? "" : String(it.unit).replace(".", ","))}">
      <span class="bi-lt num"></span>
      <button class="btn quiet bi-rm" type="button" aria-label="Retirer la ligne">×</button></div>`;
  }
  function draw() {
    $("#bi-lines").innerHTML = `<div class="bi-line bi-h"><span>Description</span><span>Qté</span><span>Prix unitaire HT</span><span>Total HT</span><span></span></div>` + items.map(lineRow).join("");
    $$("#bi-lines .bi-rm").forEach((b) => (b.onclick = () => { sync(); const k = Number(b.closest(".bi-line").dataset.k); if (items.length > 1) { items.splice(k, 1); draw(); } }));
    $$("#bi-lines input").forEach((x) => (x.oninput = recalc));
    recalc();
  }
  function sync() { $$("#bi-lines .bi-line[data-k]").forEach((r) => { const k = Number(r.dataset.k); items[k] = { label: r.querySelector(".bi-l").value, qty: r.querySelector(".bi-q").value, unit: r.querySelector(".bi-u").value }; }); }
  function readLines() { sync(); return items.map((it) => ({ label: it.label, qty: parseNum(it.qty), unit: parseNum(it.unit) })).filter((it) => it.label.trim() && it.qty > 0); }
  function recalc() {
    let sub = 0;
    $$("#bi-lines .bi-line[data-k]").forEach((r) => { const t = Math.round(parseNum(r.querySelector(".bi-q").value) * Math.round(parseNum(r.querySelector(".bi-u").value) * 100)); sub += t; r.querySelector(".bi-lt").textContent = t ? euro(t) : ""; });
    const vat = Math.round(sub * parseNum($("#bi-vat").value) / 100);
    $("#bi-total").innerHTML = `<span>Total HT <b class="num">${euro(sub)}</b></span><span>TVA <b class="num">${euro(vat)}</b></span><span class="tt">Total TTC <b class="num">${euro(sub + vat)}</b></span>`;
  }
  const fill = () => {
    const l = pick(); if (!l) return;
    if (!$("#bi-company").value) $("#bi-company").value = l.company || "";
    if (!$("#bi-name").value) $("#bi-name").value = crmName(l);
    if (!$("#bi-email").value && l.email) $("#bi-email").value = l.email;
    if (!$("#bi-addr").value && l.city) $("#bi-addr").value = l.city;
  };
  $("#bi-lead").addEventListener("change", fill);
  $("#bi-add").onclick = () => { sync(); items.push({ label: "", qty: 1, unit: "" }); draw(); const ls = $$("#bi-lines .bi-l"); ls[ls.length - 1].focus(); };
  $("#bi-vat").oninput = recalc;
  draw();
}

/* ---------- Lien de paiement rapide ---------- */
$("#bl-quick").onclick = () => bModal({
  title: "Lien de paiement", sub: "Un lien Stripe pour un montant précis, sans facture. Ton client paie par carte.", go: "Créer le lien", width: 460,
  body: `<div class="field"><label for="bq-label">Ce que le client paie</label><input id="bq-label" placeholder="Ex. Acompte réceptionniste IA"></div>
    <div class="field" style="margin-bottom:0"><label for="bq-amount">Montant TTC (€)</label><input id="bq-amount" inputmode="decimal" placeholder="490" style="max-width:180px"></div>`,
  onGo: async () => {
    const r = await api("/payment-links", { method: "POST", body: JSON.stringify({ label: $("#bq-label").value, amount: parseNum($("#bq-amount").value) }) });
    copy(r.link.url, "Lien créé et copié");
    loadBilling();
  },
});

$("#bl-new").onclick = () => openInvoiceEditor();

/* ---------- Réglages de facturation ---------- */
$("#bl-settings").onclick = async () => {
  let s;
  try { s = BL.settings = await api("/billing/settings"); } catch (e) { toast(e.message); return; }
  let logo = s.logo;
  const f = (id, lab, val, extra = "") => `<div class="field"><label for="bs-${id}">${lab}</label><input id="bs-${id}" value="${esc(val ?? "")}" ${extra}></div>`;
  bModal({
    title: "Réglages de facturation", sub: "Ce qui apparaît sur chaque facture. Les mentions légales dépendent de ta société : vérifie-les avec ton comptable.", width: 720,
    body: `<div class="bs-logo"><div class="bs-prev" id="bs-prev"></div><div><label class="btn ghost" for="bs-file">Changer le logo</label><input type="file" id="bs-file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden>
        <button class="btn quiet" type="button" id="bs-reset">Logo Biznify par défaut</button><div class="hint small muted">PNG, JPG, WebP ou SVG, moins de 500 Ko.</div></div></div>
      <div class="bi-2">
        ${f("company", "Nom de la société", s.company)}${f("tagline", "Accroche sous le logo", s.tagline, 'placeholder="Facultatif"')}
        ${f("email", "Email", s.email)}${f("phone", "Téléphone", s.phone)}
        ${f("website", "Site web", s.website)}${f("vatNumber", "N° TVA", s.vatNumber, 'placeholder="Facultatif"')}
      </div>
      <div class="field"><label for="bs-address">Adresse</label><textarea id="bs-address" style="min-height:58px">${esc(s.address)}</textarea></div>
      ${f("registration", "Immatriculation", s.registration)}
      <div class="bi-3">
        ${f("vatRate", "TVA par défaut (%)", String(s.vatRate).replace(".", ","), 'inputmode="decimal"')}
        ${f("prefix", "Préfixe des numéros", s.prefix, 'maxlength="8"')}
        <div class="field"><label for="bs-accent">Couleur</label><input id="bs-accent" type="color" value="${esc(s.accent)}" style="height:38px;padding:4px"></div>
      </div>
      ${f("vatMention", "Mention TVA", s.vatMention, 'placeholder="Ex. TVA non applicable, ou autoliquidation"')}
      <div class="field"><label for="bs-paymentTerms">Conditions de paiement</label><textarea id="bs-paymentTerms" style="min-height:58px">${esc(s.paymentTerms)}</textarea></div>
      <div class="field" style="margin-bottom:0"><label for="bs-footer">Pied de page</label><input id="bs-footer" value="${esc(s.footer)}" placeholder="Facultatif"></div>`,
    onGo: async () => {
      const body = { logo };
      ["company", "tagline", "email", "phone", "website", "vatNumber", "address", "registration", "prefix", "vatMention", "paymentTerms", "footer", "accent"].forEach((k) => (body[k] = $("#bs-" + k).value.trim()));
      body.vatRate = parseNum($("#bs-vatRate").value);
      BL.settings = await api("/billing/settings", { method: "PUT", body: JSON.stringify(body) });
      toast("Réglages de facturation enregistrés");
    },
  });
  const prev = () => { const src = logo || s.defaultLogo; $("#bs-prev").innerHTML = src ? `<img src="${src}" alt="Logo">` : `<span class="muted small">Aucun logo</span>`; };
  prev();
  $("#bs-reset").onclick = () => { logo = null; prev(); };
  $("#bs-file").onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (file.size > 500 * 1024) { toast("Logo trop lourd (500 Ko max)"); return; }
    const rd = new FileReader(); rd.onload = () => { logo = rd.result; prev(); }; rd.readAsDataURL(file);
  };
};

/* ---------- Connexion Stripe ---------- */
function openStripeConnect(forceNew) {
  const st = forceNew === true ? { enabled: false } : (window.BL_STRIPE || {});
  const fromRailway = st.source === "railway";
  if (st.enabled) {
    bModal({ title: "Stripe", cancel: "Fermer", width: 520, body: `
      <div class="stc-ok"><span class="dot-ok"></span><div><b>${esc((st.account && st.account.name) || "Compte Stripe")} est connecté</b><p class="small muted" style="margin:2px 0 0">Mode ${st.mode === "live" ? "réel (live)" : "test"}${st.account && st.account.id ? ` · ${esc(st.account.id)}` : ""}${fromRailway ? " · clé dans Railway" : ""}</p></div></div>
      ${st.account && st.account.charges === false ? `<div class="callout" style="margin-top:12px"><div class="grow"><b>Ton compte Stripe n'accepte pas encore de paiements.</b><p>Termine l'activation du compte dans Stripe (identité, IBAN).</p></div></div>` : ""}
      <p class="small muted" style="margin:14px 0 0">Les paiements arrivent dans l'app tout seuls : la facture passe en « Payée » et le prospect en « Client signé ».</p>
      <div class="stc-pk ${st.inPage ? "on" : ""}">
        <b>${st.inPage ? "Paiement directement sur la facture : activé" : "Faire payer directement sur la page de la facture"}</b>
        <p class="small muted" style="margin:4px 0 8px">${st.inPage ? "Ton client tape sa carte sans quitter la facture." : `Colle ta <b>clé publiable</b> (pk_${st.mode === "live" ? "live" : "test"}_…), visible sur ta page de clés Stripe. Sans elle, le client passe par la page Stripe puis revient sur la facture.`}</p>
        ${st.inPage ? "" : `<div style="display:flex;gap:8px"><input id="stc-pk" class="grow" autocomplete="off" spellcheck="false" placeholder="pk_${st.mode === "live" ? "live" : "test"}_…" aria-label="Clé publiable Stripe" style="flex:1"><button class="btn primary" id="stc-pk-save">Activer</button></div><div id="stc-pk-err" class="small c-bad" role="alert" style="min-height:16px;margin-top:6px"></div>`}
      </div>
      ${fromRailway ? "" : `<div style="display:flex;gap:8px;margin-top:16px"><button class="btn ghost" id="stc-change">Changer de clé</button><button class="btn quiet" id="stc-off">Déconnecter</button></div>`}` });
    const ch = $("#stc-change"); if (ch) ch.onclick = () => openStripeConnect(true);
    const pkb = $("#stc-pk-save"); if (pkb) pkb.onclick = async () => {
      pkb.disabled = true;
      try { const r = await api("/stripe/publishable", { method: "POST", body: JSON.stringify({ publishableKey: $("#stc-pk").value.trim() }) }); window.BL_STRIPE = r.stripe; toast("Paiement sur la facture activé"); openStripeConnect(); loadBilling(); }
      catch (e) { $("#stc-pk-err").textContent = e.message; pkb.disabled = false; }
    };
    const off = $("#stc-off"); if (off) off.onclick = async () => {
      if (!(await confirmBox("Déconnecter Stripe ? Le bouton « Payer » de tes factures ne marchera plus."))) return;
      try { await api("/stripe/disconnect", { method: "POST", body: "{}" }); toast("Stripe déconnecté"); $("#bm").classList.remove("on"); loadBilling(); } catch (e) { toast(e.message); }
    };
    return;
  }
  bModal({ title: "Connecter Stripe", sub: "Une seule fois.", go: "Connecter Stripe", width: 560, body: `
    <ol class="stc-steps">
      <li><b>Crée une clé pour Biznify dans Stripe</b><br><a class="btn primary" style="margin-top:8px" href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener">Ouvrir mes clés Stripe</a>
        <p class="small muted" style="margin:8px 0 0">Clique sur « Créer une clé restreinte », choisis « Fournir cette clé à un autre site web », nom : <b>Biznify</b>, site : <b>admin.biznify.pro</b>, puis crée la clé avec toutes les autorisations. Ta clé secrète (sk_live_…) marche aussi.</p></li>
      <li><b>Colle la clé ici</b>
        <div class="field" style="margin:8px 0 0"><input id="stc-key" type="password" autocomplete="off" spellcheck="false" placeholder="rk_live_… ou sk_live_…" aria-label="Clé Stripe"></div>
        <p class="small muted" style="margin:6px 0 0">Elle est vérifiée, puis enregistrée chiffrée. Biznify crée tout seul la connexion qui marque tes factures comme payées.</p></li>
      <li><b>Colle ta clé publiable</b> <span class="small muted">(pk_live_…, sur la même page Stripe)</span>
        <div class="field" style="margin:8px 0 0"><input id="stc-pk0" autocomplete="off" spellcheck="false" placeholder="pk_live_…" aria-label="Clé publiable Stripe"></div>
        <p class="small muted" style="margin:6px 0 0">Elle permet à ton client de payer directement sur la page de la facture.</p></li>
    </ol>
    <div id="stc-err" class="small c-bad" role="alert" style="min-height:18px;margin-top:6px"></div>`,
    onGo: async () => {
      const key = $("#stc-key").value.trim();
      if (!key) { $("#stc-err").textContent = "Colle ta clé Stripe"; return false; }
      try {
        const r = await api("/stripe/connect", { method: "POST", body: JSON.stringify({ key, publishableKey: $("#stc-pk0").value.trim() || undefined }) });
        window.BL_STRIPE = r.stripe; toast(`Stripe connecté${r.stripe.account ? " : " + r.stripe.account.name : ""}`); loadBilling();
      } catch (e) { $("#stc-err").textContent = e.message; return false; }
    } });
}
