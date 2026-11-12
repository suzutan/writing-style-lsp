import { deepStrictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COPIES, createCorpus, SEED } from "./corpus.mjs";

export function targetPath(argument) {
  if (!argument || !path.isAbsolute(argument)) {
    throw new Error("expected one absolute checkout path: bench/<command> <target>");
  }
  const target = realpathSync(argument);
  for (const name of ["package.json", "src/engine.ts", "rules/core.json"]) {
    if (!statSync(path.join(target, name)).isFile()) {
      throw new Error(`target is missing ${name}`);
    }
  }
  return target;
}

export function checkConfiguration(target) {
  const unsupported = readdirSync(target).find((name) =>
    /^(?:\.npmrc|(?:vitest|vite)\.config\..+|vitest\.workspace\..+)$/.test(name),
  );
  if (unsupported) {
    throw new Error(`unsupported benchmark configuration: ${unsupported}`);
  }
}

export function temporaryDirectory(callback) {
  const dir = mkdtempSync(path.join(tmpdir(), "wslsp-bench-"));
  try {
    return callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function run(target, command, args) {
  const result = spawnSync(command, args, {
    cwd: target,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.error})`);
  }
}

function esbuild(target) {
  return createRequire(path.join(target, "package.json"))("esbuild");
}

export function withEngine(target, callback) {
  return temporaryDirectory((dir) => {
    const bundle = path.join(dir, "engine.cjs");
    esbuild(target).buildSync({
      absWorkingDir: target,
      entryPoints: ["src/engine.ts"],
      outfile: bundle,
      bundle: true,
      platform: "node",
      target: "node20",
      format: "cjs",
      logLevel: "silent",
    });
    const { Engine } = createRequire(bundle)(bundle);
    const engine = new Engine([path.join(target, "rules/core.json")], ["obsidian"]);
    const corpus = createCorpus(path.join(dir, "corpus"));
    return callback(engine, corpus, path.join(dir, "corpus"));
  });
}

function json(value) {
  return JSON.parse(JSON.stringify(value));
}

export function expectedDiagnostics() {
  const golden = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url), "utf8"));
  deepStrictEqual(
    { seed: golden.seed, copies: golden.copies },
    { seed: SEED, copies: COPIES },
    "golden corpus parameters differ",
  );
  return golden.diagnostics;
}

export function checkDiagnostics(documents, results, expected) {
  for (let i = 0; i < documents.length; i++) {
    const document = documents[i];
    try {
      deepStrictEqual(json(results[i]), expected[document.key]);
    } catch {
      throw new Error(`golden diagnostics differ: ${document.name}`);
    }
  }
}

function distFiles(root, prefix = "") {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const name = path.join(prefix, entry.name);
      return entry.isDirectory() ? distFiles(path.join(root, entry.name), name) : [name];
    })
    .sort();
}

export function checkDist(target) {
  const dist = path.join(target, "dist");
  if (!existsSync(dist)) throw new Error("dist/ is missing; build and commit target artifacts first");
  deepStrictEqual(distFiles(dist), ["cli.js", "server.js"], "dist/ file list differs");
  // Kept identical to protected scripts/build.mjs; write:false leaves stale artifacts intact.
  for (const name of ["cli", "server"]) {
    const { outputFiles } = esbuild(target).buildSync({
      absWorkingDir: target,
      bundle: true,
      platform: "node",
      target: "node20",
      format: "cjs",
      sourcemap: false,
      logLevel: "silent",
      banner: { js: "#!/usr/bin/env node" },
      entryPoints: [`src/${name}.ts`],
      outfile: `dist/${name}.js`,
      write: false,
    });
    const artifact = path.join(dist, `${name}.js`);
    if (
      outputFiles.length !== 1 ||
      !readFileSync(artifact).equals(outputFiles[0].contents) ||
      (statSync(artifact).mode & 0o111) !== 0o111
    ) {
      throw new Error(`dist/${name}.js differs from a fresh target/src build`);
    }
  }
}

export function generateGolden(target) {
  return withEngine(target, (engine, { documents }, root) => {
    const diagnostics = {};
    for (const document of documents) {
      const actual = json(engine.lintText(document.text, document.filePath, root));
      if (Object.hasOwn(diagnostics, document.key)) {
        deepStrictEqual(actual, diagnostics[document.key], document.name);
      } else {
        diagnostics[document.key] = actual;
      }
    }
    return { seed: SEED, copies: COPIES, diagnostics };
  });
}

export function saveGolden(target) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const golden = path.join(root, "bench/golden.json");
  writeFileSync(golden, `${JSON.stringify(generateGolden(target), null, 2)}\n`);
  run(root, path.join(root, "node_modules/.bin/biome"), ["check", "--write", golden]);
}
