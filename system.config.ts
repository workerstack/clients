/**
 * The OS tools this repo's release fixture installs in CI (`system install <name>`, @workerstack/system): the
 * toolchains `.github/release-fixture/release.config.ts` lists, each pinned where the repo already pins it
 * (`.go-version`, `rust-toolchain.toml`, `uv.toml`, gen's Python fixture `tools.txt`).
 */
import { defineConfig } from "@workerstack/system"

export default defineConfig({ deps: { go: "1.27.2", ruff: "0.17.1", rust: "1.99.1", uv: "0.13.1" } })
