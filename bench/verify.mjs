import { deepStrictEqual, match, ok } from "node:assert";
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { targetPath, temporaryDirectory } from "./harness.mjs";

const bench = path.dirname(fileURLToPath(import.meta.url));
const target = targetPath(process.argv[2]);
if (process.argv.length !== 3) throw new Error("usage: node bench/verify.mjs <absolute-target>");

function invoke(command, checkout, cwd) {
  const start = performance.now();
  const result = spawnSync(path.join(bench, command), [checkout], {
    cwd,
    encoding: "utf8",
    timeout: command === "measure" ? 10_000 : 60_000,
  });
  if (result.error) throw result.error;
  return { ...result, wall_ms: performance.now() - start };
}

function measurement(checkout, cwd) {
  const result = invoke("measure", checkout, cwd);
  deepStrictEqual(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  deepStrictEqual(lines.length, 1, "measure must emit exactly one line");
  const parsed = JSON.parse(lines[0]);
  deepStrictEqual(Object.keys(parsed), ["metrics"]);
  deepStrictEqual(Object.keys(parsed.metrics), ["lint_cpu_ms"]);
  ok(Number.isFinite(parsed.metrics.lint_cpu_ms) && parsed.metrics.lint_cpu_ms > 0);
  return { cpu_ms: parsed.metrics.lint_cpu_ms, wall_ms: result.wall_ms };
}

temporaryDirectory((sandbox) => {
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const sample = measurement(target, sandbox);
    ok(sample.cpu_ms >= 200, `baseline CPU time below 200ms: ${sample.cpu_ms}`);
    samples.push(sample);
    process.stderr.write(`measurement ${i + 1}/10: ${sample.cpu_ms}ms CPU\n`);
  }

  const guard = invoke("guard", target, sandbox);
  deepStrictEqual(guard.status, 0, guard.stderr);

  const copy = path.join(sandbox, "external checkout with spaces");
  for (const name of ["src", "dist", "tests", "rules", "scripts", "package.json", "tsconfig.json"]) {
    cpSync(path.join(target, name), path.join(copy, name), { recursive: true });
  }
  symlinkSync(path.join(target, "node_modules"), path.join(copy, "node_modules"), "dir");
  const external = measurement(copy, sandbox);

  const rulesPath = path.join(copy, "rules/core.json");
  const originalRules = readFileSync(rulesPath);
  const rules = JSON.parse(originalRules);
  const rule = rules.rules.find((rule) => rule.id === "ai-slop.p1.em-dash");
  ok(rule, "expected fixture-covered regex rule");
  rule.pattern = "(?!)";
  writeFileSync(rulesPath, JSON.stringify(rules));
  const changedRule = invoke("guard", copy, sandbox);
  ok(changedRule.status !== 0, "guard accepted a changed rule");
  match(changedRule.stderr, /golden diagnostics differ/);
  writeFileSync(rulesPath, originalRules);

  const sourcePath = path.join(copy, "src/cli.ts");
  const originalSource = readFileSync(sourcePath);
  const originalDist = readFileSync(path.join(copy, "dist/cli.js"));
  writeFileSync(sourcePath, `process.title = "bench-unbuilt-source";\n${originalSource}`);
  const staleDist = invoke("guard", copy, sandbox);
  ok(staleDist.status !== 0, "guard accepted stale dist");
  match(staleDist.stderr, /dist\/cli\.js differs from a fresh target\/src build/);
  deepStrictEqual(readFileSync(path.join(copy, "dist/cli.js")), originalDist);
  writeFileSync(sourcePath, originalSource);

  for (const name of [".npmrc", "vitest.config.mjs", "vite.config.ts", "vitest.workspace.json"]) {
    writeFileSync(path.join(copy, name), "");
    const override = invoke("guard", copy, sandbox);
    ok(override.status !== 0, `guard accepted ${name}`);
    match(override.stderr, /unsupported benchmark configuration/);
    rmSync(path.join(copy, name));
  }

  const enginePath = path.join(copy, "src/engine.ts");
  const engineSource = readFileSync(enginePath, "utf8");
  const sentinelSource = engineSource.replace(
    "const ctx = new Context(text, filePath, workspaceRoot);",
    'throw new Error("external-target-engine-sentinel");\n    const ctx = new Context(text, filePath, workspaceRoot);',
  );
  ok(engineSource !== sentinelSource);
  writeFileSync(enginePath, sentinelSource);
  const changedEngine = invoke("measure", copy, sandbox);
  ok(changedEngine.status !== 0, "measure did not use the external target engine");
  match(changedEngine.stderr, /external-target-engine-sentinel/);
  deepStrictEqual(changedEngine.stdout, "");

  for (const command of ["prepare", "measure", "guard"]) {
    const invalid = invoke(command, "relative-path", sandbox);
    ok(invalid.status !== 0, `${command} accepted a relative target`);
    deepStrictEqual(invalid.stdout, "");
  }

  const values = samples.map((sample) => sample.cpu_ms).sort((a, b) => a - b);
  const median = (values[4] + values[5]) / 2;
  process.stdout.write(
    `${JSON.stringify({
      samples,
      median_cpu_ms: median,
      relative_range: (values.at(-1) - values[0]) / median,
      external_copy: external,
      checks: {
        guard: "passed",
        changed_rule: "rejected by golden",
        stale_dist: "rejected without modifying dist",
        external_target: "measured; target engine sentinel rejected",
        test_configuration: "npm and Vitest/Vite overrides rejected",
        relative_target: "rejected by all three entry points",
      },
    })}\n`,
  );
});
