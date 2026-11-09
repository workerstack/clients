import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/*
 * Each registry publishes a package at the version its own manifest holds, so bump moves these files
 * with `.release-state.json`. Each is edited as text on its one version line, so the formatter's layout
 * survives.
 */

type VersionFile = {
	read(text: string): string
	write(text: string, version: string): string
}

/** A match whose group 1 always participates, as each pattern here is written. */
type Matched = RegExpExecArray & { 1: string }

/** The one match of `pattern` (whose group 1 always participates) in `text`, or a throw naming `what`. */
function only(text: string, pattern: RegExp, what: string): Matched {
	const matches = [...text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))]
	if (matches.length !== 1) {
		throw new Error(`expected one ${what}, found ${matches.length}`)
	}
	return matches[0] as Matched
}

function replaceAt(text: string, match: RegExpExecArray, replacement: string): string {
	return text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length)
}

/* The top-level `"version"` of a tab-indented JSON manifest. */
const JSON_VERSION = /^\t"version": "([^"]+)"/m
const json: VersionFile = {
	read: (text) => only(text, JSON_VERSION, 'top-level "version"')[1],
	write: (text, version) =>
		replaceAt(text, only(text, JSON_VERSION, 'top-level "version"'), `\t"version": "${version}"`),
}

/* The `version = "…"` line of the `[project]` table, which ends at the next table header. */
const PROJECT_TABLE = /^\[project\]\n((?:(?!\[).*\n?)*)/m
const TOML_VERSION = /^version = "([^"]+)"$/m
const pyproject: VersionFile = {
	read: (text) => {
		const table = only(text, PROJECT_TABLE, "[project] table")
		return only(table[1], TOML_VERSION, "[project] version")[1]
	},
	write: (text, version) => {
		const table = only(text, PROJECT_TABLE, "[project] table")
		const body = table[1]
		const line = only(body, TOML_VERSION, "[project] version")
		const newBody = replaceAt(body, line, `version = "${version}"`)
		return text.slice(0, table.index) + table[0].replace(body, newBody) + text.slice(table.index + table[0].length)
	},
}

/** The version files bump keeps in step with `.release-state.json`, by file name. */
export const VERSION_FILES = {
	"jsr.json": json,
	"package.json": json,
	"pyproject.toml": pyproject,
} as const satisfies Record<string, VersionFile>

export type VersionFileName = keyof typeof VERSION_FILES

const NAMES: readonly VersionFileName[] = ["jsr.json", "package.json", "pyproject.toml"]

/** Each version file present in `dir` with the version it holds; throws naming the file whose version line is missing or doubled. */
export function readVersions(dir: string): Partial<Record<VersionFileName, string>> {
	const versions: Partial<Record<VersionFileName, string>> = {}
	for (const name of NAMES) {
		const file = join(dir, name)
		if (!existsSync(file)) continue
		try {
			versions[name] = VERSION_FILES[name].read(readFileSync(file, "utf8"))
		} catch (error) {
			/* each read throws only `only`'s Error */
			throw new Error(`${file}: ${(error as Error).message}`, {
				cause: error,
			})
		}
	}
	return versions
}

/** Writes `version` into every version file present in `dir`; returns the paths written. */
export function writeVersions(dir: string, version: string): string[] {
	readVersions(dir)
	const written: string[] = []
	for (const name of NAMES) {
		const file = join(dir, name)
		if (!existsSync(file)) continue
		writeFileSync(file, VERSION_FILES[name].write(readFileSync(file, "utf8"), version))
		written.push(file)
	}
	return written
}
