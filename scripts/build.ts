#!/usr/bin/env bun
/**
 * Builds `dist/`: JavaScript and declarations for every module under `src/` (the `build:types` script), plus
 * `runtime/`, the per-language runtime files the emitters read as text beside them
 * (`new URL("../../runtime/…", import.meta.url)`).
 * `prepack` runs this, so a tarball cannot ship without it; an install runs dist/, a checkout the source.
 *
 *   bun scripts/build.ts
 */
import { spawnSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

rmSync(join(root, "dist"), { force: true, recursive: true });

const built = spawnSync(process.execPath, ["run", "build:types"], { cwd: root, stdio: "inherit" });

if (built.status !== 0) {
  console.error("build: tsc failed");
  process.exit(built.status ?? 1);
}

cpSync(join(root, "src/runtime"), join(root, "dist/runtime"), { recursive: true });

console.log("build: dist ready");
