#!/usr/bin/env python3
"""
Pont Telegram (Telethon) pour l'extension Astreinte — driver « bridge ».

Expose le contrat HTTP local décrit en tête de `src/transports/bridge.ts` :

    GET  /health      -> { ok, voice, images, detail }
    GET  /events      -> flux SSE des messages entrants
    POST /send        -> { contactId, text }
    POST /sendVoice   -> { contactId, audioBase64, mimeType }
    POST /sendMedia   -> { contactId, mediaBase64, mimeType, caption }

C'est la preuve de la bascule de bibliothèque documentée dans
`docs/TELEGRAM-LIBRARIES.md` : l'extension parle à Telegram par MTProto via
Telethon (Python) au lieu de GramJS (Node), sans changer une ligne côté
extension — le canal est un driver interchangeable.

Compte personnel ou bot, rien à payer : un compte personnel apparaît comme un
compte utilisateur normal (jamais le badge « bot »), et un bot suffit pour les
cas où il est acceptable.

Usage :

    pip install -r requirements.txt

    # Connexion, une seule fois (trois voies) :
    python bridge.py --login            # téléphone + code + mot de passe 2FA
    python bridge.py --qr               # QR code, scan avec le téléphone
    python bridge.py --bot <jeton>      # bot de @BotFather

    # Puis lancer le pont :
    python bridge.py

    # Et configurer l'extension :
    #   transport.driver     = bridge
    #   transport.bridge_url = http://127.0.0.1:8765

    # Sans compte Telegram (vérifier le serveur / le contrat HTTP) :
    python bridge.py --dry-run

Variables d'environnement : TELEGRAM_API_ID, TELEGRAM_API_HASH,
TELEGRAM_SESSION (chemin du fichier de session, défaut « telethon.session »),
TELEGRAM_BOT_TOKEN, PORT (défaut 8765), HOST (défaut 127.0.0.1).

Attention : la session Telethon (.session) est une clé d'authentification
complète — ne la commitez jamais.
"""

import argparse
import asyncio
import base64
import json
import logging
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from aiohttp import web

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
log = logging.getLogger("telethon-bridge")

try:
    from telethon import TelegramClient, events
    from telethon.tl.types import MessageMediaDocument, DocumentAttributeAudio
except ImportError:
    log.error("Telethon n'est pas installé. Lancez : pip install -r requirements.txt")
    sys.exit(1)

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8765"))
SESSION_FILE = os.environ.get("TELEGRAM_SESSION", "telethon.session")

RECENT_LIMIT = 1000


class Bridge:
    """Le pont : client Telethon + serveur HTTP aux quatre routes du contrat."""

    def __init__(self, client: TelegramClient, dry_run: bool = False):
        self.client = client
        self.dry_run = dry_run
        self.sse_clients: set[asyncio.Queue] = set()
        # Identifiants déjà émis : ne jamais rejouer un message (le contrat
        # l'exige) — y compris ceux que le pont vient lui-même d'envoyer,
        # sinon l'extension se répondrait à elle-même en boucle.
        self.recent: set[int] = set()

    # -- État -------------------------------------------------------------

    async def me_label(self) -> str:
        try:
            me = await self.client.get_me()
            if me is None:
                return "non connecté"
            return f"@{me.username}" if me.username else f"{me.first_name or 'compte'}"
        except Exception:
            return "non connecté"

    def connected(self) -> bool:
        return not self.dry_run and self.client.is_connected() and self.client.is_user_authorized()

    # -- Routes -----------------------------------------------------------

    async def health(self, _request: web.Request) -> web.Response:
        if self.dry_run:
            return web.json_response(
                {"ok": False, "voice": True, "images": True, "detail": "dry-run : aucun compte Telegram"},
                status=503,
            )
        ok = self.connected()
        return web.json_response(
            {
                "ok": ok,
                "voice": True,
                "images": True,
                "detail": await self.me_label() if ok else "non connecté",
            },
            status=200 if ok else 503,
        )

    async def events(self, request: web.Request) -> web.StreamResponse:
        resp = web.StreamResponse(
            headers={
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            }
        )
        await resp.prepare(request)
        queue: asyncio.Queue = asyncio.Queue()
        self.sse_clients.add(queue)
        try:
            await resp.write(b": pret\n\n")
            while True:
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15)
                    data = json.dumps(payload, ensure_ascii=False)
                    await resp.write(f"data: {data}\n\n".encode("utf-8"))
                except asyncio.TimeoutError:
                    # Commentaire de garde : garde la connexion en vie et permet
                    # à l'extension de détecter une coupure.
                    await resp.write(b": ping\n\n")
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        finally:
            self.sse_clients.discard(queue)
        return resp

    async def send_media(self, request: web.Request) -> web.Response:
        if not self.connected():
            return self._not_connected()
        body = await request.json()
        contact_id = str(body.get("contactId") or "")
        media = base64.b64decode(str(body.get("mediaBase64") or ""))
        mime = str(body.get("mimeType") or "")
        caption = str(body.get("caption") or "")
        if not contact_id or not media:
            return web.json_response(
                {"error": "contactId et mediaBase64 sont requis"}, status=400
            )
        try:
            peer = await self.client.get_input_entity(contact_id)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

        with tempfile.NamedTemporaryFile(
            suffix=_extension_for(mime), delete=False
        ) as tmp:
            tmp_path = tmp.name
            tmp.write(media)
        try:
            # force_document=False : Telethon détecte le type et envoie une
            # photo (jpg/png), pas un fichier joint.
            await self.client.send_file(
                peer, tmp_path, caption=caption or None, force_document=False
            )
            return web.json_response({})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    async def send(self, request: web.Request) -> web.Response:
        if not self.connected():
            return self._not_connected()
        body = await request.json()
        contact_id = str(body.get("contactId") or "")
        text = str(body.get("text") or "")
        if not contact_id or not text:
            return web.json_response({"error": "contactId et text sont requis"}, status=400)
        try:
            peer = await self.client.get_input_entity(contact_id)
            await self.client.send_message(peer, text)
            return web.json_response({})
        except Exception as exc:  # identifiant inconnu, réseau, …
            return web.json_response({"error": str(exc)}, status=400)

    async def send_voice(self, request: web.Request) -> web.Response:
        if not self.connected():
            return self._not_connected()
        body = await request.json()
        contact_id = str(body.get("contactId") or "")
        audio = base64.b64decode(str(body.get("audioBase64") or ""))
        mime = str(body.get("mimeType") or "")
        if not contact_id or not audio:
            return web.json_response(
                {"error": "contactId et audioBase64 sont requis"}, status=400
            )
        try:
            peer = await self.client.get_input_entity(contact_id)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

        # Une note vocale Telegram est un OGG/Opus avec sa forme d'onde. Si le
        # fichier reçu n'en est pas un, on convertit avec ffmpeg (comme le fait
        # l'extension côté Node), sinon on envoie tel quel.
        needs_conversion = "ogg" not in mime and "opus" not in mime
        suffix = ".ogg" if needs_conversion else _extension_for(mime)
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp_path = tmp.name
            tmp.write(audio)
        try:
            if needs_conversion:
                tmp_path = _to_opus(tmp_path)
            await self.client.send_file(peer, tmp_path, voice_note=True)
            return web.json_response({})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    def _not_connected(self) -> web.Response:
        return web.json_response(
            {"error": "pont non connecté : lancez python bridge.py --login ou --qr"},
            status=503,
        )

    # -- Réception --------------------------------------------------------

    def register_handlers(self) -> None:
        if self.dry_run or self.client is None:
            return  # dry-run : aucun compte, donc aucun événement à écouter

        @self.client.on(events.NewMessage)
        async def on_new_message(event) -> None:
            # Nos propres envois (y compris ceux passés par /send et /sendVoice)
            # ne sont pas des messages entrants : sans ce filtre, l'extension se
            # répondrait à elle-même en boucle.
            if event.is_outgoing:
                return
            message = event.message
            if message.id in self.recent:
                return
            self.recent.add(message.id)
            if len(self.recent) > RECENT_LIMIT:
                self.recent = set(list(self.recent)[-RECENT_LIMIT // 2:])

            text = (message.text or "").strip()
            is_voice = _is_voice_note(message)
            if not text and not is_voice:
                return

            chat = await event.get_chat()
            name = getattr(chat, "first_name", None) or getattr(chat, "title", None) or None
            payload = {
                "contactId": str(event.chat_id),
                "contactName": name,
                "text": text,
                "isVoice": is_voice,
                "receivedAt": int(time.time() * 1000),
            }
            for queue in list(self.sse_clients):
                queue.put_nowait(payload)


# -- Petits outils ----------------------------------------------------------

def _is_voice_note(message) -> bool:
    media = getattr(message, "media", None)
    if not isinstance(media, MessageMediaDocument):
        return False
    for attr in media.document.attributes:
        if isinstance(attr, DocumentAttributeAudio) and getattr(attr, "voice", False):
            return True
    return False


def _extension_for(mime: str) -> str:
    m = mime.lower()
    if "jpeg" in m or "jpg" in m:
        return ".jpg"
    if "png" in m:
        return ".png"
    if "webp" in m:
        return ".webp"
    if "gif" in m:
        return ".gif"
    return ".bin"


def _to_opus(source: str) -> str:
    out = source.rsplit(".", 1)[0] + ".ogg"
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-i", source, "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", out,
            ],
            capture_output=True,
            timeout=120,
        )
    except FileNotFoundError:
        raise RuntimeError(
            "ffmpeg est introuvable et le fichier audio n'est pas en OGG/Opus. "
            "Installez ffmpeg, ou envoyez directement de l'OGG/Opus."
        )
    if result.returncode != 0:
        raise RuntimeError(f"conversion ffmpeg échouée : {result.stderr.decode(errors='replace')[-300:]}")
    return out


# -- Démarrage --------------------------------------------------------------

def parse_args(argv) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Pont Telegram (Telethon) pour l'extension Astreinte")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--login", action="store_true", help="connexion compte personnel (téléphone + code)")
    mode.add_argument("--qr", action="store_true", help="connexion compte personnel par QR code")
    mode.add_argument("--bot", metavar="JETON", help="connexion bot avec son jeton (@BotFather)")
    mode.add_argument("--dry-run", action="store_true", help="démarrer le serveur sans compte Telegram")
    parser.add_argument("--port", type=int, default=PORT, help=f"port d'écoute (défaut {PORT})")
    parser.add_argument("--host", default=HOST, help=f"adresse d'écoute (défaut {HOST})")
    return parser.parse_args(argv)


async def main(argv=None) -> None:
    args = parse_args(argv)
    api_id = int(os.environ.get("TELEGRAM_API_ID", "0") or 0)
    api_hash = os.environ.get("TELEGRAM_API_HASH", "") or ""
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "") or ""

    if not args.dry_run and (api_id <= 0 or not api_hash):
        log.error(
            "Définissez TELEGRAM_API_ID et TELEGRAM_API_HASH (https://my.telegram.org, "
            "API development tools). En dry-run, pas besoin."
        )
        sys.exit(1)

    client = TelegramClient(SESSION_FILE, api_id, api_hash) if not args.dry_run else None

    if args.dry_run:
        log.info("dry-run : serveur HTTP seul, aucun compte Telegram.")
    elif args.qr:
        await client.connect()
        qr = await client.qr_login()
        log.info("Ouvrez ce lien dans Telegram sur votre téléphone : %s", qr.url)
        await qr.wait()
        await client.connect()
    elif args.bot:
        await client.start(bot_token=args.bot or bot_token)
    else:
        # --login ou mode serveur sans session : Telethon demande le téléphone
        # et le code dans le terminal si la session n'existe pas encore. Un
        # jeton de bot dans l'environnement suffit, sans rien demander.
        await client.start(bot_token=bot_token or None)
        if not client.is_user_authorized():
            log.error("Connexion annulée.")
            sys.exit(1)

    if client is not None:
        me = await client.get_me()
        log.info("Connecté : %s", f"@{me.username}" if me and me.username else "compte")

    bridge = Bridge(client, dry_run=args.dry_run)
    bridge.register_handlers()

    app = web.Application()
    app.router.add_get("/health", bridge.health)
    app.router.add_get("/events", bridge.events)
    app.router.add_post("/send", bridge.send)
    app.router.add_post("/sendVoice", bridge.send_voice)
    app.router.add_post("/sendMedia", bridge.send_media)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, args.host, args.port)
    await site.start()
    log.info("Pont Telegram : http://%s:%s  (health, events, send, sendVoice, sendMedia)", args.host, args.port)

    try:
        if client is not None:
            await client.run_until_disconnected()
        else:
            await asyncio.Event().wait()
    finally:
        if client is not None:
            await client.disconnect()
        await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Arrêt.")
