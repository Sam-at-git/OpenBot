#!/usr/bin/env python3
"""iMessage bridge: OpenBot's iMessage channel, run on the Mac whose Messages app sends and receives.

OpenBot runs in containers, which cannot drive Messages. This process runs on the Mac itself, as the
signed-in user, and does two things:

  * POST /send {"to": handle, "text": ...}   sends an iMessage through Messages (AppleScript).
  * every few seconds, reads new incoming messages from ~/Library/Messages/chat.db and posts each
    one to OpenBot ({"id", "handle", "text"}), so a reply on the phone reaches the conversation.

Only the handles listed in the config are sent to or listened to: anything else is ignored, so a
leaked token cannot message strangers and a stranger cannot command a Bot. Every request carries
the shared token as `Authorization: Bearer <token>`, both ways.

Config, mode 600, at ~/.config/imessage-bridge/config.json (or $IMESSAGE_BRIDGE_CONFIG):

    {
      "token": "<32+ random characters, the same as IMESSAGE_BRIDGE_TOKEN in OpenBot>",
      "allowed": ["+8613500000000"],
      "inbound_url": "http://127.0.0.1:8050/api/delivery/webhooks/imessage",
      "listen_host": "127.0.0.1",
      "listen_port": 8060,
      "poll_seconds": 2
    }

The standard library only: run it with the Mac's own python3. Reading chat.db needs Full Disk
Access, and sending needs permission to control Messages, both granted to whatever started it.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import sqlite3
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import error as urlerror
from urllib import request as urlrequest

CONFIG_PATH = os.path.expanduser(
    os.environ.get("IMESSAGE_BRIDGE_CONFIG", "~/.config/imessage-bridge/config.json")
)
STATE_PATH = os.path.join(os.path.dirname(CONFIG_PATH), "state.json")
CHAT_DB = os.path.expanduser("~/Library/Messages/chat.db")
MAX_TEXT = 4000

# Sent with the handle and the text as arguments, so neither is ever spliced into the script.
SEND_SCRIPT = [
    "on run argv",
    "set targetHandle to item 1 of argv",
    "set msg to item 2 of argv",
    'tell application "Messages"',
    "set svc to 1st account whose service type = iMessage",
    "set p to participant targetHandle of svc",
    "send msg to p",
    "end tell",
    "end run",
]

log = logging.getLogger("imessage-bridge")


def normalize(handle: str) -> str:
    """A phone number without spaces or dashes, or an email address in lower case."""
    value = handle.strip()
    if "@" in value:
        return value.lower()
    return "".join(ch for ch in value if ch.isdigit() or ch == "+")


def load_config() -> dict:
    with open(CONFIG_PATH, encoding="utf-8") as file:
        config = json.load(file)
    if len(config.get("token", "")) < 32:
        raise SystemExit("config: token must be at least 32 characters")
    config["allowed"] = {normalize(h) for h in config.get("allowed", [])}
    if not config["allowed"]:
        raise SystemExit("config: allowed must name at least one handle")
    return config


def body_text(text: str | None, blob: bytes | None) -> str:
    """The message text: the `text` column, or the string inside `attributedBody` (a typedstream)."""
    if text:
        return text
    if not blob:
        return ""
    start = blob.find(b"NSString")
    if start < 0:
        return ""
    at = blob.find(b"\x84\x01+", start)
    if at < 0:
        return ""
    at += 3
    length = blob[at]
    if length == 0x81:
        length = int.from_bytes(blob[at + 1 : at + 3], "little")
        at += 3
    elif length == 0x82:
        length = int.from_bytes(blob[at + 1 : at + 5], "little")
        at += 5
    else:
        at += 1
    return blob[at : at + length].decode("utf-8", "replace")


class Bridge:
    def __init__(self, config: dict):
        self.config = config
        self.send_lock = threading.Lock()

    # -- sending ---------------------------------------------------------------------------------

    def send(self, to: str, text: str) -> str:
        handle = normalize(to)
        if handle not in self.config["allowed"]:
            raise PermissionError("That handle is not on this bridge's allowed list.")
        text = text[:MAX_TEXT]
        args = ["osascript"]
        for line in SEND_SCRIPT:
            args += ["-e", line]
        args += [handle, text]
        with self.send_lock:
            result = subprocess.run(args, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "Messages did not send the message.")
        message_id = str(uuid.uuid4())
        log.info("sent %s chars to %s (%s)", len(text), handle, message_id)
        return message_id

    # -- receiving -------------------------------------------------------------------------------

    def _db(self) -> sqlite3.Connection:
        return sqlite3.connect(f"file:{CHAT_DB}?mode=ro", uri=True, timeout=5)

    def _last_row(self) -> int:
        try:
            with open(STATE_PATH, encoding="utf-8") as file:
                return int(json.load(file)["last_row"])
        except (OSError, ValueError, KeyError):
            # First start: begin after what is already there, never replay old history.
            with self._db() as db:
                return int(db.execute("select coalesce(max(ROWID), 0) from message").fetchone()[0])

    def _save_row(self, row: int) -> None:
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as file:
            json.dump({"last_row": row}, file)
        os.replace(tmp, STATE_PATH)

    def _forward(self, message_id: str, handle: str, text: str) -> bool:
        url = self.config.get("inbound_url")
        if not url:
            log.info("received %s chars from %s (no inbound_url, not forwarded)", len(text), handle)
            return True
        body = json.dumps({"id": message_id, "handle": handle, "text": text}).encode("utf-8")
        req = urlrequest.Request(
            url,
            data=body,
            method="POST",
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {self.config['token']}",
            },
        )
        try:
            with urlrequest.urlopen(req, timeout=15) as response:
                answer = response.read().decode("utf-8", "replace")[:200]
            log.info("forwarded %s chars from %s: %s", len(text), handle, answer)
            return True
        except urlerror.HTTPError as error:
            # OpenBot answered and refused: retrying the same message would be refused again.
            log.warning("OpenBot refused a message from %s: %s", handle, error.code)
            return error.code < 500
        except (urlerror.URLError, OSError) as error:
            log.warning("OpenBot unreachable, will retry: %s", error)
            return False

    def poll_forever(self) -> None:
        last = self._last_row()
        self._save_row(last)
        log.info("listening for messages after row %s", last)
        while True:
            try:
                with self._db() as db:
                    rows = db.execute(
                        """
                        select m.ROWID, m.guid, m.text, m.attributedBody, h.id
                        from message m join handle h on m.handle_id = h.ROWID
                        where m.ROWID > ? and m.is_from_me = 0
                          and m.item_type = 0 and m.associated_message_type = 0
                        order by m.ROWID
                        """,
                        (last,),
                    ).fetchall()
                for row_id, guid, text, blob, handle in rows:
                    handle = normalize(handle or "")
                    content = body_text(text, blob).strip()
                    if handle in self.config["allowed"] and content:
                        if not self._forward(guid, handle, content):
                            break  # try this one again next time
                    last = row_id
                    self._save_row(last)
            except sqlite3.Error as error:
                log.warning("could not read chat.db: %s", error)
            time.sleep(float(self.config.get("poll_seconds", 2)))


def handler_for(bridge: Bridge):
    token = bridge.config["token"]

    class Handler(BaseHTTPRequestHandler):
        def _reply(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorised(self) -> bool:
            given = self.headers.get("authorization", "")
            return hmac.compare_digest(given.encode(), f"Bearer {token}".encode())

        def do_GET(self) -> None:
            if self.path == "/health":
                self._reply(200, {"ok": True})
            else:
                self._reply(404, {"error": "Not found."})

        def do_POST(self) -> None:
            if self.path != "/send":
                return self._reply(404, {"error": "Not found."})
            if not self._authorised():
                return self._reply(401, {"error": "Unauthorised."})
            try:
                length = min(int(self.headers.get("content-length", "0")), 64_000)
                body = json.loads(self.rfile.read(length) or b"{}")
                to, text = str(body.get("to", "")), str(body.get("text", ""))
                if not to or not text.strip():
                    return self._reply(400, {"error": "Send needs to and text."})
                self._reply(200, {"id": bridge.send(to, text), "status": "sent"})
            except PermissionError as error:
                self._reply(403, {"error": str(error)})
            except (ValueError, json.JSONDecodeError):
                self._reply(400, {"error": "The body must be JSON."})
            except subprocess.TimeoutExpired:
                self._reply(504, {"error": "Messages took too long to send."})
            except RuntimeError as error:
                log.warning("send failed: %s", error)
                self._reply(502, {"error": "Messages could not send the message."})

        def log_message(self, fmt: str, *args) -> None:  # quieter than the default access log
            log.debug(fmt, *args)

    return Handler


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config = load_config()
    bridge = Bridge(config)
    threading.Thread(target=bridge.poll_forever, daemon=True).start()
    host = config.get("listen_host", "127.0.0.1")
    port = int(config.get("listen_port", 8060))
    server = ThreadingHTTPServer((host, port), handler_for(bridge))
    log.info("iMessage bridge on %s:%s for %s handle(s)", host, port, len(config["allowed"]))
    server.serve_forever()


if __name__ == "__main__":
    main()
