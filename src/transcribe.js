// Transcription audio → texte avec Deepgram (français, séparation des voix)
const config = require("./config");

async function callDeepgram(buffer, type, model) {
  const p = new URLSearchParams({
    model,
    language: "fr",
    smart_format: "true",
    punctuate: "true",
    diarize: "true",
    multichannel: "true",
    utterances: "true",
  });
  const res = await fetch("https://api.deepgram.com/v1/listen?" + p, {
    method: "POST",
    headers: { Authorization: `Token ${config.deepgramApiKey}`, "Content-Type": type || "audio/wav" },
    body: buffer,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const e = new Error(`Deepgram ${res.status} : ${t.slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

function fmt(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function transcribe(buffer, type) {
  let j;
  try {
    j = await callDeepgram(buffer, type, config.deepgramModel);
  } catch (e) {
    if (e.status === 400 && config.deepgramModel !== "nova-2") j = await callDeepgram(buffer, type, "nova-2");
    else throw e;
  }
  const channels = (j.results && j.results.channels) || [];
  const multi = channels.length > 1;
  const utts = ((j.results && j.results.utterances) || []).slice().sort((a, b) => a.start - b.start);

  const lines = [];
  for (const u of utts) {
    const txt = (u.transcript || "").trim();
    if (!txt) continue;
    const who = "Voix " + ((multi ? u.channel : u.speaker) + 1 || 1);
    const last = lines[lines.length - 1];
    if (last && last.who === who) last.txt += " " + txt;
    else lines.push({ who, txt, at: u.start });
  }
  let text = lines.map((l) => `[${fmt(l.at)}] ${l.who} : ${l.txt}`).join("\n");
  if (!text) {
    text = channels
      .map((c, i) => (c.alternatives && c.alternatives[0] && c.alternatives[0].transcript) || "")
      .filter(Boolean)
      .map((t, i) => `Voix ${i + 1} : ${t}`)
      .join("\n");
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  const duration = j.metadata && j.metadata.duration ? Math.round(j.metadata.duration) : null;
  return { text, words, duration };
}

module.exports = { transcribe };
