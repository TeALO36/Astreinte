# L'extension dans Locaryn

[Locaryn](https://github.com/Locaryn/Locaryn) est une application de
développement assisté par LLM, open source, modulaire : on y installe des
extensions en collant l'adresse d'un dépôt Git. Cette extension
(`snap-astreinte`) s'y installe comme n'importe quelle autre, et tout ce que
le **banc de test** sait faire se retrouve dans l'application : les réglages
de connexion deviennent un formulaire, et les actions (lire, envoyer, vocal)
deviennent des outils appelables.

## Installer

1. Ouvrez **Réglages → Extensions → Ajouter**.
2. Collez l'adresse du dépôt : `TeALO36/Astreinte` (ou l'URL GitHub
   complète, ou un dossier local `./extension` pendant le développement).
3. L'application lit `plugin.json`, affiche ce que l'extension demande
   (réseau, shell, variables d'environnement) et l'installe **désactivée**.
4. Activez-la, puis accordez les permissions demandées — c'est un geste
   séparé et délibéré.
5. Ouvrez les **réglages de l'extension** : le formulaire affiche le même
   contenu que la section « Connexion » du banc de test.

## Ce que les réglages contiennent

Le formulaire de réglages est construit par Locaryn à partir de
`plugin.json` → `config.schema` : aucune des deux parties ne code la liste en
dur. Les valeurs sont stockées par l'application dans
`<extension>/.data/config.json`, qui est exactement le fichier que lit
l'extension (`SNAP_ASTREINTE_HOME` pointe dessus dans `mcp/mcp.json`) — un
réglage modifié dans l'application est pris en compte au prochain appel, sans
aller-retour manuel.

| Section | Ce qu'on y règle | Équivalent banc de test |
|---|---|---|
| **Canal** | canal (Telegram/Snapchat), connexion (compte ou bot), api_id, api_hash, jeton de bot, fichier de session | section « Connexion à tester » + « Connexion Telegram » |
| **Voix** | mode des notes vocales, moteur TTS, serveur, voix | section « Vocal PC » et réglage `voice.*` |
| **Images** | images en réponse (à la demande ou jamais), moteur (HTTP ou commande), endpoint, modèle, taille | réglages `image.*` |
| **Alertes** | prévenir l'exploitant sur Telegram | réglages `notify.*` |

Deux façons de se connecter, aucune ne coûte rien :

- **Compte personnel** : créez `api_id`/`api_hash` sur
  https://my.telegram.org (API development tools), renseignez-les, puis
  lancez la connexion par QR ou téléphone (`npm run telegram:login:qr` ou
  `npm run telegram:login`) — ou utilisez le banc de test.
- **Bot** : collez le jeton de @BotFather dans le réglage « Jeton de bot » et
  passez la connexion en mode « bot ». Aucune session à créer : la première
  utilisation s'authentifie toute seule.

## Les outils dans l'application

L'extension déclare un serveur MCP (`mcp/mcp.json`) : ses outils sont
appelables par le modèle dans le chat de Locaryn, sous le préfixe du serveur.
Ce sont les mêmes actions que le banc de test :

| Outil | Action | Banc de test équivalent |
|---|---|---|
| `get_conversations` | liste les conversations récentes | « Vérifier ce backend » |
| `get_messages` | lit les messages d'une conversation | — |
| `send_message` | envoie un texte | « Envoyer texte » |
| `send_snap` | envoie une image ou une vidéo (conservée, 10 s, vue unique) | « Envoyer média » |
| `send_voice_note` | envoie une **vraie note vocale** (OGG/Opus, avec forme d'onde) | « Envoyer vocal » |
| `mark_as_read` | marque une conversation comme lue | — |
| `telegram_login_qr` | démarre la connexion Telegram par QR (compte personnel) | « Se connecter par QR (compte) » |
| `telegram_login_status` | état de la connexion en cours (en attente, mot de passe, terminée) | le statut affiché à côté du QR |
| `telegram_login_password` | fournit le mot de passe 2FA demandé | le champ mot de passe du banc |
| `telegram_login_bot` | connecte un bot avec son jeton (@BotFather) | « Se connecter en bot » |
| `telegram_login_cancel` | annule la connexion en cours | « Annuler » |
| `list_friends` / `get_friend` | annuaire des contacts | — |
| `snap_status`, `snap_list_contacts`, `snap_read_conversation`, … | supervision du persona (serveur MCP de supervision) | — |

Le persona démon peut lui aussi répondre par une image : si `image.mode` est
activé et qu'un moteur (`image.engine`) est configuré, une demande « envoie-moi
une photo de chat » déclenche la génération locale puis l'envoi en photo avec
légende — et retombe en texte si la génération échoue.

Exemple d'usage dans le chat : « Envoie à @Jean l'image qui vient d'être
générée, puis un vocal disant *c'est prêt* ».

### Connecter Telegram depuis Locaryn

La connexion se fait dans le chat, sans ouvrir le banc de test ni un terminal :

1. Renseignez `api_id`/`api_hash` dans les réglages de l'extension (groupe
   Canal) — ou demandez à l'assistant de vous guider.
2. Dites « connecte mon compte Telegram ». L'assistant appelle
   `telegram_login_qr` et reçoit un lien `t.me/login/…`.
3. Ouvrez ce lien dans Telegram sur votre téléphone et confirmez. Si le
   compte a la 2FA, l'assistant vous demandera le mot de passe et le passera
   par `telegram_login_password`.
4. `telegram_login_status` confirme la connexion : la session est enregistrée
   dans `$SNAP_ASTREINTE_HOME/.telegram/session.txt` (sous Locaryn :
   `/.data/.telegram/session.txt`), au même endroit que le lira le démon.

Pour un **bot** à la place : « connecte mon bot Telegram » avec le jeton de
@BotFather — `telegram_login_bot` fait tout, aucune session à créer.

> Un serveur MCP ne démarre que si l'extension est **active**. Les outils
> d'envoi agissent réellement sur le compte configuré : vérifiez d'abord avec
> `get_conversations` que vous êtes bien connecté.

## Pendant le développement

Installez l'extension depuis un dossier local (`./extension` dans Locaryn) :
le manifeste est relu à chaque installation, et `npm run build` dans ce dépôt
suffit pour recompiler `dist/`. La boucle :

```bash
cd extension
npm ci && npm run build
# dans Locaryn : Réglages → Extensions → Ajouter → ./extension
# puis ouvrez le banc de test pour vérifier la connexion :
npm run test-bench
```

## Permissions demandées

- **Réseau** : recevoir et envoyer les messages, se connecter à Telegram
  (QR ou jeton), appeler le LLM et le TTS.
- **Shell** : lancer la commande TTS locale et ffmpeg pour les vocaux.
- **Variables d'environnement** : `SNAP_ASTREINTE_TELEGRAM_API_ID`,
  `_API_HASH`, `_SESSION_FILE`, `_AUTH_TYPE`, `_BOT_TOKEN`,
  `SNAP_ASTREINTE_LLM_API_KEY` — les secrets peuvent ainsi rester hors du
  fichier de config.
