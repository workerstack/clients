import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { gitRepo, removeRepos, writeAll, writeConfig } from "./__fixtures__/release-repo.ts"
import { release } from "./cli.ts"
import { type CliOptions, formatResults, HELP, parseArgs } from "./sync-command.ts"
import type { PackageResult } from "./sync.ts"

afterEach(removeRepos)

const DEFAULTS: CliOptions = {
	config: undefined,
	dryRun: false,
	help: false,
	only: undefined,
	validateOnly: false,
}

function options(argv: string[]): CliOptions {
	const parsed = parseArgs(argv)
	if (!parsed.ok) throw new Error(`expected parse to succeed: ${parsed.error}`)
	return parsed.options
}

function result(overrides: Partial<PackageResult> = {}): PackageResult {
	return { name: "cli", status: "synced", ...overrides }
}

/** Runs `release sync` in process with a scrubbed GH_TOKEN so a real token cannot leak into a test. */
async function run(args: string[], env: Record<string, string> = {}) {
	const childEnv = { ...process.env, ...env }
	if (!("GH_TOKEN" in env)) delete childEnv.GH_TOKEN
	let [stdout, stderr] = ["", ""]
	const status = await release(
		["sync", ...args],
		{ err: (text) => void (stderr += text), out: (text) => void (stdout += text) },
		{ env: childEnv },
	)
	return { status, stderr, stdout }
}

describe("parseArgs switches", () => {
	it("defaults every flag off", () => {
		expect(options([])).toEqual(DEFAULTS)
	})

	it("reads each boolean flag", () => {
		expect(options(["--dry-run"]).dryRun).toBe(true)
		expect(options(["--validate-only"]).validateOnly).toBe(true)
		expect(options(["--help"]).help).toBe(true)
		expect(options(["-h"]).help).toBe(true)
	})

	it("combines flags in any order", () => {
		expect(options(["--validate-only", "--dry-run"])).toEqual({
			...DEFAULTS,
			dryRun: true,
			validateOnly: true,
		})
		expect(options(["--dry-run", "--validate-only"])).toEqual({
			...DEFAULTS,
			dryRun: true,
			validateOnly: true,
		})
	})

	it("splits --only on commas and trims each name", () => {
		expect(options(["--only", " cli , acme/sdk "]).only).toEqual(["cli", "acme/sdk"])
	})

	it("drops empty entries from --only", () => {
		expect(options(["--only", "cli,,sdk,"]).only).toEqual(["cli", "sdk"])
	})
})

describe("parseArgs values", () => {
	it("reads --config", () => {
		expect(options(["--config", "acme/release.config.ts"]).config).toBe("acme/release.config.ts")
	})

	it("does not consume the following flag as a value", () => {
		expect(parseArgs(["--only", "--dry-run"])).toEqual({
			error: "--only requires a value (comma-separated names or project/name)",
			ok: false,
		})
		expect(parseArgs(["--config", "--dry-run"])).toEqual({
			error: "--config requires a value (the release config's path)",
			ok: false,
		})
	})

	it("errors when a value flag ends the argument list", () => {
		expect(parseArgs(["--only"]).ok).toBe(false)
		expect(parseArgs(["--config"]).ok).toBe(false)
	})

	it("does not skip the argument after a value flag it consumed", () => {
		expect(options(["--only", "cli", "--dry-run"])).toEqual({
			...DEFAULTS,
			dryRun: true,
			only: ["cli"],
		})
	})

	it("ignores an unrecognised argument rather than failing the run", () => {
		expect(options(["--unknown", "--dry-run"]).dryRun).toBe(true)
	})
})

describe("formatResults", () => {
	it("prints a header and a rule as wide as the header", () => {
		const lines = formatResults([result()])

		expect(lines[0]).toContain("NAME")
		expect(lines[0]).toContain("STATUS")
		expect(lines[0]).toContain("DETAIL")
		expect(lines[1]).toBe("-".repeat((lines[0] ?? "").length))
	})

	it("pads the name column to the longest name", () => {
		const lines = formatResults([result({ name: "cli" }), result({ name: "sdk-typescript" })])

		expect(lines[2]?.startsWith("cli".padEnd("sdk-typescript".length))).toBe(true)
	})

	it("keeps the header readable when every name is shorter than NAME", () => {
		const lines = formatResults([result({ name: "a" })])

		expect(lines[0]?.startsWith("NAME  ")).toBe(true)
	})

	it("names the tag a synced package pushed beside its mirror commit", () => {
		const lines = formatResults([result({ mirrorSha: "0123456789abcdef", tag: "v2.0.0" })])

		expect(lines[2]).toContain("mirror=0123456")
		expect(lines[2]).toContain("tag=v2.0.0")
	})

	it("names the tag a skipped package pushed after its reason", () => {
		const lines = formatResults([
			result({ reason: "content identical to mirror tip", status: "skipped", tag: "v2.0.0" }),
		])

		expect(lines[2]).toContain("content identical to mirror tip")
		expect(lines[2]).toContain("tag=v2.0.0")
	})

	it("shows the reason when one is given", () => {
		const lines = formatResults([result({ reason: "no source changes", status: "skipped" })])

		expect(lines[2]).toContain("skipped")
		expect(lines[2]).toContain("no source changes")
	})

	it("falls back to a short mirror sha when there is no reason", () => {
		const lines = formatResults([result({ mirrorSha: "0123456789abcdef" })])

		expect(lines[2]).toContain("mirror=01234567")
	})

	it("leaves the detail blank when there is neither", () => {
		expect(formatResults([result()])[2]?.trimEnd()).toBe("cli   synced")
	})

	it("prints just the header for an empty run", () => {
		expect(formatResults([])).toHaveLength(2)
	})
})

const OPENAPI = { commitMessage: "c", description: "d", name: "openapi", repo: "acme/openapi", topics: ["acme"] }

/* acme's repo with an openapi dir and a release config listing `packages`: the config's path */
async function acmeConfig(packages: readonly unknown[]): Promise<string> {
	const root = await gitRepo("public-sync-cli-")
	writeAll(root, { "acme-release/openapi/README.md": "# openapi\n", "spec.json": "{}\n" })
	return writeConfig(root, {
		codegen: ["node", "codegen.mjs"],
		homepage: "https://example.com",
		packages,
		project: "acme",
		spec: { committedPath: "spec.json", deployedUrl: "https://api.example.com/openapi/spec.json" },
	})
}

describe("cli", () => {
	it("prints help and exits 0 without syncing", async () => {
		const result = await run(["--help"])

		expect(result.status).toBe(0)
		expect(result.stdout).toContain(HELP.trim())
	})

	it("validates a config, counting its packages", async () => {
		const result = await run(["--validate-only", "--config", await acmeConfig([OPENAPI])])

		expect(result).toMatchObject({ status: 0, stdout: "Manifests valid: 1 package(s)\n" })
	})

	it("fails validation on a manifest that lists one package twice", async () => {
		const result = await run([
			"--validate-only",
			"--config",
			await acmeConfig([OPENAPI, { ...OPENAPI, repo: "acme/other" }]),
		])

		expect(result.status).toBe(1)
		expect(result.stderr).toMatch(/release\.config\.ts is invalid[\s\S]*duplicate name: openapi/)
	})

	it("refuses to sync without GH_TOKEN, before touching any mirror", async () => {
		const result = await run(["--config", path.join("nowhere", "release.config.ts")])

		expect(result.status).toBe(1)
		expect(result.stderr).toContain("GH_TOKEN env is required (or use --dry-run)")
	})

	it("exits 1 when a value flag has no value", async () => {
		const result = await run(["--only"])

		expect(result.status).toBe(1)
		expect(result.stderr).toContain("--only requires a value")
	})
})
