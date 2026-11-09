/**
 * What a person reads when `.output()` refuses a key: tsc, run on one fixture per refusal, names the key and what to do
 * instead in the diagnostic, never a bare `never`. TypeScript 7 ships no compiler API, so this spawns its `tsc` as
 * tests/docs/examples-compile.test.ts does.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../fixture/spawn-timeout.ts"

const CORE = join(import.meta.dirname, "../..")
const TSC = join(CORE, "../../node_modules/typescript/bin/tsc")

/* inside core, so `@workerstack/backend` resolves through the workspace link with core's honey-source condition */
mkdirSync(join(CORE, ".tmp"), { recursive: true })
const scratch = mkdtempSync(join(CORE, ".tmp/output-messages-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

/** Each refusal: the `.output()` argument a person writes, and the message tsc must show them, as tsc prints it. */
const REFUSALS = [
	["{ not_found: row }", '"not_found is an error status: declare it with .errors(), not .output()"'],
	['{ "text/csv": { found: true } }', '"found is a redirect: declare it under redirect"'],
	["{ ok: row, redirect: { not_found: true } }", '"not_found is no 3xx status"'],
	[
		'{ ok: row, headers: { not_found: z.object({ "x-a": z.string() }) } }',
		'"not_found is an error status: declare it with .errors(), not .output()"',
	],
	[
		'{ ok: row, "text/csv": { ok: z.string() } }',
		String.raw`"ok beside a media type: write JSON as \"application/json\": { ok: ... }"`,
	],
	["{ okay: row }", '"okay is no status key"'],
] as const

/** A module declaring one route with `output`. */
const fixture = (output: string) =>
	[
		'import { honey } from "@workerstack/backend"',
		'import * as z from "zod"',
		"const row = z.object({ x: z.string() })",
		`honey().get("/x").output(${output})`,
		"export {}",
		"",
	].join("\n")

/** tsc's diagnostics for each of `outputs`, its file's diagnostics joined with their elaboration lines. */
function diagnostics(outputs: readonly string[]): string[] {
	const files = outputs.map((output, index) => {
		writeFileSync(join(scratch, `f${index}.ts`), fixture(output))
		return `f${index}.ts`
	})
	const config = { extends: join(CORE, "tsconfig.json"), files, include: [] }
	writeFileSync(join(scratch, "tsconfig.json"), JSON.stringify(config))
	const out = spawnSync("node", [TSC, "-p", "tsconfig.json", "--pretty", "false"], {
		cwd: scratch,
		encoding: "utf8",
		timeout: SPAWN_TIMEOUT,
	}).stdout
	const byFile = outputs.map(() => "")
	let current = -1
	for (const line of out.split("\n")) {
		const head = /^f(\d+)\.ts\(/.exec(line)
		if (head) current = Number(head[1])
		if (current >= 0) byFile[current] += `${line}\n`
	}
	return byFile
}

describe(".output() refusals: a message where the key is written", () => {
	it(
		"names the key and its fix for an error status, a redirect, a non-3xx, error headers, a mix, a typo",
		() => {
			const found = diagnostics(REFUSALS.map(([output]) => output))
			expect(REFUSALS.map(([output, message], index) => [output, found[index]?.includes(message)])).toEqual(
				REFUSALS.map(([output]) => [output, true]),
			)
			expect(found.map((text) => text.includes("error TS2322"))).toEqual(REFUSALS.map(() => true))
		},
		SPAWN_TIMEOUT,
	)
})
