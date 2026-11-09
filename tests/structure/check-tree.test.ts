/* copied from @workerstack/backend's tests/structure/check-tree.test.ts, for this repo's one package (roadmap 5 D7) */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../../src/gen/__fixtures__/spawn-timeout.ts"
import { checkTree, COMPLETE, parseRows } from "./check-tree.ts"

const REPO = resolve(import.meta.dirname, "../..")

const TSV = [
	"# a comment",
	"path\tpkg\tkind\tbit\tnote\tsplit",
	"src/emit/go/sdk.ts\tgen\tsrc\t12\tthe Go SDK\t—",
	"src/runtime/go/*\tgen\tcorpus\t12\tthe Go runtime\t—",
	"src/ir/build.ts\tgen\tsrc\t01\tthe IR\t—",
	"src/ir/model.ts\tgen\ttypes\t01\tthe IR types\t—",
	"lint/index.js\tgen\tindex\t00\tthe plugin entry\t—",
	"tests/structure/check-tree.test.ts\tgen\ttest\t00\tthis\t—",
	"./README.md\tgen\tdoc\t00\tthe README\t—",
	"",
].join("\n")
const rows = parseRows(TSV)
const BIT_00_FILES = ["lint/index.js", "tests/structure/check-tree.test.ts", "README.md"]

describe("parseRows", () => {
	it("reads data rows, skipping comments, the header and blank lines; ./ names the repo root", () => {
		expect(rows.map((row) => row.path)).toEqual([
			"src/emit/go/sdk.ts",
			"src/runtime/go/*",
			"src/ir/build.ts",
			"src/ir/model.ts",
			"lint/index.js",
			"tests/structure/check-tree.test.ts",
			"README.md",
		])
	})
})

describe("checkTree", () => {
	it("passes when exactly the bit-00 rows exist", () => {
		expect(checkTree(rows, BIT_00_FILES, 0)).toEqual([])
	})

	it("reports a file in scope that no row lists, and ignores files outside the checked roots", () => {
		const files = [...BIT_00_FILES, "src/ir/stray.ts", "tests/x.test.ts", "docs/client.md", "package.json"]
		expect(checkTree(rows, files, 0)).toEqual(["unlisted: src/ir/stray.ts", "unlisted: tests/x.test.ts"])
	})

	it("reports a file born before its bit", () => {
		const files = [...BIT_00_FILES, "src/emit/go/sdk.ts", "src/runtime/go/client.go"]
		expect(checkTree(rows, files, 0)).toEqual([
			"early: src/emit/go/sdk.ts (bit 12, complete 00)",
			"early: src/runtime/go/client.go (bit 12, complete 00)",
		])
	})

	it("needs a colocated test for each src row once its bit has run", () => {
		const files = [...BIT_00_FILES, "src/ir/build.ts", "src/ir/model.ts"]
		expect(checkTree(rows, files, 1)).toEqual(["missing test: src/ir/build.test.ts (bit 01)"])
		expect(checkTree(rows, [...files, "src/ir/build.test.ts"], 1)).toEqual([])
	})
})

describe("the repository", () => {
	it(`matches files.tsv up to bit ${String(COMPLETE).padStart(2, "0")}`, { timeout: SPAWN_TIMEOUT }, () => {
		const tsv = readFileSync(join(REPO, "blueprint/files.tsv"), "utf8")
		const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
			cwd: REPO,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		})
			.split("\0")
			.filter((f) => f !== "")
		expect(checkTree(parseRows(tsv), files, COMPLETE)).toEqual([])
	})
})
