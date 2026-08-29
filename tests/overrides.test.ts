/** workspace override (.wslsp.json) のテスト: パス一致でルール・カテゴリを無効化できる。 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, expect, it } from "vitest";
import { clearWorkspaceConfigCache, defaultRulesPath, Engine, VaultIndex } from "../src/engine";

const BAD_TEXT = "参照: [[存在しないノート]] は本質的に良くない書き方です。\n";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wslsp-ov-"));
fs.mkdirSync(path.join(tmp, "journal"));
fs.mkdirSync(path.join(tmp, "docs"));
fs.writeFileSync(
  path.join(tmp, ".wslsp.json"),
  JSON.stringify({ overrides: [{ paths: "^journal/", disable: ["ref.wikilink-missing"] }] }),
);
fs.writeFileSync(path.join(tmp, "journal", "note.md"), BAD_TEXT);
fs.writeFileSync(path.join(tmp, "docs", "note.md"), BAD_TEXT);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

it("paths に一致するファイルでは指定ルールだけが無効化される", () => {
  clearWorkspaceConfigCache();
  VaultIndex.clearCache();
  const engine = new Engine([defaultRulesPath()]);

  const excluded = new Set(engine.lintFile(path.join(tmp, "journal", "note.md")).map((d) => d.ruleId));
  const included = new Set(engine.lintFile(path.join(tmp, "docs", "note.md")).map((d) => d.ruleId));

  expect(excluded.has("ref.wikilink-missing")).toBe(false);
  expect(excluded.has("ai-slop.p5.abstract-word")).toBe(true);
  expect(included.has("ref.wikilink-missing")).toBe(true);
});
