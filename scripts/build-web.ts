// Bundles the browser app into dist/public. Run with --watch for rebuild-on-change.

import { watch } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";

const watchMode = process.argv.includes("--watch");
const outdir = "dist/public";

async function build(): Promise<boolean> {
  const t0 = performance.now();
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  const result = await Bun.build({
    entrypoints: ["src/app/index.ts"],
    outdir,
    target: "browser",
    format: "esm",
    minify: !watchMode,
    sourcemap: watchMode ? "inline" : "none",
    naming: "[name].[ext]",
    define: { "process.env.NODE_ENV": JSON.stringify(watchMode ? "development" : "production") },
  });
  for (const log of result.logs) console.error(log);
  if (!result.success) return false;
  await cp("public", outdir, { recursive: true });
  console.log(`web bundle built in ${(performance.now() - t0).toFixed(0)}ms`);
  return true;
}

const ok = await build();
if (!watchMode) process.exit(ok ? 0 : 1);

let pending: Timer | undefined;
for (const dir of ["src/app", "src/common", "public"]) {
  watch(dir, { recursive: true }, () => {
    clearTimeout(pending);
    pending = setTimeout(() => void build(), 150);
  });
}
