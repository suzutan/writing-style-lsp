#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/cli.ts
var cli_exports = {};
__export(cli_exports, {
  main: () => main
});
module.exports = __toCommonJS(cli_exports);
var fs2 = __toESM(require("node:fs"));
var path2 = __toESM(require("node:path"));
var import_node_util = require("node:util");

// src/engine.ts
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
var import_node_url = require("node:url");
var import_meta = {};
var SEVERITY_ORDER = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3
};
function compileRegex(pattern, flags) {
  try {
    return new RegExp(pattern, `${flags}u`);
  } catch {
    return new RegExp(pattern, flags);
  }
}
function fmt(message, vars) {
  let out = message;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}
var FENCE_RE = /^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm;
var INLINE_CODE_RE = /`[^`\n]+`/g;
var FRONTMATTER_RE = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|(?![\s\S]))/;
var URL_MASK_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%()]+/g;
var URL_ADJ_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]+/g;
var WIKILINK_RE = /!?\[\[([^\]\n]+?)\]\]/g;
var MDLINK_RE = /!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
var HEADING_RE = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
var SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
var SENTENCE_ENDINGS = /(でしょう|ましょう|ください|でした|ました|ません|ですね|ますね|です|ます|する|される|ている|ていた)$/;
var LineIndex = class {
  constructor(text) {
    this.text = text;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") this.starts.push(i + 1);
    }
  }
  starts = [0];
  /** offset -> 0-based {line, col}。col は UTF-16 code unit 単位。 */
  pos(offset) {
    const line = this.lineOf(offset);
    return { line, col: offset - this.starts[line] };
  }
  lineOf(offset) {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  lineText(line) {
    const start = this.starts[line];
    const end = line + 1 < this.starts.length ? this.starts[line + 1] - 1 : this.text.length;
    return this.text.slice(start, end);
  }
};
function maskSpans(text, spans) {
  const arr = text.split("");
  for (const [s, e] of spans) {
    for (let i = s; i < Math.min(e, arr.length); i++) {
      if (arr[i] !== "\n") arr[i] = "\0";
    }
  }
  return arr.join("");
}
function* finditer(re, text) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m = g.exec(text);
  while (m !== null) {
    yield m;
    if (m[0].length === 0) g.lastIndex += 1;
    m = g.exec(text);
  }
}
var VaultIndex = class _VaultIndex {
  constructor(root) {
    this.root = root;
    const skip = /* @__PURE__ */ new Set([".git", ".obsidian", ".trash", "node_modules", ".claude"]);
    const walk = (dir) => {
      let entries;
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
    function push(map, key, value) {
      const arr = map.get(key);
      if (arr) arr.push(value);
      else map.set(key, [value]);
    }
  }
  static cache = /* @__PURE__ */ new Map();
  mdStems = /* @__PURE__ */ new Map();
  relNoExt = /* @__PURE__ */ new Set();
  allNames = /* @__PURE__ */ new Map();
  static forFile(filePath, fallbackRoot) {
    let cur = path.dirname(path.resolve(filePath));
    let root;
    for (; ; ) {
      if (fs.existsSync(path.join(cur, ".obsidian"))) {
        root = cur;
        break;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    root = root ?? fallbackRoot ?? path.dirname(path.resolve(filePath));
    let idx = _VaultIndex.cache.get(root);
    if (!idx) {
      idx = new _VaultIndex(root);
      _VaultIndex.cache.set(root, idx);
    }
    return idx;
  }
  static clearCache() {
    _VaultIndex.cache.clear();
  }
  resolve(target) {
    const t = target.trim().toLowerCase().replaceAll("\\", "/");
    if (!t) return true;
    if (t.includes("/")) {
      if (this.relNoExt.has(t)) return true;
      const base = t.split("/").at(-1) ?? "";
      const candidates = [...this.mdStems.get(base) ?? [], ...this.allNames.get(base) ?? []];
      return candidates.some((rel) => {
        const r = rel.toLowerCase().replaceAll(path.sep, "/");
        return r.endsWith(t) || r.endsWith(`${t}.md`);
      });
    }
    if (this.mdStems.has(t)) return true;
    return t.includes(".") && this.allNames.has(t);
  }
};
var workspaceConfigCache = /* @__PURE__ */ new Map();
function workspaceDisabledFor(filePath) {
  const start = path.dirname(path.resolve(filePath));
  let found = workspaceConfigCache.get(start);
  if (found === void 0) {
    found = null;
    let cur = start;
    for (; ; ) {
      const cfg = path.join(cur, ".wslsp.json");
      if (fs.existsSync(cfg)) {
        try {
          const data = JSON.parse(fs.readFileSync(cfg, "utf-8"));
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
  if (!found) return /* @__PURE__ */ new Set();
  const rel = path.relative(found.root, path.resolve(filePath)).replaceAll(path.sep, "/");
  const disabled = /* @__PURE__ */ new Set();
  for (const ov of found.overrides) {
    try {
      if (new RegExp(ov.paths ?? "").test(rel)) {
        for (const d of ov.disable ?? []) disabled.add(d);
      }
    } catch {
    }
  }
  return disabled;
}
var Context = class {
  constructor(text, filePath, workspaceRoot) {
    this.text = text;
    this.filePath = filePath;
    this.workspaceRoot = workspaceRoot;
    this.index = new LineIndex(text);
    const codeSpans = [];
    for (const m of finditer(FENCE_RE, text)) codeSpans.push([m.index, m.index + m[0].length]);
    const fm = FRONTMATTER_RE.exec(text);
    if (fm && fm.index === 0) codeSpans.push([0, fm[0].length]);
    const tmp = maskSpans(text, codeSpans);
    for (const m of finditer(INLINE_CODE_RE, tmp)) codeSpans.push([m.index, m.index + m[0].length]);
    this.linkable = maskSpans(text, codeSpans);
    const urlSpans = [];
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
  index;
  linkable;
  prose;
  tableLines = /* @__PURE__ */ new Set();
  headingLines = /* @__PURE__ */ new Set();
  isTable(offset) {
    return this.tableLines.has(this.index.lineOf(offset));
  }
  isHeading(offset) {
    return this.headingLines.has(this.index.lineOf(offset));
  }
  /** (開始 offset, 段落テキスト) のリスト。prose ベース。 */
  paragraphs() {
    const out = [];
    for (const m of finditer(/(?:[^\n]|\n(?![ \t]*\n))+/g, this.prose)) {
      if (m[0].replaceAll("\0", "").trim() !== "") {
        out.push({ start: m.index, text: m[0] });
      }
    }
    return out;
  }
  /** 文のリスト。表・見出し行は除外。 */
  sentences() {
    const out = [];
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
};
var Engine = class _Engine {
  rules = [];
  constructor(rulesPaths, enableCategories = [], disableCategories = []) {
    const disabled = /* @__PURE__ */ new Set();
    const all = [];
    for (const rp of rulesPaths) {
      const data = JSON.parse(fs.readFileSync(rp, "utf-8"));
      for (const c of data.default_disabled_categories ?? []) disabled.add(c);
      all.push(...data.rules ?? []);
    }
    for (const c of enableCategories) disabled.delete(c);
    for (const c of disableCategories) disabled.add(c);
    for (const rule of all) {
      if (disabled.has(rule.category)) continue;
      const compiled = { ...rule, _exc: [] };
      if (rule.type === "regex" && rule.pattern !== void 0) {
        compiled._re = compileRegex(rule.pattern, "gm");
        compiled._exc = (rule.exceptions ?? []).map((e) => compileRegex(e, "g"));
      } else if (rule.type === "density" && rule.pattern !== void 0) {
        compiled._re = compileRegex(rule.pattern, "g");
      }
      this.rules.push(compiled);
    }
  }
  // ---- チェッカー ----
  checkRegex(rule, ctx) {
    const target = rule.target ?? "prose";
    const text = target === "prose" ? ctx.prose : target === "linkable" ? ctx.linkable : ctx.text;
    const hits = [];
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
  checkDensity(rule, ctx) {
    const hits = [];
    const max = rule.max_per_paragraph ?? 1;
    if (!rule._re) return hits;
    for (const para of ctx.paragraphs()) {
      const matches = [...finditer(rule._re, para.text)];
      if (matches.length > max) {
        const m = matches[max];
        hits.push({
          start: para.start + m.index,
          end: para.start + m.index + m[0].length,
          message: fmt(rule.message, { count: matches.length })
        });
      }
    }
    return hits;
  }
  checkEndingRepetition(rule, ctx) {
    const hits = [];
    const minRun = rule.min_run ?? 3;
    let runEnding = null;
    let run = [];
    const flush = () => {
      if (runEnding !== null && run.length >= minRun) {
        const last = run[run.length - 1];
        const m = SENTENCE_ENDINGS.exec(last.text.replace(/。+$/, ""));
        const spanStart = last.end - 1 - (m ? m[0].length : 2);
        hits.push({
          start: Math.max(last.start, spanStart),
          end: last.end,
          message: fmt(rule.message, { ending: runEnding, count: run.length })
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
  checkConnectiveRun(rule, ctx) {
    const hits = [];
    const minRun = rule.min_run ?? 3;
    const connectives = rule.connectives ?? [];
    let run = [];
    const flush = () => {
      if (run.length >= minRun) {
        const last = run[run.length - 1];
        hits.push({
          start: last.start,
          end: last.start + last.connective.length,
          message: fmt(rule.message, { count: run.length })
        });
      }
    };
    for (const sent of ctx.sentences()) {
      const head = sent.text.replace(/^[\0 \t\n\-*>0-9. ]+/, "");
      const hit = connectives.find((c) => head.startsWith(c));
      if (hit !== void 0) {
        run.push({ start: sent.start, connective: hit });
      } else {
        flush();
        run = [];
      }
    }
    flush();
    return hits;
  }
  checkUrlAdjacency(rule, ctx) {
    const hits = [];
    const text = ctx.linkable;
    const okPrev = /* @__PURE__ */ new Set([" ", "	", "\n", "<", "\0", "(", '"', "'"]);
    const okNext = /* @__PURE__ */ new Set([" ", "	", "\n", ">", "\0", '"', "'"]);
    for (const m of finditer(URL_ADJ_RE, text)) {
      const s = m.index;
      const e = m.index + m[0].length;
      if (text.slice(Math.max(0, s - 2), s) === "](") continue;
      const prev = s > 0 ? text[s - 1] : "\n";
      const next = e < text.length ? text[e] : "\n";
      if (!okPrev.has(prev)) {
        const detail = (prev.codePointAt(0) ?? 0) > 12287 ? "\u5168\u89D2\u6587\u5B57\u304C\u5BC6\u7740\u3057\u30EA\u30F3\u30AF\u304C\u58CA\u308C\u308B" : "\u76F4\u524D\u306B\u534A\u89D2\u30B9\u30DA\u30FC\u30B9\u304C\u306A\u3044";
        hits.push({ start: s - 1, end: s + 8, message: `${rule.message}\uFF08\u524D\u65B9: '${prev}' \u2014 ${detail}\uFF09` });
      }
      if (!okNext.has(next)) {
        const detail = (next.codePointAt(0) ?? 0) > 12287 ? "\u5168\u89D2\u6587\u5B57\u304C\u5BC6\u7740\u3057\u30EA\u30F3\u30AF\u304C\u58CA\u308C\u308B" : "\u76F4\u5F8C\u306B\u534A\u89D2\u30B9\u30DA\u30FC\u30B9\u304C\u306A\u3044";
        hits.push({ start: e - 1, end: e + 1, message: `${rule.message}\uFF08\u5F8C\u65B9: '${next}' \u2014 ${detail}\uFF09` });
      }
    }
    return hits;
  }
  headingsOf(filePath) {
    let content;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return [];
    }
    return [...finditer(HEADING_RE, content)].map((m) => m[1]);
  }
  static slug(heading) {
    return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, "").replaceAll(" ", "-");
  }
  anchorOk(anchor, headings) {
    const a = decodeURIComponent(anchor).trim().toLowerCase();
    if (a.startsWith("^")) return true;
    return headings.some((h) => a === h.trim().toLowerCase() || a === _Engine.slug(h));
  }
  checkWikilink(rule, ctx) {
    if (!ctx.filePath) return [];
    const vault = VaultIndex.forFile(ctx.filePath, ctx.workspaceRoot);
    const hits = [];
    for (const m of finditer(WIKILINK_RE, ctx.linkable)) {
      const inner = m[1];
      const target = inner.split("|")[0];
      const name = target.split("#")[0].trim();
      if (name !== "" && !vault.resolve(name)) {
        hits.push({
          start: m.index,
          end: m.index + m[0].length,
          message: fmt(rule.message, { target: name })
        });
      }
    }
    return hits;
  }
  checkMdLink(rule, ctx) {
    const hits = [];
    const base = ctx.filePath ? path.dirname(path.resolve(ctx.filePath)) : void 0;
    for (const m of finditer(MDLINK_RE, ctx.linkable)) {
      const target = m[1];
      if (SCHEME_RE.test(target)) continue;
      const span = { start: m.index, end: m.index + m[0].length };
      if (target.startsWith("#")) {
        const headings = [...finditer(HEADING_RE, ctx.text)].map((h) => h[1]);
        if (!this.anchorOk(target.slice(1), headings)) {
          hits.push({ ...span, message: fmt(rule.message, { target }) });
        }
        continue;
      }
      if (target.startsWith("/")) continue;
      if (base === void 0) continue;
      const [pathPart, ...anchorParts] = target.split("#");
      const anchor = anchorParts.join("#");
      let resolved;
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
            message: `${fmt(rule.message, { target: `#${anchor}` })}\uFF08\u30A2\u30F3\u30AB\u30FC\u4E0D\u4E00\u81F4\uFF09`
          });
        }
      }
    }
    return hits;
  }
  // ---- エントリポイント ----
  lintText(text, filePath, workspaceRoot) {
    const ctx = new Context(text, filePath, workspaceRoot);
    const checkers = {
      regex: (r, c) => this.checkRegex(r, c),
      density: (r, c) => this.checkDensity(r, c),
      ending_repetition: (r, c) => this.checkEndingRepetition(r, c),
      connective_run: (r, c) => this.checkConnectiveRun(r, c),
      url_adjacency: (r, c) => this.checkUrlAdjacency(r, c),
      wikilink: (r, c) => this.checkWikilink(r, c),
      md_link: (r, c) => this.checkMdLink(r, c)
    };
    let diags = [];
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
          fix: rule.fix
        });
      }
    }
    if (filePath) {
      const disabled = workspaceDisabledFor(filePath);
      if (disabled.size > 0) {
        diags = diags.filter((d) => !disabled.has(d.ruleId) && !disabled.has(d.category));
      }
    }
    const seen = /* @__PURE__ */ new Map();
    for (const d of diags) {
      const key = `${d.start}:${d.end}:${d.category}`;
      const prev = seen.get(key);
      if (!prev || SEVERITY_ORDER[d.severity] < SEVERITY_ORDER[prev.severity]) {
        seen.set(key, d);
      }
    }
    return [...seen.values()].sort(
      (a, b) => a.start - b.start || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    );
  }
  lintFile(filePath, workspaceRoot) {
    const text = fs.readFileSync(filePath, "utf-8");
    return this.lintText(text, filePath, workspaceRoot);
  }
};
function defaultRulesPath() {
  const here = typeof __dirname !== "undefined" ? __dirname : path.dirname((0, import_node_url.fileURLToPath)(import_meta.url));
  return path.join(here, "..", "rules", "core.json");
}

// src/cli.ts
var SEV_MARK = { error: "E", warning: "W", info: "I", hint: "H" };
function collectFiles(paths) {
  const files = [];
  const walk = (dir) => {
    for (const ent of fs2.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path2.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
        walk(full);
      } else if (ent.name.endsWith(".md")) {
        files.push(full);
      }
    }
  };
  for (const p of paths) {
    if (fs2.statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
  return files;
}
function main(argv) {
  const { values, positionals } = (0, import_node_util.parseArgs)({
    args: argv,
    allowPositionals: true,
    options: {
      rules: { type: "string", multiple: true },
      "enable-category": { type: "string", multiple: true },
      "disable-category": { type: "string", multiple: true },
      "min-severity": { type: "string", default: "hint" },
      format: { type: "string", default: "text" },
      stat: { type: "boolean", default: false },
      fix: { type: "boolean", default: false },
      "fail-on": { type: "string", default: "none" }
    }
  });
  if (positionals.length === 0) {
    console.error("usage: wslsp lint <paths...> [--rules FILE]... [--stat] [--fix] [--format text|json]");
    return 2;
  }
  const rulesPaths = values.rules && values.rules.length > 0 ? values.rules : [defaultRulesPath()];
  const engine = new Engine(rulesPaths, values["enable-category"] ?? [], values["disable-category"] ?? []);
  const threshold = SEVERITY_ORDER[values["min-severity"]] ?? 3;
  const files = collectFiles(positionals);
  const all = [];
  let totalChars = 0;
  for (const file of files) {
    let text;
    try {
      text = fs2.readFileSync(file, "utf-8");
    } catch (err) {
      console.error(`skip ${file}: ${String(err)}`);
      continue;
    }
    totalChars += text.length;
    if (values.fix) {
      const diags = engine.lintText(text, file);
      let fixed = text;
      for (const d of [...diags].sort((a, b) => b.start - a.start)) {
        if (d.fix?.replace !== void 0) {
          fixed = fixed.slice(0, d.start) + d.fix.replace + fixed.slice(d.end);
        }
      }
      if (fixed !== text) {
        fs2.writeFileSync(file, fixed);
        console.error(`fixed: ${file}`);
        text = fixed;
      }
    }
    for (const d of engine.lintText(text, file)) {
      if (SEVERITY_ORDER[d.severity] <= threshold) all.push({ file, d });
    }
  }
  if (values.format === "json") {
    console.log(
      JSON.stringify(
        all.map(({ file, d }) => ({
          file,
          rule: d.ruleId,
          category: d.category,
          severity: d.severity,
          message: d.message,
          line: d.line,
          col: d.col,
          endLine: d.endLine,
          endCol: d.endCol,
          snippet: d.snippet,
          ...d.fix ? { fix: d.fix } : {}
        })),
        null,
        2
      )
    );
  } else {
    for (const { file, d } of all) {
      console.log(
        `${file}:${d.line}:${d.col} ${SEV_MARK[d.severity]} [${d.ruleId}] ${d.message}  \u203A${d.snippet}\u2039`
      );
    }
  }
  if (values.stat) {
    const count = (key) => {
      const m = /* @__PURE__ */ new Map();
      for (const { d } of all) m.set(key(d), (m.get(key(d)) ?? 0) + 1);
      return m;
    };
    const bySev = count((d) => d.severity);
    const byCat = count((d) => d.category);
    const byRule = count((d) => d.ruleId);
    const per1000 = (all.length * 1e3 / Math.max(1, totalChars)).toFixed(2);
    console.error("\n--- stat ---");
    console.error(
      `files: ${files.length}  chars: ${totalChars}  diagnostics: ${all.length}  per-1000-chars: ${per1000}`
    );
    const fmtMap = (m) => [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`).join(", ");
    console.error(`by severity: ${fmtMap(bySev)}`);
    console.error(`by category: ${fmtMap(byCat)}`);
    for (const [rule, n] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
      console.error(`  ${String(n).padStart(4)}  ${rule}`);
    }
  }
  const failOn = values["fail-on"];
  if (failOn !== "none" && SEVERITY_ORDER[failOn] !== void 0) {
    if (all.some(({ d }) => SEVERITY_ORDER[d.severity] <= SEVERITY_ORDER[failOn])) return 1;
  }
  return 0;
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === "lint") args.shift();
  process.exit(main(args));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  main
});
