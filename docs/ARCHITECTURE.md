# SnapMCP — Décisions d'Architecture

## Objectif

Exposer le contrôle de Snapchat ou Telegram sous forme de **tools MCP**. La couche métier se branche sur les tools (`send_message`, `send_voice_note`, `voice_call`, …) sans connaître le backend sélectionné.

## Capabilités réelles de Snapchat (vérifiées, août 2026)

| Capabilité | Snapchat Web | App Android (via ADB) |
|---|---|---|
| Messages texte | ✅ | ✅ |
| Snaps photo/vidéo | ✅ | ⚠️ (UI complexe) |
| **Notes vocales (audio)** | ❌ **non supporté** | ✅ **bouton micro** |
| Appels vocaux/vidéo (live) | ✅ (selon compte/région) | ✅ |
| Historique de messages | ⚠️ scraping | ❌ fragile |

**Conclusion clé** : les **notes vocales** (le « vocal » que tu veux) sont **mobile-only** :
- Le bouton micro n'existe pas sur `web.snapchat.com` — la page officielle liste uniquement chat, snaps, appels et partage d'écran.
- On ne peut pas joindre un fichier audio (mp3/m4a) dans un chat Snapchat : l'audio s'envoie uniquement via l'enregistrement par le bouton micro de l'app mobile.
- Donc : **web = messages/snaps/appels**, **ADB = messages + notes vocales**.

## Les 4 implémentations de `SnapchatClient`

```
SnapchatClient (interface — le contrat)
├── MockSnapchatClient   ← mock in-memory (défaut, zéro setup, dev/tests)
├── WebSnapchatClient    ← Playwright sur web.snapchat.com (headless, session QR)
├── AdbSnapchatClient    ← adb CLI sur téléphone Android (USB ou Wi-Fi)
└── TelegramSnapchatClient ← GramJS/MTProto sur compte utilisateur Telegram
```

Sélection par variable d'environnement dans `src/client/index.ts` :

```bash
SNAPCHAT_CLIENT=mock   # défaut — aucun setup
SNAPCHAT_CLIENT=web    # Playwright — messages, snaps, appels live
SNAPCHAT_CLIENT=adb      # téléphone Android — messages, notes vocales
SNAPCHAT_CLIENT=telegram # Telegram MTProto — messages, fichiers audio/notes vocales
```

## Client Telegram (GramJS/MTProto)

- **Principe** : utiliser l'API MTProto avec un compte utilisateur, via le package `telegram` (GramJS), plutôt que l'API Bot.
- **Identifiants** : `TELEGRAM_API_ID` et `TELEGRAM_API_HASH` viennent de [my.telegram.org](https://my.telegram.org).
- **Connexion** : `npm run telegram:login` réalise la connexion interactive (numéro, code Telegram, 2FA) et sauvegarde une session réutilisable dans `.telegram/session.txt`.
- **Notes vocales** : `send_voice_note` exige `audioPath` et appelle `sendFile(..., { voiceNote: true })`. Un fichier OGG/Opus mono est recommandé pour le rendu natif ; `text` est une légende/transcription facultative.
- **Limites** : le serveur ne transforme pas le texte en audio, et les appels live Telegram ne sont pas implémentés. Les comptes utilisateurs automatisés doivent respecter les règles anti-spam et les limites Telegram.

## Client Web (Playwright)

- **Principe** : piloter `web.snapchat.com` dans Chromium (headless ou non).
- **Login** : première exécution en mode `headless:0` → scan du QR code ; la session est sauvegardée dans `.snapmcp/state.json` et réutilisée ensuite en headless.
- **Permissions** : le contexte Playwright pré-grant microphone/caméra (`--use-fake-ui-for-media-stream`) pour les appels.
- **Notes vocales** : impossible → le tool `send_voice_note` lève une erreur explicite qui redirige vers le client ADB.
- **Fragilité** : les sélecteurs DOM changent souvent → centralisés dans la constante `SELECTORS` de `web-client.ts`.

## Client ADB (téléphone Android)

- **Principe** : automatiser l'app Snapchat Android via `adb shell` (uiautomator dump + input tap/text/swipe).
- **Setup** : téléphone avec debug USB, Snapchat connecté une fois manuellement, écran déverrouillé.
- **Notes vocales** : le client cherche le bouton micro (label localisé, ex. « Voice note »), effectue un vrai `adb shell input swipe x y x y durée` pour maintenir le bouton, puis le relâche pour envoyer. Le texte ne déclenche pas de TTS intégré : il sert de transcript et à estimer la durée ; le son doit venir d'une personne ou d'une solution TTS/audio côté téléphone.
- **Limite** : injecter un fichier audio pré-enregistré dans le micro via adb n'est pas fiable (nécessite un mic virtuel rooté). Documenté dans le code.
- **ADB sans câble** : `adb pair` + `adb connect` (debug sans fil, Android 11+) → pas besoin de garder le téléphone branché, juste sur le même réseau.

## Pourquoi pas l'émulation ?

Snapchat détecte agressivement les émulateurs (Play Integrity, attestation de device) : les comptes loggés depuis un émulateur (BlueStacks, Android Studio, Genymotion) sont bannis quasi-immédiatement. Même Waydroid (conteneur Android natif) reste risqué. **Conclusion : un vrai téléphone Android (via ADB) est l'option fiable ; l'émulation n'est pas recommandée.**

## Pipeline voix (notes vocales) — le « vocal » demandé

1. L'agent IA appelle `send_voice_note(conversationId, text)` ; `text` reste un transcript et une estimation de durée.
2. Le client ADB ouvre le chat puis exécute un maintien réel du micro (`input swipe x y x y durée`).
3. Pendant ce maintien, la voix réelle ou un TTS/audio configuré côté téléphone fournit le son.
4. `audioPath` n'est pas envoyé par ADB seul : copier un fichier avec `adb push` ne l'injecte pas dans le microphone Snapchat.

## Stack technique

| Décision | Choix | Raison |
|---|---|---|
| Langage | TypeScript | Écosystème MCP natif |
| SDK MCP | `@modelcontextprotocol/server` v2 | Dernière spec (2026-07-28) |
| Validation | Zod v4 | Intégré au SDK v2 |
| Browser automation | Playwright | Gestion permissions/streams + headless |
| Device automation | adb CLI | UIAutomator + input events |
| Telegram user API | GramJS/MTProto | Compte personnel, conversations et notes vocales audio |
| Transport | stdio | Standard MCP |

## Prochaines étapes pour la production

1. Tester `SNAPCHAT_CLIENT=web` : premier login QR, puis messages + appels.
2. Tester `SNAPCHAT_CLIENT=adb` : messages + notes vocales sur téléphone réel.
3. Tester `SNAPCHAT_CLIENT=telegram` avec un fichier OGG/Opus et un compte dédié.
4. Implémenter la génération audio si le produit doit convertir le texte en note vocale.
5. Rate limiting + retry pour éviter les bans et les FloodWait.
