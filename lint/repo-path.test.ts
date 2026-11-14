import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { inSource, repoPath } from "./repo-path.js"

const REPO = resolve(import.meta.dirname, "..")
const fixture = mkdtempSync(join(tmpdir(), "clients-repo-path-"))
mkdirSync(join(fixture, "nested"), { recursive: true })
writeFileSync(join(fixture, "nested", ".oxlintrc.json"), "{}")
afterAll(() => rmSync(fixture, { force: true, recursive: true }))

describe("repoPath", () => {
	it("is the path below the nearest directory holding .oxlintrc.json", () => {
		expect([
			repoPath(join(REPO, "src/ir/build.ts")),
			repoPath(join(fixture, "nested/src/a.ts")),
			repoPath(join(fixture, "outside.ts")),
		]).toEqual(["src/ir/build.ts", "src/a.ts", undefined])
	})
})

describe("inSource", () => {
	it("is a non-test file under src/", () => {
		expect([
			inSource(join(REPO, "src/ir/build.ts")),
			inSource(join(REPO, "src/ir/build.test.ts")),
			inSource(join(REPO, "tests/structure/x.ts")),
			inSource(join(fixture, "outside/src/a.ts")),
		]).toEqual([true, false, false, false])
	})
})
