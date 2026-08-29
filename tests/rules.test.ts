/** 既知入力テスト: bad.md で全ルールが発火し、clean.md で誤検知ゼロであることを確認する。 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { defaultRulesPath, Engine } from "../src/engine";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");

const EXPECTED_BAD = new Set([
  "ai-slop.p1.em-dash",
  "ai-slop.p1.fullwidth-slash",
  "ai-slop.p1.arrow-causal",
  "ai-slop.p1.kagikakko-overuse",
  "ai-slop.p1.bold-keyword",
  "ai-slop.p1.bold-generic",
  "ai-slop.p2.ending-repetition",
  "ai-slop.p2.connective-run",
  "ai-slop.p2.not-a-but-b",
  "ai-slop.p3.meta-structure",
  "ai-slop.p4.hedging",
  "ai-slop.p5.abstract-word",
  "ai-slop.p6.template-metaphor",
  "ai-slop.p6.metaphor-engine-dna",
  "ai-slop.p7.migration-history",
  "style.filler-connective",
  "style.slang",
  "style.decoration-adverb",
  "style.emoji",
  "format.bare-pr-number",
  "format.url-adjacency",
  "obsidian.prefer-bare-url",
  "ref.wikilink-missing",
  "ref.md-link-missing",
  "ref.absolute-path-link",
]);

const engine = new Engine([defaultRulesPath()], ["obsidian"]);

it("bad.md で全ルールが発火する", () => {
  const diags = engine.lintFile(path.join(FIXTURES, "bad.md"));
  const fired = new Set(diags.map((d) => d.ruleId));
  expect([...EXPECTED_BAD].filter((id) => !fired.has(id))).toEqual([]);
  expect([...fired].filter((id) => !EXPECTED_BAD.has(id))).toEqual([]);
});

it("clean.md で誤検知が出ない", () => {
  const diags = engine.lintFile(path.join(FIXTURES, "clean.md"));
  expect(diags.map((d) => `${d.line}:${d.col} ${d.ruleId} ${d.snippet}`)).toEqual([]);
});
