import { chmodSync } from "node:fs";
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: false,
  logLevel: "info",
  banner: { js: "#!/usr/bin/env node" },
};

await build({ ...common, entryPoints: ["src/cli.ts"], outfile: "dist/cli.js" });
await build({ ...common, entryPoints: ["src/server.ts"], outfile: "dist/server.js" });
chmodSync("dist/cli.js", 0o755);
chmodSync("dist/server.js", 0o755);
