# Pont Telegram — Telethon (Python)

Un pont prêt à l'emploi pour le **driver `bridge`** de l'extension Astreinte,
écrit avec **Telethon** au lieu de GramJS. C'est la démonstration de la
bascule de bibliothèque documentée dans
[`../docs/TELEGRAM-LIBRARIES.md`](../docs/TELEGRAM-LIBRARIES.md) : le canal
est un driver interchangeable, et l'extension ne change pas d'une ligne quand
on remplace le moteur MTProto.

Le pont expose le contrat HTTP local décrit en tête de
`../src/transports/bridge.ts` :

| Route | Rôle |
|---|---|
| `GET /health` | `{ ok, voice: true, detail }` — dit si le compte est connecté |
| `GET /events` | flux SSE des messages reçus |
| `POST /send` | `{ contactId, text }` |
| `POST /sendVoice` | `{ contactId, audioBase64, mimeType }` |

## Installation

```bash
cd bridge-telethon
python -m venv .venv
# Windows : .venv\Scripts\activate   —  macOS/Linux : source .venv/bin/activate
pip install -r requirements.txt
```

## Connexion (une seule fois)

Créez d'abord `api_id` / `api_hash` sur **https://my.telegram.org** →
« API development tools » :

```bash
export TELEGRAM_API_ID=12345
export TELEGRAM_API_HASH=abcdef...
```

Puis, au choix (compte personnel ou bot) :

```bash
python bridge.py --login          # téléphone + code + mot de passe 2FA
python bridge.py --qr             # QR code : scannez avec le téléphone
python bridge.py --bot 123456:ABC # bot de @BotFather, aucune session à créer
```

La session est écrite dans `telethon.session` (ou le chemin de
`TELEGRAM_SESSION`) : c'est une clé d'authentification complète, **ne la
commitez jamais**. Le fichier `.gitignore` de l'extension l'ignore déjà
(`*.session`). Si vous préférez, renseignez `TELEGRAM_BOT_TOKEN` dans
l'environnement et lancez simplement `python bridge.py` : un jeton de bot
suffit.

## Lancer

```bash
python bridge.py                   # écoute sur 127.0.0.1:8765
```

## Brancher l'extension

Dans la configuration de l'extension :

- `transport.driver = bridge`
- `transport.bridge_url = http://127.0.0.1:8765`

Vérifiez sans rien envoyer : `node dist/index.js check`. Le démon
(`npm run start`) reçoit alors les messages par le pont et répond, notes
vocales comprises (le pont annonce `voice: true` sur `/health`).

## Tester le contrat sans compte Telegram

```bash
python bridge.py --dry-run
```

Le serveur démarre sans aucun compte : `/health` répond 503 avec
`{ ok: false }` (l'extension affiche « le pont ne répond pas » — normal), le
flux `/events` reste ouvert avec ses `: ping`, et `/send` / `/sendVoice`
répondent 503 « pont non connecté ». Utile pour valider l'installation et le
contrat HTTP avant de se connecter.

## Notes

- **`contactId`** est l'identifiant numérique de la conversation (stable) :
  un `@pseudo` fonctionne aussi au moment de l'envoi. C'est la clé du
  contexte par interlocuteur côté extension — ne le changez pas.
- Le pont **n'émet jamais ses propres envois** (`outgoing` filtré) et
  déduplique par identifiant de message : sans cela, l'extension se
  répondrait à elle-même en boucle.
- Les **notes vocales** partent en OGG/Opus (`voice_note=True`, avec forme
  d'onde). Si le fichier reçu n'est pas en OGG/Opus, `ffmpeg` est utilisé
  pour convertir ; sans ffmpeg, l'envoi échoue franchement et l'extension
  retombe en texte (c'est le comportement prévu par le contrat).
- Compte personnel = « userbot » : toléré pour un usage privé, contraire aux
  conditions d'utilisation de Telegram. Utilisez de préférence un compte
  secondaire dédié.
