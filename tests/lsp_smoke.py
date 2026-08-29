"""LSP スモークテスト: サーバーを stdio で起動し、initialize → didOpen → publishDiagnostics
→ didChange（修正後テキスト）→ diagnostics クリア → shutdown/exit を検証する。"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(ROOT, "tests", "fixtures")


def send(proc, msg):
    body = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    proc.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii"))
    proc.stdin.write(body)
    proc.stdin.flush()


def recv(proc):
    headers = {}
    while True:
        line = proc.stdout.readline()
        if not line:
            return None
        line = line.decode("ascii").strip()
        if line == "":
            break
        k, _, v = line.partition(":")
        headers[k.strip().lower()] = v.strip()
    length = int(headers["content-length"])
    return json.loads(proc.stdout.read(length).decode("utf-8"))


def wait_for(proc, pred):
    while True:
        msg = recv(proc)
        if msg is None:
            raise RuntimeError("server closed unexpectedly")
        if pred(msg):
            return msg


def main() -> int:
    env = dict(os.environ, WSLSP_ENABLE_CATEGORIES="rp")
    proc = subprocess.Popen(
        [sys.executable, "-m", "wslsp", "serve"],
        cwd=ROOT, env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    bad_path = os.path.join(FIXTURES, "bad.md")
    with open(bad_path, encoding="utf-8") as f:
        bad_text = f.read()
    uri = "file://" + bad_path

    send(proc, {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"processId": os.getpid(), "rootUri": "file://" + FIXTURES,
                           "capabilities": {}}})
    init = wait_for(proc, lambda m: m.get("id") == 1)
    caps = init["result"]["capabilities"]
    assert caps.get("textDocumentSync") == 1, caps
    print(f"initialize OK: serverInfo={init['result']['serverInfo']}")

    send(proc, {"jsonrpc": "2.0", "method": "initialized", "params": {}})
    send(proc, {"jsonrpc": "2.0", "method": "textDocument/didOpen",
                "params": {"textDocument": {"uri": uri, "languageId": "markdown",
                                            "version": 1, "text": bad_text}}})
    pub = wait_for(proc, lambda m: m.get("method") == "textDocument/publishDiagnostics")
    diags = pub["params"]["diagnostics"]
    assert len(diags) > 0, "didOpen で diagnostics が返らない"
    print(f"didOpen OK: {len(diags)} diagnostics published")
    d0 = diags[0]
    print(f"  例: L{d0['range']['start']['line'] + 1} [{d0['code']}] {d0['message'][:40]}…")

    clean_text = "# 修正済み\n\nこのドキュメントは規律に沿って書かれている。\n"
    send(proc, {"jsonrpc": "2.0", "method": "textDocument/didChange",
                "params": {"textDocument": {"uri": uri, "version": 2},
                           "contentChanges": [{"text": clean_text}]}})
    pub2 = wait_for(proc, lambda m: m.get("method") == "textDocument/publishDiagnostics")
    assert pub2["params"]["diagnostics"] == [], pub2["params"]["diagnostics"]
    print("didChange OK: 修正後テキストで diagnostics が 0 件にクリアされた")

    send(proc, {"jsonrpc": "2.0", "id": 2, "method": "shutdown"})
    wait_for(proc, lambda m: m.get("id") == 2)
    send(proc, {"jsonrpc": "2.0", "method": "exit"})
    proc.wait(timeout=5)
    assert proc.returncode == 0, proc.returncode
    print("shutdown/exit OK")
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
