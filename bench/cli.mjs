import {
  checkConfiguration,
  checkDiagnostics,
  checkDist,
  expectedDiagnostics,
  run,
  saveGolden,
  targetPath,
  withEngine,
} from "./harness.mjs";

try {
  const [, , command, argument, ...extra] = process.argv;
  if (extra.length) throw new Error("expected exactly one target argument");
  const target = targetPath(argument);
  checkConfiguration(target);
  switch (command) {
    case "prepare":
      run(target, "npm", ["ci"]);
      // Refuse stale committed artifacts before the requested build can overwrite them.
      checkDist(target);
      run(target, "npm", ["run", "build"]);
      break;
    case "measure": {
      const expected = expectedDiagnostics();
      const cpu = withEngine(target, (engine, { documents, warmup }, root) => {
        for (const document of warmup) engine.lintText(document.text, document.filePath, root);
        global.gc?.();
        const results = [];
        const start = process.cpuUsage();
        for (const document of documents) {
          results.push(JSON.stringify(engine.lintText(document.text, document.filePath, root)));
        }
        const elapsed = process.cpuUsage(start);
        checkDiagnostics(
          documents,
          results.map((result) => JSON.parse(result)),
          expected,
        );
        return (elapsed.user + elapsed.system) / 1000;
      });
      if (!Number.isFinite(cpu) || cpu <= 0) throw new Error("invalid lint CPU duration");
      process.stdout.write(`${JSON.stringify({ metrics: { lint_cpu_ms: cpu } })}\n`);
      break;
    }
    case "guard":
      withEngine(target, (engine, { documents }, root) => {
        const results = documents.map((document) => engine.lintText(document.text, document.filePath, root));
        checkDiagnostics(documents, results, expectedDiagnostics());
      });
      checkDist(target);
      run(target, "npm", ["test"]);
      process.stderr.write("guard passed: golden diagnostics, dist rebuild, existing tests\n");
      break;
    case "golden":
      saveGolden(target);
      break;
    default:
      throw new Error(`unknown bench command: ${command}`);
  }
} catch (error) {
  process.stderr.write(`bench: ${error.message}\n`);
  process.exitCode = 1;
}
