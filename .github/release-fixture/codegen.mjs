/*
 * The release fixture's codegen: prints the version of each tool the repo root's system.config.ts pins and exits 1
 * naming the first one that is missing or at another version, so a toolchain that failed to install, or lost PATH to
 * a runner's preinstalled one, fails the workflow instead of passing. Each probe runs from the OS temp dir with
 * RUSTUP_TOOLCHAIN unset and GOTOOLCHAIN=local, so the repo's rust-toolchain.toml and go.mod cannot pick the version
 * for it. RELEASE_FIXTURE_ANY_VERSION=1 accepts any version (a local run on other pins); CI never sets it. Runs on
 * Bun, which imports system.config.ts and the TypeScript package it imports. Writes nothing.
 */
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"

const { default: config } = await import(new URL("../../system.config.ts", import.meta.url).href)

/* each pinned tool's version command and the version in its output */
const PROBES = {
	go: { argv: ["go", "version"], version: /go(\d+\.\d+(?:\.\d+)?)/ },
	ruff: { argv: ["ruff", "--version"], version: /(\d+\.\d+\.\d+)/ },
	rust: { argv: ["rustc", "--version"], version: /(\d+\.\d+\.\d+)/ },
	uv: { argv: ["uv", "--version"], version: /(\d+\.\d+\.\d+)/ },
}

const anyVersion = process.env.RELEASE_FIXTURE_ANY_VERSION === "1"
const env = { ...process.env, GOTOOLCHAIN: "local" }
delete env.RUSTUP_TOOLCHAIN

function fail(message) {
	console.error(`release-fixture: ${message}`)
	process.exit(1)
}

for (const [name, want] of Object.entries(config.deps)) {
	const probe = PROBES[name]
	if (probe === undefined) fail(`${name} has no version probe; add one to codegen.mjs`)
	const [command, ...args] = probe.argv
	const result = spawnSync(command, args, { cwd: tmpdir(), encoding: "utf8", env })
	if (result.error || result.status !== 0) fail(`${name} is not installed (${probe.argv.join(" ")} failed)`)
	const output = result.stdout.trim()
	const found = probe.version.exec(output)?.[1]
	if (!anyVersion && found !== want)
		fail(`${name} is ${found ?? output}, want ${want} (the version in system.config.ts)`)
	console.log(`${name}: ${output}`)
}
