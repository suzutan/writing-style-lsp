# Lint benchmark contract

Run the harness from the base checkout and pass the absolute path of the checkout
being evaluated. Commands do not depend on the caller's working directory.

```sh
/absolute/base/bench/prepare /absolute/target
/absolute/base/bench/guard /absolute/target
/absolute/base/bench/measure /absolute/target
```

`prepare` runs `npm ci`, checks committed artifacts against a fresh in-memory
build, then runs `npm run build`. Stale or missing `dist/` artifacts fail before
the build can overwrite the evidence. Build and commit intentional source changes
before preparing a candidate. Dependency installation and build logs go to stderr.

`measure` prints exactly one JSON line:

```json
{"metrics":{"lint_cpu_ms":650.0}}
```

`lint_cpu_ms` is process user plus system CPU time in milliseconds for one fixed
corpus traversal, including JSON serialization to materialize all diagnostic
fields inside the timed region. Startup, bundling the target engine, module
loading, rule compilation, corpus materialization, warmup, explicit GC, and golden comparison
are outside the timed region. The engine is bundled from **target/src/engine.ts**
with the target's installed esbuild; the harness never imports its own engine.
There is no adaptive iteration count, division by document count, or time floor.
Faster candidates can legitimately report less than 200ms.

The workload contains both public `tests/fixtures` documents and 2,560 synthetic
documents (eight paragraph orders, 320 copies each). A fixed xorshift seed
(`0x5eed2026`) controls paragraph order and unique suffixes. Each measured text is
linted once; 64 separate documents warm the engine first. References resolve
inside an isolated temporary vault with an empty workspace override configuration.
The `obsidian` category is enabled. No external prose or private notes are inputs.

`guard` compares every document's complete ordered diagnostics with `golden.json`,
checks both `dist/` bundles byte-for-byte against an in-memory rebuild, checks their
executable bits and file list, and runs the target's existing `npm test`. It does
not rewrite `dist/`. Diagnostic objects are JSON-normalized to omit undefined
properties. Synthetic copies share an expected array per paragraph order because
only their trailing, diagnostic-free suffix differs; all copies are checked.
`measure` also checks every diagnostic after timing and fails without a metric
on a mismatch.

The dist build options mirror `scripts/build.mjs`. Changes to that build contract
must update this harness together. `spec.json` protects the harness, fixtures,
rules, build scripts, dependency manifests, and TypeScript configuration. The
runner must reject candidate changes to these paths before invoking the harness.
All entry points additionally reject target-local `.npmrc`, `vitest.config.*`,
`vite.config.*`, and `vitest.workspace.*` overrides. The baseline has none of these;
introducing them requires reviewing the benchmark's test execution contract.

## Verification

```sh
node bench/verify.mjs /absolute/target
```

This runs ten isolated measurements (each required to take at least 200ms CPU and
less than ten seconds wall time on the baseline), the guard, a measurement of a
copy outside the checkout, and fault injections into that disposable copy.
It rejects a changed rule through golden diagnostics, unbuilt CLI source through
dist comparison, and an engine sentinel through the external measurement. It also
checks test configuration overrides and relative-path rejection. Copies are
removed even on failure. The final JSON reports all samples, their median,
`(max - min) / median`, and check outcomes.

Golden regeneration is explicit and is not part of prepare, guard, or measure:

```sh
node bench/cli.mjs golden /absolute/trusted-baseline
```

Install the harness checkout's dependencies with `npm ci` before regenerating.
Generation runs the harness's Biome check and formatter on `golden.json`; generated
files are not excluded from lint. Run `bench/guard` again after regeneration.

Review corpus and diagnostic changes together. `golden.json` stores full diagnostic
fields, including messages, spans, severity, snippets, and fixes, not just counts.

## Initial calibration

Ten sequential runs on November 12, 2026 (macOS arm64, Node.js 26.8.1):

```text
lint_cpu_ms: 1207.055, 1142.864, 1150.965, 1182.021, 1216.462,
             1164.212, 1238.009, 1168.927, 1180.934, 1216.786
median: 1181.4775ms
(max - min) / median: 0.080531
maximum wall time: 2335.349ms
```

`min_effect: 0.10` conservatively exceeds the observed 8.05% range. Fifteen
repetitions provide more samples for the median than this ten-run calibration.
Two discarded runner warmups supplement the 64 internal warmup documents; the
ten samples show no monotonic warmup trend. These are conservative initial
settings, not a direct estimate of the ratio-of-medians confidence interval.
They do not promise 5% sensitivity. Run the runner's A/A gate on the actual
comparison machine before accepting improvements.

All ten runs met the 200ms CPU minimum and ten-second wall-time limit.
The external copy reported 1250.392ms CPU and 2378.289ms wall time. The verification
command also passed the normal guard, rejected a rule mutation through golden
diagnostics, rejected stale dist without rewriting it, and confirmed use of the
external engine with a failing sentinel.

## Limitations

- Synthetic paragraphs repeat across documents. Cross-document paragraph caching
  can appear more beneficial than in real editing; review such candidates
  separately. This is not a sandbox against deliberately benchmark-specific code.
- A stale-dist failure in `prepare` becomes the runner's `unverified` verdict,
  rather than `guard-failed`. Build and commit candidate artifacts before prepare.
- After merging source changes, wait for the existing main-branch dist update job
  before guarding main.
- Existing CI uses Node.js 24, unlike the calibration machine. It does not
  automatically run `bench/verify.mjs`.
