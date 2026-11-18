/* Biznify — Notifications email (Réglages) */
const NT_ITEMS = {
  owner: [
    ["booking", "Nouveau RDV réservé", "Dès qu'un prospect réserve sur une de tes pages de réservation."],
    ["change", "RDV déplacé ou annulé", "Quand un prospect déplace ou annule lui-même son RDV."],
    ["payment", "Paiement reçu", "Dès qu'une facture est payée."],
    ["reply_sms", "Réponse d'un prospect par SMS", "Avec le texte du message."],
    ["reply_email", "Réponse d'un prospect par email", "Souvent inutile : la réponse arrive déjà dans ta boîte mail."],
    ["digest", "Ta journée, chaque matin", "Tes RDV des prochaines 24 h, tes tâches, tes factures en retard et ton encaissé du mois."],
  ],
  client: [
    ["booking_confirm", "Confirmation de RDV", "Récapitulatif, bouton pour rejoindre la visio, ajout à l'agenda, lien pour déplacer ou annuler."],
    ["booking_change", "RDV déplacé ou annulé", "Confirme le nouveau créneau, ou propose d'en reprendre un."],
    ["payment_receipt", "Reçu de paiement", "Remercie le client et lui donne le lien de sa facture."],
  ],
};

async function loadNotifications() {
  let r;
  try { r = await api("/notifications"); } catch (e) { $("#nt-body").innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  const s = r.settings, st = r.status;
  $("#nt-status").textContent = st.ready ? (st.via === "resend" ? `Envoi depuis ${st.from} (Resend)` : `Envoi depuis ${st.from} (Gmail)`) : "Envoi non configuré";
  const row = (grp, [k, t, d]) => `<div class="toggle"><div><b>${esc(t)}</b><p>${esc(d)}</p></div><label class="switch"><input type="checkbox" data-g="${grp}" data-k="${k}" ${s[grp][k] ? "checked" : ""} aria-label="${esc(t)}"><span></span></label></div>`;
  $("#nt-body").innerHTML = `
    ${!st.ready || st.via !== "resend" ? `<div class="callout" style="margin-bottom:16px"><div class="grow"><b>${st.ready ? "Tes emails partent de ton Gmail pour l'instant." : "Les emails ne partent pas encore."}</b><p>Branche Resend pour qu'ils partent de contact@biznify.pro : ajoute <code>RESEND_API_KEY</code> dans Railway.</p></div></div>` : ""}
    <div class="nt-grid">
      <div>
        <h3 class="nt-h">Pour toi</h3>
        <div class="field"><label for="nt-owner">Recevoir mes notifications sur</label><input id="nt-owner" type="email" value="${esc(s.owner_email || "")}" placeholder="${esc(r.owner || "ton@email.com")}"></div>
        ${NT_ITEMS.owner.map((x) => row("owner", x)).join("")}
        <div class="field nt-hour"><label for="nt-hour">Heure du résumé du matin (ton heure locale)</label><select id="nt-hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${s.digest_hour === h ? "selected" : ""}>${String(h).padStart(2, "0")}:00</option>`).join("")}</select></div>
      </div>
      <div>
        <h3 class="nt-h">Pour tes prospects et clients</h3>
        <p class="small muted" style="margin:0 0 6px">Aux couleurs de Biznify : logo, bleu Biznify, bouton d'action, mentions en pied de page.</p>
        ${NT_ITEMS.client.map((x) => row("client", x)).join("")}
        <p class="small muted" style="margin:14px 0 0">Les emails de tes automatisations (rappels, relances, onboarding) prennent aussi ce design. Les emails que tu écris à la main dans Conversations restent simples, comme un vrai email perso.</p>
      </div>
    </div>
    <div class="nt-tests"><span class="small muted">M'envoyer un exemple :</span>
      <button class="btn quiet" data-test="client_booking">Confirmation de RDV</button>
      <button class="btn quiet" data-test="invoice">Facture</button>
      <button class="btn quiet" data-test="owner_booking">Alerte nouveau RDV</button>
      <button class="btn quiet" data-test="digest">Résumé du matin</button>
    </div>`;
  const save = async (patch) => { try { await api("/notifications", { method: "PUT", body: JSON.stringify(patch) }); toast("Notifications enregistrées"); } catch (e) { toast(e.message); } };
  $$("#nt-body [data-g]").forEach((c) => (c.onchange = () => save({ [c.dataset.g]: { [c.dataset.k]: c.checked } })));
  $("#nt-owner").onchange = (e) => save({ owner_email: e.target.value.trim() });
  $("#nt-hour").onchange = (e) => save({ digest_hour: Number(e.target.value) });
  $$("#nt-body [data-test]").forEach((b) => (b.onclick = async () => {
    b.disabled = true; const lab = b.textContent; b.innerHTML = `<span class="spin"></span>${esc(lab)}`;
    try { const r = await api("/notifications/test", { method: "POST", body: JSON.stringify({ kind: b.dataset.test }) }); toast(`Exemple envoyé à ${r.to}`); } catch (e) { toast(e.message); }
    b.disabled = false; b.textContent = lab;
  }));
}
