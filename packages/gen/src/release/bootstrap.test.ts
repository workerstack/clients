import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
	type BootstrapOptions,
	countRemoteCommits,
	FORCE_COMMIT_LIMIT,
	hasTarget,
	judgeMirror,
	parseArgs,
	USAGE,
} from "./bootstrap.ts"
import { gitRepo, removeRepos, writeAll, writeConfig } from "./__fixtures__/release-repo.ts"
import { release } from "./cli.ts"
import { gitOutput, gitRun, sshToHttps } from "./git.ts"

const DEFAULTS: BootstrapOptions = {
	all: false,
	config: undefined,
	forceBootstrap: false,
	only: undefined,
}

const workdirs: string[] = []

function tmp(prefix: string): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
	workdirs.push(dir)
	return dir
}

function options(argv: string[]): BootstrapOptions {
	const parsed = parseArgs(argv)
	if (!parsed.ok) throw new Error(`expected parse to succeed: ${parsed.error}`)
	return parsed.options
}

/** A throwaway bare repo with `commits` commits on `main`, standing in for a mirror. */
async function mirrorWithCommits(commits: number): Promise<string> {
	const work = tmp("public-sync-mirror-work-")
	await gitRun(["init", "--quiet", "--initial-branch=main", "."], work)
	await gitRun(["config", "user.email", "test@example.com"], work)
	await gitRun(["config", "user.name", "Test"], work)
	for (let i = 0; i < commits; i++) {
		writeFileSync(path.join(work, "README.md"), `# mirror ${i}\n`)
		await gitRun(["add", "README.md"], work)
		await gitRun(["commit", "--quiet", "-m", `commit ${i}`], work)
	}
	const bare = tmp("public-sync-mirror-")
	await gitRun(["clone", "--quiet", "--bare", work, bare], work)
	return bare
}

/** Runs `release bootstrap` in process with a scrubbed GH_TOKEN so a real token cannot leak into a test. */
async function run(args: string[], env: Record<string, string> = {}) {
	const childEnv = { ...process.env, ...env }
	if (!("GH_TOKEN" in env)) delete childEnv.GH_TOKEN
	let [stdout, stderr] = ["", ""]
	const status = await release(
		["bootstrap", ...args],
		{ err: (text) => void (stderr += text), out: (text) => void (stdout += text) },
		{ env: childEnv },
	)
	return { status, stderr, stdout }
}

/** A fixture product with one package, `openapi`, in a fresh git repo: its release config's path and the repo. */
async function product(): Promise<{ config: string; root: string }> {
	const root = await gitRepo("public-sync-bootstrap-")
	writeAll(root, { "spec.json": "{}\n", "acme-release/openapi/openapi.json": "{}\n" })
	const config = writeConfig(root, {
		codegen: ["node", "codegen.mjs"],
		homepage: "https://example.com",
		packages: [{ commitMessage: "c", description: "d", name: "openapi", repo: "acme/openapi", topics: ["acme"] }],
		project: "acme",
		spec: { committedPath: "spec.json", deployedUrl: "https://api.example.com/openapi/spec.json" },
	})
	return { config, root }
}

afterEach(() => {
	for (const dir of workdirs.splice(0)) rmSync(dir, { force: true, recursive: true })
	removeRepos()
})

describe("sshToHttps", () => {
	it("rewrites a GitHub ssh remote to a token-authenticated https one", () => {
		expect(sshToHttps("git@github.com:acme/widget.git", "tok")).toBe(
			"https://x-access-token:tok@github.com/acme/widget.git",
		)
	})

	it("leaves a URL that is already https alone", () => {
		const https = "https://github.com/acme/widget.git"

		expect(sshToHttps(https, "tok")).toBe(https)
	})

	it("does not rewrite another host's ssh remote", () => {
		const other = "git@gitlab.com:me/thing.git"

		expect(sshToHttps(other, "tok")).toBe(other)
	})
})

describe("parseArgs", () => {
	it("defaults to no target and no force", () => {
		expect(options([])).toEqual(DEFAULTS)
	})

	it("reads --all and --force-bootstrap", () => {
		expect(options(["--all", "--force-bootstrap"])).toEqual({
			...DEFAULTS,
			all: true,
			forceBootstrap: true,
		})
	})

	it("ignores an argument it does not know", () => {
		expect(options(["stray", "--all"])).toEqual({ ...DEFAULTS, all: true })
	})

	it("accepts --name and --only as the same filter", () => {
		expect(options(["--name", "cli"]).only).toEqual(["cli"])
		expect(options(["--only", "cli"]).only).toEqual(["cli"])
	})

	it("splits the filter on commas and trims each name", () => {
		expect(options(["--only", " cli , acme/sdk "]).only).toEqual(["cli", "acme/sdk"])
	})

	it("reads --config", () => {
		expect(options(["--config", "acme/release.config.ts"]).config).toBe("acme/release.config.ts")
	})

	it("names the flag that is missing its value", () => {
		expect(parseArgs(["--name"])).toEqual({ error: "--name requires a value", ok: false })
		expect(parseArgs(["--only", "--all"])).toEqual({ error: "--only requires a value", ok: false })
		expect(parseArgs(["--config"])).toEqual({ error: "--config requires a value", ok: false })
	})

	it("does not skip the argument after a value flag it consumed", () => {
		expect(options(["--config", "acme/release.config.ts", "--force-bootstrap"]).forceBootstrap).toBe(true)
	})
})

describe("hasTarget", () => {
	it("is false with no target, so an empty argv never means every mirror", () => {
		expect(hasTarget(DEFAULTS)).toBe(false)
		expect(hasTarget({ ...DEFAULTS, forceBootstrap: true })).toBe(false)
	})

	it("is true for either --all or --only, and the config alone is no target", () => {
		expect(hasTarget({ ...DEFAULTS, all: true })).toBe(true)
		expect(hasTarget({ ...DEFAULTS, only: ["cli"] })).toBe(true)
		expect(hasTarget({ ...DEFAULTS, config: "acme/release.config.ts" })).toBe(false)
	})

	it("counts an empty --only list as a target, since the filter was given", () => {
		expect(hasTarget({ ...DEFAULTS, only: [] })).toBe(true)
	})
})

describe("judgeMirror", () => {
	it("proceeds on an empty branch, with or without force", () => {
		for (const forceBootstrap of [false, true]) {
			expect(judgeMirror({ branch: "main", commitCount: 0, forceBootstrap, tip: undefined })).toEqual({ proceed: true })
		}
	})

	it("refuses a stub branch without --force-bootstrap", () => {
		const verdict = judgeMirror({
			branch: "main",
			commitCount: FORCE_COMMIT_LIMIT,
			forceBootstrap: false,
			tip: "0123456789abcdef",
		})

		expect(verdict.proceed).toBe(false)
		expect(verdict.reason).toContain("Pass --force-bootstrap to overwrite the stub")
		expect(verdict.reason).toContain("tip=01234567")
	})

	it("overwrites a stub branch with --force-bootstrap", () => {
		expect(
			judgeMirror({
				branch: "main",
				commitCount: FORCE_COMMIT_LIMIT,
				forceBootstrap: true,
				tip: "0123456789abcdef",
			}),
		).toEqual({ proceed: true })
	})

	it("refuses real history even with --force-bootstrap", () => {
		const verdict = judgeMirror({
			branch: "main",
			commitCount: FORCE_COMMIT_LIMIT + 1,
			forceBootstrap: true,
			tip: "0123456789abcdef",
		})

		expect(verdict.proceed).toBe(false)
		expect(verdict.reason).toContain("refuses to overwrite real history")
	})
})

describe("countRemoteCommits", () => {
	it("counts the commits on the mirror branch", async () => {
		const mirror = await mirrorWithCommits(2)

		expect(await countRemoteCommits(mirror, "main")).toBe(2)
	})

	it("caps the count at the force limit plus one, so history size never drives the fetch", async () => {
		const mirror = await mirrorWithCommits(FORCE_COMMIT_LIMIT + 4)

		expect(await countRemoteCommits(mirror, "main")).toBe(FORCE_COMMIT_LIMIT + 1)
	})

	it("returns 0 when the branch does not exist on the mirror", async () => {
		const mirror = await mirrorWithCommits(1)

		expect(await countRemoteCommits(mirror, "no-such-branch")).toBe(0)
	})

	it("returns 0 when the mirror is unreachable", async () => {
		expect(await countRemoteCommits(path.join(tmp("public-sync-gone-"), "nope"), "main")).toBe(0)
	})

	it("leaves no temp clone behind", async () => {
		const mirror = await mirrorWithCommits(1)
		const before = new Set(await listTmpCounts())

		await countRemoteCommits(mirror, "main")

		expect((await listTmpCounts()).filter((name) => !before.has(name))).toEqual([])
	})
})

async function listTmpCounts(): Promise<string[]> {
	const { readdir } = await import("node:fs/promises")
	const entries = await readdir(os.tmpdir())
	return entries.filter((name) => name.startsWith("public-sync-count-"))
}

describe("cli", () => {
	it("exits 1 with usage when given no target, before touching any mirror", async () => {
		const { config } = await product()
		const result = await run(["--config", config], { GH_TOKEN: "unused" })

		expect(result.status).toBe(1)
		for (const line of USAGE.filter(Boolean)) expect(result.stderr).toContain(line)
	})

	it("exits 1 without GH_TOKEN", async () => {
		const { config } = await product()
		const result = await run(["--config", config, "--all"])

		expect(result.status).toBe(1)
		expect(result.stderr).toContain("GH_TOKEN env is required")
	})

	it("exits 1 naming the available packages when the filter matches nothing", async () => {
		const { config } = await product()
		const result = await run(["--config", config, "--only", "not-a-package"], { GH_TOKEN: "unused" })

		expect(result.status).toBe(1)
		expect(result.stderr).toContain("No packages match. Available: acme/openapi")
	})

	it("checks the target before the token, so a missing target is not masked", async () => {
		const { config, root } = await product()
		const noTarget = await run(["--config", config], { GH_TOKEN: "unused" })

		expect(noTarget.stderr).toContain("Usage:")
		expect(noTarget.stderr).not.toContain("GH_TOKEN env is required")

		expect(await gitOutput(["rev-parse", "--is-inside-work-tree"], root)).toBe("true")
	})
})
