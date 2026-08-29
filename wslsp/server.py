"""最小 LSP サーバー実装（stdio / JSON-RPC 2.0）。

textDocument/didOpen・didChange・didSave で lint を実行し、
textDocument/publishDiagnostics を push する。依存は標準ライブラリのみ。
"""
from __future__ import annotations

import json
import os
import sys
import urllib.parse
from typing import Dict, Optional

from .engine import Engine, LineIndex, default_rules_path

SEVERITY_MAP = {"error": 1, "warning": 2, "info": 3, "hint": 4}


def _read_message(stdin) -> Optional[dict]:
    headers = {}
    while True:
        line = stdin.readline()
        if not line:
            return None
        line = line.decode("ascii").strip()
        if line == "":
            break
        key, _, value = line.partition(":")
        headers[key.strip().lower()] = value.strip()
    length = int(headers.get("content-length", 0))
    body = stdin.read(length)
    return json.loads(body.decode("utf-8"))


def _write_message(stdout, msg: dict) -> None:
    body = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    stdout.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii"))
    stdout.write(body)
    stdout.flush()


def _uri_to_path(uri: str) -> str:
    parsed = urllib.parse.urlparse(uri)
    return urllib.parse.unquote(parsed.path)


def _utf16_col(line_text: str, col_cp: int) -> int:
    """codepoint 単位の col を LSP 既定の UTF-16 code unit へ変換する。"""
    return len(line_text[:col_cp].encode("utf-16-le")) // 2


class Server:
    def __init__(self):
        rules_env = os.environ.get("WSLSP_RULES", "")
        rules = [p for p in rules_env.split(os.pathsep) if p] or [default_rules_path()]
        enable = [c for c in os.environ.get("WSLSP_ENABLE_CATEGORIES", "").split(",") if c]
        disable = [c for c in os.environ.get("WSLSP_DISABLE_CATEGORIES", "").split(",") if c]
        self.engine = Engine(rules, enable_categories=enable, disable_categories=disable)
        self.docs: Dict[str, str] = {}
        self.root: Optional[str] = None
        self.stdin = sys.stdin.buffer
        self.stdout = sys.stdout.buffer

    def publish(self, uri: str) -> None:
        text = self.docs.get(uri, "")
        path = _uri_to_path(uri)
        diags = self.engine.lint_text(text, path=path, workspace_root=self.root)
        index = LineIndex(text)
        lsp_diags = []
        for d in diags:
            start_line_text = index.line_text(d.line - 1)
            end_line_text = index.line_text(d.end_line - 1)
            lsp_diags.append({
                "range": {
                    "start": {"line": d.line - 1, "character": _utf16_col(start_line_text, d.col - 1)},
                    "end": {"line": d.end_line - 1, "character": _utf16_col(end_line_text, d.end_col - 1)},
                },
                "severity": SEVERITY_MAP[d.severity],
                "code": d.rule_id,
                "source": "wslsp",
                "message": d.message,
            })
        _write_message(self.stdout, {
            "jsonrpc": "2.0",
            "method": "textDocument/publishDiagnostics",
            "params": {"uri": uri, "diagnostics": lsp_diags},
        })

    def run(self) -> int:
        while True:
            msg = _read_message(self.stdin)
            if msg is None:
                return 0
            method = msg.get("method")
            msg_id = msg.get("id")
            params = msg.get("params") or {}

            if method == "initialize":
                root_uri = params.get("rootUri")
                if root_uri:
                    self.root = _uri_to_path(root_uri)
                _write_message(self.stdout, {
                    "jsonrpc": "2.0", "id": msg_id,
                    "result": {
                        "capabilities": {
                            "textDocumentSync": 1,
                        },
                        "serverInfo": {"name": "wslsp", "version": "0.1.0"},
                    },
                })
            elif method == "textDocument/didOpen":
                doc = params["textDocument"]
                self.docs[doc["uri"]] = doc["text"]
                self.publish(doc["uri"])
            elif method == "textDocument/didChange":
                uri = params["textDocument"]["uri"]
                changes = params.get("contentChanges", [])
                if changes:
                    self.docs[uri] = changes[-1]["text"]  # full sync
                self.publish(uri)
            elif method == "textDocument/didSave":
                uri = params["textDocument"]["uri"]
                if "text" in params:
                    self.docs[uri] = params["text"]
                self.publish(uri)
            elif method == "textDocument/didClose":
                uri = params["textDocument"]["uri"]
                self.docs.pop(uri, None)
                _write_message(self.stdout, {
                    "jsonrpc": "2.0",
                    "method": "textDocument/publishDiagnostics",
                    "params": {"uri": uri, "diagnostics": []},
                })
            elif method == "shutdown":
                _write_message(self.stdout, {"jsonrpc": "2.0", "id": msg_id, "result": None})
            elif method == "exit":
                return 0
            elif msg_id is not None:
                # 未対応の request には空応答を返す（notification は無視）
                _write_message(self.stdout, {"jsonrpc": "2.0", "id": msg_id, "result": None})


def main() -> int:
    return Server().run()


if __name__ == "__main__":
    sys.exit(main())
