/**
 * gen stands alone (roadmap 5 slice 4): no file of this package reaches packages/core by path, so the package works
 * the same in its own repo (github.com/workerstack/clients), with backend from npm. backend is
 * reached by its package name, `@workerstack/backend`, and its published exports only.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../../src/gen/__fixtures__/spawn-timeout.ts"

const GEN = resolve(import.meta.dirname, "../..")
const SELF = "tests/structure/no-core-path.test.ts"
/* the boundaries rule's test spells an escape into a sibling package on purpose, as the input it must refuse */
const TOOLING = ["lint/boundaries.test.ts"]
/* the package's code; the blueprint and the lessons are history and name the old layout */
const CODE = /^(?:src|tests|scripts|lint|bin)\//
/* `packages/core`, or a relative step into the sibling: `../core`, `../../core/src`, `resolve(GEN, "../core")` */
const CROSSING = /packages\/core\b|\.\.\/core\b/

/** Every file under gen that git tracks or would add, package-relative, but this guard. */
function files(): string[] {
	const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], {
		cwd: GEN,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	})
	return out.split("\0").filter((file) => CODE.test(file) && file !== SELF && !TOOLING.includes(file))
}

/** `<file>:<line> reaches packages/core by path: …` for each crossing in `file`. */
function crossings(file: string): string[] {
	const path = join(GEN, file)
	if (!existsSync(path)) return []
	const bytes = readFileSync(path)
	if (bytes.includes(0)) return []
	return bytes
		.toString("utf8")
		.split("\n")
		.flatMap((line, i) =>
			CROSSING.test(line)
				? [`${file}:${i + 1} reaches packages/core by path: import @workerstack/backend by name`]
				: [],
		)
}

describe("gen reaches backend by package name only (roadmap 5 slice 4)", () => {
	it("no file under packages/gen names packages/core or steps into ../core", { timeout: SPAWN_TIMEOUT }, () => {
		expect(files().flatMap(crossings)).toEqual([])
	})
})
