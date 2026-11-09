/* The repo-relative path a rule decides by: the file's path below the nearest directory holding .oxlintrc.json (the
 * repo root, or a lint fixture's root), or undefined outside one. Each directory is looked up once per lint run. */
import { existsSync } from "node:fs"
import { dirname, join, relative } from "node:path"

const roots = new Map()

/** Whether `dir` holds the oxlint config, cached. */
function isRoot(dir) {
	if (!roots.has(dir)) roots.set(dir, existsSync(join(dir, ".oxlintrc.json")))
	return roots.get(dir)
}

/** `filename` relative to its repo root, with forward slashes; undefined when no root is above it. */
export function repoPath(filename) {
	const file = String(filename).replaceAll("\\", "/")
	for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir))
		if (isRoot(dir)) return relative(dir, file).replaceAll("\\", "/")
	return undefined
}

/** Whether `filename` is product source: under src/ and not a test. */
export function inSource(filename) {
	const path = repoPath(filename)
	return path !== undefined && path.startsWith("src/") && !/\.test\.[cm]?[jt]sx?$/.test(path)
}
