import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, expectTypeOf, it } from "vitest"

import type { MetadataField } from "../emit/shared/metadata.ts"
import { configOf, gitRepo, removeRepos, writeConfig } from "./__fixtures__/release-repo.ts"
import { readRelease } from "./load.ts"
import { defineRelease, MIRROR_ALLOWLIST } from "./manifest.ts"
import type { PackageMetadata } from "./types.ts"
import { SPAWN_TIMEOUT } from "../gen/__fixtures__/spawn-timeout.ts"

afterEach(removeRepos)

type FixturePackage = {
	name: string
	repo: string
	commitMessage?: string
	description?: string
	honey?: unknown
	registries?: unknown[]
	topics?: unknown[]
}

const HOMEPAGE = "https://example.com"

type FixtureSpec = { deployedUrl: string; committedPath: string } | null

const CODEGEN = ["node", "codegen.mjs"]

const SPEC: FixtureSpec = {
	committedPath: "spec.json",
	deployedUrl: "https://api.example.com/openapi/spec.json",
}

/**
 * A repo root holding acme's release config at `<root>/acme-release/release.config.ts`, a dir beside it
 * per name in `dirs` (default: every package), and the committed spec `spec.json` the default `spec` points at.
 */
function product(
	root: string,
	packages: FixturePackage[],
	{
		dirs = packages.map((p) => p.name),
		spec = SPEC,
		homepage = HOMEPAGE,
	}: { dirs?: string[]; spec?: FixtureSpec; homepage?: string | null } = {},
): void {
	writeFileSync(path.join(root, "spec.json"), "{}\n")
	const configDir = path.dirname(configOf(root))
	mkdirSync(configDir, { recursive: true })
	for (const dir of dirs) mkdirSync(path.join(configDir, dir), { recursive: true })
	writeConfig(root, {
		codegen: CODEGEN,
		...(homepage === null ? {} : { homepage }),
		...(spec ? { spec } : {}),
		packages: packages.map((p) => ({
			commitMessage: "chore: sync",
			description: `${p.name} package`,
			topics: ["acme"],
			...p,
		})),
		project: "acme",
	})
}

/* the packages acme's release config in `root` places */
const loadPackages = async (root: string) => (await readRelease(configOf(root), {})).packages

const repo = () => gitRepo("manifest-test-")

describe("MIRROR_ALLOWLIST", () => {
	it("matches github SSH URLs for any org", () => {
		expect(MIRROR_ALLOWLIST.test("git@github.com:acme/openapi.git")).toBe(true)
		expect(MIRROR_ALLOWLIST.test("git@github.com:acme-corp/cli.git")).toBe(true)
	})

	it("rejects non-github or malformed URLs", () => {
		expect(MIRROR_ALLOWLIST.test("https://github.com/acme/openapi.git")).toBe(false)
		expect(MIRROR_ALLOWLIST.test("git@gitlab.com:acme/openapi.git")).toBe(false)
		expect(MIRROR_ALLOWLIST.test("git@github.com:acme/foo")).toBe(false)
	})
})

describe("loadPackages spec and codegen", () => {
	it("gives each package the release's spec, with an absolute committed path", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await repo()
		product(root, [{ name: "sdk", repo: "acme/sdk" }])
		const [pkg] = await loadPackages(root)
		expect(pkg?.spec).toEqual({
			committedPath: path.join(root, "spec.json"),
			deployedUrl: "https://api.example.com/openapi/spec.json",
		})
	})

	it("gives each package the release's codegen command", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await repo()
		product(root, [{ name: "sdk", repo: "acme/sdk" }])
		const [pkg] = await loadPackages(root)
		expect(pkg?.codegen).toEqual(CODEGEN)
	})

	it("rejects a release without a codegen command, naming the manifest", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await repo()
		product(root, [{ name: "sdk", repo: "acme/sdk" }])
		writeConfig(root, {
			packages: [{ commitMessage: "c", description: "d", name: "sdk", repo: "acme/sdk" }],
			project: "acme",
			spec: SPEC,
		})
		await expect(loadPackages(root)).rejects.toThrow(/release\.config\.ts is invalid:[\s\S]*codegen/)
	})
})

describe("loadPackages homepage, description and topics", () => {
	it(
		"gives each package the release's homepage, its description and its topics",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const root = await repo()
			product(root, [
				{
					description: "Acme SDK (example.com)",
					name: "sdk",
					repo: "acme/sdk",
					topics: ["acme", "sdk"],
				},
			])
			const [pkg] = await loadPackages(root)
			expect([pkg?.homepage, pkg?.description, pkg?.topics]).toEqual([
				HOMEPAGE,
				"Acme SDK (example.com)",
				["acme", "sdk"],
			])
		},
	)

	it("rejects a release without a homepage, naming the manifest", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await repo()
		product(root, [{ name: "sdk", repo: "acme/sdk" }], { homepage: null })
		await expect(loadPackages(root)).rejects.toThrow(/release\.config\.ts is invalid:[\s\S]*homepage/)
	})

	it.each([
		["no topics", { topics: undefined }, /topics/],
		["an empty topic list", { topics: [] }, /topics/],
		["a topic GitHub refuses", { topics: ["Not A Slug"] }, /topics/],
		["a description longer than GitHub keeps", { description: "x".repeat(351) }, /description/],
	])("rejects a package with %s, naming the manifest", { timeout: SPAWN_TIMEOUT }, async (_case, fields, message) => {
		const root = await repo()
		product(root, [{ name: "sdk", repo: "acme/sdk", ...fields }])
		await expect(loadPackages(root)).rejects.toThrow(message)
	})
})

describe("loadPackages deployed spec URL", () => {
	it("accepts http on a loopback host, for tests", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await repo()
		product(root, [{ name: "sdk", repo: "acme/sdk" }], {
			spec: { committedPath: "spec.json", deployedUrl: "http://127.0.0.1:8123/openapi/spec.json" },
		})
		const [pkg] = await loadPackages(root)
		expect(pkg?.spec.deployedUrl).toBe("http://127.0.0.1:8123/openapi/spec.json")
	})

	it.each([
		["no spec", null, /release\.config\.ts is invalid:[\s\S]*spec/],
		[
			"an http deployedUrl off loopback",
			{ committedPath: "spec.json", deployedUrl: "http://api.example.com/spec.json" },
			/release\.config\.ts is invalid:[\s\S]*deployedUrl/,
		],
		[
			"a committedPath that does not exist",
			{ committedPath: "nope.json", deployedUrl: "https://api.example.com/spec.json" },
			/release\.config\.ts: spec\.committedPath nope\.json does not exist/,
		],
	])("rejects %s, naming the manifest", { timeout: SPAWN_TIMEOUT }, async (_case, spec, message) => {
		const root = await repo()
		product(root, [{ name: "sdk", repo: "acme/sdk" }], { spec: spec as FixtureSpec })
		await expect(loadPackages(root)).rejects.toThrow(message)
	})
})

describe("loadPackages placement", () => {
	it("places each package beside its release config", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await repo()
		product(root, [
			{ name: "openapi", repo: "acme/openapi" },
			{ name: "cli", repo: "acme-oss/acme-cli" },
		])

		const packages = await loadPackages(root)

		expect(packages.map((p) => [p.project, p.name, p.path, p.mirror, p.branch])).toEqual([
			["acme", "openapi", "acme-release/openapi", "git@github.com:acme/openapi.git", "main"],
			["acme", "cli", "acme-release/cli", "git@github.com:acme-oss/acme-cli.git", "main"],
		])
	})

	it("rejects a listed package whose dir is missing", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await repo()
		product(root, [{ name: "openapi", repo: "acme/openapi" }], { dirs: [] })

		await expect(loadPackages(root)).rejects.toThrow(/acme-release\/openapi/)
	})

	it("rejects a public dir the manifest does not list, but not a dot-dir", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await repo()
		product(root, [{ name: "openapi", repo: "acme/openapi" }], { dirs: ["openapi", ".tmp"] })
		await expect(loadPackages(root)).resolves.toHaveLength(1)

		mkdirSync(path.join(root, "acme-release/stray"))
		await expect(loadPackages(root)).rejects.toThrow(/stray/)
	})
})

describe("loadPackages registries", () => {
	it("gives each package its registries, none when it lists none", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await repo()
		product(root, [
			{ name: "sdk", registries: [{ kind: "npm" }, { kind: "jsr" }], repo: "acme/sdk" },
			{
				name: "spec",
				registries: [{ assets: ["openapi.json"], kind: "github" }],
				repo: "acme/spec",
			},
			{ name: "cli", repo: "acme/cli" },
		])

		const byName = Object.fromEntries((await loadPackages(root)).map((p) => [p.name, p.registries]))
		expect(byName).toEqual({
			cli: [],
			sdk: [{ kind: "npm" }, { kind: "jsr" }],
			spec: [{ assets: ["openapi.json"], kind: "github" }],
		})
	})

	it("takes C# and Java packages published to NuGet and Maven Central", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await repo()
		product(root, [
			{
				honey: { options: { packageId: "Acme.Sdk" }, target: "csharp" },
				name: "sdk-csharp",
				registries: [{ kind: "nuget" }],
				repo: "acme/sdk-csharp",
			},
			{
				honey: { options: { groupId: "com.acme" }, target: "java" },
				name: "sdk-java",
				registries: [{ kind: "maven" }],
				repo: "acme/sdk-java",
			},
		])

		const byName = Object.fromEntries((await loadPackages(root)).map((p) => [p.name, [p.honey?.target, p.registries]]))
		expect(byName).toEqual({
			"sdk-csharp": ["csharp", [{ kind: "nuget" }]],
			"sdk-java": ["java", [{ kind: "maven" }]],
		})
	})
})

describe("loadPackages duplicates and repos", () => {
	it(
		"rejects an unknown registry kind and a GitHub release with no assets, naming the manifest",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			for (const registries of [[{ kind: "hackage" }], [{ assets: [], kind: "github" }]]) {
				const root = await repo()
				product(root, [{ name: "sdk", registries, repo: "acme/sdk" }])
				await expect(loadPackages(root)).rejects.toThrow(/release\.config\.ts is invalid:[\s\S]*registries/)
			}
		},
	)

	it("rejects a duplicate package name, naming the manifest", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await repo()
		product(root, [
			{ name: "openapi", repo: "acme/openapi" },
			{ name: "openapi", repo: "acme/openapi-2" },
		])

		await expect(loadPackages(root)).rejects.toThrow(/release\.config\.ts[\s\S]*duplicate/)
	})

	it("rejects a duplicate repo within one manifest", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await repo()
		product(root, [
			{ name: "openapi", repo: "acme/openapi" },
			{ name: "cli", repo: "acme/openapi" },
		])

		await expect(loadPackages(root)).rejects.toThrow(/release\.config\.ts[\s\S]*duplicate/)
	})

	it("rejects a repo that is not owner/name", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await repo()
		product(root, [{ name: "openapi", repo: "git@github.com:acme/openapi.git" }])

		await expect(loadPackages(root)).rejects.toThrow(/release\.config\.ts/)
	})
})

describe("loadRelease on a project laid out outside any monorepo", () => {
	const SDK = { commitMessage: "c", description: "d", name: "sdk", repo: "acme/sdk", topics: ["acme"] }

	it(
		"roots the release at the git toplevel and places each package beside the config",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const root = await repo()
			product(root, [{ name: "sdk", repo: "acme/sdk" }])
			const release = await readRelease(configOf(root), {})
			expect(release.root).toBe(realpathSync(root))
			expect([release.project, release.codegen, release.spec.committedPath]).toEqual([
				"acme",
				CODEGEN,
				path.join(realpathSync(root), "spec.json"),
			])
			expect(release.packages.map((p) => [p.project, p.path, p.mirror])).toEqual([
				["acme", "acme-release/sdk", "git@github.com:acme/sdk.git"],
			])
		},
	)

	it.each([
		["no project", {}, "got undefined"],
		["a project that is not a slug", { project: "Acme Corp" }, 'got "Acme Corp"'],
	])("requires the project, naming the config, for %s", { timeout: SPAWN_TIMEOUT }, async (_case, project, got) => {
		const root = await repo()
		writeFileSync(path.join(root, "spec.json"), "{}\n")
		mkdirSync(path.join(root, "acme-release/sdk"), { recursive: true })
		writeConfig(root, { codegen: CODEGEN, homepage: HOMEPAGE, packages: [SDK], spec: SPEC, ...project })
		await expect(loadPackages(root)).rejects.toThrow(
			new RegExp(`^acme-release/release\\.config\\.ts: project: expected a slug, ${got}$`),
		)
	})

	it("commits as public-sync[bot] unless the config names its own committer", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await repo()
		product(root, [{ name: "sdk", repo: "acme/sdk" }])
		const [byDefault] = await loadPackages(root)
		const committer = { email: "123+acme-sync[bot]@users.noreply.github.com", name: "acme-sync[bot]" }
		/* a second repo: a config's module is imported once per process */
		const other = await repo()
		product(other, [{ name: "sdk", repo: "acme/sdk" }])
		writeConfig(other, {
			codegen: CODEGEN,
			committer,
			homepage: HOMEPAGE,
			packages: [SDK],
			project: "acme",
			spec: SPEC,
		})
		const [own] = await loadPackages(other)
		expect([byDefault?.committer, own?.committer]).toEqual([
			{ email: "public-sync[bot]@users.noreply.github.com", name: "public-sync[bot]" },
			committer,
		])
	})
})

describe("loadRelease refusing a config it cannot read", () => {
	const SDK = { commitMessage: "c", description: "d", name: "sdk", repo: "acme/sdk", topics: ["acme"] }

	it("names a config that is not there", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await repo()
		await expect(readRelease(configOf(root), {})).rejects.toThrow(
			/acme-release\/release\.config\.ts: no such release config/,
		)
	})

	it("names a config outside any git repository", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await repo()
		product(root, [{ name: "sdk", repo: "acme/sdk" }])
		/* without .git the dir is a plain temp dir, which no repository encloses */
		const { rmSync } = await import("node:fs")
		rmSync(path.join(root, ".git"), { force: true, recursive: true })
		await expect(readRelease(configOf(root), {})).rejects.toThrow(/release\.config\.ts: not inside a git repository/)
	})

	it("names a config with no default export", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await repo()
		product(root, [{ name: "sdk", repo: "acme/sdk" }])
		writeFileSync(configOf(root), "export const release = {}\n")
		await expect(readRelease(configOf(root), {})).rejects.toThrow(
			/release\.config\.ts has no default export; write `export default defineRelease\(\{ \.\.\. \}\)`/,
		)
	})

	it("types a config by returning it unchanged, with a metadata field for every one honey-clients reads", () => {
		const config = { codegen: CODEGEN, homepage: HOMEPAGE, packages: [SDK], project: "acme", spec: SPEC }
		expect(defineRelease(config)).toBe(config)
		expectTypeOf<keyof PackageMetadata>().toEqualTypeOf<MetadataField>()
	})
})

describe("loadPackages metadata", () => {
	it(
		"lays a package's metadata over the release's, adding its keywords to the release's",
		{ timeout: SPAWN_TIMEOUT },
		async () => {
			const root = await repo()
			product(root, [{ name: "sdk", repo: "acme/sdk" }])
			writeConfig(root, {
				codegen: CODEGEN,
				homepage: HOMEPAGE,
				metadata: { keywords: ["acme"], license: "MIT" },
				packages: [
					{
						commitMessage: "c",
						description: "d",
						metadata: { keywords: ["sdk"], license: "Apache-2.0" },
						name: "sdk",
						repo: "acme/sdk",
						topics: ["acme"],
					},
				],
				project: "acme",
				spec: SPEC,
			})
			const [pkg] = await loadPackages(root)
			expect(pkg?.metadata).toEqual({ keywords: ["acme", "sdk"], license: "Apache-2.0" })
		},
	)

	it("names the missing project when the default export is no object", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await repo()
		product(root, [{ name: "sdk", repo: "acme/sdk" }])
		writeFileSync(configOf(root), "export default 42\n")
		await expect(loadPackages(root)).rejects.toThrow(
			"acme-release/release.config.ts: project: expected a slug, got undefined",
		)
	})
})
