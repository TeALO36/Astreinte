# Contrôler un compte Telegram : les bibliothèques

L'extension parle à Telegram par **MTProto** — le protocole interne de
Telegram — avec **votre compte personnel** : pas de jeton de bot, pas d'API
officielle payante, pas d'intermédiaire ni de prestataire tiers. Le compte
apparaît comme un compte utilisateur normal, jamais avec le badge « bot ».

Il existe plusieurs bibliothèques MTProto, dans plusieurs langages. Toutes
font la même chose (connexion avec un compte, lecture des messages, envoi de
texte, d'images, de notes vocales, d'appels), avec des forces et des
faiblesses différentes. Aujourd'hui l'extension utilise **GramJS** ; si un
jour GramJS ne fonctionne plus (blocage, arrêt du projet, bug), une autre
bibliothèque prend le relais. Ce document explique lesquelles et comment
basceler.

## Les bibliothèques

| Bibliothèque | Langage | Point fort | Point faible |
|---|---|---|---|
| **GramJS** | JavaScript / Node | C'est celle qui est déjà embarquée. Aucune dépendance Python, s'intègre au reste de l'extension (TypeScript). | Projet maintenu au ralenti ; quelques zones du protocole (appels vocaux) non couvertes. |
| **Telethon** | Python | La référence, maintenue activement, excellente documentation, support des appels vocaux via MTProto. | Impose un runtime Python à côté de Node. |
| **Pyrogram** | Python | Rapide et légère, très utilisée, API proche de l'API native de Telegram. | Suit de près les versions de Telethon pour le bas niveau ; communauté active. |
| **MTKruto** | TypeScript | Pensée pour être embarquée : zéro dépendance, générée à partir des schémas officiels, parfaite pour un plugin d'application. | Plus jeune, plus petite communauté, moins d'exemples. |
| **MadelineProto** | PHP | Autonome : gère la session et le QR lui-même, beaucoup de fonctionnalités. | PHP n'est pas un choix naturel dans cet écosystème Node. |

**Pourquoi MTProto et pas l'API Bot ?** L'API Bot (jeton de @BotFather) est
gratuite aussi, mais elle a deux limites : un bot ne peut pas lire ni répondre
dans des conversations où il n'a pas été ajouté, et il ne peut pas prendre
l'identité d'un compte utilisateur. Avec MTProto et votre compte, l'extension
lit et répond là où vous lisez et répondez vous-même, envoie de vraies notes
vocales, des photos éphémères, etc. Le mode **bot** est tout de même pris en
charge (voir plus bas) pour ceux qui préfèrent.

> **Avertissement** : piloter un compte personnel par un script (un
> « userbot ») est toléré pour un usage privé mais contraire aux conditions
> d'utilisation de Telegram. Utilisez de préférence un compte secondaire
> dédié ; le risque de restriction existe même avec votre propre compte.

## Où la bibliothèque est utilisée dans le dépôt

GramJS n'apparaît qu'à quatre endroits, tous du côté « canal » :

| Fichier | Rôle |
|---|---|
| `src/transports/telegram.ts` | Le driver de conversation du démon (recevoir, répondre, vocal). |
| `src/client/telegram-client.ts` | L'adaptateur de contrôle (SnapMCP) : lister, lire, envoyer texte/média/vocal. |
| `scripts/telegram-auth.mjs` | Les trois parcours de connexion : QR, téléphone, bot. |
| `scripts/telegram-login.mjs`, `scripts/test-bench-app.mjs` | CLI et banc de test qui appellent `telegram-auth.mjs`. |

Le reste de l'extension (contextes, persona, garde-fous, TTS, MCP) ne connaît
que le contrat `Transport` (`src/transports/types.ts`) et la couche
`SnapchatClient` (`src/client/types.ts`). C'est ce qui rend la bascule
contenue.

## Comment basculer vers une autre bibliothèque

Le principe : **remplacer le contenu des quatre fichiers ci-dessus, sans
toucher au reste**. Le contrat à respecter :

1. `Transport` (`src/transports/types.ts`) : `start`, `stop`, `sendText`,
   `sendVoice`, `setTyping?`. `sendVoice` doit échouer franchement si le
   format audio n'est pas accepté — l'appelant sait retomber sur du texte.
2. `SnapchatClient` (`src/client/types.ts`) : `getConversations`,
   `getMessages`, `sendMessage`, `sendSnap` (image/vidéo), `sendVoiceNote`,
   `markAsRead`, `listFriends`, et les appels.
3. Le fichier de session : une chaîne de session écrite dans
   `.telegram/session.txt`, produite une fois par le login. Les trois
   bibliothèques Python écrivent leur propre format (`.session` Telethon /
   Pyrogram) ; il faut soit exporter la session en chaîne (Telethon sait
   exporter via `StringSession`), soit adapter `src/telegram/session.ts` pour
   lire leur format. Le plus simple : garder le même fichier de chaîne de
   session, chaque bibliothèque sait importer/exporter une chaîne.
4. Les notes vocales : le canal attend de l'**OGG/Opus** (`voiceNote: true`).
   La conversion ffmpeg vit dans `src/audio/opus.ts` et reste valable quelle
   que soit la bibliothèque.

### Exemple de bascule : Telethon en Python — déjà écrit

Un pont Telethon **prêt à l'emploi** vit dans [`bridge-telethon/`](../bridge-telethon/)
(`bridge.py` + `requirements.txt` + README). Il expose exactement le contrat
du driver `bridge` (`GET /health`, `GET /events` en SSE, `POST /send`,
`POST /sendVoice`, `POST /sendMedia` — détaillé dans `src/transports/bridge.ts`)
et sait se connecter en compte personnel (`--login`, `--qr`) ou en bot
(`--bot`). `/health` annonce `voice: true` et `images: true` : notes vocales
et photos (générées par le persona, par exemple) passent par le pont.

```bash
cd bridge-telethon
pip install -r requirements.txt
python bridge.py --qr            # une fois : scannez le QR avec le téléphone
python bridge.py                 # puis : le pont écoute sur 127.0.0.1:8765
```

Et côté extension : `transport.driver = bridge`,
`transport.bridge_url = http://127.0.0.1:8765`. Le démon reçoit et répond par
le pont, notes vocales et images comprises (le pont annonce `voice: true` et
`images: true`, convertit le vocal avec ffmpeg si besoin). Un
`python bridge.py --dry-run` permet de valider le serveur et le contrat HTTP
sans aucun compte Telegram.

La voie directe (remplacer GramJS dans `telegram.ts` par un appel à un
sous-processus Telethon) revient au même coût, mais en l'écrivant dans le
dépôt : si vous préférez, gardez `TelegramTransport` comme façade et
déléguez ses cinq méthodes à un service Telethon lancé en tâche de fond.

## Vérifier la connexion sans rien envoyer

```bash
npm run build
node dist/index.js check        # vérifie configuration, canal, modèle, TTS
npm run test-bench              # banc de test local (diagnostic + actions)
```
