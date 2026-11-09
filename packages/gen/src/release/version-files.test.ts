import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { readVersions, VERSION_FILES, writeVersions } from "./version-files.ts"

const PACKAGE_JSON = `{
\t"dependencies": {
\t\t"zod": "4.6.7"
\t},
\t"name": "@acme/sdk",
\t"publishConfig": {
\t\t"version": "ignored"
\t},
\t"version": "1.0.0"
}
`

const JSR_JSON = `{
\t"exports": "./index.ts",
\t"name": "@acme/sdk",
\t"version": "1.0.0"
}
`

const PYPROJECT = `[project]
name = "acme"
version = "1.0.0"
dependencies = ["httpx>=0.27"]

[project.urls]
Homepage = "https://acme.ai"

[tool.bumpver]
version = "9.9.9"
`

const dirs: string[] = []

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

function packageDir(files: Record<string, string>): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "version-files-"))
	dirs.push(dir)
	for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text)
	return dir
}

describe("VERSION_FILES", () => {
	it("reads the top-level version of package.json and jsr.json, not a nested one", () => {
		expect(VERSION_FILES["package.json"].read(PACKAGE_JSON)).toBe("1.0.0")
		expect(VERSION_FILES["jsr.json"].read(JSR_JSON)).toBe("1.0.0")
	})

	it("writes only the top-level JSON version", () => {
		expect(VERSION_FILES["package.json"].write(PACKAGE_JSON, "1.2.0")).toBe(
			PACKAGE_JSON.replace('\t"version": "1.0.0"', '\t"version": "1.2.0"'),
		)
	})

	it("reads and writes [project] version, leaving [tool.*] versions alone", () => {
		const pyproject = VERSION_FILES["pyproject.toml"]
		expect(pyproject.read(PYPROJECT)).toBe("1.0.0")
		expect(pyproject.write(PYPROJECT, "2.0.0")).toBe(
			PYPROJECT.replace('name = "acme"\nversion = "1.0.0"', 'name = "acme"\nversion = "2.0.0"'),
		)
	})

	it("throws on a missing or doubled version line", () => {
		expect(() => VERSION_FILES["package.json"].read('{\n\t"name": "x"\n}\n')).toThrow(/version/)
		expect(() => VERSION_FILES["pyproject.toml"].read('[project]\nversion = "1"\nversion = "2"\n')).toThrow(/version/)
	})
})

describe("readVersions and writeVersions", () => {
	it("cover every version file present in the dir and nothing else", () => {
		const dir = packageDir({
			"README.md": "# sdk\n",
			"jsr.json": JSR_JSON,
			"package.json": PACKAGE_JSON,
		})

		expect(readVersions(dir)).toEqual({ "jsr.json": "1.0.0", "package.json": "1.0.0" })
		expect(
			writeVersions(dir, "1.0.1")
				.map((p) => path.basename(p))
				.sort(),
		).toEqual(["jsr.json", "package.json"])
		expect(readVersions(dir)).toEqual({ "jsr.json": "1.0.1", "package.json": "1.0.1" })
		expect(readFileSync(path.join(dir, "README.md"), "utf8")).toBe("# sdk\n")
	})

	it("names the file whose version line is missing", () => {
		const dir = packageDir({ "package.json": '{\n\t"name": "x"\n}\n' })

		expect(() => readVersions(dir)).toThrow(/package\.json/)
	})
})
