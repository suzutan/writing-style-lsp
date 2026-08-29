/** CLI: ファイル・ディレクトリを lint し、diagnostics を text / json で出力する。 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { type Diagnostic, defaultRulesPath, Engine, SEVERITY_ORDER, type Severity } from "./engine";

const SEV_MARK: Record<Severity, string> = { error: "E", warning: "W", info: "I", hint: "H" };

function collectFiles(paths: string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
        walk(full);
      } else if (ent.name.endsWith(".md")) {
        files.push(full);
      }
    }
  };
  for (const p of paths) {
    if (fs.statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
  return files;
}

export function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
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
      "fail-on": { type: "string", default: "none" },
    },
  });

  if (positionals.length === 0) {
    console.error("usage: wslsp lint <paths...> [--rules FILE]... [--stat] [--fix] [--format text|json]");
    return 2;
  }

  const rulesPaths = values.rules && values.rules.length > 0 ? values.rules : [defaultRulesPath()];
  const engine = new Engine(rulesPaths, values["enable-category"] ?? [], values["disable-category"] ?? []);
  const threshold = SEVERITY_ORDER[values["min-severity"] as Severity] ?? 3;

  const files = collectFiles(positionals);
  const all: Array<{ file: string; d: Diagnostic }> = [];
  let totalChars = 0;

  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch (err) {
      console.error(`skip ${file}: ${String(err)}`);
      continue;
    }
    totalChars += text.length;

    if (values.fix) {
      const diags = engine.lintText(text, file);
      let fixed = text;
      for (const d of [...diags].sort((a, b) => b.start - a.start)) {
        if (d.fix?.replace !== undefined) {
          fixed = fixed.slice(0, d.start) + d.fix.replace + fixed.slice(d.end);
        }
      }
      if (fixed !== text) {
        fs.writeFileSync(file, fixed);
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
          ...(d.fix ? { fix: d.fix } : {}),
        })),
        null,
        2,
      ),
    );
  } else {
    for (const { file, d } of all) {
      console.log(
        `${file}:${d.line}:${d.col} ${SEV_MARK[d.severity]} [${d.ruleId}] ${d.message}  ›${d.snippet}‹`,
      );
    }
  }

  if (values.stat) {
    const count = (key: (d: Diagnostic) => string): Map<string, number> => {
      const m = new Map<string, number>();
      for (const { d } of all) m.set(key(d), (m.get(key(d)) ?? 0) + 1);
      return m;
    };
    const bySev = count((d) => d.severity);
    const byCat = count((d) => d.category);
    const byRule = count((d) => d.ruleId);
    const per1000 = ((all.length * 1000) / Math.max(1, totalChars)).toFixed(2);
    console.error("\n--- stat ---");
    console.error(
      `files: ${files.length}  chars: ${totalChars}  diagnostics: ${all.length}  per-1000-chars: ${per1000}`,
    );
    const fmtMap = (m: Map<string, number>): string =>
      [...m.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
    console.error(`by severity: ${fmtMap(bySev)}`);
    console.error(`by category: ${fmtMap(byCat)}`);
    for (const [rule, n] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
      console.error(`  ${String(n).padStart(4)}  ${rule}`);
    }
  }

  const failOn = values["fail-on"] as Severity | "none";
  if (failOn !== "none" && SEVERITY_ORDER[failOn] !== undefined) {
    if (all.some(({ d }) => SEVERITY_ORDER[d.severity] <= SEVERITY_ORDER[failOn])) return 1;
  }
  return 0;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === "lint") args.shift();
  process.exit(main(args));
}
