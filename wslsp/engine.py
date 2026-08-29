"""Writing Style LSP - ルールエンジン。

rules/*.json で宣言されたルールを Markdown テキストへ適用して diagnostics を返す。
LSP サーバー (server.py) と CLI (cli.py) の共通層。依存は標準ライブラリのみ。
"""
from __future__ import annotations

import bisect
import json
import os
import re
import urllib.parse
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2, "hint": 3}

FENCE_RE = re.compile(r"^(```|~~~)[^\n]*\n.*?(?:^\1[^\n]*$|\Z)", re.M | re.S)
INLINE_CODE_RE = re.compile(r"`[^`\n]+`")
FRONTMATTER_RE = re.compile(r"\A---[ \t]*\n.*?\n---[ \t]*(?:\n|\Z)", re.S)
URL_MASK_RE = re.compile(r"https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'*+,;=%()]+")
URL_ADJ_RE = re.compile(r"https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'*+,;=%]+")
WIKILINK_RE = re.compile(r"(!?)\[\[([^\]\n]+?)\]\]")
MDLINK_RE = re.compile(r"(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
HEADING_RE = re.compile(r"^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$", re.M)

SENTENCE_ENDINGS = re.compile(
    r"(でしょう|ましょう|ください|ください|でした|ました|ません|ですね|ますね|です|ます|する|される|ている|ていた)$"
)


@dataclass
class Diagnostic:
    rule_id: str
    category: str
    severity: str
    message: str
    start: int
    end: int
    line: int  # 1-based
    col: int  # 1-based, codepoint 単位
    end_line: int
    end_col: int
    snippet: str
    fix: Optional[dict] = None

    def to_dict(self) -> dict:
        d = {
            "rule": self.rule_id,
            "category": self.category,
            "severity": self.severity,
            "message": self.message,
            "line": self.line,
            "col": self.col,
            "endLine": self.end_line,
            "endCol": self.end_col,
            "snippet": self.snippet,
        }
        if self.fix:
            d["fix"] = self.fix
        return d


class LineIndex:
    def __init__(self, text: str):
        self.text = text
        self.starts = [0]
        for i, ch in enumerate(text):
            if ch == "\n":
                self.starts.append(i + 1)

    def pos(self, offset: int) -> Tuple[int, int]:
        """offset -> (line0, col0) codepoint 単位。"""
        line = bisect.bisect_right(self.starts, offset) - 1
        return line, offset - self.starts[line]

    def line_of(self, offset: int) -> int:
        return bisect.bisect_right(self.starts, offset) - 1

    def line_text(self, line0: int) -> str:
        start = self.starts[line0]
        end = self.starts[line0 + 1] - 1 if line0 + 1 < len(self.starts) else len(self.text)
        return self.text[start:end]


def _mask(text: str, spans: List[Tuple[int, int]]) -> str:
    chars = list(text)
    for s, e in spans:
        for i in range(s, min(e, len(chars))):
            if chars[i] != "\n":
                chars[i] = "\x00"
    return "".join(chars)


class VaultIndex:
    """Obsidian vault のファイル索引。wikilink の解決に使う。"""

    _cache: Dict[str, "VaultIndex"] = {}

    def __init__(self, root: str):
        self.root = root
        self.md_stems: Dict[str, List[str]] = {}
        self.rel_no_ext = set()
        self.all_names: Dict[str, List[str]] = {}
        skip_dirs = {".git", ".obsidian", ".trash", "node_modules", ".claude"}
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in skip_dirs and not d.startswith(".")]
            for fn in filenames:
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, root)
                self.all_names.setdefault(fn.lower(), []).append(rel)
                if fn.lower().endswith(".md"):
                    stem = fn[:-3].lower()
                    self.md_stems.setdefault(stem, []).append(rel)
                    self.rel_no_ext.add(rel[:-3].lower().replace(os.sep, "/"))

    @classmethod
    def for_file(cls, path: str, fallback_root: Optional[str] = None) -> Optional["VaultIndex"]:
        d = os.path.dirname(os.path.abspath(path))
        root = None
        cur = d
        while True:
            if os.path.isdir(os.path.join(cur, ".obsidian")):
                root = cur
                break
            parent = os.path.dirname(cur)
            if parent == cur:
                break
            cur = parent
        if root is None:
            root = fallback_root or d
        if root not in cls._cache:
            cls._cache[root] = cls(root)
        return cls._cache[root]

    def resolve(self, target: str) -> bool:
        t = target.strip().lower().replace("\\", "/")
        if not t:
            return True
        if "/" in t:
            if t in self.rel_no_ext:
                return True
            base = t.rsplit("/", 1)[-1]
            if base in self.md_stems or base in self.all_names:
                # パス付き指定はサブパス一致まで確認する
                for rel in self.md_stems.get(base, []) + self.all_names.get(base, []):
                    r = rel.lower().replace(os.sep, "/")
                    if r.endswith(t) or r.endswith(t + ".md"):
                        return True
            return False
        if t in self.md_stems:
            return True
        if "." in t and t in self.all_names:
            return True
        return False


class WorkspaceConfig:
    """ファイルの祖先ディレクトリにある .wslsp.json を読む。

    形式: {"overrides": [{"paths": "<相対パスへの正規表現>", "disable": ["rule-id または category", ...]}]}
    最初に見つかった 1 ファイルのみ適用する。
    """

    _cache: Dict[str, Optional[Tuple[str, list]]] = {}

    @classmethod
    def for_file(cls, path: str) -> Optional[Tuple[str, list]]:
        cur = os.path.dirname(os.path.abspath(path))
        start = cur
        if start in cls._cache:
            return cls._cache[start]
        found = None
        while True:
            cfg = os.path.join(cur, ".wslsp.json")
            if os.path.isfile(cfg):
                try:
                    with open(cfg, encoding="utf-8") as f:
                        data = json.load(f)
                    found = (cur, data.get("overrides", []))
                except (OSError, ValueError):
                    found = None
                break
            parent = os.path.dirname(cur)
            if parent == cur:
                break
            cur = parent
        cls._cache[start] = found
        return found

    @classmethod
    def disabled_for(cls, path: str) -> set:
        found = cls.for_file(path)
        if not found:
            return set()
        root, overrides = found
        rel = os.path.relpath(os.path.abspath(path), root).replace(os.sep, "/")
        disabled = set()
        for ov in overrides:
            try:
                if re.search(ov.get("paths", ""), rel):
                    disabled |= set(ov.get("disable", []))
            except re.error:
                continue
        return disabled


class Context:
    def __init__(self, text: str, path: Optional[str], workspace_root: Optional[str]):
        self.text = text
        self.path = path
        self.workspace_root = workspace_root
        self.index = LineIndex(text)

        code_spans = [m.span() for m in FENCE_RE.finditer(text)]
        fm = FRONTMATTER_RE.match(text)
        if fm:
            code_spans.append(fm.span())
        # インラインコードは fence の外側のみ
        tmp = _mask(text, code_spans)
        code_spans += [m.span() for m in INLINE_CODE_RE.finditer(tmp)]

        self.linkable = _mask(text, code_spans)  # コードのみマスク（リンク・URL 検査用）
        url_spans = [m.span() for m in URL_MASK_RE.finditer(self.linkable)]
        self.prose = _mask(self.linkable, url_spans)  # コード + URL をマスク（散文検査用）

        self.table_lines = set()
        self.heading_lines = set()
        for i in range(len(self.index.starts)):
            lt = self.index.line_text(i).lstrip()
            if lt.startswith("|"):
                self.table_lines.add(i)
            if lt.startswith("#"):
                self.heading_lines.add(i)

    def is_table(self, offset: int) -> bool:
        return self.index.line_of(offset) in self.table_lines

    def is_heading(self, offset: int) -> bool:
        return self.index.line_of(offset) in self.heading_lines

    def paragraphs(self) -> List[Tuple[int, str]]:
        """(開始 offset, 段落テキスト) のリスト。prose ベース。"""
        out = []
        offset = 0
        for chunk in re.split(r"\n[ \t]*\n", self.prose):
            if chunk.strip("\x00 \t\n"):
                out.append((offset, chunk))
            offset += len(chunk) + 2  # 区切りの概算。正確な offset は re.finditer で取る
        # 正確に取り直す
        out = []
        for m in re.finditer(r"(?:[^\n]|\n(?![ \t]*\n))+", self.prose):
            if m.group().strip("\x00 \t\n"):
                out.append((m.start(), m.group()))
        return out

    def sentences(self) -> List[Tuple[int, int, str]]:
        """(start, end, sentence) のリスト。表・見出し行は除外。"""
        out = []
        for pstart, para in self.paragraphs():
            if self.is_table(pstart) or self.is_heading(pstart):
                continue
            pos = 0
            for m in re.finditer(r"[^。]*。", para):
                s = pstart + m.start()
                sent = m.group().strip("\x00 \t\n")
                if sent and not self.is_table(s) and not self.is_heading(s):
                    out.append((s, pstart + m.end(), sent))
                pos = m.end()
        return out


def _fmt(message: str, **kw) -> str:
    try:
        return message.format(**kw)
    except (KeyError, IndexError):
        return message


class Engine:
    def __init__(
        self,
        rules_paths: List[str],
        enable_categories: Optional[List[str]] = None,
        disable_categories: Optional[List[str]] = None,
    ):
        self.rules: List[dict] = []
        disabled = set()
        for rp in rules_paths:
            with open(rp, encoding="utf-8") as f:
                data = json.load(f)
            disabled |= set(data.get("default_disabled_categories", []))
            self.rules.extend(data.get("rules", []))
        disabled -= set(enable_categories or [])
        disabled |= set(disable_categories or [])
        self.rules = [r for r in self.rules if r.get("category") not in disabled]
        for r in self.rules:
            if r["type"] == "regex":
                r["_re"] = re.compile(r["pattern"], re.M)
                r["_exc"] = [re.compile(e) for e in r.get("exceptions", [])]
            elif r["type"] == "density":
                r["_re"] = re.compile(r["pattern"])

    # ---- チェッカー ----

    def _check_regex(self, rule: dict, ctx: Context) -> List[tuple]:
        target = rule.get("target", "prose")
        text = {"prose": ctx.prose, "linkable": ctx.linkable, "raw": ctx.text}[target]
        results = []
        for m in rule["_re"].finditer(text):
            s, e = m.span()
            if s == e:
                continue
            if rule.get("skip_tables") and ctx.is_table(s):
                continue
            if rule.get("skip_headings") and ctx.is_heading(s):
                continue
            if rule["_exc"] if rule["type"] == "regex" else None:
                window = ctx.text[max(0, s - 30) : e + 30]
                woff = max(0, s - 30)
                skip = False
                for exc in rule["_exc"]:
                    for em in exc.finditer(window):
                        if woff + em.start() <= s and e <= woff + em.end():
                            skip = True
                            break
                    if skip:
                        break
                if skip:
                    continue
            results.append((s, e, rule["message"], None))
        return results

    def _check_density(self, rule: dict, ctx: Context) -> List[tuple]:
        results = []
        for pstart, para in ctx.paragraphs():
            hits = list(rule["_re"].finditer(para))
            if len(hits) > rule["max_per_paragraph"]:
                m = hits[rule["max_per_paragraph"]]
                results.append(
                    (
                        pstart + m.start(),
                        pstart + m.end(),
                        _fmt(rule["message"], count=len(hits)),
                        None,
                    )
                )
        return results

    def _check_ending_repetition(self, rule: dict, ctx: Context) -> List[tuple]:
        results = []
        min_run = rule.get("min_run", 3)
        run_ending = None
        run = []
        sents = ctx.sentences()

        def flush():
            if run_ending and len(run) >= min_run:
                s, e, _ = run[-1]
                m = SENTENCE_ENDINGS.search(run[-1][2].rstrip("。"))
                span_s = e - 1 - (len(m.group()) if m else 2)
                results.append(
                    (
                        max(s, span_s),
                        e,
                        _fmt(rule["message"], ending=run_ending, count=len(run)),
                        None,
                    )
                )

        for s, e, sent in sents:
            body = sent.rstrip("。")
            m = SENTENCE_ENDINGS.search(body)
            ending = m.group() if m else None
            if ending and ending == run_ending:
                run.append((s, e, sent))
            else:
                flush()
                run_ending = ending
                run = [(s, e, sent)] if ending else []
        flush()
        return results

    def _check_connective_run(self, rule: dict, ctx: Context) -> List[tuple]:
        results = []
        min_run = rule.get("min_run", 3)
        connectives = rule["connectives"]
        run = []
        for s, e, sent in ctx.sentences():
            head = sent.lstrip("\x00 \t\n-*>0123456789. ")
            hit = next((c for c in connectives if head.startswith(c)), None)
            if hit:
                run.append((s, e, hit))
            else:
                if len(run) >= min_run:
                    ls, le, lc = run[-1]
                    results.append((ls, ls + len(lc), _fmt(rule["message"], count=len(run)), None))
                run = []
        if len(run) >= min_run:
            ls, le, lc = run[-1]
            results.append((ls, ls + len(lc), _fmt(rule["message"], count=len(run)), None))
        return results

    def _check_url_adjacency(self, rule: dict, ctx: Context) -> List[tuple]:
        results = []
        text = ctx.linkable
        for m in URL_ADJ_RE.finditer(text):
            s, e = m.span()
            if text[max(0, s - 2) : s] == "](":
                continue  # Markdown リンク構文は別ルールで扱う
            prev = text[s - 1] if s > 0 else "\n"
            nxt = text[e] if e < len(text) else "\n"
            if prev not in " \t\n<\x00(\"'":
                detail = "全角文字が密着しリンクが壊れる" if ord(prev) > 0x2FFF else "直前に半角スペースがない"
                results.append((s - 1, s + 8, rule["message"] + f"（前方: '{prev}' — {detail}）", None))
            if nxt not in " \t\n>\x00\"'":
                detail = "全角文字が密着しリンクが壊れる" if ord(nxt) > 0x2FFF else "直後に半角スペースがない"
                results.append((e - 1, e + 1, rule["message"] + f"（後方: '{nxt}' — {detail}）", None))
        return results

    def _headings_of(self, path: str) -> List[str]:
        try:
            with open(path, encoding="utf-8") as f:
                content = f.read()
        except OSError:
            return []
        return [m.group(1) for m in HEADING_RE.finditer(content)]

    @staticmethod
    def _slug(h: str) -> str:
        s = re.sub(r"[^\w\- ]", "", h.strip().lower(), flags=re.UNICODE)
        return s.replace(" ", "-")

    def _anchor_ok(self, anchor: str, headings: List[str]) -> bool:
        a = urllib.parse.unquote(anchor).strip().lower()
        if a.startswith("^"):
            return True  # block reference は検査対象外
        for h in headings:
            if a == h.strip().lower() or a == self._slug(h):
                return True
        return False

    def _check_wikilink(self, rule: dict, ctx: Context) -> List[tuple]:
        if not ctx.path:
            return []
        vault = VaultIndex.for_file(ctx.path, ctx.workspace_root)
        if vault is None:
            return []
        results = []
        for m in WIKILINK_RE.finditer(ctx.linkable):
            inner = m.group(2)
            target = inner.split("|", 1)[0]
            name, _, anchor = target.partition("#")
            name = name.strip()
            if name and not vault.resolve(name):
                results.append(
                    (m.start(), m.end(), _fmt(rule["message"], target=name), None)
                )
        return results

    def _check_md_link(self, rule: dict, ctx: Context) -> List[tuple]:
        results = []
        base = os.path.dirname(os.path.abspath(ctx.path)) if ctx.path else None
        for m in MDLINK_RE.finditer(ctx.linkable):
            target = m.group(3)
            if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target):  # http:, mailto: 等
                continue
            if target.startswith("#"):
                headings = [h for h in HEADING_RE.findall(ctx.text)]
                if not self._anchor_ok(target[1:], headings):
                    results.append(
                        (m.start(), m.end(), _fmt(rule["message"], target=target), None)
                    )
                continue
            if target.startswith("/"):
                continue  # 絶対 path は ref.absolute-path-link が扱う
            if base is None:
                continue
            path_part, _, anchor = target.partition("#")
            resolved = os.path.normpath(os.path.join(base, urllib.parse.unquote(path_part)))
            if not os.path.exists(resolved):
                results.append(
                    (m.start(), m.end(), _fmt(rule["message"], target=target), None)
                )
            elif anchor and resolved.endswith(".md"):
                if not self._anchor_ok(anchor, self._headings_of(resolved)):
                    results.append(
                        (
                            m.start(),
                            m.end(),
                            _fmt(rule["message"], target="#" + anchor) + "（アンカー不一致）",
                            None,
                        )
                    )
        return results

    # ---- エントリポイント ----

    def lint_text(
        self, text: str, path: Optional[str] = None, workspace_root: Optional[str] = None
    ) -> List[Diagnostic]:
        ctx = Context(text, path, workspace_root)
        checkers = {
            "regex": self._check_regex,
            "density": self._check_density,
            "ending_repetition": self._check_ending_repetition,
            "connective_run": self._check_connective_run,
            "url_adjacency": self._check_url_adjacency,
            "wikilink": self._check_wikilink,
            "md_link": self._check_md_link,
        }
        diags: List[Diagnostic] = []
        for rule in self.rules:
            fn = checkers.get(rule["type"])
            if fn is None:
                continue
            for s, e, msg, sev in fn(rule, ctx):
                l0, c0 = ctx.index.pos(max(0, s))
                l1, c1 = ctx.index.pos(min(e, len(text)))
                snippet = text[max(0, s) : min(e, len(text))].replace("\n", "\\n")[:60]
                diags.append(
                    Diagnostic(
                        rule_id=rule["id"],
                        category=rule["category"],
                        severity=sev or rule["severity"],
                        message=msg or rule["message"],
                        start=max(0, s),
                        end=min(e, len(text)),
                        line=l0 + 1,
                        col=c0 + 1,
                        end_line=l1 + 1,
                        end_col=c1 + 1,
                        snippet=snippet,
                        fix=rule.get("fix"),
                    )
                )
        if path:
            disabled = WorkspaceConfig.disabled_for(path)
            if disabled:
                diags = [d for d in diags if d.rule_id not in disabled and d.category not in disabled]
        # 同一 span の重複は重い severity を残す
        seen: Dict[Tuple[int, int, str], Diagnostic] = {}
        for d in diags:
            key = (d.start, d.end, d.category)
            if key not in seen or SEVERITY_ORDER[d.severity] < SEVERITY_ORDER[seen[key].severity]:
                seen[key] = d
        out = sorted(seen.values(), key=lambda d: (d.start, SEVERITY_ORDER[d.severity]))
        return out

    def lint_file(self, path: str, workspace_root: Optional[str] = None) -> List[Diagnostic]:
        with open(path, encoding="utf-8") as f:
            text = f.read()
        return self.lint_text(text, path=path, workspace_root=workspace_root)


def default_rules_path() -> str:
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "rules", "core.json")
