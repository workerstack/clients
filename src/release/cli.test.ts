import { spawnSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { main } from "../cli.ts"
import { usage } from "../gen/args.ts"
import { SPAWN_TIMEOUT } from "../gen/__fixtures__/spawn-timeout.ts"
import { configOf, gitRepo, removeRepos, writeAll } from "./__fixtures__/release-repo.ts"
import { release, USAGE } from "./cli.ts"

afterEach(removeRepos)

const BIN = resolve(import.meta.dirname, "../../bin/clients.js")

const CONFIG = {
	codegen: ["node", "codegen.mjs"],
	homepage: "https://example.com",
	packages: [{ commitMessage: "c", description: "d", name: "sdk", repo: "acme/sdk", topics: ["acme"] }],
	project: "acme",
	spec: { committedPath: "spec.json", deployedUrl: "https://api.example.com/spec.json" },
}

/* acme's repo with its release config holding `config` */
async function acme(config: unknown = CONFIG): Promise<string> {
	const root = await gitRepo("release-cli-")
	writeAll(root, {
		"acme-release/release.config.ts": `export default ${JSON.stringify(config)}\n`,
		"acme-release/sdk/.keep": "",
		"spec.json": "{}\n",
	})
	return root
}

/* `run(argv, io)`'s exit code and output */
async function captured(
	run: (io: { err: (text: string) => void; out: (text: string) => void }) => Promise<number>,
): Promise<{ status: number; stdout: string; stderr: string }> {
	let [stdout, stderr] = ["", ""]
	const status = await run({ err: (text) => void (stderr += text), out: (text) => void (stdout += text) })
	return { status, stderr, stdout }
}

describe("release --help", () => {
	it.each(["--help", "-h"])("prints the usage on stdout for %s and exits 0", async (flag) => {
		expect(await captured((io) => release([flag], io))).toEqual({ status: 0, stderr: "", stdout: USAGE })
	})

	it("lists codegen and toolchains with what each does", () => {
		expect(USAGE).toContain(
			"  codegen --config <path>\n      run the config's codegen from the repo root, as bump does before it decides\n",
		)
		expect(USAGE).toContain(
			"  toolchains --config <path>\n      print the config's toolchains, one per line: the system.config.ts names its codegen needs\n",
		)
	})
})

describe("release --config", () => {
	it.each(["bump", "sync", "bootstrap", "codegen", "toolchains"])(
		"is required by %s, which says so naming itself",
		async (command) => {
			const result = await captured((io) => release([command, ...(command === "bootstrap" ? ["--all"] : [])], io))

			expect(result).toEqual({
				status: 1,
				stderr: `clients: release ${command}: --config <path> is required\n`,
				stdout: "",
			})
		},
	)

	it("names a value flag given no value as bootstrap's usage mistake", async () => {
		const result = await captured((io) => release(["bootstrap", "--config"], io))

		expect(result.stderr).toBe("clients: release bootstrap: --config requires a value\n")
	})

	it("prints a config that cannot load as its own message, with no usage prefix", async () => {
		const result = await captured((io) => release(["sync", "--config", "nope.ts", "--validate-only"], io))

		expect(result.stderr).toBe("clients: nope.ts: no such release config\n")
		expect(result.status).toBe(1)
	})

	it("names the config and the project when the config names none", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await acme({ ...CONFIG, project: undefined })

		const result = await captured((io) => release(["sync", "--config", configOf(root), "--validate-only"], io))

		expect(result.stderr).toBe("clients: acme-release/release.config.ts: project: expected a slug, got undefined\n")
	})

	it("prints a thrown value that is no Error as itself", async () => {
		const env = new Proxy({}, { get: () => raise("env unreadable") })

		const result = await captured((io) => release(["sync", "--config", "c.ts"], io, { env }))

		expect(result).toMatchObject({ status: 1, stderr: "clients: env unreadable\n" })
	})
})

describe("release toolchains", () => {
	it.each([
		[["rust", "uv", "ruff", "go"], "rust\nuv\nruff\ngo\n"],
		[undefined, ""],
	])("prints %j one name per line", { timeout: SPAWN_TIMEOUT }, async (toolchains, stdout) => {
		const root = await acme({ ...CONFIG, ...(toolchains === undefined ? {} : { toolchains }) })

		expect(await captured((io) => release(["toolchains", "--config", configOf(root)], io))).toEqual({
			status: 0,
			stderr: "",
			stdout,
		})
	})

	it.each(["codegen", "toolchains"])("prints only its own usage for %s --help", async (command) => {
		for (const flag of ["--help", "-h"]) {
			const result = await captured((io) => release([command, flag], io))

			expect(result.status).toBe(0)
			expect(result.stdout).toMatch(new RegExp(`^usage: clients release ${command} --config <path>\\n {6}\\S`))
		}
	})

	it("names a --config given no value and an unknown flag as its usage mistakes", async () => {
		expect((await captured((io) => release(["toolchains", "--config"], io))).stderr).toBe(
			"clients: release toolchains: --config requires a value\n",
		)
		expect((await captured((io) => release(["toolchains", "--config", "--help"], io))).stderr).toBe(
			"clients: release toolchains: --config requires a value\n",
		)
		expect((await captured((io) => release(["toolchains", "--only", "x"], io))).stderr).toBe(
			"clients: release toolchains: unknown flag: --only\n",
		)
	})
})

describe("release codegen", () => {
	it("runs the config's codegen from the repo root and exits 0", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await acme()
		writeAll(root, { "codegen.mjs": 'import { writeFileSync } from "node:fs"\nwriteFileSync("ran", process.cwd())\n' })

		const result = await captured((io) => release(["codegen", "--config", configOf(root)], io))

		expect(result).toEqual({ status: 0, stderr: "", stdout: "" })
		expect(readFileSync(join(root, "ran"), "utf8")).toBe(realpathSync(root))
	})

	it("exits 1 naming the codegen when it fails", { timeout: SPAWN_TIMEOUT }, async () => {
		const root = await acme({ ...CONFIG, codegen: ["node", "fail.mjs"] })
		writeAll(root, { "fail.mjs": "process.exit(1)\n" })

		expect(await captured((io) => release(["codegen", "--config", configOf(root)], io))).toEqual({
			status: 1,
			stderr: "clients: codegen (node fail.mjs) exited 1\n",
			stdout: "",
		})
	})
})

/* throws `value` as it is, no Error around it */
function raise(value: string): never {
	throw value
}

describe("clients main", () => {
	it(
		"is what main runs for `release`, and the main usage names it",
		async () => {
			const result = await captured((io) => main(["release"], io))

			expect(result).toEqual({ status: 1, stderr: USAGE, stdout: "" })
			expect(usage()).toContain("release bump|sync|bootstrap|codegen|toolchains --config <path>")
		},
		SPAWN_TIMEOUT,
	)
})

describe("clients release from the bin", () => {
	it.each([
		[
			"sync validates a config",
			(cfg: string) => ["sync", "--config", cfg, "--validate-only"],
			0,
			/Manifests valid: 1 package\(s\)/,
		],
		["bump wants its config", () => ["bump"], 1, /release bump: --config <path> is required/],
		["bootstrap wants a target", (cfg: string) => ["bootstrap", "--config", cfg], 1, /--all \| --only <names>/],
	] as const)(
		"runs from the bin on Node: %s",
		async (_name, args, status, said) => {
			const cfg = configOf(await acme())

			const result = spawnSync("node", [BIN, "release", ...args(cfg)], { encoding: "utf8" })

			expect({ said: `${result.stdout}${result.stderr}`, status: result.status }).toEqual({
				said: expect.stringMatching(said),
				status,
			})
		},
		SPAWN_TIMEOUT,
	)
})
