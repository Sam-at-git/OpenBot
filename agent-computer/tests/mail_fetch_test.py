"""`mail-fetch` against a small fake IMAP server, end to end: log in, open the folder, search, fetch,
save, and pick up only what is new on the next run.

    /opt/python/bin/python agent-computer/tests/mail_fetch_test.py
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import re
import socketserver
import subprocess
import sys
import tempfile
import threading
import unittest
from email.message import EmailMessage
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "bin" / "mail-fetch"


def load_script():
    loader = importlib.machinery.SourceFileLoader("mail_fetch", str(SCRIPT))
    spec = importlib.util.spec_from_loader("mail_fetch", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def message(subject: str, body: str, attachment: bytes | None = None) -> bytes:
    msg = EmailMessage()
    msg["From"] = "张三 <zhang@example.com>"
    msg["To"] = "bot@example.com"
    msg["Subject"] = subject
    msg["Date"] = "Thu, 05 Nov 2026 10:00:00 +0800"
    msg.set_content(body)
    if attachment is not None:
        msg.add_attachment(attachment, maintype="application", subtype="pdf", filename="合同.pdf")
    return msg.as_bytes()


class FakeImap(socketserver.StreamRequestHandler):
    """Just enough IMAP4rev1 for imaplib: LOGIN, ID, SELECT, UID SEARCH, UID FETCH, LOGOUT."""

    mail: dict[int, bytes] = {}
    password = "app-code"
    selected: list[str] = []
    stored_flags: list[str] = []

    def send(self, line: str | bytes) -> None:
        self.wfile.write(line if isinstance(line, bytes) else line.encode())

    def handle(self) -> None:
        self.send("* OK fake ready\r\n")
        while True:
            raw = self.rfile.readline()
            if not raw:
                return
            line = raw.decode().rstrip("\r\n")
            tag, _, rest = line.partition(" ")
            command, _, args = rest.partition(" ")
            command = command.upper()
            if command == "CAPABILITY":
                self.send("* CAPABILITY IMAP4rev1 ID AUTH=PLAIN\r\n")
                self.send(f"{tag} OK done\r\n")
            elif command == "LOGIN":
                ok = args.split(" ", 1)[1].strip('"') == self.password
                self.send(f"{tag} OK logged in\r\n" if ok else f"{tag} NO [AUTHENTICATIONFAILED] bad\r\n")
            elif command == "ID":
                self.send('* ID ("name" "fake")\r\n')
                self.send(f"{tag} OK id\r\n")
            elif command in ("SELECT", "EXAMINE"):
                type(self).selected.append(args.strip('"'))
                self.send(f"* {len(self.mail)} EXISTS\r\n")
                self.send("* OK [UIDVALIDITY 42] uids valid\r\n")
                self.send(f"{tag} OK [READ-ONLY] selected\r\n")
            elif command == "UID":
                sub, _, params = args.partition(" ")
                sub = sub.upper()
                if sub == "SEARCH":
                    match = re.match(r"UID (\d+):\*", params)
                    uids = sorted(self.mail)
                    if match:
                        low = int(match.group(1))
                        # Like real servers: "n:*" also answers the highest uid when nothing is newer.
                        uids = [u for u in uids if u >= low] or uids[-1:]
                    self.send(f"* SEARCH {' '.join(map(str, uids))}\r\n")
                    self.send(f"{tag} OK search\r\n")
                elif sub == "FETCH":
                    uid = int(params.split(" ", 1)[0])
                    if "PEEK" not in params:
                        type(self).stored_flags.append("seen")
                    data = self.mail[uid]
                    self.send(f"* {uid} FETCH (UID {uid} BODY[] {{{len(data)}}}\r\n".encode() + data + b")\r\n")
                    self.send(f"{tag} OK fetch\r\n")
                else:
                    self.send(f"{tag} BAD unknown\r\n")
            elif command == "LOGOUT":
                self.send("* BYE\r\n")
                self.send(f"{tag} OK bye\r\n")
                return
            else:
                self.send(f"{tag} BAD unknown {command}\r\n")


class MailFetchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        socketserver.TCPServer.allow_reuse_address = True
        cls.server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), FakeImap)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()

    def run_fetch(self, dest: str, password: str = "app-code", folder: str = "INBOX") -> dict:
        env = {**os.environ, "MAIL_PASSWORD": password}
        out = subprocess.run(
            [sys.executable, str(SCRIPT), "--host", "127.0.0.1", "--port", str(self.port),
             "--security", "plain", "--user", "bot@example.com", "--folder", folder,
             "--dest", dest, "--since-days", "3650"],
            capture_output=True, text=True, env=env, timeout=30,
        )
        return json.loads(out.stdout.strip().splitlines()[-1])

    def test_fetches_new_mail_once_and_leaves_it_unread(self) -> None:
        FakeImap.mail = {
            1: message("报价单", "第一封"),
            2: message("合同", "请见附件", attachment=b"%PDF-1.4 fake"),
        }
        FakeImap.stored_flags = []
        with tempfile.TemporaryDirectory() as dest:
            first = self.run_fetch(dest)
            self.assertTrue(first["ok"], first)
            self.assertEqual(first["new"], 2)
            folder = Path(dest) / "INBOX"
            saved = json.loads((folder / "2" / "message.json").read_text())
            self.assertEqual(saved["subject"], "合同")
            self.assertEqual(saved["from"], "张三 <zhang@example.com>")
            self.assertEqual((folder / "2" / "attachments" / "合同.pdf").read_bytes(), b"%PDF-1.4 fake")
            self.assertIn("请见附件", (folder / "2" / "body.txt").read_text())
            self.assertEqual(len((folder / "index.jsonl").read_text().splitlines()), 2)

            # Nothing new: nothing saved again.
            again = self.run_fetch(dest)
            self.assertEqual(again["new"], 0, again)

            # One more arrives: only that one.
            FakeImap.mail[3] = message("新邮件", "第三封")
            third = self.run_fetch(dest)
            self.assertEqual([item["uid"] for item in third["saved"]], [3])
            self.assertEqual(len((folder / "index.jsonl").read_text().splitlines()), 3)
        self.assertEqual(FakeImap.stored_flags, [], "messages must be fetched with BODY.PEEK")

    def test_a_wrong_password_is_reported_without_the_password(self) -> None:
        FakeImap.mail = {1: message("x", "y")}
        with tempfile.TemporaryDirectory() as dest:
            result = self.run_fetch(dest, password="wrong-code")
        self.assertFalse(result["ok"])
        self.assertNotIn("wrong-code", json.dumps(result))

    def test_a_chinese_folder_is_selected_in_modified_utf7(self) -> None:
        FakeImap.mail = {1: message("x", "y")}
        FakeImap.selected = []
        with tempfile.TemporaryDirectory() as dest:
            self.assertTrue(self.run_fetch(dest, folder="已发送")["ok"])
        self.assertEqual(FakeImap.selected[-1], "&XfJT0ZAB-")

    def test_file_names_stay_inside_their_folder(self) -> None:
        script = load_script()
        self.assertEqual(script.safe_name("../../etc/passwd", "x"), "_.._etc_passwd")
        self.assertEqual(script.safe_name("", "attachment-1"), "attachment-1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
