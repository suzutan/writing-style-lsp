---
name: writing-style-lsp
description: |
  日本語 Markdown の文章規律（AI slop パターン・表記規則・参照切れ）を決定論的に検査する linter。
  「文章 lint して」「writing style チェック」「文書の規律検査」「リンク切れ検査」などでトリガー。
  LSP サーバーとしても動作し、.md の編集時 diagnostics を提供する。
license: MIT
compatibility: Requires Node.js 20+
user-invocable: true
---

# writing-style-lsp

日本語 Markdown の文章規律を検査する linter + LSP。ルールは `rules/core.json` に宣言され、AI 生成文書に混入しやすいパターン（P1〜P7）、文体規律、表記規則、参照検査（wikilink・相対リンク・アンカー）を持つ。

## CLI

このディレクトリをカレントにして実行する（バンドル済みのため `npm install` は不要）。

```bash
# lint（ファイル・ディレクトリ混在可）
node dist/cli.js lint <file-or-dir> --stat

# severity で絞る / JSON 出力 / CI 用 exit code
node dist/cli.js lint docs/ --min-severity warning --format json --fail-on warning

# 既定 off のカテゴリ（obsidian = 素の URL 推奨）を有効化
node dist/cli.js lint draft.md --enable-category obsidian

# fix.replace を持つルールの機械的修正
node dist/cli.js lint docs/ --fix
```

## workspace 単位の除外

検査対象の祖先ディレクトリに `.wslsp.json` を置くと、相対パスの正規表現でルール・カテゴリを無効化できる。

```json
{"overrides": [{"paths": "^journal/", "disable": ["ref.wikilink-missing"]}]}
```

詳細は同梱の README.md を参照。
