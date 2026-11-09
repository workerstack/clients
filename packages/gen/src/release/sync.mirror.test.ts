import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { gitOutput, gitRun } from "./git.ts"
import { readRelease } from "./load.ts"
import { syncAll, type SyncOptions } from "./sync.ts"

/*
 * Real git against a local bare repository standing in for github.com/acme/openapi. A
 * `url.<local>.insteadOf` rewrite (GIT_CONFIG_*, which every git child inherits) turns the token
 * URL sync builds into a file:// path, so sync runs unchanged.
 */

const BOT_EMAIL = "public-sync[bot]@users.noreply.github.com"
const TOKEN = "tok"
const SPEC = '{"openapi":"3.1.0"}\n'

const workdirs: string[] = []

function tmp(prefix: string): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
	workdirs.push(dir)
	return dir
}

async function initRepo(dir: string, email: string): Promise<void> {
	await gitRun(["init", "--quiet", "--initial-branch=main", "."], dir)
	await gitRun(["config", "user.email", email], dir)
	await gitRun(["config", "user.name", "Someone"], dir)
}

const RELEASE_YML = ".github/workflows/release.yml"
const STATE = ".release-state.json"

/** A package source that publishes itself: its release workflow and the version its state records. */
const releasing = (version: string): Record<string, string> => ({
	[RELEASE_YML]: "on: { push: { tags: ['v*'] } }\n",
	[STATE]: `${JSON.stringify({ version })}\n`,
})

function writeAll(dir: string, files: Record<string, string>): void {
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
		writeFileSync(path.join(dir, name), content)
	}
}

/** The source repo: a release config with one package, its source (`openapi.json` plus `extra`), and one commit. */
async function sourceRepo(
	spec: string,
	extra: Record<string, string> = {},
	registries: unknown[] = [],
): Promise<string> {
	const root = tmp("public-sync-root-")
	await initRepo(root, "dev@example.com")
	const publicDir = path.join(root, "acme-release")
	mkdirSync(path.join(publicDir, "openapi"), { recursive: true })
	writeFileSync(
		path.join(publicDir, "release.config.ts"),
		`export default ${JSON.stringify({
			codegen: ["node", "codegen.mjs"],
			homepage: "https://example.com",
			packages: [
				{
					commitMessage: "chore: update openapi spec",
					description: "OpenAPI spec.",
					name: "openapi",
					registries,
					repo: "acme/openapi",
					topics: ["acme"],
				},
			],
			project: "acme",
			spec: {
				committedPath: "spec.json",
				deployedUrl: "https://api.example.com/openapi/spec.json",
			},
		})}\n`,
	)
	writeFileSync(path.join(publicDir, "openapi", "openapi.json"), spec)
	writeAll(path.join(publicDir, "openapi"), extra)
	writeFileSync(path.join(root, "spec.json"), spec)
	await gitRun(["add", "-A"], root)
	await gitRun(["commit", "--quiet", "-m", "source"], root)
	return root
}

/** The public repo: a bare repo whose one commit holds `spec` plus `extra`, committed by `committer`. */
async function publicRepo(
	remotes: string,
	spec: string,
	committer: string,
	extra: Record<string, string> = {},
): Promise<string> {
	const bare = path.join(remotes, "acme", "openapi.git")
	mkdirSync(bare, { recursive: true })
	await gitRun(["init", "--quiet", "--bare", "--initial-branch=main", "."], bare)
	const seed = tmp("public-sync-seed-")
	await initRepo(seed, committer)
	writeFileSync(path.join(seed, "openapi.json"), spec)
	writeAll(seed, extra)
	await gitRun(["add", "-A"], seed)
	await gitRun(["commit", "--quiet", "-m", "seed"], seed)
	await gitRun(["push", "--quiet", bare, "HEAD:refs/heads/main"], seed)
	return bare
}

const tip = (bare: string) => gitOutput(["rev-parse", "refs/heads/main"], bare)
/** The commit a tag names in the public repo, or undefined when it has no such tag. */
const tagged = async (bare: string, tag: string) =>
	(await gitOutput(["tag", "--list", tag], bare)) === ""
		? undefined
		: gitOutput(["rev-parse", `refs/tags/${tag}^{commit}`], bare)
/** A file at the public repo's tip, or undefined when the tip has none. */
const tipFile = async (bare: string, file: string) =>
	(await gitOutput(["ls-tree", "--name-only", "main", file], bare)) === ""
		? undefined
		: gitOutput(["show", `main:${file}`], bare)
const tipCommitter = (bare: string) => gitOutput(["log", "-1", "--format=%ce", "main"], bare)

let remotes: string

beforeEach(() => {
	remotes = tmp("public-sync-remotes-")
	process.env.GIT_CONFIG_COUNT = "1"
	process.env.GIT_CONFIG_KEY_0 = `url.file://${remotes}/.insteadOf`
	process.env.GIT_CONFIG_VALUE_0 = `https://x-access-token:${TOKEN}@github.com/`
})

afterEach(() => {
	delete process.env.GIT_CONFIG_COUNT
	delete process.env.GIT_CONFIG_KEY_0
	delete process.env.GIT_CONFIG_VALUE_0
	for (const dir of workdirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

async function run(root: string, extra: Partial<SyncOptions> = {}) {
	/* openapi has no honey manifest, so the gate is never asked; one that throws proves it */
	const specGate = () => Promise.reject(new Error("the spec gate was asked"))
	const { packages } = await readRelease(path.join(root, "acme-release", "release.config.ts"), {})
	const [result] = await syncAll(packages, {
		only: ["openapi"],
		repoRoot: root,
		repoSettings: async () => ({ changed: [], status: "checked" }),
		specGate,
		token: TOKEN,
		...extra,
	})
	return result
}

describe("syncAll against a public repo's tip", () => {
	it("skips when the source equals the bot's tip", async () => {
		const root = await sourceRepo(SPEC)
		const bare = await publicRepo(remotes, SPEC, BOT_EMAIL)
		const before = await tip(bare)

		expect((await run(root))?.status).toBe("skipped")
		expect(await tip(bare)).toBe(before)
	})

	it("pushes a bot commit when the source changed and the tip is the bot's", async () => {
		const root = await sourceRepo('{"openapi":"3.1.1"}\n')
		const bare = await publicRepo(remotes, SPEC, BOT_EMAIL)
		const before = await tip(bare)

		expect((await run(root))?.status).toBe("synced")
		expect(await tip(bare)).not.toBe(before)
		expect(await tipCommitter(bare)).toBe(BOT_EMAIL)
	})

	it("refuses to overwrite a tip someone else committed", async () => {
		const root = await sourceRepo('{"openapi":"3.1.1"}\n')
		const bare = await publicRepo(remotes, SPEC, "someone@example.com")
		const before = await tip(bare)

		const result = await run(root)
		expect(result?.status).toBe("failed")
		expect(result?.reason).toMatch(/external push detected/)
		expect(await tip(bare)).toBe(before)
	})

	it("overwrites a foreign tip when told to", async () => {
		const root = await sourceRepo('{"openapi":"3.1.1"}\n')
		const bare = await publicRepo(remotes, SPEC, "someone@example.com")

		expect((await run(root, { overwriteForeignTip: true }))?.status).toBe("synced")
		expect(await tipCommitter(bare)).toBe(BOT_EMAIL)
	})

	it("fails on a foreign tip even when the source equals it, and tags nothing", async () => {
		const root = await sourceRepo(SPEC, releasing("1.2.3"))
		const bare = await publicRepo(remotes, SPEC, "someone@example.com", releasing("1.2.3"))
		const before = await tip(bare)

		expect((await run(root))?.status).toBe("failed")
		expect(await tip(bare)).toBe(before)
		expect(await tagged(bare, "v1.2.3")).toBeUndefined()
	})

	it("reports an unchanged package as skipped on a dry run", async () => {
		const root = await sourceRepo(SPEC)
		const bare = await publicRepo(remotes, SPEC, BOT_EMAIL)
		const before = await tip(bare)

		expect((await run(root, { dryRun: true }))?.status).toBe("skipped")
		expect(await tip(bare)).toBe(before)
	})
})

describe("syncAll tags the version a self-publishing package records", () => {
	it("tags the commit it pushed, and a rerun pushes nothing more", async () => {
		const root = await sourceRepo('{"openapi":"3.1.1"}\n', releasing("1.2.3"))
		const bare = await publicRepo(remotes, SPEC, BOT_EMAIL)

		const result = await run(root)
		expect(result?.status).toBe("synced")
		expect(result?.tag).toBe("v1.2.3")
		const pushed = await tip(bare)
		expect(await tagged(bare, "v1.2.3")).toBe(pushed)

		const again = await run(root)
		expect(again?.status).toBe("skipped")
		expect(again?.tag).toBeUndefined()
		expect(await tip(bare)).toBe(pushed)
	})

	it("tags a bot tip that already equals the source, as after a run that stopped before its tag", async () => {
		const root = await sourceRepo(SPEC, releasing("1.2.3"))
		const bare = await publicRepo(remotes, SPEC, BOT_EMAIL, releasing("1.2.3"))
		const before = await tip(bare)

		const result = await run(root)
		expect(result?.status).toBe("skipped")
		expect(result?.tag).toBe("v1.2.3")
		expect(await tagged(bare, "v1.2.3")).toBe(before)
	})

	it("leaves a tag that already names another commit where it is", async () => {
		const root = await sourceRepo(SPEC, releasing("1.2.3"))
		const bare = await publicRepo(remotes, SPEC, BOT_EMAIL, releasing("1.2.3"))
		const old = await tip(bare)
		await gitRun(["tag", "v1.2.3", old], bare)
		writeAll(path.join(root, "acme-release/openapi"), {
			"openapi.json": '{"openapi":"3.1.1"}\n',
		})

		const result = await run(root)
		expect(result?.status).toBe("synced")
		expect(result?.tag).toBeUndefined()
		expect(await tagged(bare, "v1.2.3")).toBe(old)
	})
})

describe("syncAll tags nothing it should not", () => {
	it("tags nothing for a package without a release workflow or without a recorded version", async () => {
		const noWorkflow = await sourceRepo('{"openapi":"3.1.1"}\n', { [STATE]: '{"version":"1.2.3"}\n' })
		const bare = await publicRepo(remotes, SPEC, BOT_EMAIL)
		expect((await run(noWorkflow))?.status).toBe("synced")
		expect(await tagged(bare, "v1.2.3")).toBeUndefined()

		const noState = await sourceRepo('{"openapi":"3.1.2"}\n', { [RELEASE_YML]: "on: push\n" })
		expect((await run(noState))?.status).toBe("synced")
		expect(await gitOutput(["tag", "--list"], bare)).toBe("")
	})

	it("names the tag on a dry run and pushes nothing", async () => {
		const root = await sourceRepo('{"openapi":"3.1.1"}\n', releasing("1.2.3"))
		const bare = await publicRepo(remotes, SPEC, BOT_EMAIL)
		const before = await tip(bare)

		const result = await run(root, { dryRun: true })
		expect(result?.status).toBe("synced")
		expect(result?.tag).toBe("v1.2.3")
		expect(await tip(bare)).toBe(before)
		expect(await tagged(bare, "v1.2.3")).toBeUndefined()
	})
})

describe("syncAll writes the release workflow a package's registries call for", () => {
	const GITHUB = [{ assets: ["openapi.json"], kind: "github" }]

	it("puts the rendered workflow in the public tree and tags the version beside it", async () => {
		const root = await sourceRepo('{"openapi":"3.1.1"}\n', { [STATE]: '{"version":"2.0.0"}\n' }, GITHUB)
		const bare = await publicRepo(remotes, SPEC, BOT_EMAIL)

		const result = await run(root)
		expect(result?.status).toBe("synced")
		expect(result?.tag).toBe("v2.0.0")
		expect(await tipFile(bare, RELEASE_YML)).toMatch(/gh release create "\$TAG" "openapi\.json"/)
		expect(await tagged(bare, "v2.0.0")).toBe(await tip(bare))

		expect((await run(root))?.status).toBe("skipped")
	})

	it("refuses a source that carries its own release workflow and lists registries", async () => {
		const root = await sourceRepo('{"openapi":"3.1.1"}\n', releasing("2.0.0"), GITHUB)
		const bare = await publicRepo(remotes, SPEC, BOT_EMAIL)
		const before = await tip(bare)

		const result = await run(root)
		expect(result?.status).toBe("failed")
		expect(result?.reason).toMatch(/release\.yml.*registries|registries.*release\.yml/)
		expect(await tip(bare)).toBe(before)
	})
})
