/* Biznify — Vidéos (façon Loom) : écran + caméra, bulle flottante, envoi en direct, lien de partage, suivi des vues */
const VD = {
  init: false, mode: "screen-cam", phase: "idle", // idle | ready | countdown | rec | finishing | done
  prev: null, screen: null, actx: null, meterRaf: null, mixCtx: null,
  rec: null, mime: "", video: null, created: null, blobs: [], sent: 0, offset: 0, queue: Promise.resolve(), upErr: null, discard: false,
  t0: 0, acc: 0, paused: false, timer: null, pip: null, thumb: null, leads: [], list: [], defaultCta: null, listTimer: null,
};
const VD_MAX_MIN = 60;
const canScreen = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
const needsCam = () => VD.mode !== "screen";
const needsScreen = () => VD.mode !== "cam";
const vdStore = (k, v) => { try { if (v === undefined) return localStorage.getItem("vd-" + k); localStorage.setItem("vd-" + k, v); } catch {} };
const fmtClock = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const fmtSize = (b) => b >= 1e9 ? (b / 1e9).toFixed(1).replace(".", ",") + " Go" : b >= 1e6 ? Math.round(b / 1e6) + " Mo" : Math.max(1, Math.round(b / 1e3)) + " Ko";
// Chrome/Edge : on incruste la bulle caméra directement dans la vidéo (dans un worker, qui tourne même onglet caché)
const canCompose = () => !!(window.MediaStreamTrackProcessor && window.MediaStreamTrackGenerator && window.OffscreenCanvas && window.VideoFrame && window.Worker);
const elapsed = () => VD.acc + (VD.paused || !VD.t0 ? 0 : Date.now() - VD.t0);

/* ---------- Ouverture de la vue ---------- */
async function loadVideos() {
  if (!VD.init) vdInit();
  loadVideoList();
  clearInterval(VD.listTimer);
  VD.listTimer = setInterval(() => { if (!document.hidden && $("#v-videos").classList.contains("on")) loadVideoList(); }, 30000);
  if (VD.phase === "idle") startPreview();
}
// en quittant la vue : on coupe la caméra et le micro, sauf pendant un enregistrement
function vdLeave() {
  clearInterval(VD.listTimer);
  if (VD.phase === "idle" || VD.phase === "done") stopPreview();
}

function vdInit() {
  VD.init = true;
  if (!canScreen()) {
    $$("#vd-mode button").forEach((b) => { if (b.dataset.m !== "cam") b.hidden = true; });
    VD.mode = "cam";
    $("#vd-sys-f").hidden = true;
  } else {
    const m = vdStore("mode"); if (["screen-cam", "screen", "cam"].includes(m)) VD.mode = m;
  }
  $$("#vd-mode button").forEach((b) => b.classList.toggle("on", b.dataset.m === VD.mode));
  $("#vd-mode").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b || VD.phase !== "idle") return;
    VD.mode = b.dataset.m; vdStore("mode", VD.mode);
    $$("#vd-mode button").forEach((x) => x.classList.toggle("on", x === b));
    startPreview();
  });
  $("#vd-cam-sel").onchange = (e) => { vdStore("cam", e.target.value); startPreview(); };
  $("#vd-mic-sel").onchange = (e) => { vdStore("mic", e.target.value); startPreview(); };
  $("#vd-sys").checked = vdStore("sys") !== "0";
  $("#vd-sys").onchange = (e) => vdStore("sys", e.target.checked ? "1" : "0");
  $("#vd-cta-l").value = vdStore("cta-l") || "";
  $("#vd-cta-u").value = vdStore("cta-u") || "";
  $("#vd-start").onclick = onStart;
  $("#vd-launch").onclick = () => launch(true);
  $("#vd-abort").onclick = () => resetRecorder();
  $("#vd-pause").onclick = togglePause;
  $("#vd-stop").onclick = stopRecording;
  $("#vd-cancel").onclick = cancelRecording;
  $("#vd-list").addEventListener("click", onListClick);
  window.addEventListener("beforeunload", (e) => {
    if (["rec", "countdown", "finishing"].includes(VD.phase)) { e.preventDefault(); e.returnValue = ""; }
  });
  api("/videos/leads").then((r) => {
    VD.leads = r.leads || [];
    $("#vd-leads").innerHTML = VD.leads.map((l) => `<option value="${esc(leadLabel(l))}"></option>`).join("");
  }).catch(() => {});
}
const leadLabel = (l) => `${l.name || "Sans nom"}${l.company && l.company !== l.name ? " — " + l.company : ""} #${l.id}`;
function pickedLead() {
  const m = /#(\d+)\s*$/.exec($("#vd-lead").value);
  return m ? VD.leads.find((l) => l.id === Number(m[1])) || null : null;
}

/* ---------- Aperçu caméra + micro ---------- */
function setStage() {
  const st = $("#vd-stage");
  st.classList.toggle("cam-only", VD.mode === "cam");
  st.classList.toggle("no-cam", !needsCam());
  $("#vd-cam-f").hidden = !needsCam();
  $("#vd-sys-f").hidden = !needsScreen();
  $("#vd-hint").textContent = VD.mode !== "screen-cam" ? "" : canCompose() ? "Ta bulle caméra est ajoutée dans la vidéo, en bas à gauche, quel que soit l'écran, la fenêtre ou l'onglet partagé." : "Astuce : partage ton « Écran entier » pour que ta bulle apparaisse dans la vidéo.";
}
function stopTracks(s) { if (s) s.getTracks().forEach((t) => t.stop()); }
function stopPreview() {
  stopTracks(VD.prev); VD.prev = null;
  cancelAnimationFrame(VD.meterRaf);
  if (VD.actx) { VD.actx.close().catch(() => {}); VD.actx = null; }
  VD.level = null;
  $("#vd-cam").srcObject = null;
}
async function startPreview() {
  setStage();
  $("#vd-err").textContent = "";
  stopPreview();
  const camId = vdStore("cam"), micId = vdStore("mic");
  const want = {
    audio: { deviceId: micId ? { ideal: micId } : undefined, echoCancellation: true, noiseSuppression: true },
    video: needsCam() ? { deviceId: camId ? { ideal: camId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } : false,
  };
  try {
    VD.prev = await navigator.mediaDevices.getUserMedia(want);
  } catch (e) {
    // pas de caméra ? on garde au moins le micro
    try { if (want.video) { VD.prev = await navigator.mediaDevices.getUserMedia({ audio: want.audio }); $("#vd-err").textContent = "Caméra introuvable ou refusée : l'enregistrement se fera sans ta bulle."; } else throw e; }
    catch (e2) { $("#vd-err").textContent = permMsg(e2); return; }
  }
  if (!$("#v-videos").classList.contains("on") && VD.phase === "idle") { stopPreview(); return; }
  const v = $("#vd-cam"); v.srcObject = VD.prev.getVideoTracks().length ? VD.prev : null; v.play().catch(() => {});
  meter();
  fillDevices();
}
function permMsg(e) {
  if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) return "Autorise l'accès au micro et à la caméra (icône à gauche de l'adresse dans ton navigateur), puis recharge la page.";
  if (e && e.name === "NotFoundError") return "Aucun micro détecté. Branche un micro ou un casque.";
  return "Micro ou caméra indisponible : " + ((e && e.message) || "erreur inconnue");
}
async function fillDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const cur = (kind) => { const t = VD.prev && VD.prev.getTracks().find((x) => x.kind === kind); return t ? t.getSettings().deviceId : ""; };
    const fill = (sel, kind, label) => {
      const list = all.filter((d) => d.kind === kind);
      const c = cur(kind === "videoinput" ? "video" : "audio");
      $(sel).innerHTML = list.map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === c ? "selected" : ""}>${esc(d.label || `${label} ${i + 1}`)}</option>`).join("") || `<option value="">Aucun</option>`;
    };
    fill("#vd-cam-sel", "videoinput", "Caméra");
    fill("#vd-mic-sel", "audioinput", "Micro");
  } catch {}
}
function meter() {
  const t = VD.prev && VD.prev.getAudioTracks()[0];
  if (!t) return;
  try {
    VD.actx = new (window.AudioContext || window.webkitAudioContext)();
    const an = VD.actx.createAnalyser(); an.fftSize = 512;
    VD.actx.createMediaStreamSource(new MediaStream([t])).connect(an);
    const buf = new Uint8Array(an.fftSize);
    VD.level = () => {
      an.getByteTimeDomainData(buf);
      let peak = 0; for (const x of buf) peak = Math.max(peak, Math.abs(x - 128));
      return Math.min(100, Math.round((peak / 128) * 160)) + "%";
    };
    const loop = () => { $("#vd-meter").style.width = VD.level(); VD.meterRaf = requestAnimationFrame(loop); };
    loop();
  } catch {}
}

/* ---------- Démarrage ---------- */
async function onStart() {
  $("#vd-err").textContent = "";
  if (!VD.prev || !VD.prev.getAudioTracks().length) { await startPreview(); if (!VD.prev) return; }
  if (needsScreen()) {
    try {
      VD.screen = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 } },
        audio: $("#vd-sys").checked ? { echoCancellation: false, noiseSuppression: false } : false,
        selfBrowserSurface: "exclude", surfaceSwitching: "include", systemAudio: "include", monitorTypeSurfaces: "include",
      });
    } catch (e) {
      if (e && e.name !== "NotAllowedError") $("#vd-err").textContent = "Partage d'écran impossible : " + e.message;
      return;
    }
    const sv = $("#vd-screen"); sv.srcObject = VD.screen; sv.hidden = false; sv.play().catch(() => {});
    $("#vd-screen-ph").hidden = true;
    // « Arrêter le partage » dans la barre du navigateur = fin de l'enregistrement
    VD.screen.getVideoTracks()[0].addEventListener("ended", () => {
      if (VD.phase === "rec") stopRecording();
      else if (VD.phase === "ready" || VD.phase === "countdown") resetRecorder();
    });
  }
  if (VD.mode === "screen-cam" && VD.prev.getVideoTracks().length) {
    // la bulle a besoin d'un clic : on tente tout de suite, sinon on demande « Lancer »
    if (await openBubble()) return launch(false);
    VD.phase = "ready"; showPane("ready");
    $("#vd-ready-txt").textContent = "Clique sur Lancer : ta bulle caméra s'affiche par-dessus tes fenêtres, puis le compte à rebours démarre.";
    return;
  }
  launch(false);
}
async function launch(fromClick) {
  if (fromClick && VD.mode === "screen-cam" && !VD.pip) await openBubble();
  countdown();
}
function showPane(p) {
  $("#vd-setup").hidden = p !== "setup" && p !== "countdown";
  $("#vd-ready").hidden = p !== "ready";
  $("#vd-live").hidden = p !== "live";
  $("#vd-done").hidden = p !== "done";
  $("#vd-mode").style.display = p === "setup" ? "" : "none";
  $$("#vd-setup .field, #vd-setup .vd-more, #vd-setup .vd-go").forEach((x) => { x.style.display = p === "setup" ? "" : "none"; });
  $("#vd-rec-title").textContent = p === "live" ? "Enregistrement en cours" : p === "done" ? "Ta vidéo" : p === "ready" ? "Prêt à enregistrer" : "Nouvel enregistrement";
  $("#vd-rec-sub").textContent = p === "live" ? "Le lien sera prêt juste après la fin" : p === "done" ? "" : p === "ready" ? "Écran choisi" : "Choisis ce que tu veux filmer";
}

function countdown() {
  VD.phase = "countdown"; showPane("countdown");
  let n = 3;
  const el = $("#vd-count");
  const paint = () => {
    el.hidden = false; el.textContent = n;
    if (VD.pip) { const c = VD.pip.document.getElementById("cd"); if (c) { c.hidden = false; c.textContent = n; } }
  };
  paint();
  const t = setInterval(() => {
    if (VD.phase !== "countdown") { clearInterval(t); el.hidden = true; return; }
    n--;
    if (n > 0) return paint();
    clearInterval(t); el.hidden = true;
    if (VD.pip) { const c = VD.pip.document.getElementById("cd"); if (c) c.hidden = true; }
    beginRecording();
  }, 1000);
}

/* ---------- Bulle caméra flottante (au-dessus de toutes les fenêtres) ---------- */
async function openBubble() {
  const cam = VD.prev && VD.prev.getVideoTracks().length ? VD.prev : null;
  if (!cam) return false;
  if (window.documentPictureInPicture) {
    try {
      const ctrl = canCompose(); // la bulle est déjà dans la vidéo : la fenêtre flottante ne garde que les boutons (sinon double bulle)
      const w = await documentPictureInPicture.requestWindow(ctrl ? { width: 330, height: 64 } : { width: 260, height: 330 });
      w.document.head.innerHTML = `<meta charset="utf-8"><title>Biznify</title><style>
        html,body{margin:0;height:100%;background:#0B1220;color:#fff;font:600 13px Inter,system-ui,sans-serif;overflow:hidden}
        .w{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:10px}
        .b{position:relative;width:min(220px,calc(100vh - 90px),calc(100vw - 20px));aspect-ratio:1;border-radius:50%;overflow:hidden;border:3px solid #fff;box-shadow:0 8px 24px rgba(0,0,0,.4)}
        video{width:100%;height:100%;object-fit:cover;transform:scaleX(-1);display:block}
        #cd{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(11,18,32,.55);font-size:72px}
        .bar{display:flex;align-items:center;gap:8px}
        .dot{width:9px;height:9px;border-radius:50%;background:#E5322D}.p .dot{background:#C77700}
        button{border:0;border-radius:8px;padding:7px 11px;font:600 12.5px Inter,system-ui,sans-serif;cursor:pointer;background:#1F2A3D;color:#fff}
        .cdt{font-size:20px;color:#fff}
        button.s{background:#E5322D}.m{width:60px;height:3px;background:#1F2A3D;border-radius:3px;overflow:hidden}.m i{display:block;height:100%;width:0;background:#12A150}
      </style>`;
      w.document.body.innerHTML = ctrl ? `<div class="w"><div class="bar" id="bar"><span class="dot"></span><span id="t">0:00</span><b id="cd" class="cdt" hidden></b><div class="m"><i id="m"></i></div><button id="p" type="button">Pause</button><button id="s" class="s" type="button">Terminer</button></div></div>`
        : `<div class="w"><div class="b"><video id="v" muted playsinline autoplay></video><div id="cd" hidden></div></div>
        <div class="bar" id="bar"><span class="dot"></span><span id="t">0:00</span><div class="m"><i id="m"></i></div><button id="p" type="button">Pause</button><button id="s" class="s" type="button">Terminer</button></div></div>`;
      const v = w.document.getElementById("v"); if (v) { v.srcObject = cam; v.play().catch(() => {}); }
      w.document.getElementById("p").onclick = togglePause;
      w.document.getElementById("s").onclick = stopRecording;
      // la bulle est toujours visible : c'est elle qui fait avancer le chrono quand l'onglet est en arrière-plan
      let n = 0;
      w.setInterval(() => {
        const m = w.document.getElementById("m"); if (m && VD.level && VD.actx) m.style.width = VD.level();
        if (++n % 3 === 0 && VD.phase === "rec") tick();
      }, 150);
      w.addEventListener("pagehide", () => { VD.pip = null; });
      VD.pip = w;
      return true;
    } catch { /* pas de clic récent : on passera par « Lancer » */ }
  }
  // Safari et autres : image dans l'image classique sur la vidéo de la caméra
  try {
    const v = $("#vd-cam");
    if (document.pictureInPictureEnabled && !document.pictureInPictureElement) { await v.requestPictureInPicture(); return true; }
  } catch {}
  return false;
}
function closeBubble() {
  if (VD.pip) { try { VD.pip.close(); } catch {} VD.pip = null; }
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
}
function bubbleTick() {
  if (!VD.pip) return;
  const d = VD.pip.document;
  d.getElementById("t").textContent = fmtClock(elapsed());
  d.getElementById("bar").classList.toggle("p", VD.paused);
  d.getElementById("p").textContent = VD.paused ? "Reprendre" : "Pause";
}

/* ---------- Enregistrement ---------- */
function pickMime() {
  // MP4 H.264 + AAC d'abord : lisible partout, y compris sur iPhone. Sinon WebM. « video/mp4 » seul en dernier :
  // certains navigateurs y mettent du VP9, moins bien lu sur téléphone.
  const types = ["video/mp4;codecs=avc1.42E01F,mp4a.40.2", "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1.4D401F,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2",
    "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
}
const COMPOSE_WORKER = `
let screen = null, canvas = null, ctx = null, writer = null;
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
onmessage = ({ data }) => {
  writer = data.out.getWriter();
  (async () => { const r = data.screen.getReader(); for (;;) { const { value, done } = await r.read(); if (done) break; if (screen) screen.close(); screen = value; } })().catch(() => {});
  (async () => {
    const r = data.cam.getReader();
    for (;;) {
      const { value: cam, done } = await r.read(); if (done) break;
      try { if (screen) await draw(cam); } catch (e) {}
      cam.close();
    }
    try { writer.close(); } catch (e) {}
  })().catch(() => {});
};
async function draw(cam) {
  const sw = screen.displayWidth, sh = screen.displayHeight;
  const W = even(Math.min(sw, 1920)), H = even(sh * W / sw);
  if (!canvas || canvas.width !== W || canvas.height !== H) { canvas = new OffscreenCanvas(W, H); ctx = canvas.getContext("2d"); }
  ctx.drawImage(screen, 0, 0, W, H);
  const d = Math.round(Math.min(W, H) * 0.24), m = Math.round(Math.min(W, H) * 0.035), x = m, y = H - d - m;
  const cw = cam.displayWidth, ch = cam.displayHeight, s = Math.min(cw, ch);
  ctx.save(); ctx.shadowColor = "rgba(0,0,0,.35)"; ctx.shadowBlur = d * 0.08;
  ctx.beginPath(); ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill(); ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.arc(x + d / 2, y + d / 2, d / 2 - Math.max(2, d * 0.02), 0, Math.PI * 2); ctx.clip();
  ctx.drawImage(cam, (cw - s) / 2, (ch - s) / 2, s, s, x, y, d, d); ctx.restore();
  const f = new VideoFrame(canvas, { timestamp: cam.timestamp });
  try { await writer.write(f); } finally { try { f.close(); } catch (e) {} }
}`;
// Fusionne l'écran et la caméra en une seule piste vidéo (bulle ronde en bas à gauche)
function composeTrack(screenTrack, camTrack) {
  if (!canCompose() || !screenTrack || !camTrack) return null;
  try {
    const sc = screenTrack.clone(), cc = camTrack.clone();
    const sp = new MediaStreamTrackProcessor({ track: sc }), cp = new MediaStreamTrackProcessor({ track: cc });
    const gen = new MediaStreamTrackGenerator({ kind: "video" });
    const w = new Worker(URL.createObjectURL(new Blob([COMPOSE_WORKER], { type: "text/javascript" })));
    w.postMessage({ screen: sp.readable, cam: cp.readable, out: gen.writable }, [sp.readable, cp.readable, gen.writable]);
    VD.compose = { worker: w, tracks: [sc, cc, gen] };
    return gen;
  } catch (e) { console.warn("Incrustation de la caméra impossible :", e); return null; }
}
function stopCompose() {
  if (!VD.compose) return;
  VD.compose.tracks.forEach((t) => { try { t.stop(); } catch {} });
  setTimeout(((w) => () => w.terminate())(VD.compose.worker), 1500);
  VD.compose = null;
}
function buildStream() {
  const tracks = [];
  const camTrack = VD.prev && VD.prev.getVideoTracks()[0];
  let vtrack = needsScreen() ? VD.screen.getVideoTracks()[0] : camTrack;
  if (VD.mode === "screen-cam" && camTrack) vtrack = composeTrack(vtrack, camTrack) || vtrack;
  if (vtrack) tracks.push(vtrack);
  const mic = VD.prev && VD.prev.getAudioTracks()[0];
  const sys = VD.screen && VD.screen.getAudioTracks()[0];
  if (mic && sys) {
    VD.mixCtx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = VD.mixCtx.createMediaStreamDestination();
    VD.mixCtx.createMediaStreamSource(new MediaStream([mic])).connect(dest);
    const g = VD.mixCtx.createGain(); g.gain.value = 0.8;
    VD.mixCtx.createMediaStreamSource(new MediaStream([sys])).connect(g).connect(dest);
    tracks.push(dest.stream.getAudioTracks()[0]);
  } else if (mic || sys) tracks.push(mic || sys);
  return new MediaStream(tracks);
}

function beginRecording() {
  const stream = buildStream();
  if (!stream.getVideoTracks().length) { $("#vd-err").textContent = "Aucune image à enregistrer."; return resetRecorder(); }
  const mime = pickMime();
  try {
    VD.rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: needsScreen() ? 2500000 : 1800000, audioBitsPerSecond: 128000 });
  } catch (e) { $("#vd-err").textContent = "Ton navigateur ne sait pas enregistrer de vidéo : " + e.message; return resetRecorder(); }
  VD.mime = (VD.rec.mimeType || mime || "video/webm").split(";")[0];
  Object.assign(VD, { blobs: [], sent: 0, part: 0, offset: 0, queue: Promise.resolve(), upErr: null, discard: false, video: null, thumb: null, acc: 0, paused: false, t0: Date.now() });
  const lead = pickedLead();
  const ctaL = $("#vd-cta-l").value.trim(), ctaU = $("#vd-cta-u").value.trim();
  vdStore("cta-l", ctaL); vdStore("cta-u", ctaU);
  VD.created = api("/videos", { method: "POST", body: JSON.stringify({
    title: $("#vd-title").value.trim() || (lead ? `Vidéo pour ${lead.name}` : ""), lead_id: lead ? lead.id : null,
    mode: VD.mode, mime: VD.mime, cta_label: ctaU ? (ctaL || "En savoir plus") : "", cta_url: ctaU,
  }) }).then((v) => (VD.video = v)).catch((e) => { VD.upErr = e.message; return null; });
  VD.rec.ondataavailable = (e) => { if (e.data && e.data.size) { VD.blobs.push(e.data); pump(); } };
  VD.rec.start(2000);
  VD.phase = "rec";
  showPane("live");
  $("#vd-live-tip").textContent = VD.mode === "cam" ? "Regarde la caméra et parle naturellement." : VD.compose ? "Ta bulle caméra est incrustée dans la vidéo. Va sur ce que tu veux montrer : tout est enregistré." : VD.pip || document.pictureInPictureElement ? "Ta bulle caméra flotte au-dessus de tes fenêtres. Va sur ce que tu veux montrer : tout est enregistré." : "Va sur ce que tu veux montrer : tout est enregistré. Reviens ici pour terminer.";
  $(".vd-live").classList.remove("paused");
  $("#vd-pause").textContent = "Pause";
  clearInterval(VD.timer);
  VD.timer = setInterval(tick, 500); tick();
  setTimeout(grabThumb, 900);
}
function tick() {
  const ms = elapsed();
  $("#vd-time").textContent = fmtClock(ms);
  bubbleTick();
  const mb = VD.offset / 1e6;
  $("#vd-up").textContent = VD.upErr ? "Envoi en pause, la vidéo reste sur ton ordinateur" : VD.offset ? `${mb < 10 ? mb.toFixed(1).replace(".", ",") : Math.round(mb)} Mo envoyés` : "";
  if (ms >= VD_MAX_MIN * 60e3 && VD.phase === "rec") { toast(`Limite de ${VD_MAX_MIN} minutes atteinte`); stopRecording(); }
}
function togglePause() {
  if (VD.phase !== "rec" || !VD.rec) return;
  if (VD.paused) { VD.rec.resume(); VD.t0 = Date.now(); VD.paused = false; }
  else { VD.rec.pause(); VD.acc += Date.now() - VD.t0; VD.paused = true; }
  $(".vd-live").classList.toggle("paused", VD.paused);
  $("#vd-pause").textContent = VD.paused ? "Reprendre" : "Pause";
  tick();
}

/* Envoi en direct, morceau par morceau, dans l'ordre (3 nouvelles tentatives par morceau) */
function pump() {
  VD.queue = VD.queue.then(async () => {
    await VD.created;
    while (!VD.upErr && !VD.discard && VD.video && VD.sent < VD.blobs.length) {
      // un morceau peut être énorme (certains navigateurs donnent tout à la fin) : on l'envoie par tranches de 8 Mo
      const blob = VD.blobs[VD.sent], part = VD.part || 0;
      const b = blob.slice(part, part + 8 * 1024 * 1024);
      let ok = false, err = null;
      for (let i = 0; i < 4 && !ok; i++) {
        try {
          const res = await fetch(`/api/videos/${VD.video.id}/chunk?start=${VD.offset}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream" }, body: b });
          if (res.ok) ok = true; else { err = (await res.json().catch(() => ({}))).error || `Erreur ${res.status}`; if (res.status < 500 && res.status !== 429) break; }
        } catch (e) { err = e.message; }
        if (!ok) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
      if (!ok) { VD.upErr = err || "Connexion perdue"; break; }
      VD.offset += b.size; VD.part = part + b.size;
      if (VD.part >= blob.size) { VD.sent++; VD.part = 0; }
      if (VD.phase === "finishing") progress();
    }
  });
  return VD.queue;
}

async function grabThumb() {
  try {
    const W = 640, H = 360, c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d"); g.fillStyle = "#0B1220"; g.fillRect(0, 0, W, H);
    const frame = async (track, el) => {
      if (track && window.ImageCapture) { try { return await new ImageCapture(track).grabFrame(); } catch {} }
      return el && el.videoWidth ? el : null;
    };
    const dims = (f) => [f.videoWidth || f.width, f.videoHeight || f.height];
    if (needsScreen()) {
      const f = await frame(VD.screen && VD.screen.getVideoTracks()[0], $("#vd-screen"));
      if (f) { const [w, h] = dims(f); const k = Math.min(W / w, H / h); g.drawImage(f, (W - w * k) / 2, (H - h * k) / 2, w * k, h * k); }
    }
    const camTrack = VD.prev && VD.prev.getVideoTracks()[0];
    if (needsCam() && camTrack) {
      const f = await frame(camTrack, $("#vd-cam"));
      if (f) {
        const [w, h] = dims(f);
        if (VD.mode === "cam") { const k = Math.max(W / w, H / h); g.drawImage(f, (W - w * k) / 2, (H - h * k) / 2, w * k, h * k); }
        else {
          const d = 120, x = 18, y = H - d - 18, s = Math.min(w, h);
          g.save(); g.beginPath(); g.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2); g.clip();
          g.drawImage(f, (w - s) / 2, (h - s) / 2, s, s, x, y, d, d); g.restore();
          g.beginPath(); g.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2); g.lineWidth = 4; g.strokeStyle = "#fff"; g.stroke();
        }
      }
    }
    VD.thumb = c.toDataURL("image/jpeg", 0.8);
  } catch {}
}

async function stopRecording() {
  if (VD.phase !== "rec" || !VD.rec) return;
  if (!VD.paused) VD.acc += Date.now() - VD.t0;
  VD.paused = true;
  VD.phase = "finishing";
  clearInterval(VD.timer);
  const stopped = new Promise((r) => { VD.rec.onstop = r; });
  try { VD.rec.stop(); } catch {}
  await stopped;
  releaseCapture();
  renderDone();
  await finishUpload();
}
function releaseCapture() {
  closeBubble();
  stopCompose();
  stopTracks(VD.screen); VD.screen = null;
  if (VD.mixCtx) { VD.mixCtx.close().catch(() => {}); VD.mixCtx = null; }
  $("#vd-screen").srcObject = null; $("#vd-screen").hidden = true; $("#vd-screen-ph").hidden = false;
  stopPreview();
}
async function cancelRecording() {
  if (!(await confirmBox("Annuler cet enregistrement ? La vidéo sera supprimée.", "Supprimer"))) return;
  VD.discard = true;
  if (VD.rec && VD.rec.state !== "inactive") { VD.rec.ondataavailable = null; try { VD.rec.stop(); } catch {} }
  clearInterval(VD.timer);
  const v = await VD.created;
  if (v) api(`/videos/${v.id}`, { method: "DELETE" }).catch(() => {});
  resetRecorder();
}
function resetRecorder() {
  clearInterval(VD.timer);
  releaseCapture();
  Object.assign(VD, { phase: "idle", rec: null, blobs: [], video: null, created: null, sent: 0, part: 0, offset: 0, upErr: null, thumb: null, acc: 0, t0: 0, paused: false });
  $("#vd-count").hidden = true;
  $("#vd-done").innerHTML = "";
  showPane("setup");
  if ($("#v-videos").classList.contains("on")) startPreview();
}

/* ---------- Fin : aperçu local, envoi des derniers morceaux, lien ---------- */
function totalBytes() { return VD.blobs.reduce((s, b) => s + b.size, 0); }
function renderDone() {
  showPane("done");
  const url = URL.createObjectURL(new Blob(VD.blobs, { type: VD.mime }));
  VD.localUrl = url;
  $("#vd-done").innerHTML = `
    <video src="${url}" controls playsinline></video>
    <div id="vd-fin"><div class="vd-prog"><i id="vd-prog"></i></div><p class="small muted" id="vd-prog-t">Finalisation de l'envoi…</p></div>
    <div class="vd-live-btns"><button class="btn ghost" id="vd-new" type="button">Nouvel enregistrement</button><a class="btn quiet" href="${url}" download="video.${VD.mime === "video/mp4" ? "mp4" : "webm"}">Télécharger</a></div>`;
  // WebM du navigateur : durée inconnue tant qu'on n'a pas lu jusqu'au bout, on la force
  const pv = $("#vd-done video");
  pv.addEventListener("loadedmetadata", () => { if (pv.duration === Infinity) { pv.currentTime = 1e101; pv.addEventListener("durationchange", function f() { if (isFinite(pv.duration)) { pv.removeEventListener("durationchange", f); pv.currentTime = 0; } }); } }, { once: true });
  $("#vd-new").onclick = () => { $("#vd-title").value = ""; $("#vd-lead").value = ""; resetRecorder(); };
  progress();
}
function progress() {
  const tot = totalBytes() || 1, p = Math.min(100, Math.round((100 * VD.offset) / tot));
  const bar = $("#vd-prog"); if (bar) bar.style.width = p + "%";
  const t = $("#vd-prog-t"); if (t && !VD.upErr) t.textContent = `Envoi : ${p} % (${fmtSize(VD.offset)} sur ${fmtSize(tot)})`;
}
async function finishUpload() {
  if (!VD.thumb) await grabThumbFromLocal();
  await pump();
  const fin = $("#vd-fin");
  if (VD.upErr || !VD.video || VD.sent < VD.blobs.length) {
    if (fin) fin.innerHTML = `<div class="callout err"><div class="grow"><b>L'envoi n'est pas terminé</b><p>${esc(VD.upErr || "Connexion perdue")}. Ta vidéo est toujours là : réessaie, ou télécharge-la.</p></div><button class="btn primary" id="vd-retry" type="button">Réessayer</button></div>`;
    const r = $("#vd-retry"); if (r) r.onclick = retryUpload;
    return;
  }
  let v;
  try { v = await api(`/videos/${VD.video.id}/finish`, { method: "POST", body: JSON.stringify({ size: totalBytes(), duration: Math.round(VD.acc / 1000), thumb: VD.thumb }) }); }
  catch (e) { VD.upErr = e.message; return finishUpload(); }
  VD.phase = "done";
  if (fin) fin.innerHTML = `
    <div class="vd-link"><input id="vd-url" readonly value="${esc(v.url)}"><button class="btn primary" id="vd-copy" type="button">Copier le lien</button></div>
    <p class="small muted" style="margin:0">${v.lead_name ? `Tu seras prévenu dès que ${esc(v.lead_name)} regarde.` : "Tu seras prévenu dès que quelqu'un regarde."} <a href="${esc(v.url)}" target="_blank" rel="noopener">Ouvrir la page</a></p>`;
  $("#vd-copy").onclick = () => copyLink(v.url);
  copyLink(v.url, true);
  loadVideoList();
}
async function retryUpload() {
  VD.upErr = null;
  $("#vd-fin").innerHTML = `<div class="vd-prog"><i id="vd-prog"></i></div><p class="small muted" id="vd-prog-t"></p>`;
  if (!VD.video) {
    // la création avait échoué : on recrée la vidéo et on renvoie tout
    VD.created = api("/videos", { method: "POST", body: JSON.stringify({ title: $("#vd-title").value.trim(), mode: VD.mode, mime: VD.mime, lead_id: pickedLead() ? pickedLead().id : null, cta_label: $("#vd-cta-l").value.trim(), cta_url: $("#vd-cta-u").value.trim() }) })
      .then((v) => (VD.video = v)).catch((e) => { VD.upErr = e.message; return null; });
    VD.sent = 0; VD.part = 0; VD.offset = 0;
  }
  progress();
  await finishUpload();
}
async function grabThumbFromLocal() {
  try {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.src = VD.localUrl;
    await new Promise((ok, ko) => { v.onloadeddata = ok; v.onerror = ko; setTimeout(ko, 4000); });
    const c = document.createElement("canvas"); c.width = 640; c.height = 360;
    const g = c.getContext("2d"), k = Math.min(640 / v.videoWidth, 360 / v.videoHeight);
    g.fillStyle = "#0B1220"; g.fillRect(0, 0, 640, 360);
    g.drawImage(v, (640 - v.videoWidth * k) / 2, (360 - v.videoHeight * k) / 2, v.videoWidth * k, v.videoHeight * k);
    VD.thumb = c.toDataURL("image/jpeg", 0.8);
  } catch {}
}
async function copyLink(url, silent) {
  try { await navigator.clipboard.writeText(url); toast("Lien copié : colle-le dans ton SMS ou ton email"); }
  catch {
    const i = $("#vd-url");
    if (i && i.value === url) { i.select(); try { document.execCommand("copy"); toast("Lien copié"); return; } catch {} }
    if (!silent) prompt("Copie ce lien :", url);
  }
}

/* ---------- Bibliothèque ---------- */
async function loadVideoList() {
  let r;
  try { r = await api("/videos"); } catch (e) { $("#vd-list").innerHTML = `<div class="panel-b muted">${esc(e.message)}</div>`; return; }
  VD.list = r.videos; VD.defaultCta = r.defaultCta;
  if (VD.defaultCta && !$("#vd-cta-u").value && vdStore("cta-u") === null) { $("#vd-cta-l").value = VD.defaultCta.label; $("#vd-cta-u").value = VD.defaultCta.url; }
  $("#vd-usage").textContent = r.count ? `${r.count} vidéo${r.count > 1 ? "s" : ""} · ${fmtSize(r.totalBytes)}` : "";
  const watched = VD.list.filter((v) => v.views).length;
  $("#vd-lib-sub").textContent = VD.list.length ? `${watched} sur ${VD.list.length} regardée${watched > 1 ? "s" : ""}` : "Vues et taux de visionnage de chaque lien";
  if (!VD.list.length) { $("#vd-list").innerHTML = emptyState("Aucune vidéo pour l'instant", "Enregistre ta première vidéo : elle apparaîtra ici avec son lien et ses vues."); return; }
  const d = (iso) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  $("#vd-list").innerHTML = `<ul class="vd-items">${VD.list.map((v) => `
    <li class="vd-item" data-id="${v.id}">
      <a class="vd-th" href="${esc(v.url)}" target="_blank" rel="noopener" style="${v.has_thumb ? `background-image:url('/v/${esc(v.token)}/thumb.jpg')` : ""}" aria-label="Ouvrir ${esc(v.title)}">${v.duration ? `<em>${fmtClock(v.duration * 1000)}</em>` : ""}</a>
      <div class="vd-it"><b title="${esc(v.title)}">${esc(v.title)}</b>
        <div class="small muted">${v.views ? `<span class="badge good">${v.views} vue${v.views > 1 ? "s" : ""}</span><span>regardée à ${v.max_pct} %</span>` : `<span class="badge">Pas encore vue</span>`}<span>· ${esc(d(v.created_at))}</span>${v.lead_name ? `<span>· ${esc(v.lead_name)}</span>` : ""}</div></div>
      <div class="vd-acts">
        <button class="btn quiet" data-a="copy" title="Copier le lien" aria-label="Copier le lien"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg></button>
        <button class="btn quiet" data-a="edit" title="Renommer" aria-label="Renommer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/></svg></button>
        <a class="btn quiet" href="/v/${esc(v.token)}/video?dl=1" title="Télécharger" aria-label="Télécharger"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></svg></a>
        <button class="btn quiet" data-a="del" title="Supprimer" aria-label="Supprimer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>
      </div>
    </li>`).join("")}</ul>`;
}
async function onListClick(e) {
  const b = e.target.closest("button[data-a]"); if (!b) return;
  const v = VD.list.find((x) => x.id === Number(b.closest("[data-id]").dataset.id)); if (!v) return;
  if (b.dataset.a === "copy") copyLink(v.url);
  if (b.dataset.a === "edit") {
    const t = prompt("Titre de la vidéo", v.title);
    if (t && t.trim() && t.trim() !== v.title) { try { await api(`/videos/${v.id}`, { method: "PUT", body: JSON.stringify({ title: t.trim() }) }); loadVideoList(); } catch (err) { toast(err.message); } }
  }
  if (b.dataset.a === "del") {
    if (!(await confirmBox(`Supprimer « ${v.title} » ? Le lien ne marchera plus.`, "Supprimer"))) return;
    try { await api(`/videos/${v.id}`, { method: "DELETE" }); toast("Vidéo supprimée"); loadVideoList(); } catch (err) { toast(err.message); }
  }
}
