# SnapMCP — Documentation API

## Architecture

SnapMCP est un serveur MCP (Model Context Protocol) qui expose des **tools** pour contrôler Snapchat ou Telegram. Il est construit avec le SDK `@modelcontextprotocol/server` v2 (spécification 2026-07-28) et fonctionne en transport **stdio** (standard input/output).

```
┌─────────────┐     stdio      ┌──────────────┐     interface      ┌──────────────────┐
│  MCP Client │ ◄────────────► │  MCP Server   │ ◄───────────────► │  SnapchatClient  │
│ (Claude,    │   JSON-RPC     │  (snapmcp)    │                    │  (mock ou réel)  │
│  Cursor…)   │                │               │                    │                  │
└─────────────┘                └──────────────┘                    └──────────────────┘
```

La couche `SnapchatClient` est une **interface TypeScript** conservée comme contrat commun pour les backends Snapchat et Telegram. L'implémentation mock (`MockSnapchatClient`) simule un backend complet en mémoire ; les implémentations réelles utilisent Playwright/ADB pour Snapchat et GramJS/MTProto pour Telegram.

## Outils MCP (Tools)

### Conversations

| Tool | Description |
|---|---|
| `get_conversations` | Lister les conversations récentes du backend choisi (individuelles et groupes) |
| `get_conversation` | Détails d'une conversation spécifique |
| `get_messages` | Récupérer les messages d'une conversation |
| `mark_as_read` | Marquer une conversation comme lue |

### Messagerie

| Tool | Description |
|---|---|
| `send_message` | Envoyer un message texte |
| `send_snap` | Envoyer un média photo/vidéo (snap Snapchat ou fichier Telegram) |
| `send_voice_note` | 🎙️ Envoyer une note vocale — fichier audio réel en Telegram, micro du téléphone en Snapchat/ADB |

### Amis

| Tool | Description |
|---|---|
| `list_friends` | Lister les amis connectés |
| `get_friend` | Profil détaillé d'un ami |

### Appels Vocaux

| Tool | Description |
|---|---|
| `voice_call` | Démarrer un appel vocal |
| `end_call` | Terminer un appel actif |
| `call_status` | Vérifier le statut d'un appel |
| `active_call` | Récupérer l'appel actif (ou null) |

## Schémas de données

### Conversation

```json
{
  "id": "conv_1",
  "type": "individual",
  "displayName": "Emma Dubois",
  "participants": ["me", "friend_1"],
  "lastMessage": { … },
  "lastActivity": "2026-08-03T10:00:00.000Z",
  "unreadCount": 1
}
```

### Message

```json
{
  "id": "msg_1",
  "conversationId": "conv_1",
  "senderId": "friend_1",
  "type": "text",
  "text": "Salut !",
  "timestamp": "2026-08-03T09:55:00.000Z",
  "status": "opened",
  "saved": true
}
```

### Friend

```json
{
  "id": "friend_1",
  "displayName": "Emma Dubois",
  "username": "emma.dubois",
  "bitmojiUrl": "https://bitmoji.api.snapchat.com/avatar/emma.png",
  "status": "connected",
  "hasStory": true,
  "lastActive": "2026-08-03T09:58:00.000Z"
}
```

### VoiceCall

```json
{
  "callId": "call_101",
  "conversationId": "conv_1",
  "participants": ["me", "friend_1"],
  "state": "in_progress",
  "startedAt": "2026-08-03T10:02:00.000Z",
  "outgoing": true
}
```

États possibles : `idle`, `ringing_outgoing`, `ringing_incoming`, `in_progress`, `ended`.

## Utilisation (mode mock)

```bash
# Démarrer le serveur MCP (stdio)
npm run snapmcp

# Test rapide des tools sur le mock
npm run smoke
```

Le serveur MCP communique via stdin/stdout. Configure ton client MCP (Claude Desktop, Cursor, etc.) pour pointer vers `npm run snapmcp` dans le répertoire du projet.

### Config exemple pour Claude Desktop

```json
{
  "mcpServers": {
    "snapmcp": {
      "command": "node",
      "args": ["dist/snapmcp.js"],
      "cwd": "/chemin/vers/SnapMCP"
    }
  }
}
```

## Basculer vers un vrai client

Sélection par variable d'environnement (`src/client/index.ts`) :

```bash
SNAPCHAT_CLIENT=mock   # défaut — mock in-memory
SNAPCHAT_CLIENT=web    # Playwright sur web.snapchat.com
SNAPCHAT_CLIENT=adb      # téléphone Android via adb CLI
SNAPCHAT_CLIENT=telegram # compte utilisateur Telegram via GramJS/MTProto
```

Pour créer un nouveau client, implémente l'interface `SnapchatClient` (voir `src/client/types.ts`) et ajoute-le à la factory `createSnapchatClient()` :

```typescript
// src/client/real-client.ts
import type { SnapchatClient, … } from "./types.js";

export class RealSnapchatClient implements SnapchatClient {
  async sendMessage(params: SendMessageParams): Promise<Message> {
    // Ton implémentation réelle ici
  }
  // … toutes les autres méthodes
}
```

## Configuration Telegram

Le backend Telegram utilise un **compte utilisateur MTProto**, pas un bot. Il faut créer une application sur [my.telegram.org](https://my.telegram.org), puis fournir `TELEGRAM_API_ID` et `TELEGRAM_API_HASH`.

```bash
export TELEGRAM_API_ID=123456
export TELEGRAM_API_HASH=...
npm run telegram:login
SNAPCHAT_CLIENT=telegram npm run snapmcp
```

`telegram:login` demande le numéro de téléphone, le code reçu dans Telegram et le mot de passe 2FA éventuel. Il écrit une session réutilisable dans `.telegram/session.txt`, ignoré par git. Cette session est un secret équivalent à une connexion complète : ne jamais la publier.

## Notes vocales (`send_voice_note`)

La note vocale est un **message audio** envoyé dans le chat (le « vocal » façon WhatsApp).

| Client | Support | Détail |
|---|---|---|
| mock | ✅ | Simulé : durée estimée depuis le texte |
| web | ❌ | Snapchat Web n'a pas de bouton micro ni de jointure audio |
| adb | ✅ | Maintien réel du bouton micro ; le texte est un transcript/durée et l'audio vient du téléphone |
| telegram | ✅ | `audioPath` est envoyé comme vraie note vocale avec `voiceNote: true`; préférer OGG/Opus mono |

Paramètres :

```json
{
  "conversationId": "conv_1",
  "text": "Salut, c'est SnapMCP !",
  "language": "fr-FR"
}
```

En mode Telegram, une note vocale réelle nécessite un fichier audio :

```json
{
  "conversationId": "@destinataire_ou_id",
  "audioPath": "/chemin/note.ogg",
  "text": "Transcription facultative"
}
```

Pour Telegram, `audioPath` est transmis à GramJS avec `voiceNote: true`. Un fichier OGG/Opus mono est recommandé pour obtenir le rendu natif de note vocale ; le texte est une légende/transcription facultative. Le backend ne synthétise pas automatiquement le texte.

Pour ADB, `audioPath` est refusé : `adb push` ne suffit pas à injecter un fichier dans le microphone Snapchat. Le texte sert seulement de transcript et à estimer la durée du maintien ; le son doit venir du téléphone.

> Les appels live Telegram ne sont pas implémentés par cet adaptateur ; `voice_call` renvoie une erreur explicite au lieu de simuler un succès.
