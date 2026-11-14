/**
 * The release fixture runs this checkout as a consumer would. release-fixture.yml's bump job on main finds no change
 * only while every package's `.release-state.json` holds the hand digest of the files beside it; a file edited there
 * without the local bump the fixture's README asks for would otherwise open a real release PR. And the reusable
 * release workflows reach clients through their `cli` input: a consumer's installed bin by default, while this
 * repo, whose root package bun never links into its own node_modules/.bin, passes the checkout's bin.
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { load } from "js-yaml"
import { describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../../src/gen/__fixtures__/spawn-timeout.ts"
import { handDigest } from "../../src/release/digest.ts"
import { loadRelease } from "../../src/release/load.ts"
import { releaseStateSchema } from "../../src/release/release-state.ts"

const ROOT = resolve(import.meta.dirname, "../..")
const CONFIG = ".github/release-fixture/release.config.ts"
const REUSABLE = ["release-validate", "release-sync", "release-bump"]
const DEFAULT_CLI = "bun x --no-install clients"

type Step = { run?: string }
type Workflow = {
	on: { workflow_call?: { inputs?: Record<string, { default?: unknown; type?: string; required?: boolean }> } }
	jobs: Record<string, { steps?: Step[]; uses?: string; with?: Record<string, unknown> }>
}

const workflow = (name: string) =>
	load(readFileSync(join(ROOT, ".github/workflows", `${name}.yml`), "utf8")) as Workflow

describe("the release fixture", () => {
	it("records the hand digest of each package as committed", { timeout: SPAWN_TIMEOUT }, async () => {
		const release = await loadRelease(join(ROOT, CONFIG))
		expect(release.packages.length).toBeGreaterThan(0)
		for (const pkg of release.packages) {
			const state = releaseStateSchema().parse(
				JSON.parse(readFileSync(join(release.root, pkg.path, ".release-state.json"), "utf8")),
			)
			expect({ [pkg.path]: state.hand }).toEqual({ [pkg.path]: handDigest(release.root, pkg) })
		}
	})

	it("reaches clients in every reusable release workflow only through its cli input", () => {
		for (const name of REUSABLE) {
			const parsed = workflow(name)
			expect({ name, cli: parsed.on.workflow_call?.inputs?.cli }).toEqual({
				name,
				cli: expect.objectContaining({ default: DEFAULT_CLI, required: false, type: "string" }),
			})
			const runs = Object.values(parsed.jobs).flatMap((job) => (job.steps ?? []).flatMap((step) => step.run ?? []))
			const direct = runs.filter((run) => run.includes("clients"))
			expect({ name, direct }).toEqual({ name, direct: [] })
			expect(runs.some((run) => run.includes('"${cli[@]}" release'))).toBe(true)
		}
	})

	it("passes every reusable release workflow a cli that runs this checkout's bin", { timeout: SPAWN_TIMEOUT }, () => {
		const fixture = workflow("release-fixture")
		const calls = Object.values(fixture.jobs).filter((job) => job.uses !== undefined)
		expect(calls.map((job) => job.uses).toSorted()).toEqual(
			REUSABLE.map((name) => `./.github/workflows/${name}.yml`).toSorted(),
		)
		const clis = new Set(calls.map((job) => job.with?.cli))
		expect([...clis]).toEqual(["node bin/clients.js"])
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { bin: Record<string, string> }
		expect(pkg.bin["clients"]).toBe("bin/clients.js")
		const [command = "", ...args] = String([...clis][0]).split(" ")
		const ran = spawnSync(command, [...args, "release", "toolchains", "--config", CONFIG], {
			cwd: ROOT,
			encoding: "utf8",
			timeout: SPAWN_TIMEOUT,
		})
		expect({ status: ran.status, stderr: ran.stderr }).toEqual({ status: 0, stderr: "" })
		expect(ran.stdout.trim().split("\n")).toEqual(["go", "rust", "uv", "ruff"])
	})
})
