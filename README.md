# Astreinte

[![Build](https://github.com/TeALO36/SnapMCP/actions/workflows/build.yml/badge.svg)](https://github.com/TeALO36/SnapMCP/actions/workflows/build.yml)
[![Tests](https://github.com/TeALO36/SnapMCP/actions/workflows/test.yml/badge.svg)](https://github.com/TeALO36/SnapMCP/actions/workflows/test.yml)
[![Licence MIT](https://img.shields.io/badge/Licence-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](package.json)

Astreinte fait tourner un **persona** sur une messagerie. Vous définissez un
personnage — son nom, sa personnalité, sa voix, ses garde-fous — et les gens
discutent avec lui comme avec une personne : un contexte séparé par
interlocuteur, des garde-fous qui lui font passer la main quand la demande
dépasse ce qu'il doit traiter, et des notes vocales quand on en demande une.

Exemple d'usage : un persona de vous-même qui répond à vos demandes de support
informatique sur Telegram ou Snapchat, avec votre voix clonée en TTS. Mais le
persona peut être n'importe qui : un assistant commercial, un prof, un
personnage de fiction…

Rien n'est propre à un canal ni à une application. C'est un serveur MCP qui
tourne aussi bien sous Locaryn, Claude Code ou Gemini CLI, et le canal de
discussion est un driver interchangeable : **Telegram ou Snapchat, au choix**.

> **Dans Locaryn** : l'extension s'installe en collant l'adresse du dépôt dans
> Réglages → Extensions, et tout ce que montre le banc de test se retrouve dans
> les réglages de l'extension (formulaire de connexion) et dans le chat
> (outils MCP). Voir [`docs/LOCARYN.md`](docs/LOCARYN.md).

## Installation

> Le dépôt contient aussi **SnapMCP**, un serveur MCP pour contrôler
> Snapchat ou Telegram (messages, médias, notes vocales, appels) : voir
> [`SNAPMCP.md`](SNAPMCP.md) et [`docs/API.md`](docs/API.md).

Le dépôt ne contient que les sources TypeScript (`src/`) : `dist/` est un
artefact de build généré par `tsc`, ignoré par git et absent du dépôt. Après
un clone :

```bash
npm ci
npm run build
```

Puis renseignez la configuration (voir plus bas) et lancez :

```bash
node dist/index.js check     # vérifie tout sans rien envoyer
node dist/index.js daemon    # le persona tourne
```

### Scripts disponibles

| Commande | Rôle |
|---|---|
| `npm run build` | compile `src/` vers `dist/` (`tsc`). À lancer avant toute utilisation. |
| `npm run typecheck` | vérifie les types sans émettre de fichiers (`tsc --noEmit`). |
| `npm run test` | compile puis lance les deux suites de tests (`dist/*.test.js`). |
| `npm run dev` | recompile en continu pendant le développement (`tsc --watch`). |
| `npm run start` | lance le démon depuis `dist/` (`node dist/index.js daemon`). |
| `npm run test-bench` | ouvre le banc de test local (diagnostic, connexion Telegram, envois réels, **lecture des messages et affichage des médias reçus**). |
| `npm run telegram:login` | connexion compte personnel (téléphone + code). |
| `npm run telegram:login:qr` | connexion compte personnel par **QR code** (scan avec le téléphone). |
| `npm run telegram:login:bot` | connexion **bot** avec son jeton (`--bot <jeton>`). |
| `npm run android:vms` | démarre les trois VM Android du banc et ouvre le Play Store sur chacune. |

## Les deux modes

| Commande | Rôle |
|---|---|
| `snap-astreinte daemon` | reçoit, décide, répond. C'est le persona qui répond. |
| `snap-astreinte mcp` | serveur MCP de supervision, sur stdio. |
| `snap-astreinte check` | teste le canal, le modèle et la synthèse vocale, sans rien envoyer. |

Les deux premiers peuvent tourner en même temps : ils partagent les mêmes
fichiers. Le démon répond, le serveur MCP vous laisse regarder par-dessus son
épaule depuis votre assistant habituel et reprendre la main.

Outils MCP exposés : `snap_status`, `snap_list_contacts`,
`snap_read_conversation`, `snap_resume`, `snap_forget`,
`snap_get_config`, `snap_set_config`.

## Configuration

Tous les réglages vivent dans `plugin.json`, sous `config.schema`. C'est la
seule source : l'extension y lit ses défauts, et une application hôte y lit de
quoi construire son formulaire. Aucune des deux ne code la liste en dur, donc
aucune ne peut dériver de l'autre.

Les valeurs sont stockées dans `$SNAP_ASTREINTE_HOME/config.json`
(`~/.astreinte/` par défaut). Les secrets peuvent rester hors du fichier via
l'environnement : `SNAP_ASTREINTE_TELEGRAM_API_ID`,
`SNAP_ASTREINTE_TELEGRAM_API_HASH`, `SNAP_ASTREINTE_TELEGRAM_SESSION_FILE`,
`SNAP_ASTREINTE_TELEGRAM_AUTH_TYPE`, `SNAP_ASTREINTE_TELEGRAM_BOT_TOKEN`,
`SNAP_ASTREINTE_LLM_API_KEY`.

Huit groupes : **Personnalité**, **Garde-fous**, **Voix**, **Image**, **Modèle**,
**Canal**, **Alertes**, **Contexte**.

### Le mode sans limite

`limits.enabled` décoché désactive **tout** : plus d'escalade, plus de plage
horaire, plus de limite de longueur, plus de périmètre. L'assistant répond à
tout, seul, indéfiniment. C'est un choix explicite, pas un défaut.

## Un contexte par interlocuteur

C'est la garantie centrale. Chaque personne a son fichier, son historique et son
compteur de tours ; rien n'est partagé. Deux personnes qui écrivent en même
temps sont traitées en parallèle et ne peuvent pas se mélanger.

Deux messages rapprochés d'une **même** personne, eux, sont sérialisés par un
verrou : sans lui, les deux liraient le contexte avant que l'un ait écrit le
sien, et un tour serait silencieusement perdu. C'est testé
(`deux messages rapprochés du même contact sont sérialisés`).

Au-delà de `context.max_history_turns`, les tours anciens sont repliés dans un
résumé plutôt que jetés.

## Canaux

Un canal est un driver qui implémente `Transport` (`src/transports/types.ts`) :
`start`, `stop`, `sendText`, `sendVoice`. Rien d'autre dans l'extension ne sait
sur quel canal elle tourne.

### Telegram — votre compte personnel (ou un bot), rien à payer

Aucune API officielle payante, aucun intermédiaire, aucun prestataire : le
canal parle par **MTProto** (GramJS), soit avec **votre compte Telegram
personnel** — qui apparaît comme un compte utilisateur normal, jamais avec le
badge « bot », et peut lire et répondre dans vos conversations réelles — soit
avec un **bot**, si vous préférez.

Le canal sait **lire les messages** (réception en push + rattrapage des
non-lus), **envoyer du texte, des images et des vidéos** (photos conservées,
10 secondes ou vue unique) et **envoyer de vraies notes vocales** (OGG/Opus,
avec forme d'onde — pas des fichiers audio).

#### Compte personnel — trois étapes, une seule fois

1. Créez vos identifiants sur **https://my.telegram.org** → « API development
   tools » : notez `api_id` et `api_hash`.
2. Connectez-vous, au choix :
   - **QR code** (le plus simple) : `npm run telegram:login:qr`, scannez le
     QR avec l'application Telegram sur votre téléphone ;
   - ou **téléphone + code** : `npm run telegram:login` ;
   - ou depuis le **banc de test** (`npm run test-bench`), bouton
     « Se connecter par QR (compte) ».
3. Renseignez dans la configuration du canal : `transport.driver = telegram`,
   `transport.telegram_auth = account`, `transport.telegram_api_id`,
   `transport.telegram_api_hash`, `transport.telegram_session_file`.

La session est écrite dans `$SNAP_ASTREINTE_HOME/.telegram/session.txt`
(`~/.snap-astreinte/.telegram/session.txt` en ligne de commande, `/.data/.telegram/session.txt`
sous Locaryn) et ne doit jamais être commitée. Les secrets peuvent aussi
passer par l'environnement (`SNAP_ASTREINTE_TELEGRAM_API_ID`, `_API_HASH`,
`_SESSION_FILE`).

**Depuis Locaryn**, la connexion se lance dans le chat : demandez à
l'assistant « connecte mon compte Telegram ». Il appelle `telegram_login_qr`,
vous ouvre le lien (`t.me/login/…`) à confirmer sur votre téléphone, et
vérifie jusqu'à ce que la session soit enregistrée (le mot de passe 2FA passe
par `telegram_login_password`, un bot par `telegram_login_bot`).

#### Bot — un jeton et c'est tout

Mettez `transport.telegram_auth = bot` et collez le jeton de @BotFather dans
`transport.telegram_bot_token`. **Aucune session à créer** : la première
utilisation s'authentifie avec le jeton et enregistre la session toute seule.

> **Pourquoi MTProto et pas l'API Bot ?** Un bot ne peut pas lire ni répondre
> dans une conversation où il n'a pas été ajouté, et ne prend jamais
> l'identité d'un compte. Le compte personnel fait tout ce qu'un compte
> utilisateur fait. La liste des bibliothèques MTProto utilisables et le
> guide de bascule (Telethon, Pyrogram, MTKruto, MadelineProto) sont dans
> [`docs/TELEGRAM-LIBRARIES.md`](docs/TELEGRAM-LIBRARIES.md).

> **Avertissements**
>
> - Un auto-répondeur piloté par un **compte personnel** est un « userbot » :
>   c'est toléré pour un usage privé, mais contraire aux conditions
>   d'utilisation de Telegram. Utilisez de préférence un **compte secondaire**
>   dédié ; le risque de restriction existe même avec votre propre compte.
> - `.telegram/session.txt` est une **clé d'authentification complète**
>   (équivalente à un mot de passe) : ne la partagez jamais, ne la commitez
>   jamais, et effacez-la si le compte est compromis.
> - Au démarrage, les conversations non lues sont marquées comme lues après
>   traitement : l'état de lecture peut donc changer dans votre application
>   Telegram réelle (c'est ce qui évite de répondre deux fois au même message).

Les notes vocales partent en OGG/Opus. Si votre moteur TTS produit du WAV,
`ffmpeg` est utilisé pour convertir ; sans lui, l'envoi échoue franchement et la
réponse part en texte.

### Pont externe — pour les canaux sans API

Certains canaux (Snapchat en premier lieu) n'exposent aucune API permettant de
lire ou d'envoyer des messages. Le driver `bridge` s'adresse à un processus que
vous fournissez, dans le langage de votre choix, qui expose cinq routes en
local :

| Route | Rôle |
|---|---|
| `GET /health` | `{ ok: true, voice: true, images: true }` |
| `GET /events` | flux SSE des messages reçus |
| `POST /send` | `{ contactId, text }` |
| `POST /sendVoice` | `{ contactId, audioBase64, mimeType }` |
| `POST /sendMedia` | `{ contactId, mediaBase64, mimeType, caption }` — photo, pas un fichier joint |

`/health` annonce les capacités : `voice` dit si le pont sait envoyer une note
vocale, `images` s'il sait envoyer une photo. Le persona ne demande une image
que si le canal le permet. Le contrat détaillé est en tête de
`src/transports/bridge.ts`. Un pont **Telegram prêt à l'emploi** (Telethon,
compte personnel ou bot, QR, notes vocales **et images**) vit dans
[`bridge-telethon/`](bridge-telethon/) : c'est la démonstration de la bascule
de bibliothèque MTProto, voir
[`docs/TELEGRAM-LIBRARIES.md`](docs/TELEGRAM-LIBRARIES.md).

Deux points sur lesquels un pont se plante en général :

- **`contactId` doit être stable et unique par personne.** C'est la clé du
  contexte. Un identifiant dérivé du nom d'affichage change dès que la personne
  renomme son profil, et le fil repart de zéro.
- **Ne jamais réémettre en entrée ce que le pont vient d'envoyer**, sinon
  l'assistant se répond à lui-même en boucle.

`transport.driver = snapchat` est ce même driver, préconfiguré avec un message
d'aide explicite quand le pont ne répond pas. **Le pont Snapchat n'est pas
fourni** : Snapchat n'expose aucune API de messagerie, et la seule voie passe
par un client non officiel contournant l'attestation d'intégrité de l'appareil.
Tout le reste de l'extension fonctionne dès qu'un pont existe.

## Notes vocales

Deux moteurs, parce qu'aucun n'est universel :

- `voice.tts_mode = http` — un serveur exposant `/v1/audio/speech`.
- `voice.tts_mode = command` — une commande locale, pour les moteurs qui clonent
  une voix à partir d'un échantillon (XTTS, Qwen3-TTS, OpenVoice). Le gabarit
  reçoit `{text}`, `{out}` et `{ref}` ; sans `{text}`, le texte passe par stdin.

`voice.mode` vaut `on_request` (détection des « tu peux me faire un vocal »),
`always` ou `never`. Une synthèse qui échoue ne fait jamais perdre la réponse :
elle part en texte, et la raison est journalisée.

## Images

Le persona sait aussi **envoyer une image en réponse** quand on lui en demande
une (« envoie-moi une photo de chat », « génère un logo »…). Le modèle écrit
le prompt de génération, un moteur local produit l'image, et elle part en
photo avec une courte légende.

Deux moteurs, comme pour la voix :

- `image.engine = http` — un serveur exposant `/v1/images/generations`
  (Stable Diffusion WebUI, ComfyUI, …), configuré par `image.base_url`,
  `image.model`, `image.size`.
- `image.engine = command` — une commande locale dont le gabarit reçoit
  `{prompt}` et `{out}`.

`image.mode` vaut `on_request` (défaut) ou `never`. Une génération qui échoue
ne fait jamais perdre la réponse : la légende part en texte, et la raison est
journalisée. Le canal doit savoir envoyer une photo (Telegram oui, un pont
HTTP sans route média non) pour que la directive entre dans le prompt du
modèle.

## Alertes

`notify.*` envoie une alerte Telegram à **l'exploitant** — vous — à chaque
escalade et à chaque échec de réponse. Volontairement indépendant du canal des
conversations : quand le canal principal est justement ce qui ne va pas, une
alerte qui passe par lui n'arrive jamais.

Les alertes partent du **même compte personnel** que le canal (aucun bot à
créer). Dans `notify.telegram_chat_id`, mettez `me` pour vos **Messages
enregistrés** (recommandé : rien à chercher, tout arrive dans votre espace
privé), un identifiant numérique, ou un `@pseudo`.

## Tests

```bash
npm test
```

Deux suites. L'une couvre l'isolation des contextes, les garde-fous et la
configuration ; l'autre monte un faux pont et un faux modèle en HTTP local et
vérifie le trajet complet d'un message, y compris deux interlocuteurs
simultanés, l'escalade qui court-circuite le modèle, le repli du vocal vers le
texte, et le modèle injoignable.

## Licence

MIT.
