/*
 * `release bootstrap` and `release sync` with real git against a local bare repository standing in for
 * github.com/acme/sdk. A `url.<local>.insteadOf` rewrite (GIT_CONFIG_*, which every git child inherits) turns the
 * token URL each builds into a file:// path; the GitHub settings step talks to a fake that holds the repo's settings.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { SPAWN_TIMEOUT } from "../gen/__fixtures__/spawn-timeout.ts"
import { configOf, gitRepo, removeRepos, writeAll, writeConfig } from "./__fixtures__/release-repo.ts"
import { release } from "./cli.ts"
import { gitOutput, gitRun } from "./git.ts"

const TOKEN = "tok"
const SETTINGS = { description: "the sdk", homepage: "https://example.com" }
const STAMPED = /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\]$/

/* a GitHub that holds acme/sdk's settings as the config names them, or refuses every request */
const github =
	(refuse: boolean): typeof fetch =>
	async (url) => {
		if (refuse) return Response.json({ message: "Resource not accessible by integration" }, { status: 403 })
		return Response.json(String(url).endsWith("/topics") ? { names: ["acme"] } : SETTINGS)
	}

type Run = { status: number; out: string; err: string }

/* what one test's mirror offers: its bare repo, its source's config, and each command run against them */
type Mirror = {
	/** The bare repo standing in for github.com/acme/sdk. */
	bare(): string
	/** Writes acme's source with `pkg`'s fields over the sdk package's, commits it, and returns its config. */
	source(pkg?: Record<string, unknown>, files?: Record<string, string>): Promise<string>
	/** `release <command> --config <config> ...args` against a GitHub that `refuse`s or holds the settings. */
	run(command: string, args: readonly string[], refuse?: boolean): Promise<Run>
}

/* registers a fresh bare mirror and the insteadOf rewrite to it for each test of the calling describe */
function useMirror(): Mirror {
	let remotes = ""
	let config = ""
	beforeEach(async () => {
		remotes = mkdtempSync(join(tmpdir(), "release-remotes-"))
		const bare = join(remotes, "acme", "sdk.git")
		mkdirSync(bare, { recursive: true })
		await gitRun(["init", "--quiet", "--bare", "--initial-branch=main", "."], bare)
		process.env.GIT_CONFIG_COUNT = "1"
		process.env.GIT_CONFIG_KEY_0 = `url.file://${remotes}/.insteadOf`
		process.env.GIT_CONFIG_VALUE_0 = `https://x-access-token:${TOKEN}@github.com/`
	}, SPAWN_TIMEOUT)
	afterEach(() => {
		delete process.env.GIT_CONFIG_COUNT
		delete process.env.GIT_CONFIG_KEY_0
		delete process.env.GIT_CONFIG_VALUE_0
		rmSync(remotes, { force: true, recursive: true })
		removeRepos()
	})
	return {
		bare: () => join(remotes, "acme", "sdk.git"),
		async source(pkg = {}, files = {}) {
			const root = await gitRepo("release-source-")
			writeAll(root, { "acme-release/sdk/README.md": "# sdk\n", "spec.json": "{}\n", ...files })
			const sdk = {
				commitMessage: "c",
				description: SETTINGS.description,
				name: "sdk",
				repo: "acme/sdk",
				topics: ["acme"],
			}
			const spec = { committedPath: "spec.json", deployedUrl: "https://api.example.com/spec.json" }
			writeConfig(root, {
				codegen: ["true"],
				homepage: SETTINGS.homepage,
				packages: [{ ...sdk, ...pkg }],
				project: "acme",
				spec,
			})
			await gitRun(["add", "-A"], root)
			await gitRun(["commit", "--quiet", "-m", "source"], root)
			return (config = configOf(root))
		},
		async run(command, args, refuse = false) {
			let [out, err] = ["", ""]
			const status = await release(
				[command, "--config", config, ...args],
				{ err: (text) => void (err += text), out: (text) => void (out += text) },
				{ env: { GH_TOKEN: TOKEN }, fetch: github(refuse) },
			)
			return { err, out, status }
		},
	}
}

describe("release bootstrap against an empty mirror", () => {
	const mirror = useMirror()

	it(
		"pushes its initial release",
		async () => {
			await mirror.source()

			const result = await mirror.run("bootstrap", ["--all"])

			expect(result.out).toMatch(
				/→ acme\/sdk → git@github\.com:acme\/sdk\.git\n {2}ok: source=[0-9a-f]{8} mirror=[0-9a-f]{8}/,
			)
			expect(result.out).toContain("Bootstrap done: 1 synced, 0 skipped, 0 failed.")
			expect(result.status).toBe(0)
			expect(await gitOutput(["log", "-1", "--format=%s", "main"], mirror.bare())).toMatch(/^chore: initial release /)
		},
		SPAWN_TIMEOUT,
	)

	it(
		"leaves what bootstrapExclude names out of the initial push",
		async () => {
			await mirror.source({ bootstrapExclude: ["gen/**"] }, { "acme-release/sdk/gen/client.go": "package sdk\n" })

			expect((await mirror.run("bootstrap", ["--only", "sdk"])).status).toBe(0)

			expect(await gitOutput(["ls-tree", "-r", "--name-only", "main"], mirror.bare())).not.toContain("gen/client.go")
		},
		SPAWN_TIMEOUT,
	)

	it(
		"fails a package whose settings GitHub refuses",
		async () => {
			await mirror.source()

			const result = await mirror.run("bootstrap", ["--all"], true)

			expect(result.err).toMatch(/fail: .*acme\/sdk: GitHub answered GET \/ with 403: Resource not accessible/)
			expect(result.out).toContain("Bootstrap done: 0 synced, 0 skipped, 1 failed.")
			expect(result.status).toBe(1)
		},
		SPAWN_TIMEOUT,
	)
})

describe("release bootstrap against a mirror with a commit", () => {
	const mirror = useMirror()

	it(
		"refuses it unless forced, and then has nothing to push",
		async () => {
			await mirror.source()
			await mirror.run("bootstrap", ["--all"])

			const refused = await mirror.run("bootstrap", ["--all"])
			const forced = await mirror.run("bootstrap", ["--all", "--force-bootstrap"])

			expect(refused.err).toMatch(/fail: mirror branch main is non-empty \(1 commit\(s\)/)
			expect(refused.status).toBe(1)
			expect(forced.out).toMatch(/ {2}skip: /)
			expect(forced.out).toContain("Bootstrap done: 0 synced, 1 skipped, 0 failed.")
			expect(forced.status).toBe(0)
		},
		SPAWN_TIMEOUT,
	)

	it(
		"overwrites a stub whose one commit holds no file, when forced",
		async () => {
			const stub = await gitRepo("release-stub-")
			await gitRun(["commit", "--quiet", "--allow-empty", "-m", "stub"], stub)
			await gitRun(["push", "--quiet", mirror.bare(), "HEAD:refs/heads/main"], stub)
			await mirror.source()

			const result = await mirror.run("bootstrap", ["--all", "--force-bootstrap"])

			expect(result.out).toContain("Bootstrap done: 1 synced, 0 skipped, 0 failed.")
			expect(await gitOutput(["log", "-1", "--format=%s", "main"], mirror.bare())).toMatch(STAMPED)
			expect(await gitOutput(["ls-tree", "-r", "--name-only", "main"], mirror.bare())).toBe("README.md")
		},
		SPAWN_TIMEOUT,
	)
})

describe("release sync against a bootstrapped mirror", () => {
	const mirror = useMirror()

	it(
		"skips a package the mirror already holds, and fails one whose settings GitHub refuses",
		async () => {
			await mirror.source()
			await mirror.run("bootstrap", ["--all"])

			const unchanged = await mirror.run("sync", [])
			const refused = await mirror.run("sync", [], true)

			expect(unchanged).toMatchObject({ status: 0 })
			expect(unchanged.out).toMatch(/acme\/sdk.*content identical to mirror tip/)
			expect(refused.status).toBe(1)
			expect(refused.out).toMatch(/acme\/sdk.*GitHub answered GET \/ with 403/)
		},
		SPAWN_TIMEOUT,
	)
})
