#!/usr/bin/env node
// The installgen bin. A repository checkout (marked by tsconfig.json, which is not published) runs the TypeScript
// source natively (Node by its type stripping), so a stale build never runs; an installed package runs the compiled
// JavaScript (the tarball ships it, not src/).
import { existsSync } from "node:fs";

const checkout = existsSync(new URL("../tsconfig.json", import.meta.url));

/**
 * The module to run: the source, or the build compiled from it, typed as the source.
 *
 * @returns {Promise<typeof import("../src/installers/cli.ts")>}
 */
function entry() {
  // Node strips the source's types by default from 22.18
  if (checkout) return import("../src/installers/cli.ts");

  // typed as the source it compiles from, so lint reads the same types with or without a build
  return /** @type {Promise<typeof import("../src/installers/cli.ts")>} */ (import("../dist/installers/cli.js"));
}

const { start } = await entry();

await start();
