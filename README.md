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
tourne aussi bien sous Lochor, Claude Code ou Gemini CLI, et le canal de
discussion est un driver interchangeable : **Telegram ou Snapchat, au choix**.

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
`SNAP_ASTREINTE_LLM_API_KEY`.

Sept groupes : **Personnalité**, **Garde-fous**, **Voix**, **Modèle**, **Canal**,
**Alertes**, **Contexte**.

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

### Telegram — votre compte personnel, pas un bot

Aucun jeton de bot, aucune API officielle, aucun intermédiaire : le canal parle
via **votre compte Telegram personnel**, par MTProto (GramJS). Le compte
apparaît comme un compte utilisateur normal — jamais avec le badge « bot » — et
peut lire et répondre dans vos conversations réelles.

Mise en place en deux étapes, une seule fois :

1. Créez vos identifiants sur **https://my.telegram.org** → « API development
   tools » : notez `api_id` et `api_hash`.
2. Lancez la connexion interactive : `npm run telegram:login`. Vous entrez
   votre numéro, le code reçu dans Telegram (et le mot de passe 2FA s'il est
   activé) ; la session est écrite dans `.telegram/session.txt` et ne doit
   jamais être commitée.

Puis renseignez dans la configuration du canal :

- `transport.telegram_api_id` — l'identifiant de l'étape 1,
- `transport.telegram_api_hash` — la clé de l'étape 1,
- `transport.telegram_session_file` — le fichier de session (défaut
  `.telegram/session.txt`),
- `transport.driver = telegram`.

Ou passez les secrets par l'environnement (`SNAP_ASTREINTE_TELEGRAM_API_ID`,
`SNAP_ASTREINTE_TELEGRAM_API_HASH`, `SNAP_ASTREINTE_TELEGRAM_SESSION_FILE`) pour
les garder hors du fichier de config.

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
vous fournissez, dans le langage de votre choix, qui expose quatre routes en
local :

| Route | Rôle |
|---|---|
| `GET /health` | `{ ok: true, voice: true }` |
| `GET /events` | flux SSE des messages reçus |
| `POST /send` | `{ contactId, text }` |
| `POST /sendVoice` | `{ contactId, audioBase64, mimeType }` |

Le contrat détaillé est en tête de `src/transports/bridge.ts`. Deux points sur
lesquels un pont se plante en général :

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
