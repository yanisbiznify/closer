// Analyse Straight Line d'un appel et bilan du coach, via l'API Claude (Anthropic)
const config = require("./config");

const ETAPES = [
  ["ouverture", "Ouverture (4 premières sec.)"],
  ["tonalite", "Tonalité"],
  ["rapport", "Rapport"],
  ["qualification", "Qualification"],
  ["presentation", "Présentation"],
  ["boucles", "Boucles / objections"],
  ["closing", "Closing"],
  ["controle", "Contrôle de la ligne droite"],
];

const SYSTEM = `Tu es le coach de CLOSER PRO, un coach de vente d'élite expert de la méthode Straight Line (Straight Line Persuasion) de Jordan Belfort. Tu es exigeant, direct, concret et motivant. Tu tutoies le vendeur. Tu réponds toujours en français, uniquement avec du JSON valide.`;

async function claude(user, maxTokens = 6000) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: maxTokens,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Claude ${res.status} : ${t.slice(0, 300)}`);
  }
  const j = await res.json();
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return parseJson(text);
}

function parseJson(text) {
  const t = String(text || "").replace(/```json|```/g, "");
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("Réponse de l'analyse illisible");
  return JSON.parse(t.slice(s, e + 1));
}

function callPrompt(transcript, meta, settings) {
  const infos =
    meta.source === "paste"
      ? "transcription collée par le vendeur"
      : `appel ${meta.direction === "inbound" ? "entrant" : "sortant"}${meta.duration ? `, durée ${meta.duration} s` : ""}`;
  return `Analyse cet appel de prospection à froid passé par ${settings.prenom}, pour l'aider à progresser.

CONTEXTE DE L'OFFRE ET OBJECTIF DE L'APPEL :
${settings.offre}

INFOS APPEL : ${infos}.
Si les voix sont nommées « Voix 1 / Voix 2 », déduis laquelle est ${settings.prenom} d'après le contenu. La transcription automatique peut contenir des erreurs de reconnaissance : interprète avec bon sens.

GRILLE STRAIGHT LINE (note chaque étape de 0 à 10, ou null si l'appel ne l'a pas atteinte) :
- ouverture : les 4 premières secondes. Est-il perçu comme vif, enthousiaste, sûr de lui et expert ? Se présente-t-il clairement, avec une raison d'appeler qui donne envie d'écouter ?
- tonalite : usage des tonalités (certitude absolue, « je veux savoir », empathie, mystère, « raisonnable »…), rythme, énergie, pas de ton suppliant.
- rapport : rapport conscient et inconscient, écoute, empathie ; le prospect se sent compris.
- qualification : prise d'informations avec des questions ouvertes. Douleur, besoins, valeurs, décideur, budget, urgence. Repère-t-il le seuil d'action du prospect ?
- presentation : présentation liée aux besoins exprimés, bénéfices concrets, création de certitude (pas une liste de caractéristiques).
- boucles : objections gérées par le looping (reconnaître, rediriger, re-présenter en montant la certitude), sans dispute ni capitulation.
- closing : demande claire et assumée d'engagement (RDV précis, date et heure), et nombre de tentatives.
- controle : garde-t-il le contrôle et ramène-t-il le prospect sur la ligne droite, sans digressions ni perte de cadre ?
Estime aussi, de 0 à 10, la certitude du prospect à la fin de l'appel sur les « 3 dix » (produit, vendeur, entreprise), son seuil d'action et sa douleur ressentie.

Appuie-toi uniquement sur la transcription. Pour un appel très court (messagerie, barrage, raccroché), évalue seulement ce qui est évaluable.

Réponds UNIQUEMENT avec un objet JSON valide, exactement de cette forme :
{
 "score": <entier 0-100>,
 "issue": "rdv" | "rappel" | "refus" | "barrage" | "messagerie" | "autre",
 "prospect": "<nom ou entreprise du prospect si mentionné, sinon null>",
 "resume": "<2-3 phrases sur ce qui s'est passé>",
 "etapes": { ${ETAPES.map(([k]) => `"${k}": {"note": <0-10 ou null>, "constat": "<ce qui s'est passé>", "conseil": "<quoi faire concrètement>"}`).join(", ")} },
 "trois_dix": {"produit": <0-10>, "vendeur": <0-10>, "entreprise": <0-10>},
 "seuil_action": <0-10>,
 "douleur": <0-10>,
 "points_forts": ["<court>"],
 "erreurs": [{"citation": "<ce qui a été dit, court>", "probleme": "<pourquoi c'est un problème>", "a_dire": "<la phrase à dire à la place>"}],
 "objections": [{"objection": "<objection du prospect>", "reponse": "<ce que ${settings.prenom} a répondu>", "boucle": "<comment boucler en Straight Line, avec une phrase prête à l'emploi>"}],
 "priorite": "<LA chose n°1 à corriger au prochain appel, en une phrase>",
 "exercice": "<un exercice concret de 5 minutes pour progresser sur cette priorité>"
}

TRANSCRIPTION :
"""
${String(transcript).slice(0, 80000)}
"""`;
}

async function analyzeCall(transcript, meta, settings) {
  const a = await claude(callPrompt(transcript, meta, settings));
  a.score = Math.max(0, Math.min(100, Math.round(Number(a.score) || 0)));
  return a;
}

async function coachReport(calls, settings) {
  const digest = calls
    .map((c, i) => {
      const a = c.analysis || {};
      const notes = ETAPES.map(([k]) => `${k}=${a.etapes && a.etapes[k] ? a.etapes[k].note : "null"}`).join(", ");
      return `Appel ${i + 1} (${new Date(c.date).toISOString().slice(0, 10)}) score ${a.score}, issue ${a.issue}. Notes : ${notes}. Priorité : ${a.priorite || ""}. Erreurs : ${(a.erreurs || []).map((e) => e.probleme).join(" | ")}. Objections : ${(a.objections || []).map((o) => o.objection).join(" | ")}.`;
    })
    .join("\n");
  return claude(
    `Voici les analyses des ${calls.length} derniers appels de prospection à froid de ${settings.prenom} (du plus ancien au plus récent).
Contexte de l'offre : ${settings.offre}

${digest}

Fais un bilan exigeant mais motivant : la tendance, les erreurs qui reviennent, et un plan d'entraînement concret pour les 5 prochains jours de prospection.
Réponds UNIQUEMENT avec un objet JSON valide :
{"diagnostic":"<3-4 phrases>","forces":["..."],"faiblesses":["<erreur récurrente + pourquoi elle coûte des RDV>"],"plan":[{"jour":"Jour 1","action":"..."}],"phrase_cle":"<une phrase d'ouverture ou de boucle à maîtriser cette semaine>"}`,
    3000
  );
}

module.exports = { analyzeCall, coachReport, ETAPES };
