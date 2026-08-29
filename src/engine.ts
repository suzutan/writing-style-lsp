/**
 * writing-style-lsp ルールエンジン。
 *
 * rules/*.json で宣言されたルールを Markdown テキストへ適用して diagnostics を返す。
 * LSP サーバー (server.ts) と CLI (cli.ts) の共通層。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type Severity = "error" | "warning" | "info" | "hint";

export const SEVERITY_ORDER: Record<Severity, number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
};

export interface RuleFix {
  replace?: string;
}

export interface Rule {
  id: string;
  category: string;
  severity: Severity;
  type: string;
  message: string;
  source?: string;
  target?: "prose" | "linkable" | "raw";
  pattern?: string;
  exceptions?: string[];
  skip_tables?: boolean;
  skip_headings?: boolean;
  max_per_paragraph?: number;
  min_run?: number;
  connectives?: string[];
  fix?: RuleFix;
}

export interface Diagnostic {
  ruleId: string;
  category: string;
  severity: Severity;
  message: string;
  start: number;
  end: number;
  /** 1-based */
  line: number;
  /** 1-based, UTF-16 code unit 単位 */
  col: number;
  endLine: number;
  endCol: number;
  snippet: string;
  fix?: RuleFix;
}

interface RulesFile {
  default_disabled_categories?: string[];
  rules?: Rule[];
}

type Span = [number, number];
type Hit = { start: number; end: number; message?: string };

/** \u{...} を含むパターンのために u フラグ付きを優先し、非対応パターンはフォールバックする。 */
function compileRegex(pattern: string, flags: string): RegExp {
  try {
    return new RegExp(pattern, `${flags}u`);
  } catch {
    return new RegExp(pattern, flags);
  }
}

function fmt(message: string, vars: Record<string, string | number>): string {
  let out = message;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

const FENCE_RE = /^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const FRONTMATTER_RE = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|(?![\s\S]))/;
const URL_MASK_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%()]+/g;
const URL_ADJ_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]+/g;
const WIKILINK_RE = /!?\[\[([^\]\n]+?)\]\]/g;
const MDLINK_RE = /!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HEADING_RE = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const SENTENCE_ENDINGS =
  /(でしょう|ましょう|ください|でした|ました|ません|ですね|ますね|です|ます|する|される|ている|ていた)$/;

export class LineIndex {
  readonly starts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") this.starts.push(i + 1);
    }
  }

  /** offset -> 0-based {line, col}。col は UTF-16 code unit 単位。 */
  pos(offset: number): { line: number; col: number } {
    const line = this.lineOf(offset);
    return { line, col: offset - this.starts[line] };
  }

  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  lineText(line: number): string {
    const start = this.starts[line];
    const end = line + 1 < this.starts.length ? this.starts[line + 1] - 1 : this.text.length;
    return this.text.slice(start, end);
  }
}

function maskSpans(text: string, spans: Span[]): string {
  const arr = text.split("");
  for (const [s, e] of spans) {
    for (let i = s; i < Math.min(e, arr.length); i++) {
      if (arr[i] !== "\n") arr[i] = "\0";
    }
  }
  return arr.join("");
}

function* finditer(re: RegExp, text: string): Generator<RegExpExecArray> {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m = g.exec(text);
  while (m !== null) {
    yield m;
    if (m[0].length === 0) g.lastIndex += 1;
    m = g.exec(text);
  }
}

/** Obsidian vault のファイル索引。wikilink の解決に使う。 */
export class VaultIndex {
  private static cache = new Map<string, VaultIndex>();

  private mdStems = new Map<string, string[]>();
  private relNoExt = new Set<string>();
  private allNames = new Map<string, string[]>();

  private constructor(readonly root: string) {
    const skip = new Set([".git", ".obsidian", ".trash", "node_modules", ".claude"]);
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (ent.isDirectory()) {
          if (skip.has(ent.name) || ent.name.startsWith(".")) continue;
          walk(path.join(dir, ent.name));
        } else {
          const full = path.join(dir, ent.name);
          const rel = path.relative(this.root, full);
          const lower = ent.name.toLowerCase();
          push(this.allNames, lower, rel);
          if (lower.endsWith(".md")) {
            push(this.mdStems, lower.slice(0, -3), rel);
            this.relNoExt.add(rel.slice(0, -3).toLowerCase().replaceAll(path.sep, "/"));
          }
        }
      }
    };
    walk(root);

    function push(map: Map<string, string[]>, key: string, value: string): void {
      const arr = map.get(key);
      if (arr) arr.push(value);
      else map.set(key, [value]);
    }
  }

  static forFile(filePath: string, fallbackRoot?: string): VaultIndex {
    let cur = path.dirname(path.resolve(filePath));
    let root: string | undefined;
    for (;;) {
      if (fs.existsSync(path.join(cur, ".obsidian"))) {
        root = cur;
        break;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    root = root ?? fallbackRoot ?? path.dirname(path.resolve(filePath));
    let idx = VaultIndex.cache.get(root);
    if (!idx) {
      idx = new VaultIndex(root);
      VaultIndex.cache.set(root, idx);
    }
    return idx;
  }

  static clearCache(): void {
    VaultIndex.cache.clear();
  }

  resolve(target: string): boolean {
    const t = target.trim().toLowerCase().replaceAll("\\", "/");
    if (!t) return true;
    if (t.includes("/")) {
      if (this.relNoExt.has(t)) return true;
      const base = t.split("/").at(-1) ?? "";
      const candidates = [...(this.mdStems.get(base) ?? []), ...(this.allNames.get(base) ?? [])];
      return candidates.some((rel) => {
        const r = rel.toLowerCase().replaceAll(path.sep, "/");
        return r.endsWith(t) || r.endsWith(`${t}.md`);
      });
    }
    if (this.mdStems.has(t)) return true;
    return t.includes(".") && this.allNames.has(t);
  }
}

interface OverrideEntry {
  paths?: string;
  disable?: string[];
}

/**
 * ファイルの祖先ディレクトリにある .wslsp.json を読む。
 * 形式: {"overrides": [{"paths": "<相対パスへの正規表現>", "disable": ["rule-id または category", ...]}]}
 * 最初に見つかった 1 ファイルのみ適用する。
 */
const workspaceConfigCache = new Map<string, { root: string; overrides: OverrideEntry[] } | null>();

export function clearWorkspaceConfigCache(): void {
  workspaceConfigCache.clear();
}

export function workspaceDisabledFor(filePath: string): Set<string> {
  const start = path.dirname(path.resolve(filePath));
  let found = workspaceConfigCache.get(start);
  if (found === undefined) {
    found = null;
    let cur = start;
    for (;;) {
      const cfg = path.join(cur, ".wslsp.json");
      if (fs.existsSync(cfg)) {
        try {
          const data = JSON.parse(fs.readFileSync(cfg, "utf-8")) as {
            overrides?: OverrideEntry[];
          };
          found = { root: cur, overrides: data.overrides ?? [] };
        } catch {
          found = null;
        }
        break;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    workspaceConfigCache.set(start, found);
  }
  if (!found) return new Set();
  const rel = path.relative(found.root, path.resolve(filePath)).replaceAll(path.sep, "/");
  const disabled = new Set<string>();
  for (const ov of found.overrides) {
    try {
      if (new RegExp(ov.paths ?? "").test(rel)) {
        for (const d of ov.disable ?? []) disabled.add(d);
      }
    } catch {
      // 不正な正規表現はそのエントリだけ無視する
    }
  }
  return disabled;
}

class Context {
  readonly index: LineIndex;
  readonly linkable: string;
  readonly prose: string;
  readonly tableLines = new Set<number>();
  readonly headingLines = new Set<number>();

  constructor(
    readonly text: string,
    readonly filePath?: string,
    readonly workspaceRoot?: string,
  ) {
    this.index = new LineIndex(text);

    const codeSpans: Span[] = [];
    for (const m of finditer(FENCE_RE, text)) codeSpans.push([m.index, m.index + m[0].length]);
    const fm = FRONTMATTER_RE.exec(text);
    if (fm && fm.index === 0) codeSpans.push([0, fm[0].length]);
    const tmp = maskSpans(text, codeSpans);
    for (const m of finditer(INLINE_CODE_RE, tmp)) codeSpans.push([m.index, m.index + m[0].length]);

    this.linkable = maskSpans(text, codeSpans);
    const urlSpans: Span[] = [];
    for (const m of finditer(URL_MASK_RE, this.linkable)) {
      urlSpans.push([m.index, m.index + m[0].length]);
    }
    this.prose = maskSpans(this.linkable, urlSpans);

    for (let i = 0; i < this.index.starts.length; i++) {
      const lt = this.index.lineText(i).trimStart();
      if (lt.startsWith("|")) this.tableLines.add(i);
      if (lt.startsWith("#")) this.headingLines.add(i);
    }
  }

  isTable(offset: number): boolean {
    return this.tableLines.has(this.index.lineOf(offset));
  }

  isHeading(offset: number): boolean {
    return this.headingLines.has(this.index.lineOf(offset));
  }

  /** (開始 offset, 段落テキスト) のリスト。prose ベース。 */
  paragraphs(): Array<{ start: number; text: string }> {
    const out: Array<{ start: number; text: string }> = [];
    for (const m of finditer(/(?:[^\n]|\n(?![ \t]*\n))+/g, this.prose)) {
      if (m[0].replaceAll("\0", "").trim() !== "") {
        out.push({ start: m.index, text: m[0] });
      }
    }
    return out;
  }

  /** 文のリスト。表・見出し行は除外。 */
  sentences(): Array<{ start: number; end: number; text: string }> {
    const out: Array<{ start: number; end: number; text: string }> = [];
    for (const para of this.paragraphs()) {
      if (this.isTable(para.start) || this.isHeading(para.start)) continue;
      for (const m of finditer(/[^。]*。/g, para.text)) {
        const s = para.start + m.index;
        const sent = m[0].replaceAll("\0", " ").trim();
        if (sent !== "" && !this.isTable(s) && !this.isHeading(s)) {
          out.push({ start: s, end: para.start + m.index + m[0].length, text: sent });
        }
      }
    }
    return out;
  }
}

interface CompiledRule extends Rule {
  _re?: RegExp;
  _exc: RegExp[];
}

export class Engine {
  private rules: CompiledRule[] = [];

  constructor(rulesPaths: string[], enableCategories: string[] = [], disableCategories: string[] = []) {
    const disabled = new Set<string>();
    const all: Rule[] = [];
    for (const rp of rulesPaths) {
      const data = JSON.parse(fs.readFileSync(rp, "utf-8")) as RulesFile;
      for (const c of data.default_disabled_categories ?? []) disabled.add(c);
      all.push(...(data.rules ?? []));
    }
    for (const c of enableCategories) disabled.delete(c);
    for (const c of disableCategories) disabled.add(c);

    for (const rule of all) {
      if (disabled.has(rule.category)) continue;
      const compiled: CompiledRule = { ...rule, _exc: [] };
      if (rule.type === "regex" && rule.pattern !== undefined) {
        compiled._re = compileRegex(rule.pattern, "gm");
        compiled._exc = (rule.exceptions ?? []).map((e) => compileRegex(e, "g"));
      } else if (rule.type === "density" && rule.pattern !== undefined) {
        compiled._re = compileRegex(rule.pattern, "g");
      }
      this.rules.push(compiled);
    }
  }

  // ---- チェッカー ----

  private checkRegex(rule: CompiledRule, ctx: Context): Hit[] {
    const target = rule.target ?? "prose";
    const text = target === "prose" ? ctx.prose : target === "linkable" ? ctx.linkable : ctx.text;
    const hits: Hit[] = [];
    if (!rule._re) return hits;
    for (const m of finditer(rule._re, text)) {
      const s = m.index;
      const e = m.index + m[0].length;
      if (s === e) continue;
      if (rule.skip_tables && ctx.isTable(s)) continue;
      if (rule.skip_headings && ctx.isHeading(s)) continue;
      if (rule._exc.length > 0) {
        const wStart = Math.max(0, s - 30);
        const window = ctx.text.slice(wStart, e + 30);
        const covered = rule._exc.some((exc) => {
          for (const em of finditer(exc, window)) {
            if (wStart + em.index <= s && e <= wStart + em.index + em[0].length) return true;
          }
          return false;
        });
        if (covered) continue;
      }
      hits.push({ start: s, end: e });
    }
    return hits;
  }

  private checkDensity(rule: CompiledRule, ctx: Context): Hit[] {
    const hits: Hit[] = [];
    const max = rule.max_per_paragraph ?? 1;
    if (!rule._re) return hits;
    for (const para of ctx.paragraphs()) {
      const matches = [...finditer(rule._re, para.text)];
      if (matches.length > max) {
        const m = matches[max];
        hits.push({
          start: para.start + m.index,
          end: para.start + m.index + m[0].length,
          message: fmt(rule.message, { count: matches.length }),
        });
      }
    }
    return hits;
  }

  private checkEndingRepetition(rule: CompiledRule, ctx: Context): Hit[] {
    const hits: Hit[] = [];
    const minRun = rule.min_run ?? 3;
    let runEnding: string | null = null;
    let run: Array<{ start: number; end: number; text: string }> = [];

    const flush = (): void => {
      if (runEnding !== null && run.length >= minRun) {
        const last = run[run.length - 1];
        const m = SENTENCE_ENDINGS.exec(last.text.replace(/。+$/, ""));
        const spanStart = last.end - 1 - (m ? m[0].length : 2);
        hits.push({
          start: Math.max(last.start, spanStart),
          end: last.end,
          message: fmt(rule.message, { ending: runEnding, count: run.length }),
        });
      }
    };

    for (const sent of ctx.sentences()) {
      const body = sent.text.replace(/。+$/, "");
      const m = SENTENCE_ENDINGS.exec(body);
      const ending = m ? m[0] : null;
      if (ending !== null && ending === runEnding) {
        run.push(sent);
      } else {
        flush();
        runEnding = ending;
        run = ending !== null ? [sent] : [];
      }
    }
    flush();
    return hits;
  }

  private checkConnectiveRun(rule: CompiledRule, ctx: Context): Hit[] {
    const hits: Hit[] = [];
    const minRun = rule.min_run ?? 3;
    const connectives = rule.connectives ?? [];
    let run: Array<{ start: number; connective: string }> = [];

    const flush = (): void => {
      if (run.length >= minRun) {
        const last = run[run.length - 1];
        hits.push({
          start: last.start,
          end: last.start + last.connective.length,
          message: fmt(rule.message, { count: run.length }),
        });
      }
    };

    for (const sent of ctx.sentences()) {
      const head = sent.text.replace(/^[\0 \t\n\-*>0-9. ]+/, "");
      const hit = connectives.find((c) => head.startsWith(c));
      if (hit !== undefined) {
        run.push({ start: sent.start, connective: hit });
      } else {
        flush();
        run = [];
      }
    }
    flush();
    return hits;
  }

  private checkUrlAdjacency(rule: CompiledRule, ctx: Context): Hit[] {
    const hits: Hit[] = [];
    const text = ctx.linkable;
    const okPrev = new Set([" ", "\t", "\n", "<", "\0", "(", '"', "'"]);
    const okNext = new Set([" ", "\t", "\n", ">", "\0", '"', "'"]);
    for (const m of finditer(URL_ADJ_RE, text)) {
      const s = m.index;
      const e = m.index + m[0].length;
      if (text.slice(Math.max(0, s - 2), s) === "](") continue; // Markdown リンク構文は別ルールで扱う
      const prev = s > 0 ? text[s - 1] : "\n";
      const next = e < text.length ? text[e] : "\n";
      if (!okPrev.has(prev)) {
        const detail =
          (prev.codePointAt(0) ?? 0) > 0x2fff ? "全角文字が密着しリンクが壊れる" : "直前に半角スペースがない";
        hits.push({ start: s - 1, end: s + 8, message: `${rule.message}（前方: '${prev}' — ${detail}）` });
      }
      if (!okNext.has(next)) {
        const detail =
          (next.codePointAt(0) ?? 0) > 0x2fff ? "全角文字が密着しリンクが壊れる" : "直後に半角スペースがない";
        hits.push({ start: e - 1, end: e + 1, message: `${rule.message}（後方: '${next}' — ${detail}）` });
      }
    }
    return hits;
  }

  private headingsOf(filePath: string): string[] {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return [];
    }
    return [...finditer(HEADING_RE, content)].map((m) => m[1]);
  }

  private static slug(heading: string): string {
    return heading
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\- ]/gu, "")
      .replaceAll(" ", "-");
  }

  private anchorOk(anchor: string, headings: string[]): boolean {
    const a = decodeURIComponent(anchor).trim().toLowerCase();
    if (a.startsWith("^")) return true; // block reference は検査対象外
    return headings.some((h) => a === h.trim().toLowerCase() || a === Engine.slug(h));
  }

  private checkWikilink(rule: CompiledRule, ctx: Context): Hit[] {
    if (!ctx.filePath) return [];
    const vault = VaultIndex.forFile(ctx.filePath, ctx.workspaceRoot);
    const hits: Hit[] = [];
    for (const m of finditer(WIKILINK_RE, ctx.linkable)) {
      const inner = m[1];
      const target = inner.split("|")[0];
      const name = target.split("#")[0].trim();
      if (name !== "" && !vault.resolve(name)) {
        hits.push({
          start: m.index,
          end: m.index + m[0].length,
          message: fmt(rule.message, { target: name }),
        });
      }
    }
    return hits;
  }

  private checkMdLink(rule: CompiledRule, ctx: Context): Hit[] {
    const hits: Hit[] = [];
    const base = ctx.filePath ? path.dirname(path.resolve(ctx.filePath)) : undefined;
    for (const m of finditer(MDLINK_RE, ctx.linkable)) {
      const target = m[1];
      if (SCHEME_RE.test(target)) continue; // http:, mailto: 等
      const span: Hit = { start: m.index, end: m.index + m[0].length };
      if (target.startsWith("#")) {
        const headings = [...finditer(HEADING_RE, ctx.text)].map((h) => h[1]);
        if (!this.anchorOk(target.slice(1), headings)) {
          hits.push({ ...span, message: fmt(rule.message, { target }) });
        }
        continue;
      }
      if (target.startsWith("/")) continue; // 絶対 path は別ルールが扱う
      if (base === undefined) continue;
      const [pathPart, ...anchorParts] = target.split("#");
      const anchor = anchorParts.join("#");
      let resolved: string;
      try {
        resolved = path.normalize(path.join(base, decodeURIComponent(pathPart)));
      } catch {
        continue;
      }
      if (!fs.existsSync(resolved)) {
        hits.push({ ...span, message: fmt(rule.message, { target }) });
      } else if (anchor !== "" && resolved.endsWith(".md")) {
        if (!this.anchorOk(anchor, this.headingsOf(resolved))) {
          hits.push({
            ...span,
            message: `${fmt(rule.message, { target: `#${anchor}` })}（アンカー不一致）`,
          });
        }
      }
    }
    return hits;
  }

  // ---- エントリポイント ----

  lintText(text: string, filePath?: string, workspaceRoot?: string): Diagnostic[] {
    const ctx = new Context(text, filePath, workspaceRoot);
    const checkers: Record<string, (rule: CompiledRule, ctx: Context) => Hit[]> = {
      regex: (r, c) => this.checkRegex(r, c),
      density: (r, c) => this.checkDensity(r, c),
      ending_repetition: (r, c) => this.checkEndingRepetition(r, c),
      connective_run: (r, c) => this.checkConnectiveRun(r, c),
      url_adjacency: (r, c) => this.checkUrlAdjacency(r, c),
      wikilink: (r, c) => this.checkWikilink(r, c),
      md_link: (r, c) => this.checkMdLink(r, c),
    };

    let diags: Diagnostic[] = [];
    for (const rule of this.rules) {
      const fn = checkers[rule.type];
      if (!fn) continue;
      for (const hit of fn(rule, ctx)) {
        const start = Math.max(0, hit.start);
        const end = Math.min(hit.end, text.length);
        const s = ctx.index.pos(start);
        const e = ctx.index.pos(end);
        diags.push({
          ruleId: rule.id,
          category: rule.category,
          severity: rule.severity,
          message: hit.message ?? rule.message,
          start,
          end,
          line: s.line + 1,
          col: s.col + 1,
          endLine: e.line + 1,
          endCol: e.col + 1,
          snippet: text.slice(start, end).replaceAll("\n", "\\n").slice(0, 60),
          fix: rule.fix,
        });
      }
    }

    if (filePath) {
      const disabled = workspaceDisabledFor(filePath);
      if (disabled.size > 0) {
        diags = diags.filter((d) => !disabled.has(d.ruleId) && !disabled.has(d.category));
      }
    }

    // 同一 span の重複は重い severity を残す
    const seen = new Map<string, Diagnostic>();
    for (const d of diags) {
      const key = `${d.start}:${d.end}:${d.category}`;
      const prev = seen.get(key);
      if (!prev || SEVERITY_ORDER[d.severity] < SEVERITY_ORDER[prev.severity]) {
        seen.set(key, d);
      }
    }
    return [...seen.values()].sort(
      (a, b) => a.start - b.start || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
  }

  lintFile(filePath: string, workspaceRoot?: string): Diagnostic[] {
    const text = fs.readFileSync(filePath, "utf-8");
    return this.lintText(text, filePath, workspaceRoot);
  }
}

export function defaultRulesPath(): string {
  // cjs バンドル (dist/) では __dirname、ESM 実行 (vitest) では import.meta.url を基準にする。
  // どちらも repo 直下の rules/core.json に解決される。
  const here = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "rules", "core.json");
}
