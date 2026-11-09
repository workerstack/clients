import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
	ADDED,
	bumped,
	OPENAPI,
	PUBLIC,
	SDK,
	succeeded,
	TIMEOUT_MS,
	useBumpProject,
} from "./__fixtures__/bump-project.ts"
import { parseBumpArgs } from "./bump-args.ts"
import { CHANGELOG_HEADER, prependEntry, readPrevious } from "./bump-command.ts"
import { release, USAGE } from "./cli.ts"

const STATE = {
	hand: "c".repeat(64),
	output: "d".repeat(64),
	publishedAt: "2026-04-20T12:00:00Z",
	spec: { commit: "1".repeat(40), path: "spec.json", sha: "a".repeat(64) },
	version: "1.2.3",
}

describe("parseBumpArgs", () => {
	it("reads the config", () => {
		expect(parseBumpArgs(["--config", "acme-release/release.config.ts"])).toEqual({
			ok: true,
			value: { config: "acme-release/release.config.ts", major: false },
		})
	})

	it("reads --major on either side of the config", () => {
		const expected = { ok: true, value: { config: "r.ts", major: true } }
		expect(parseBumpArgs(["--config", "r.ts", "--major"])).toEqual(expected)
		expect(parseBumpArgs(["--major", "--config", "r.ts"])).toEqual(expected)
	})

	it("never takes --major as the config's value", () => {
		expect(parseBumpArgs(["--config", "--major"]).ok).toBe(false)
	})

	it("rejects a missing config", () => {
		expect(parseBumpArgs([])).toEqual({ error: "--config <path> is required", ok: false })
		expect(parseBumpArgs(["--config"]).ok).toBe(false)
	})

	it("names a flag it no longer takes rather than ignoring it", () => {
		expect(parseBumpArgs(["--config", "r.ts", "--spec", "s"])).toEqual({
			error: "unknown flag: --spec",
			ok: false,
		})
		expect(parseBumpArgs(["--all"])).toEqual({ error: "unknown flag: --all", ok: false })
	})
})

describe("prependEntry", () => {
	it("writes the header and the entry into an empty changelog, ending on the entry's last line", () => {
		expect(prependEntry("", "## 1.0.0\n\n- first\n")).toBe(`${CHANGELOG_HEADER}## 1.0.0\n\n- first\n`)
	})

	it("separates a new entry from the previous one by one blank line", () => {
		expect(prependEntry(`${CHANGELOG_HEADER}## 1.0.0\n\n- first\n`, "## 1.1.0\n\n- second\n")).toBe(
			`${CHANGELOG_HEADER}## 1.1.0\n\n- second\n\n## 1.0.0\n\n- first\n`,
		)
	})

	it("puts a new entry above the previous ones, under a single header", () => {
		const next = prependEntry(`${CHANGELOG_HEADER}## 1.0.0\n\n- first\n`, "## 1.1.0\n\n- second\n")

		expect(next.indexOf("## 1.1.0")).toBeLessThan(next.indexOf("## 1.0.0"))
		expect(next.match(/# Changelog/g)).toHaveLength(1)
	})

	it("keeps a changelog that has no header intact below the new entry", () => {
		const next = prependEntry("## 0.9.0\n\n- old\n", "## 1.0.0\n\n- new\n")

		expect(next.startsWith(CHANGELOG_HEADER)).toBe(true)
		expect(next).toContain("## 0.9.0")
	})
})

describe("readPrevious", () => {
	let dir = ""
	beforeEach(async () => void (dir = await fs.mkdtemp(path.join(os.tmpdir(), "oss-state-"))))
	afterEach(() => fs.rm(dir, { force: true, recursive: true }))

	async function write(content: string): Promise<string> {
		const file = path.join(dir, "state.json")
		await fs.writeFile(file, content, "utf8")
		return file
	}

	it("returns undefined when no state file exists yet", async () => {
		expect(await readPrevious(path.join(dir, "missing.json"))).toBeUndefined()
	})

	it("parses a valid state file", async () => {
		expect(await readPrevious(await write(JSON.stringify(STATE)))).toEqual(STATE)
	})

	it("throws on a state file that does not match the schema", async () => {
		await expect(readPrevious(await write(JSON.stringify({ version: 1 })))).rejects.toThrow(
			/expected string, received number/,
		)
	})

	it("throws when the state path cannot be read, rather than treating it as a first release", async () => {
		await expect(readPrevious(dir)).rejects.toThrow(/EISDIR/)
	})

	it("throws on unparseable JSON rather than treating it as a first release", async () => {
		await expect(readPrevious(await write("{ not json"))).rejects.toThrow(SyntaxError)
	})
})

/* release's output, captured */
async function run(argv: readonly string[]): Promise<{ status: number; stdout: string; stderr: string }> {
	let [stdout, stderr] = ["", ""]
	const status = await release(argv, {
		err: (text) => void (stderr += text),
		out: (text) => void (stdout += text),
	})
	return { status, stderr, stdout }
}

describe("cli usage", () => {
	it("exits 1 with usage when given no subcommand", async () => {
		const result = await run([])

		expect(result.status).toBe(1)
		expect(result.stderr).toContain(USAGE.trim())
	})

	it("exits 1 with usage on an unknown subcommand", async () => {
		const result = await run(["publish"])

		expect(result.status).toBe(1)
		expect(result.stderr).toContain("usage:")
	})

	it("exits 1 naming an unknown flag", async () => {
		const result = await run(["bump", "--nope"])

		expect(result.status).toBe(1)
		expect(result.stderr).toContain("unknown flag: --nope")
	})
})

describe("bump --config releasing", () => {
	const acme = useBumpProject()

	it(
		"releases every package 1.0.0 first, at the version it generates, and the merged release finds nothing",
		async () => {
			const first = await acme.bump()

			succeeded(first)
			expect(bumped(first.stdout)).toEqual(["bumped: openapi 1.0.0 initial", "bumped: sdk 1.0.0 initial"])
			expect(first.stdout).toMatch(new RegExp(`^wrote: ${SDK}/gen\\.txt$`, "m"))
			expect(await acme.read(`${SDK}/gen.txt`)).toContain("version=1.0.0")
			expect(await acme.read(`${SDK}/package.json`)).toContain('"version": "1.0.0"')
			expect(await acme.read(`${SDK}/CHANGELOG.md`)).toContain("sdk first cut")
			expect((await acme.state(SDK)).spec).toEqual({
				commit: acme.git("rev-parse", "HEAD").trim(),
				path: "spec.json",
				sha: expect.stringMatching(/^[0-9a-f]{64}$/),
			})
			acme.commit("release")

			const second = await acme.bump()

			succeeded(second)
			expect(bumped(second.stdout)).toEqual([])
			expect(acme.git("status", "--porcelain")).toBe("")
		},
		TIMEOUT_MS,
	)

	it(
		"patches only the package whose hand files changed",
		async () => {
			await acme.released()
			await acme.write(`${SDK}/README.md`, "# readme, now longer\n")
			acme.commit("docs")

			const result = await acme.bump()

			succeeded(result)
			expect(bumped(result.stdout)).toEqual(["bumped: sdk 1.0.1 patch"])
			expect(await acme.read(`${SDK}/CHANGELOG.md`)).toContain("### Package")
		},
		TIMEOUT_MS,
	)
})

describe("bump --config under --major", () => {
	const acme = useBumpProject()

	it(
		"makes every releasing package a major under --major, and leaves an unchanged one alone",
		async () => {
			await acme.released()
			await acme.write(`${SDK}/README.md`, "# readme, now longer\n")
			acme.commit("docs")

			const result = await acme.bump("--major")

			succeeded(result)
			expect(bumped(result.stdout)).toEqual(["bumped: sdk 2.0.0 major"])
		},
		TIMEOUT_MS,
	)
})

describe("bump --config refusing", () => {
	const acme = useBumpProject()

	it(
		"refuses a spec that is not committed",
		async () => {
			await acme.write("spec.json", ADDED)

			const result = await acme.bump()

			expect(result.status).toBe(1)
			expect(result.stderr).toMatch(/commit the spec/)
			await expect(acme.read(`${SDK}/.release-state.json`)).rejects.toThrow(/ENOENT/)
		},
		TIMEOUT_MS,
	)

	it(
		"writes nothing for any package when generated output would release against a spec prod does not serve",
		async () => {
			acme.serve(ADDED)

			const result = await acme.bump()

			expect(result.status).toBe(1)
			expect(result.stderr).toContain("POST /v1/widgets")
			for (const pkg of [OPENAPI, SDK]) {
				await expect(acme.read(`${pkg}/.release-state.json`)).rejects.toThrow(/ENOENT/)
				expect(await acme.read(`${pkg}/package.json`)).toContain('"version": "0.1.0"')
			}
		},
		TIMEOUT_MS,
	)

	it(
		"writes nothing when a version file has no version line",
		async () => {
			await acme.write(`${SDK}/package.json`, '{\n\t"name": "@acme/sdk"\n}\n')
			acme.commit("break the version file")

			const result = await acme.bump()

			expect(result.status).toBe(1)
			expect(result.stderr).toContain("package.json")
			await expect(acme.read(`${SDK}/.release-state.json`)).rejects.toThrow(/ENOENT/)
			await expect(acme.read(`${SDK}/CHANGELOG.md`)).rejects.toThrow(/ENOENT/)
		},
		TIMEOUT_MS,
	)
})

describe("bump --config asking prod", () => {
	const acme = useBumpProject()

	it(
		"releases a hand-kept package's hand change without asking prod",
		async () => {
			await acme.released()
			acme.serve(ADDED)
			acme.resetRequests()
			await acme.write(`${OPENAPI}/README.md`, "# openapi, now longer\n")
			acme.commit("docs")

			const result = await acme.bump()

			succeeded(result)
			expect(bumped(result.stdout)).toEqual(["bumped: openapi 1.0.1 patch"])
			expect(acme.requests()).toBe(0)
		},
		TIMEOUT_MS,
	)
})

describe("bump --config on a broken codegen or changelog", () => {
	const acme = useBumpProject()

	it(
		"says the codegen could not start, naming why",
		async () => {
			const config = await acme.read(`${PUBLIC}/release.config.ts`)
			await acme.write(`${PUBLIC}/release.config.ts`, config.replace('["node","codegen.mjs"]', '["no-such-codegen"]'))
			acme.commit("break the codegen")

			const result = await acme.bump()

			expect(result.status).toBe(1)
			expect(result.stderr).toMatch(/codegen could not start: .*ENOENT/)
		},
		TIMEOUT_MS,
	)

	it(
		"fails naming why when a changelog cannot be read",
		async () => {
			await acme.write(`${SDK}/CHANGELOG.md/.keep`, "")
			acme.commit("a dir where the changelog goes")

			const result = await acme.bump()

			expect(result.status).toBe(1)
			expect(result.stderr).toMatch(/EISDIR/)
		},
		TIMEOUT_MS,
	)
})

describe("bump --config on a spec it cannot trust", () => {
	const acme = useBumpProject()

	it(
		"refuses a spec HEAD does not hold at all",
		async () => {
			acme.git("rm", "--cached", "--quiet", "spec.json")
			acme.git("commit", "--quiet", "-m", "untrack the spec")

			const result = await acme.bump()

			expect(result.status).toBe(1)
			expect(result.stderr).toContain("spec.json differs from HEAD: commit the spec first")
		},
		TIMEOUT_MS,
	)

	it(
		"refuses a release state whose recorded spec is not the one at its commit",
		async () => {
			await acme.released()
			const state = await acme.state(SDK)
			await acme.write(
				`${SDK}/.release-state.json`,
				`${JSON.stringify({ ...state, spec: { ...state.spec, sha: "0".repeat(64) } })}\n`,
			)
			await acme.write("spec.json", ADDED)
			acme.commit("tamper with the record, then move the spec")

			const result = await acme.bump()

			expect(result.status).toBe(1)
			expect(result.stderr).toMatch(/:spec\.json is not the spec the release recorded \(0{64}\)/)
		},
		TIMEOUT_MS,
	)
})
