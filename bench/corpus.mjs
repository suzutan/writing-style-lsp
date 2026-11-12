import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SEED = 0x5eed2026;
export const COPIES = 320;

// All prose is synthetic. The only other inputs are this harness's public fixtures.
const BLOCKS = [
  "設定ファイルを読み取る。入力の形式を検査する。処理の結果を保存する。",
  "本記事では、設計──実装／運用の手順を説明します。",
  "これは手動ではなく自動で処理する。重要なのは設定の一貫性である。",
  "しかし、条件を変更しました。また、設定を更新しました。さらに、結果を確認しました。",
  "「品質」「速度」「安全」「信頼」を確認する。**重要**: **必ず確認**する。",
  "一概には言えませんが、本質的に組織の架け橋であり、組織のDNAとなるでしょう。",
  "APIを更新し、テストを実行し、成果物を生成し、リリースする。",
  "進捗は PR #25 を参照。対応済み（https://example.com/status）を確認する。",
  "参照: [[bad]] と [[missing-note]] と [不明](./missing.md) と [見出し](#missing)。",
  "参照: [fixture](../fixtures/clean.md) と [外部](https://example.com/page)。",
  "| 対象 | 内容 |\n| --- | --- |\n| 設定 | a → b ／ c |",
  "```md\n本記事では──PR #25 と [[missing-code]] を説明します。\n```\n\n`非常に効率的 🚀`",
  "処理を実行することができる。データが結果を語る。情報は残差ストリームに住んでいる。",
  "手順を紹介していきます。この方針でいかがでしょうか。結論として、この方式を採用する。",
  "完全版を公開する。出版と版権を確認する。設定変更 → 反映 → 完了 の順に進む。",
  "<!-- wslsp-disable-file -->\n\n[絶対パス](/example/document.md) と [アンカー](#corpus)。",
];

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

export function createCorpus(root) {
  mkdirSync(path.join(root, ".obsidian"), { recursive: true });
  writeFileSync(path.join(root, ".wslsp.json"), '{"overrides": []}\n');
  const next = random(SEED);
  const templates = Array.from({ length: 8 }, (_, i) => {
    const blocks = [...BLOCKS];
    for (let j = blocks.length - 1; j > 0; j--) {
      const k = next() % (j + 1);
      [blocks[j], blocks[k]] = [blocks[k], blocks[j]];
    }
    return {
      key: `synthetic-${i}`,
      text: `---\ntitle: corpus-${i}\n---\n\n# Corpus\n\n${blocks.join("\n\n")}\n`,
    };
  });
  const documents = [];
  const add = (key, name, text) => {
    const filePath = path.join(root, name);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, text);
    documents.push({ key, name, text, filePath });
  };
  for (const name of ["bad", "clean"]) {
    add(
      `fixture-${name}`,
      `fixtures/${name}.md`,
      readFileSync(new URL(`../tests/fixtures/${name}.md`, import.meta.url), "utf8"),
    );
  }
  for (let i = 0; i < COPIES; i++) {
    for (const template of templates) {
      // Unique, fixed-width suffixes prevent identical-input memoization across samples.
      const suffix = next().toString(16).padStart(8, "0");
      add(
        template.key,
        `synthetic/${template.key}-${i.toString().padStart(3, "0")}.md`,
        `${template.text}\n<!-- sample-${i.toString().padStart(3, "0")}-${suffix} -->\n`,
      );
    }
  }
  const warmup = Array.from({ length: 64 }, (_, i) => {
    const template = templates[i % templates.length];
    const filePath = path.join(root, "synthetic", `warmup-${i}.md`);
    const text = `${template.text}\n<!-- warmup-${i} -->\n`;
    writeFileSync(filePath, text);
    return { text, filePath };
  });
  return { documents, warmup };
}
