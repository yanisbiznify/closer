# CLOSER

**Reste sur la ligne. Close plus.**

CLOSER récupère tes appels de prospection dans GoHighLevel, les transcrit et les analyse avec la méthode Straight Line de Jordan Belfort. Pour chaque appel, tu obtiens :

- un score sur 100 ;
- une note pour chacune des 8 étapes de la ligne droite ;
- la certitude du prospect sur les 3 dix ;
- tes erreurs, avec la phrase à dire à la place ;
- tes objections, avec la boucle idéale ;
- ta priorité n°1 et un exercice de 5 minutes.

Un tableau de bord suit ta progression. Le bilan du coach te donne un plan pour la semaine.

S'installe sur ton téléphone comme une vraie app (PWA).

---

## Déployer sur Railway (10 minutes)

### 1. Créer le projet
1. Va sur [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo** → choisis `closer`.
2. Dans le même projet : **+ Create** → **Database** → **PostgreSQL**.
3. Dans le service `closer` → **Variables** → **Add Variable Reference** → `DATABASE_URL` (celle de Postgres).
4. **Settings** → **Networking** → **Generate Domain** pour obtenir ton adresse (ex. `closer-production.up.railway.app`).

### 2. Ajouter les variables (service `closer` → Variables)

| Variable | Valeur |
|---|---|
| `DATABASE_URL` | référence vers la base Postgres (étape 1.3) |
| `APP_PASSWORD` | ton mot de passe pour entrer dans l'app |
| `GHL_API_KEY` | ton jeton d'intégration privée GHL (voir ci-dessous) |
| `GHL_LOCATION_ID` | `Vf0LEy5Srevu60UFpMh6` (ton sous-compte Biznify) |
| `DEEPGRAM_API_KEY` | clé API Deepgram (transcription) |
| `ANTHROPIC_API_KEY` | clé API Claude (analyse) |
| `WEBHOOK_SECRET` | *(optionnel)* une chaîne aléatoire pour le webhook GHL |
| `ANTHROPIC_MODEL` | *(optionnel)* par défaut `claude-sonnet-5-5` |
| `DEEPGRAM_MODEL` | *(optionnel)* par défaut `nova-3` (repli automatique sur `nova-2`) |
| `SYNC_INTERVAL_MIN` | *(optionnel)* fréquence de synchro GHL, par défaut `10` |

Le fichier `.env.example` récapitule ces variables.

### 3. Obtenir les clés

**GoHighLevel**
Dans ton sous-compte Biznify : **Settings → Private Integrations → Create new integration**. Coche ces deux autorisations :
- `View Conversation Messages` (conversations/message.readonly)
- `View Contacts` (contacts.readonly)

Copie le jeton dans `GHL_API_KEY`.

**Deepgram**
Crée un compte sur [console.deepgram.com](https://console.deepgram.com) : 200 $ de crédit offert, soit des centaines d'heures d'appels. Crée ensuite une clé API.

**Claude**
Va sur [console.anthropic.com](https://console.anthropic.com) → **API Keys**.

### 4. Installer l'app sur ton téléphone
Ouvre ton adresse Railway sur ton téléphone :
- **iPhone (Safari)** : Partager → Sur l'écran d'accueil.
- **Android (Chrome)** : ⋮ → Installer l'application.

---

## Comment ça marche

- **Automatique** : toutes les 10 minutes, CLOSER récupère tes nouveaux appels GHL. Chaque appel décroché qui a un enregistrement est transcrit (Deepgram, en français, voix séparées) puis analysé (Claude). Seuls les appels passés **après l'installation** sont analysés automatiquement.
- **Historique** : dans l'onglet *Appels*, le bouton « Analyser tout l'historique » traite tes anciens appels. Tu peux aussi analyser un appel en le touchant.
- **Appels trop courts** : en dessous de la durée minimale (réglable) ou de 25 mots, l'appel est marqué « trop court » et n'est pas envoyé à Claude.
- **Ajouter** : importe un fichier audio (appel passé hors GHL, jeu de rôle…) ou colle une transcription.
- **Réglages** : ton prénom, ton offre et l'objectif de tes appels. Ce contexte est utilisé par le coach pour juger tes appels, donc garde-le à jour.

### Webhook (optionnel, pour une analyse quasi instantanée)
Dans GHL, crée un workflow : déclencheur **Call Status** (appel terminé), puis action **Webhook** en POST vers :
```
https://TON-DOMAINE.up.railway.app/api/webhook/ghl?secret=TON_WEBHOOK_SECRET
```
CLOSER lancera une synchronisation 20 secondes après chaque appel.

### Coûts estimés
- Transcription Deepgram : environ 0,005 $ par minute d'appel.
- Analyse Claude Sonnet : environ 0,03 à 0,05 $ par appel.
- Railway : environ 5 $/mois (app + base).

### Rappel légal
En France, préviens ton interlocuteur que l'appel est enregistré.

---

## Développement local
```bash
cp .env.example .env   # puis remplis les valeurs
npm install
node --env-file=.env server.js
```

## Structure
```
server.js            API + serveur web
src/config.js        variables d'environnement
src/db.js            Postgres (tables créées automatiquement au démarrage)
src/ghl.js           API GoHighLevel (appels, enregistrements, contacts)
src/transcribe.js    transcription Deepgram
src/analyze.js       analyse Straight Line + bilan du coach (Claude)
src/worker.js        synchro GHL + file de traitement
public/              interface (PWA), guide de marque (/marque), logos
scripts/brand.js     génération des logos et icônes
```

## Marque
Le guide de marque complet (logo, couleurs, typographie, voix) est disponible dans l'app sur `/marque`.
