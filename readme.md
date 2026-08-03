# SnapMCP

> Serveur MCP pour contrôler Snapchat **ou Telegram** : messages, médias, **notes vocales** et conversations, avec un backend sélectionnable.

[![MCP](https://img.shields.io/badge/MCP-2026--07--28-blue)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-22-green)](https://nodejs.org/)

## 🎯 Fonctionnalités

- 🎙️ **Notes vocales** : vraies notes audio Telegram depuis un fichier, ou bouton micro Snapchat via ADB
- ✉️ **Messagerie** : messages texte et médias Snapchat/Telegram
- 📞 **Appels vocaux/vidéo** : appels live selon les capacités du backend (mock/Web/ADB ; Telegram live non implémenté)
- 👥 **Amis** : Lister les amis, voir les profils
- 💬 **Conversations** : Lister, lire les messages, marquer comme lu
- 🔌 **MCP natif** : Fonctionne avec Claude Desktop, Cursor, et tout client MCP compatible

## ⚡ Choix du backend (variable d'environnement `SNAPCHAT_CLIENT`)

| Mode | Setup | Messages | Médias | Notes vocales | Appels live |
|---|---|---|---|---|---|
| `mock` (défaut) | aucun | ✅ | ✅ simulés | ✅ simulées | ✅ simulés |
| `web` | Playwright + login QR | ✅ | ✅ snaps | ❌ | ✅ selon Snapchat |
| `adb` | téléphone Android + debug USB/Wi-Fi | ✅ | ⚠️ partiel | ✅ micro du téléphone | ✅ selon Snapchat |
| `telegram` | API ID/hash + session utilisateur | ✅ | ✅ fichiers | ✅ fichier audio réel | ❌ non implémentés |

> ⚠️ Snapchat Web ne supporte pas les notes vocales. Pour Snapchat, utilise ADB. Si tu préfères Telegram, le backend MTProto envoie une vraie note vocale depuis `audioPath` (idéalement `.ogg`/Opus). Le texte seul ne génère pas d'audio.

## 🌱 Variables d'environnement

Aucune variable n'est requise en mode mock (défaut).

| Variable | Valeurs | Description |
|---|---|---|
| `SNAPCHAT_CLIENT` | `mock` (défaut) · `web` · `adb` · `telegram` | Sélectionne le backend de chat |
| `SNAPCHAT_HEADLESS` | `1` (défaut) · `0` | Client web : `0` = navigateur visible (1er run, scan QR) · `1`/absent = headless |
| `ADB_SERIAL` | ex. `R58M1234ABC` | Client ADB : serial du device (`adb devices`) ; vide = device unique connecté |
| `SNAPCHAT_SESSION_TOKEN` | (réservé) | Futur client API reverse-engineered |
| `SNAPCHAT_DEVICE_ID` | (réservé) | Futur client API reverse-engineered |
| `TELEGRAM_API_ID` | entier | API ID de l'application créée sur [my.telegram.org](https://my.telegram.org) |
| `TELEGRAM_API_HASH` | secret | API hash de l'application Telegram |
| `TELEGRAM_SESSION_FILE` | `.telegram/session.txt` (défaut) | Fichier de session utilisateur créé par `npm run telegram:login` |
| `TELEGRAM_SESSION_STRING` | secret, optionnel | Alternative au fichier de session ; ne pas exposer ni commiter |

> 🔒 La session du client web (cookies d'authentification) est stockée dans `.snapmcp/state.json`, qui est ignoré par git (`.gitignore`) et ne doit jamais être commité.

## 🚀 Démarrage rapide

```bash
# Installer les dépendances
npm install

# Builder
npm run build

# Lancer (mode stdio pour client MCP)
npm start

# Développement (reload automatique)
npm run dev

# Test rapide (exercice des tools MCP sur le mock)
npm test
```

## 🖥️ Configuration Freebuff Preview

Les commandes du projet sont définies dans `package.json`. Pour démarrer un aperçu depuis l'UI Freebuff, configure :

| Paramètre | Commande | Détails |
|---|---|---|
| Install | `npm install` | Installation des dépendances |
| Dev / Preview | `npm run dev` | Serveur MCP en mode watch (stdio, pas de port HTTP) |
| Build | `npm run build` | Compilation TypeScript → `dist/` |

> ⚠️ **Note** : SnapMCP est un serveur MCP qui communique en **stdio** (standard input/output), pas un serveur web. L'aperçu n'expose donc pas de page web sur un port ; il est conçu pour être consommé par un client MCP (Claude Desktop, Cursor, etc.). Pour tester les tools, connecte ton client MCP à la commande `npm start`.

## 🔧 Configuration client MCP

Ajoute ce bloc à la config de ton client MCP :

```json
{
  "mcpServers": {
    "snapmcp": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/chemin/vers/SnapMCP"
    }
  }
}
```

## 🛠️ Tools MCP disponibles

| Tool | Description |
|---|---|
| `send_message` | Envoyer un message texte |
| `send_snap` | Envoyer un snap photo/vidéo |
| `send_voice_note` | 🎙️ Note vocale : fichier audio réel en Telegram, micro ADB pour Snapchat, simulation en mock |
| `voice_call` | Démarrer un appel vocal |
| `end_call` | Terminer un appel |
| `call_status` | Statut d'un appel |
| `active_call` | Appel en cours |
| `get_conversations` | Liste des conversations |
| `get_conversation` | Détail d'une conversation |
| `get_messages` | Messages d'une conversation |
| `mark_as_read` | Marquer comme lu |
| `list_friends` | Liste des amis |
| `get_friend` | Profil d'un ami |

## 📁 Structure

```
src/
├── index.ts          # Point d'entrée, transport stdio + sélection client
├── server.ts         # Définition des tools MCP Snapchat/Telegram
└── client/
    ├── types.ts      # Interface SnapchatClient + types
    ├── mock-client.ts # Mock in-memory (développement)
    ├── web-client.ts  # Playwright sur web.snapchat.com
    ├── adb-client.ts      # adb CLI sur téléphone Android
    ├── telegram-client.ts # GramJS/MTProto sur compte Telegram utilisateur
    └── index.ts            # Factory createSnapchatClient()
scripts/
├── smoke-test.mjs      # Exercice des tools via stdio (npm test)
└── telegram-login.mjs  # Première connexion Telegram et sauvegarde de session
docs/
├── API.md            # Documentation API complète
└── ARCHITECTURE.md   # Décisions d'architecture + analyse vocaux
```

## 🔄 Utilisation des vrais clients

```bash
# Client Web (messages, snaps, appels live) — premier login via QR code
SNAPCHAT_CLIENT=web SNAPCHAT_HEADLESS=0 npm start   # scan du QR une fois
SNAPCHAT_CLIENT=web npm start                       # ensuite, headless

# Client ADB (messages + notes vocales) — téléphone branché ou Wi-Fi
SNAPCHAT_CLIENT=adb ADB_SERIAL=<serial> npm start

# Client Telegram (messages + vraies notes vocales audio)
# 1) renseigner TELEGRAM_API_ID et TELEGRAM_API_HASH
npm run telegram:login
SNAPCHAT_CLIENT=telegram npm start
```

### Setup Telegram (messages + notes vocales)

1. Crée une application sur [my.telegram.org](https://my.telegram.org) et récupère `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`.
2. Lance `npm run telegram:login`, puis termine la connexion avec ton numéro, le code reçu dans Telegram et ton mot de passe 2FA si activé.
3. La session est sauvegardée dans `.telegram/session.txt` (ignoré par git). Traite-la comme un mot de passe : ne la partage jamais.
4. Lance `SNAPCHAT_CLIENT=telegram npm start`.
5. Pour `send_voice_note`, fournis `conversationId` et `audioPath`. Utilise de préférence un fichier `.ogg` mono encodé Opus pour obtenir le rendu natif « note vocale » de Telegram ; `text` est une légende/transcription facultative.

> Le backend utilise un compte utilisateur MTProto, pas un bot. Les envois automatisés peuvent déclencher des limites anti-spam ou un bannissement : respecte les règles de Telegram et utilise un compte dédié si nécessaire.

### Setup ADB (notes vocales)

1. Téléphone Android : Paramètres → Options développeur → **Débogage USB**
2. Connecte le téléphone (USB, ou `adb pair` + `adb connect` en Wi-Fi)
3. Ouvre Snapchat sur le téléphone et connecte-toi **une fois** manuellement
4. Garde l'écran déverrouillé, Snapchat en arrière-plan
5. `adb devices` doit lister ton téléphone → puis `SNAPCHAT_CLIENT=adb npm start`

> Les notes vocales sont envoyées en maintenant réellement le bouton micro pendant la durée estimée du texte (~2,5 mots/s), puis en le relâchant. Le serveur ne génère pas lui-même l'audio : parle dans le micro du téléphone ou utilise une solution TTS/audio côté téléphone. `audioPath` n'est pas injecté directement dans le micro par ADB.

> 📖 Voir [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) pour l'analyse complète (émulation, web, ADB).

## ⚠️ Avertissement

Ce projet est à but éducatif et expérimental. L'automatisation de Snapchat viole les conditions d'utilisation de Snap Inc. et peut entraîner le bannissement permanent de ton compte. Utilise à tes risques et périls.
