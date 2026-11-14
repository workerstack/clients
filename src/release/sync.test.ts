import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import * as gitMod from "./git.ts"
import type { PublicPackage } from "./types.ts"
import { SPAWN_TIMEOUT } from "../gen/__fixtures__/spawn-timeout.ts"

/* every git call is a fake; the token URL is built as sync builds it */
vi.mock("./git.ts", async (original) => ({
	...(await original<typeof import("./git.ts")>()),
	getRemoteTip: vi.fn(),
	gitExitCode: vi.fn(),
	gitOutput: vi.fn(),
	gitRun: vi.fn(),
}))

const HEAD_SHA = "a".repeat(40)
const PRIOR_MIRROR_SHA = "b".repeat(40)

const BOT_EMAIL = "public-sync[bot]@users.noreply.github.com"
const CODEGEN = ["node", "codegen.mjs"]
const COMMITTER = { email: BOT_EMAIL, name: "public-sync[bot]" }
const SPEC = {
	committedPath: "/spec.json",
	deployedUrl: "https://api.example.com/openapi/spec.json",
}
const IN_STEP = async () => ({ changed: [], status: "checked" as const })
const MATCH = async () => ({ sha: "c".repeat(64), status: "match" as const })
const DRIFT = async () => ({
	committedSha: "c".repeat(64),
	deployedSha: "d".repeat(64),
	extra: [],
	missing: ["GET /v1/new"],
	status: "drift" as const,
})
const REFUSED = async () => {
	throw new Error("acme/openapi: GitHub answered PATCH / with 403: Resource not accessible by integration")
}

/* a package `acme/<name>` at `packages/<name>`, its fields over the defaults */
function entry(name: string, fields: Pick<PublicPackage, "commitMessage" | "description">): PublicPackage {
	return {
		branch: "main",
		codegen: CODEGEN,
		committer: COMMITTER,
		homepage: "https://example.com",
		mirror: `git@github.com:acme/${name}.git`,
		name,
		path: `packages/${name}`,
		project: "acme",
		registries: [],
		repo: `acme/${name}`,
		spec: SPEC,
		topics: ["acme"],
		...fields,
	}
}

const DRY_RUN_ENTRY = entry("openapi", { commitMessage: "chore: update openapi spec", description: "OpenAPI spec." })
const GATE_ENTRY = entry("sdk-go", { commitMessage: "chore: update sdk", description: "Go SDK." })
const SETTINGS_ENTRY = entry("openapi", {
	commitMessage: "chore: update spec",
	description: "Acme spec (example.com).",
})

/* a temp repo root per test holding `pkg`'s dir, every git fake reset after; `files` go in the package's dir */
function usePackageRoot(pkg: PublicPackage, files: Readonly<Record<string, string>> = {}): () => string {
	let root = ""
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "sync-test-"))
		mkdirSync(join(root, pkg.path), { recursive: true })
		for (const [name, content] of Object.entries(files)) writeFileSync(join(root, pkg.path, name), content)
		vi.mocked(gitMod.gitRun).mockResolvedValue(undefined)
		vi.mocked(gitMod.gitExitCode).mockResolvedValue(1)
	}, SPAWN_TIMEOUT)
	afterEach(() => {
		rmSync(root, { force: true, recursive: true })
		vi.clearAllMocks()
	})
	return () => root
}

/* the tip is the bot's and the tree differs, so a dry run reaches its report */
function botTip(): void {
	vi.mocked(gitMod.gitOutput).mockImplementation(async (args) => (args.includes("--format=%ce") ? BOT_EMAIL : HEAD_SHA))
}

/* the bot's tip, a changed tree whose staged paths are `changed` */
function mirrorDiff(changed: string[]): void {
	vi.mocked(gitMod.getRemoteTip).mockResolvedValue(PRIOR_MIRROR_SHA)
	vi.mocked(gitMod.gitOutput).mockImplementation(async (args) => {
		if (args.includes("--format=%ce")) return BOT_EMAIL
		if (args.includes("--name-only")) return changed.join("\n")
		return HEAD_SHA
	})
}

/* the bot's tip; `unchanged` decides whether the staged tree equals it */
function mirror(unchanged: boolean): void {
	vi.mocked(gitMod.getRemoteTip).mockResolvedValue(PRIOR_MIRROR_SHA)
	botTip()
	vi.mocked(gitMod.gitExitCode).mockResolvedValue(unchanged ? 0 : 1)
}

const BASE_OPTS = {
	dryRun: true,
	repoRoot: "",
	repoSettings: IN_STEP,
	specGate: MATCH,
	token: "tok",
}

describe("syncPackage dry-run messages", () => {
	const root = usePackageRoot(DRY_RUN_ENTRY)
	beforeEach(botTip, SPAWN_TIMEOUT)

	it("first sync to an empty mirror uses the initial release message", { timeout: SPAWN_TIMEOUT }, async () => {
		vi.mocked(gitMod.getRemoteTip).mockResolvedValue(undefined)

		const { syncPackage } = await import("./sync.ts")
		const result = await syncPackage(DRY_RUN_ENTRY, {
			...BASE_OPTS,
			initialMessage: "chore: initial release",
			repoRoot: root(),
		})

		expect(result.status).toBe("synced")
		expect(result.reason).toMatch(/initial release/)
		const pushCalls = vi.mocked(gitMod.gitRun).mock.calls.filter((c) => c[0].includes("push"))
		expect(pushCalls).toHaveLength(0)
	})

	it("a later sync uses the package commitMessage template", { timeout: SPAWN_TIMEOUT }, async () => {
		vi.mocked(gitMod.getRemoteTip).mockResolvedValue(PRIOR_MIRROR_SHA)

		const { syncPackage } = await import("./sync.ts")
		const result = await syncPackage(DRY_RUN_ENTRY, { ...BASE_OPTS, repoRoot: root() })

		expect(result.status).toBe("synced")
		expect(result.reason).toMatch(/chore: update openapi spec/)
	})

	it("a sidecar message overrides the template", { timeout: SPAWN_TIMEOUT }, async () => {
		writeFileSync(
			join(root(), "packages", "openapi", ".publicsync-message"),
			"fix(retry): handle 5xx without unbounded backoff\n",
			"utf8",
		)
		vi.mocked(gitMod.getRemoteTip).mockResolvedValue(PRIOR_MIRROR_SHA)

		const { syncPackage } = await import("./sync.ts")
		const result = await syncPackage(DRY_RUN_ENTRY, { ...BASE_OPTS, repoRoot: root() })

		expect(result.status).toBe("synced")
		expect(result.reason).toMatch(/fix\(retry\): handle 5xx/)
	})
})

describe("syncPackage spec gate on a drifting prod", () => {
	const root = usePackageRoot(GATE_ENTRY, {
		".clients-generated.json": JSON.stringify({ files: { "client.go": "a".repeat(64) } }),
		"README.md": "# sdk-go\n",
		"client.go": "package acme\n",
	})

	it(
		"refuses a changed generated file while prod's spec drifts, pushing nothing",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			mirrorDiff(["client.go"])
			const { syncPackage } = await import("./sync.ts")
			const result = await syncPackage(GATE_ENTRY, {
				repoRoot: root(),
				repoSettings: IN_STEP,
				specGate: DRIFT,
				token: "tok",
			})

			expect(result.status).toBe("failed")
			expect(result.reason).toContain("acme/sdk-go: its generated output changed")
			expect(result.reason).toContain("GET /v1/new")
			expect(vi.mocked(gitMod.gitRun).mock.calls.filter((c) => c[0].includes("push"))).toHaveLength(0)
		},
	)

	it("syncs a hand-file-only change without asking prod", { timeout: SPAWN_TIMEOUT }, async () => {
		mirrorDiff(["README.md"])
		const gate = vi.fn(DRIFT)
		const { syncPackage } = await import("./sync.ts")
		const result = await syncPackage(GATE_ENTRY, {
			dryRun: true,
			repoRoot: root(),
			repoSettings: IN_STEP,
			specGate: gate,
			token: "tok",
		})

		expect(result.status).toBe("synced")
		expect(gate).not.toHaveBeenCalled()
	})
})

describe("syncPackage spec gate on a matching prod", () => {
	const root = usePackageRoot(GATE_ENTRY, {
		".clients-generated.json": JSON.stringify({ files: { "client.go": "a".repeat(64) } }),
		"README.md": "# sdk-go\n",
		"client.go": "package acme\n",
	})

	it("syncs a generated change when prod serves the committed spec", { timeout: SPAWN_TIMEOUT }, async () => {
		mirrorDiff(["client.go", "README.md"])
		const { syncPackage } = await import("./sync.ts")
		const result = await syncPackage(GATE_ENTRY, {
			dryRun: true,
			repoRoot: root(),
			repoSettings: IN_STEP,
			specGate: MATCH,
			token: "tok",
		})

		expect(result.status).toBe("synced")
	})

	it("keeps clients' manifest out of the mirror", { timeout: SPAWN_TIMEOUT }, async () => {
		mirrorDiff(["README.md"])
		/* the staged tree, seen when sync stages it (the worktree is removed afterwards) */
		const staged: string[] = []
		vi.mocked(gitMod.gitRun).mockImplementation(async (args) => {
			if (args.includes("add")) staged.push(...readdirSync(args[1] as string))
		})
		const { syncPackage } = await import("./sync.ts")
		await syncPackage(GATE_ENTRY, {
			dryRun: true,
			repoRoot: root(),
			repoSettings: IN_STEP,
			specGate: MATCH,
			token: "tok",
		})

		expect(staged).toContain("client.go")
		expect(staged).not.toContain(".clients-generated.json")
	})
})

describe("filterPackages", () => {
	it("keeps every package when --only names none", async () => {
		const { filterPackages } = await import("./sync.ts")
		const packages = ["openapi", "cli"].map((name) => ({ name, project: "acme" }) as PublicPackage)
		expect(filterPackages(packages, {}).map((p) => p.name)).toEqual(["openapi", "cli"])
		expect(filterPackages(packages, { only: [] }).map((p) => p.name)).toEqual(["openapi", "cli"])
	})

	it("--only accepts short name or project/name", async () => {
		const { filterPackages } = await import("./sync.ts")
		const packages: PublicPackage[] = [
			{
				branch: "main",
				codegen: CODEGEN,
				committer: COMMITTER,
				commitMessage: "c",
				description: "d",
				homepage: "https://example.com",
				mirror: "git@github.com:a/x.git",
				name: "openapi",
				path: "a",
				project: "acme",
				registries: [],
				repo: "a/x",
				spec: SPEC,
				topics: ["acme"],
			},
			{
				branch: "main",
				codegen: CODEGEN,
				committer: COMMITTER,
				commitMessage: "c",
				description: "d",
				homepage: "https://example.com",
				mirror: "git@github.com:b/y.git",
				name: "cli",
				path: "b",
				project: "acme",
				registries: [],
				repo: "b/y",
				spec: SPEC,
				topics: ["acme"],
			},
		]
		expect(filterPackages(packages, { only: ["openapi"] })).toHaveLength(1)
		expect(filterPackages(packages, { only: ["acme/cli"] })).toHaveLength(1)
	})
})

describe("syncPackage repo settings applied", () => {
	const root = usePackageRoot(SETTINGS_ENTRY)

	it("applies the settings to a package whose content is unchanged", { timeout: SPAWN_TIMEOUT }, async () => {
		mirror(true)
		const repoSettings = vi.fn(async () => ({
			changed: ["homepage" as const],
			status: "checked" as const,
		}))
		const { syncPackage } = await import("./sync.ts")
		const result = await syncPackage(SETTINGS_ENTRY, {
			repoRoot: root(),
			repoSettings,
			specGate: MATCH,
			token: "tok",
		})

		expect(repoSettings).toHaveBeenCalledWith(SETTINGS_ENTRY)
		expect(result).toMatchObject({ settings: "settings changed: homepage", status: "skipped" })
	})

	it(
		"fails a package GitHub refuses the settings of, keeping the push that landed",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			mirror(false)
			const { syncPackage } = await import("./sync.ts")
			const result = await syncPackage(SETTINGS_ENTRY, {
				repoRoot: root(),
				repoSettings: REFUSED,
				specGate: MATCH,
				token: "tok",
			})

			expect(vi.mocked(gitMod.gitRun).mock.calls.some((call) => call[0].includes("push"))).toBe(true)
			expect(result).toMatchObject({ mirrorSha: HEAD_SHA, status: "failed" })
			expect(result.reason).toContain("403: Resource not accessible by integration")
		},
	)
})

describe("syncPackage repo settings reported", () => {
	const root = usePackageRoot(SETTINGS_ENTRY)

	it("reports a dry run's settings as what it would change", { timeout: SPAWN_TIMEOUT }, async () => {
		mirror(false)
		const { syncPackage } = await import("./sync.ts")
		const result = await syncPackage(SETTINGS_ENTRY, {
			dryRun: true,
			repoRoot: root(),
			repoSettings: async () => ({ changed: ["description", "topics"], status: "checked" }),
			specGate: MATCH,
			token: "tok",
		})

		expect(result).toMatchObject({
			settings: "settings would change: description, topics",
			status: "synced",
		})
	})

	it("says the settings went unchecked without a token", { timeout: SPAWN_TIMEOUT }, async () => {
		mirror(true)
		const { syncPackage } = await import("./sync.ts")
		const result = await syncPackage(SETTINGS_ENTRY, {
			dryRun: true,
			repoRoot: root(),
			repoSettings: async () => ({ status: "unchecked: no token" }),
			specGate: MATCH,
			token: "",
		})

		expect(result.settings).toBe("settings unchecked: no token")
	})
})

describe("syncPackage repo settings failing", () => {
	const root = usePackageRoot(SETTINGS_ENTRY)

	it("adds GitHub's refusal to what a dry run would have done", { timeout: SPAWN_TIMEOUT }, async () => {
		mirror(false)
		const { syncPackage } = await import("./sync.ts")
		const result = await syncPackage(SETTINGS_ENTRY, { ...BASE_OPTS, repoRoot: root(), repoSettings: REFUSED })

		expect(result.status).toBe("failed")
		expect(result.reason).toMatch(/^.+; acme\/openapi: GitHub answered PATCH \/ with 403/)
	})

	it("reports a settings step that throws no Error by what it threw", { timeout: SPAWN_TIMEOUT }, async () => {
		mirror(false)
		const { syncPackage } = await import("./sync.ts")
		const result = await syncPackage(SETTINGS_ENTRY, {
			repoRoot: root(),
			repoSettings: () => Promise.reject("rate limited"),
			specGate: MATCH,
			token: "tok",
		})

		expect(result).toMatchObject({ reason: "rate limited", status: "failed" })
	})
})

describe("syncAll on a package that throws", () => {
	const root = usePackageRoot(SETTINGS_ENTRY)

	it.each([
		["an Error, by its message", new Error("disk full"), "disk full"],
		["anything else, as it is", "disk gone", "disk gone"],
	])("fails that package and reports %s", { timeout: SPAWN_TIMEOUT }, async (_case, thrown, reason) => {
		vi.mocked(gitMod.getRemoteTip).mockRejectedValue(thrown)
		const { syncAll } = await import("./sync.ts")

		const results = await syncAll([SETTINGS_ENTRY], { ...BASE_OPTS, repoRoot: root() })

		expect(results).toEqual([{ name: "acme/openapi", reason, status: "failed" }])
	})
})
