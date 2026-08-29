/**
 * LSP スモークテスト: バンドル済みサーバー (dist/server.js) を stdio で起動し、
 * initialize → didOpen → publishDiagnostics → didChange（修正後）→ クリア → shutdown/exit を検証する。
 * 事前に `npm run build` が必要（task ci は build を先に実行する）。
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const SERVER = path.join(ROOT, "dist", "server.js");
const FIXTURES = path.join(HERE, "fixtures");

// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC メッセージは任意形状
type Message = Record<string, any>;

class LspClient {
  private buffer = Buffer.alloc(0);
  private queue: Message[] = [];
  private waiters: Array<(m: Message) => void> = [];

  constructor(private proc: ChildProcess) {
    proc.stdout?.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
  }

  private drain(): void {
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const m = /Content-Length: *(\d+)/i.exec(header);
      if (!m) throw new Error(`Content-Length ヘッダが無い: ${header}`);
      const length = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf-8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      const msg = JSON.parse(body) as Message;
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.queue.push(msg);
    }
  }

  send(msg: Message): void {
    const body = Buffer.from(JSON.stringify(msg), "utf-8");
    this.proc.stdin?.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin?.write(body);
  }

  private next(): Promise<Message> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async waitFor(pred: (m: Message) => boolean, timeoutMs = 10_000): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("LSP メッセージ待ちがタイムアウトした");
      const msg = await Promise.race([
        this.next(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), remaining)),
      ]);
      if (pred(msg)) return msg;
    }
  }
}

let proc: ChildProcess;
let client: LspClient;

beforeAll(() => {
  if (!fs.existsSync(SERVER)) {
    throw new Error("dist/server.js が無い。先に `npm run build` を実行する（task ci は build 込み）");
  }
  proc = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  client = new LspClient(proc);
});

afterAll(() => {
  proc.kill();
});

it("initialize から diagnostics push、クリア、shutdown まで一巡する", async () => {
  const badPath = path.join(FIXTURES, "bad.md");
  const uri = `file://${badPath}`;
  const badText = fs.readFileSync(badPath, "utf-8");

  client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { processId: process.pid, rootUri: `file://${FIXTURES}`, capabilities: {} },
  });
  const init = await client.waitFor((m) => m.id === 1);
  expect(init.result.serverInfo.name).toBe("wslsp");
  client.send({ jsonrpc: "2.0", method: "initialized", params: {} });

  client.send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: { textDocument: { uri, languageId: "markdown", version: 1, text: badText } },
  });
  const pub = await client.waitFor((m) => m.method === "textDocument/publishDiagnostics");
  expect(pub.params.diagnostics.length).toBeGreaterThan(0);
  expect(pub.params.diagnostics[0].source).toBe("wslsp");

  client.send({
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "# 修正済み\n\nこのドキュメントは規律に沿って書かれている。\n" }],
    },
  });
  const pub2 = await client.waitFor((m) => m.method === "textDocument/publishDiagnostics");
  expect(pub2.params.diagnostics).toEqual([]);

  client.send({ jsonrpc: "2.0", id: 2, method: "shutdown" });
  await client.waitFor((m) => m.id === 2);
  client.send({ jsonrpc: "2.0", method: "exit" });
});
