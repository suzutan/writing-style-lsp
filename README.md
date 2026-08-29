# writing-style-lsp

日本語 Markdown の文章規律を決定論的に検査する linter と LSP サーバー。AI 生成文書に混入しやすいパターン（記号の残骸、保険表現、テンプレ比喩、語尾の単調さ）、表記規則違反（URL への全角文字密着、省略形の issue 番号）、参照切れ（wikilink、相対リンク、アンカー）を編集時に指摘する。

ルールは JSON で宣言し、エンジン本体を変更せずに追加・調整できる。依存は Python 3.9+ の標準ライブラリのみ。

## Claude Code への導入（plugin marketplace）

このリポジトリは Claude Code の plugin marketplace を兼ねる。次の 2 コマンドで導入できる。

```bash
claude plugin marketplace add suzutan/writing-style-lsp
claude plugin install writing-style-lsp@suzutan
```

導入後、`.md` ファイルの編集時に LSP diagnostics が返る。更新は `claude plugin marketplace update suzutan` で取り込む。

## CLI

```bash
# lint（ファイル・ディレクトリ混在可）
python3 -m wslsp lint path/to/doc.md docs/ --stat

# severity で絞る / JSON 出力 / CI 用 exit code
python3 -m wslsp lint docs/ --min-severity warning --format json --fail-on warning

# 既定 off のカテゴリを有効化
python3 -m wslsp lint draft.md --enable-category obsidian

# fix.replace を持つルールの機械的修正を適用
python3 -m wslsp lint docs/ --fix
```

LSP サーバー（stdio）:

```bash
python3 -m wslsp serve
```

環境変数で設定する。

| 変数 | 意味 |
| --- | --- |
| `WSLSP_RULES` | ルール JSON のパス（`:` 区切りで複数可。省略時 `rules/core.json`） |
| `WSLSP_ENABLE_CATEGORIES` | 既定 off のカテゴリを有効化（`,` 区切り） |
| `WSLSP_DISABLE_CATEGORIES` | カテゴリを無効化（`,` 区切り） |

## ルールセット

`rules/core.json` に 25 ルールを宣言する。

| カテゴリ | 内容 | 例 |
| --- | --- | --- |
| `ai-slop` | AI 生成文書に混入しやすいパターン（P1 記号の残骸〜P7 移行履歴） | em ダッシュ、同一語尾3連、保険表現、テンプレ比喩 |
| `style` | 文体規律 | 冗長接続詞、俗語、装飾副詞、絵文字 |
| `format` | 表記規則 | 省略形 issue 番号、URL 前後の密着 |
| `obsidian` | Obsidian 運用向け（既定 off） | Markdown リンクではなく素の URL を推奨 |
| `ref` | 参照検査 | wikilink 切れ、相対リンク切れ、アンカー不一致、絶対 path |

検査対象からコードブロック・インラインコード・frontmatter を除外し、散文ルールでは URL 内も対象外となる。表の行は矢印ルール等の検査から外せる（`skip_tables`）。

ルール定義のチェッカー種別: `regex`（`exceptions` による除外付き）/ `density`（段落内出現数）/ `ending_repetition`（同一語尾の連続）/ `connective_run`（文頭接続詞の連続）/ `url_adjacency` / `wikilink` / `md_link`。

## ルールの拡張（組織・プロジェクト固有ルール）

`--rules` の複数指定または `WSLSP_RULES`（`:` 区切り）で、コアに組織固有のルールセットを重ねられる。チケット ID の完全 URL 強制などはこの層に書く。

```json
{
  "version": 1,
  "name": "org-rules",
  "rules": [
    {
      "id": "org.bare-ticket-id",
      "category": "org",
      "severity": "warning",
      "type": "regex",
      "target": "prose",
      "pattern": "(?<![A-Za-z0-9/_-])PROJ-[0-9]+",
      "message": "チケット ID は完全 URL（https://jira.example.com/browse/PROJ-xxxx）で書く",
      "source": "org 表記規則"
    }
  ]
}
```

```bash
python3 -m wslsp lint docs/ --rules rules/core.json --rules org.json
```

## workspace 単位の除外（.wslsp.json）

検査対象ファイルの祖先ディレクトリに `.wslsp.json` を置くと、config からの相対パスに対する正規表現でルールやカテゴリを無効化できる（最初に見つかった 1 ファイルのみ適用）。テンプレート由来で意図的にリンク未解決な daily note などをパス単位で除外する用途を想定している。

```json
{"overrides": [{"paths": "^journal/", "disable": ["ref.wikilink-missing"]}]}
```

## テスト

```bash
python3 tests/test_rules.py      # 既知入力: bad.md で全ルール発火、clean.md で誤検知ゼロ
python3 tests/test_overrides.py  # .wslsp.json によるパス単位の除外
python3 tests/lsp_smoke.py       # LSP プロトコル: initialize / didOpen / didChange / shutdown
```

## 設計メモ

- 位置情報は内部で codepoint 単位、LSP 応答では UTF-16 code unit へ変換する（LSP 既定のエンコーディングに一致させるため）
- wikilink の解決は `.obsidian` を持つ最近傍の祖先ディレクトリを vault root とし、basename とパス末尾一致で判定する
- severity は error / warning / info の3段で、error は参照切れのみ。文体系は warning 以下に留め、文脈次第で正当な表現を error にしない

## License

MIT
