/**
 * clients serves nothing on a backend runtime: no `.ts` under src/, tests/ or scripts/ imports a backend subpath
 * that is a Node or Bun server or one of their long-lived workers. The reference app runs on workerd and the OAuth
 * world on Bun's own server, so backend can delete these subpaths (and `./ws/session`, which turns internal)
 * without reddening this repo.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../../src/gen/__fixtures__/spawn-timeout.ts"

const ROOT = resolve(import.meta.dirname, "../..")
const SELF = "tests/structure/no-backend-runtime.test.ts"
const CODE = /^(?:src|tests|scripts)\/.*\.ts$/
/* a module specifier, quoted: prose that names a subpath is not an import */
const RUNTIME = /["']@workerstack\/backend\/(?:bun|node|ws\/bun|ws\/node|queue\/serve|cron\/serve|ws\/session)["']/

/** `<file>:<line> imports <subpath>: …` for each backend runtime import in `source`. */
function runtimeImports(file: string, source: string): string[] {
	return source.split("\n").flatMap((line, i) => {
		const subpath = RUNTIME.exec(line)?.[0].slice(1, -1)
		return subpath === undefined ? [] : [`${file}:${i + 1} imports ${subpath}: serve on workerd or Bun's own server`]
	})
}

/** Every `.ts` under src, tests and scripts that git tracks or would add, but this guard. */
function files(): string[] {
	const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], {
		cwd: ROOT,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	})
	return out.split("\0").filter((file) => CODE.test(file) && file !== SELF && existsSync(join(ROOT, file)))
}

describe("clients imports no backend runtime subpath", () => {
	it("flags a file that imports one", () => {
		const source = 'import { serve } from "@workerstack/backend/bun"\nimport { honey } from "@workerstack/backend"\n'
		expect(runtimeImports("app.ts", source)).toEqual([
			"app.ts:1 imports @workerstack/backend/bun: serve on workerd or Bun's own server",
		])
		expect(runtimeImports("app.ts", 'import { workersWebSocket } from "@workerstack/backend/ws/workers"\n')).toEqual([])
	})

	it("imports no backend runtime subpath", { timeout: SPAWN_TIMEOUT }, () => {
		expect(files().flatMap((file) => runtimeImports(file, readFileSync(join(ROOT, file), "utf8")))).toEqual([])
	})
})
