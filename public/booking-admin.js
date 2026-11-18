/* Biznify — Calendriers de réservation (onglet Agenda) */
window.BC = { list: [], defaultHours: null };
const BC_DAYS = [["1", "Lundi"], ["2", "Mardi"], ["3", "Mercredi"], ["4", "Jeudi"], ["5", "Vendredi"], ["6", "Samedi"], ["7", "Dimanche"]];
const bcDur = (m) => (m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min`);

async function loadBookingCalendars() {
  try { const r = await api("/booking/calendars"); BC.list = r.calendars; BC.defaultHours = r.defaultHours; } catch (e) { $("#bc-list").innerHTML = `<div class="panel-b muted">${esc(e.message)}</div>`; return; }
  renderBookingCalendars();
}

function hoursSummary(h) {
  const open = BC_DAYS.filter(([d]) => (h[d] || []).length);
  if (!open.length) return "Aucune disponibilité";
  const same = open.every(([d]) => JSON.stringify(h[d]) === JSON.stringify(h[open[0][0]]));
  const ranges = (h[open[0][0]] || []).map(([a, b]) => `${a}–${b}`).join(", ");
  const days = open.length === 5 && open[0][0] === "1" && open[4][0] === "5" ? "Lun–ven" : open.length === 6 && open[0][0] === "1" && open[5][0] === "6" ? "Lun–sam" : open.map(([, n]) => n.slice(0, 3)).join(", ");
  return same ? `${days}, ${ranges}` : `${days} (horaires variables)`;
}

function renderBookingCalendars() {
  if (!BC.list.length) {
    $("#bc-list").innerHTML = `<div class="panel-b muted">Pas encore de calendrier. Crée une page de réservation que tes prospects utilisent pour choisir un créneau eux-mêmes.</div>`;
    return;
  }
  $("#bc-list").innerHTML = `<div class="bc-cards">${BC.list.map((c) => `<div class="bc-card ${c.active ? "" : "off"}">
      <div class="bc-top"><span class="bc-dot" style="background:${esc(c.color)}"></span><b>${esc(c.name)}</b>${c.active ? "" : `<span class="badge">Désactivé</span>`}</div>
      <div class="small muted">${bcDur(c.duration_min)}${c.meet ? " · Google Meet" : ""} · ${esc(hoursSummary(c.hours))}</div>
      <div class="small muted">${c.upcoming} RDV à venir · ${c.total} au total</div>
      <div class="bc-url"><input readonly value="${esc(c.url)}" aria-label="Lien de réservation ${esc(c.name)}"></div>
      <div class="bc-act"><button class="btn ghost" data-copy="${esc(c.url)}">Copier le lien</button><a class="btn quiet" href="${esc(c.url)}" target="_blank" rel="noopener">Voir la page</a><button class="btn quiet" data-edit="${c.id}">Modifier</button></div>
    </div>`).join("")}</div>`;
  $$("#bc-list [data-copy]").forEach((b) => (b.onclick = () => copy(b.dataset.copy, "Lien de réservation copié")));
  $$("#bc-list [data-edit]").forEach((b) => (b.onclick = () => openCalendarEditor(BC.list.find((c) => c.id === Number(b.dataset.edit)))));
}

function openCalendarEditor(c) {
  const isNew = !c;
  c = c || { name: "", slug: "", description: "", duration_min: 30, interval_min: 30, buffer_min: 0, notice_hours: 2, days_ahead: 30, max_per_day: null, hours: BC.defaultHours, color: "#1877F2", meet: true, active: true, event_title: "", thanks: "", consent: "J'accepte que Biznify me contacte par email, SMS ou téléphone au sujet de ma demande. Je peux me désinscrire à tout moment (STOP par SMS)." };
  const hours = JSON.parse(JSON.stringify(c.hours || BC.defaultHours || {}));
  const num = (id, lab, v, extra = "") => `<div class="field"><label for="bce-${id}">${lab}</label><input id="bce-${id}" type="number" min="0" value="${v ?? ""}" ${extra}></div>`;
  const close = bModal({
    title: isNew ? "Nouveau calendrier de réservation" : `Modifier « ${c.name} »`, sub: "Tes prospects choisissent eux-mêmes un créneau libre. Les créneaux déjà pris dans ton Google Agenda sont masqués automatiquement.", width: 780,
    go: isNew ? "Créer le calendrier" : "Enregistrer",
    body: `<div class="bi-2">
        <div class="field"><label for="bce-name">Nom</label><input id="bce-name" value="${esc(c.name)}" placeholder="Ex. Appel découverte"></div>
        <div class="field"><label for="bce-slug">Lien</label><div class="bce-slug"><span>/r/</span><input id="bce-slug" value="${esc(c.slug)}" placeholder="appel-decouverte"></div></div>
      </div>
      <div class="field"><label for="bce-desc">Description (affichée au prospect)</label><textarea id="bce-desc" style="min-height:64px">${esc(c.description || "")}</textarea></div>
      <div class="bce-grid">
        ${num("dur", "Durée (min)", c.duration_min, 'step="5"')}
        ${num("int", "Un créneau toutes les (min)", c.interval_min, 'step="5"')}
        ${num("buf", "Pause entre 2 RDV (min)", c.buffer_min, 'step="5"')}
        ${num("notice", "Réservable au plus tôt dans (h)", c.notice_hours)}
        ${num("ahead", "Réservable jusqu'à (jours)", c.days_ahead)}
        ${num("max", "RDV max par jour", c.max_per_day || "", 'placeholder="Illimité"')}
      </div>
      <div class="field"><label>Disponibilités (heure de Paris)</label>
        <div class="bce-hours" id="bce-hours"></div></div>
      <div class="bi-2">
        <div class="field"><label for="bce-title">Titre de l'événement dans ton agenda</label><input id="bce-title" value="${esc(c.event_title || "")}" placeholder="${esc((c.name || "RDV") + " · {nom}")}"></div>
        <div class="field"><label for="bce-color">Couleur</label><input id="bce-color" type="color" value="${esc(c.color)}" style="height:38px;padding:4px"></div>
      </div>
      <div class="field"><label for="bce-thanks">Message après la réservation</label><textarea id="bce-thanks" style="min-height:58px">${esc(c.thanks || "")}</textarea></div>
      <div class="field"><label for="bce-consent">Case d'accord à cocher (vide = pas de case)</label><textarea id="bce-consent" style="min-height:58px">${esc(c.consent || "")}</textarea></div>
      <label class="au-opt"><input type="checkbox" id="bce-meet" ${c.meet ? "checked" : ""}> Créer un lien Google Meet pour chaque RDV</label>
      <label class="au-opt"><input type="checkbox" id="bce-active" ${c.active ? "checked" : ""}> Page de réservation en ligne</label>
      ${isNew ? "" : `<div class="au-danger"><span></span><button class="btn quiet bl-del" id="bce-del">Supprimer le calendrier</button></div>`}`,
    onGo: async () => {
      readHours();
      const body = {
        name: $("#bce-name").value.trim(), slug: $("#bce-slug").value.trim() || $("#bce-name").value, description: $("#bce-desc").value.trim(),
        duration_min: $("#bce-dur").value, interval_min: $("#bce-int").value, buffer_min: $("#bce-buf").value, notice_hours: $("#bce-notice").value,
        days_ahead: $("#bce-ahead").value, max_per_day: $("#bce-max").value || null, hours, color: $("#bce-color").value,
        event_title: $("#bce-title").value.trim(), thanks: $("#bce-thanks").value.trim(), consent: $("#bce-consent").value.trim(),
        meet: $("#bce-meet").checked, active: $("#bce-active").checked,
      };
      if (!body.name) { toast("Donne un nom au calendrier"); return false; }
      const r = isNew ? await api("/booking/calendars", { method: "POST", body: JSON.stringify(body) }) : await api(`/booking/calendars/${c.id}`, { method: "PUT", body: JSON.stringify(body) });
      toast(isNew ? "Calendrier créé" : "Calendrier enregistré");
      if (isNew) copy(r.calendar.url, "Calendrier créé, lien copié");
      AU.meta = null; loadBookingCalendars();
    },
  });
  function drawHours() {
    $("#bce-hours").innerHTML = BC_DAYS.map(([d, n]) => {
      const r = hours[d] || [];
      return `<div class="bce-day" data-d="${d}"><label class="au-opt" style="margin:0;min-width:120px"><input type="checkbox" data-on ${r.length ? "checked" : ""}> ${n}</label>
        <div class="bce-ranges">${r.length ? r.map(([a, b], i) => `<span class="bce-range" data-i="${i}"><input type="time" value="${a}" data-a aria-label="${n} début"><span>–</span><input type="time" value="${b}" data-b aria-label="${n} fin"><button class="btn quiet" type="button" data-rmr aria-label="Retirer cette plage">×</button></span>`).join("") + `<button class="btn quiet" type="button" data-addr>+ plage</button>` : `<span class="small muted">Indisponible</span>`}</div></div>`;
    }).join("");
    $$("#bce-hours .bce-day").forEach((row) => {
      const d = row.dataset.d;
      row.querySelector("[data-on]").onchange = (e) => { readHours(); hours[d] = e.target.checked ? [["09:00", "12:00"], ["14:00", "18:00"]] : []; drawHours(); };
      row.querySelectorAll("[data-rmr]").forEach((b) => (b.onclick = () => { readHours(); hours[d].splice(Number(b.closest(".bce-range").dataset.i), 1); drawHours(); }));
      const add = row.querySelector("[data-addr]"); if (add) add.onclick = () => { readHours(); const last = (hours[d] || []).slice(-1)[0]; hours[d].push([last ? last[1] : "09:00", "18:00"]); drawHours(); };
    });
  }
  function readHours() {
    $$("#bce-hours .bce-day").forEach((row) => {
      const d = row.dataset.d;
      if (!row.querySelector("[data-on]").checked) { hours[d] = []; return; }
      hours[d] = [...row.querySelectorAll(".bce-range")].map((r) => [r.querySelector("[data-a]").value, r.querySelector("[data-b]").value]).filter(([a, b]) => a && b);
    });
  }
  drawHours();
  $("#bce-name").addEventListener("input", (e) => { if (isNew && !$("#bce-slug").dataset.edited) $("#bce-slug").value = e.target.value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); });
  $("#bce-slug").addEventListener("input", (e) => (e.target.dataset.edited = "1"));
  const del = $("#bce-del"); if (del) del.onclick = async () => {
    if (!(await confirmBox(`Supprimer le calendrier « ${c.name} » ? Son lien de réservation ne marchera plus. Les RDV déjà pris restent dans ton agenda.`, "Supprimer"))) return;
    await api(`/booking/calendars/${c.id}`, { method: "DELETE" }); toast("Calendrier supprimé"); close(); loadBookingCalendars();
  };
}

$("#bc-new").onclick = () => openCalendarEditor(null);
setTimeout(() => api("/booking/calendars").then((r) => { BC.list = r.calendars; BC.defaultHours = r.defaultHours; }).catch(() => {}), 1500);
