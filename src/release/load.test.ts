import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { SPAWN_TIMEOUT } from "../gen/__fixtures__/spawn-timeout.ts"
import type { BunBuild, BunLike } from "../installers/config/hooks/bun.ts"
import type { RegisterHooks } from "../installers/config/hooks/node.ts"
import type { RuntimeInfo } from "../installers/config/load.ts"
import { configOf, gitRepo, removeRepos, writeAll } from "./__fixtures__/release-repo.ts"
import { loadRelease, readRelease, RELEASE_SPECIFIER } from "./load.ts"

afterEach(removeRepos)

const NODE: RuntimeInfo = { nodeVersion: "26.0.0", runtime: "node" }

const CONFIG = {
	codegen: ["node", "codegen.mjs"],
	homepage: "https://example.com",
	packages: [{ commitMessage: "c", description: "d", name: "sdk", repo: "acme/sdk", topics: ["acme"] }],
	project: "acme",
	spec: { committedPath: "spec.json", deployedUrl: "https://api.example.com/spec.json" },
}

/* acme's repo: its spec, its sdk dir, and a release config whose body is `config` (default: export CONFIG) */
async function acme(config = `export default ${JSON.stringify(CONFIG)}\n`): Promise<string> {
	const root = await gitRepo("release-load-")
	writeAll(root, { "acme-release/release.config.ts": config, "acme-release/sdk/.keep": "", "spec.json": "{}\n" })
	return root
}

/* a registerHooks that records each register and deregister in `events` */
function recording(events: string[]): RegisterHooks {
	return () => {
		events.push("register")
		return { deregister: () => void events.push("deregister") }
	}
}

describe("readRelease on an old Node", () => {
	it.each(["22.17.0", "23.5.0"])(
		"refuses a .ts config on Node %s, naming the version it needs",
		async (nodeVersion) => {
			const root = await acme()
			const importModule = async () => ({ default: CONFIG })
			await expect(
				readRelease(configOf(root), { importModule, runtime: { nodeVersion, runtime: "node" } }),
			).rejects.toThrow(`needs Node >= 22.18 (23.6 on Node 23; this is ${nodeVersion}); run honey-clients with Bun`)
		},
	)

	it("refuses a .mts config on an old Node too, and takes a .mjs one there", async () => {
		const root = await acme()
		writeAll(root, { "acme-release/release.config.mts": "", "acme-release/release.config.mjs": "" })
		const options = {
			importModule: async () => ({ default: CONFIG }),
			registerHooks: recording([]),
			runtime: { nodeVersion: "22.17.0", runtime: "node" } as const,
		}

		await expect(readRelease(join(root, "acme-release/release.config.mts"), options)).rejects.toThrow(
			/needs Node >= 22\.18/,
		)
		await expect(readRelease(join(root, "acme-release/release.config.mjs"), options)).resolves.toMatchObject({
			project: "acme",
		})
	})
})

describe("readRelease on Node, importing", () => {
	it("holds the self-resolve hook for the import alone, also when the import throws", async () => {
		const root = await acme()
		const events: string[] = []
		const importing = (fail: boolean) => async () => {
			events.push("import")
			if (fail) throw new Error("boom")
			return { default: CONFIG }
		}
		const registerHooks = recording(events)

		await readRelease(configOf(root), { importModule: importing(false), registerHooks, runtime: NODE })
		await expect(
			readRelease(configOf(root), { importModule: importing(true), registerHooks, runtime: NODE }),
		).rejects.toThrow(/failed to load .*release\.config\.ts: boom/)

		expect(events).toEqual(["register", "import", "deregister", "register", "import", "deregister"])
	})

	it("names the config when its import throws something that is no Error", async () => {
		const root = await acme()
		const importModule = async () => Promise.reject("a string")

		await expect(
			readRelease(configOf(root), { importModule, registerHooks: recording([]), runtime: NODE }),
		).rejects.toThrow(/failed to load .*release\.config\.ts: a string/)
	})

	it("loads a real .ts config with the running process's own hook and entry", async () => {
		const release = await loadRelease(configOf(await acme()))

		expect(release.packages.map((pkg) => pkg.path)).toEqual(["acme-release/sdk"])
	})
})

describe("readRelease on Bun", () => {
	it("maps the release specifier to the running package before importing the config", async () => {
		const root = await acme()
		const order: string[] = []
		const modules = new Map<string, () => unknown>()
		const bun: BunLike = {
			plugin(plugin) {
				order.push(`plugin:${plugin.name}`)
				const build: BunBuild = { module: (specifier, load) => void modules.set(specifier, load) }
				void plugin.setup(build)
			},
		}
		const self = { defineRelease: (config: unknown) => config }

		const release = await readRelease(configOf(root), {
			importModule: async (url) => {
				order.push(url)
				return url === "file:///self/index.js" ? self : { default: CONFIG }
			},
			runtime: { bun, nodeVersion: "22.0.0", runtime: "bun" },
			selfUrl: "file:///self/index.js",
		})

		expect(order).toEqual([
			"file:///self/index.js",
			`plugin:self:${RELEASE_SPECIFIER}`,
			pathToFileURL(realpathSync(configOf(root))).href,
		])
		expect(modules.get(RELEASE_SPECIFIER)?.()).toEqual({ exports: self, loader: "object" })
		expect(release.project).toBe("acme")
	})
})

/* The real runtimes against the source, from a repo outside any install: v8 cannot see these. */
const TS_CONFIG = `import { defineRelease } from "${RELEASE_SPECIFIER}"

export default defineRelease(${JSON.stringify(CONFIG)})
`

const driver = (config: string) => `
	import { loadRelease } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "index.ts")).href)}
	try {
		const release = await loadRelease(${JSON.stringify(config)})
		console.log(JSON.stringify({ paths: release.packages.map((pkg) => pkg.path), project: release.project }))
	} catch (error) {
		console.log(JSON.stringify({ error: error.message }))
	}
`

describe("loadRelease in a real runtime, against the source", () => {
	it.each([
		["node", ["node"]],
		["bun --bun", ["bun", "--bun"]],
	] as const)(
		"loads a .ts config importing the release subpath under %s",
		async (_name, command) => {
			const root = await acme(TS_CONFIG)
			writeAll(root, { ".driver/driver.mjs": driver(configOf(root)) })
			const [bin, ...args] = command

			const result = spawnSync(bin, [...args, join(root, ".driver/driver.mjs")], { cwd: root, encoding: "utf8" })

			expect(result.status, result.stderr).toBe(0)
			expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")).toEqual({
				paths: ["acme-release/sdk"],
				project: "acme",
			})
		},
		SPAWN_TIMEOUT,
	)
})
