/* The package's import boundaries (00-rules "Environments", as honey-clients keeps them): src/ is build-time Node code,
 * so node builtins and Node globals are fine; an import never leaves src/; ts-morph stays in extract/, the one place
 * that walks an app's types; and @workerstack/backend is read through its public subpaths, never its src/ or dist/. */
import { inSource, repoPath } from "./repo-path.js"

const MESSAGES = {
	escape: "an import stays inside its package's src (no repo path outside it, no sibling package)",
	internal: "honey-clients reads @workerstack/backend through public subpaths only",
	tsMorph: "ts-morph is for honey-clients's extract/ only",
}

/** The src-relative path of a non-test file under src/, else null. */
function locate(filename) {
	return inSource(filename) ? repoPath(filename).slice("src/".length) : null
}

/** Whether `spec`, imported from the src-relative `rel`, climbs out of src/. */
function escapes(rel, spec) {
	const parts = rel.split("/").slice(0, -1)
	for (const part of spec.split("/")) {
		if (part === "" || part === ".") continue
		if (part !== "..") parts.push(part)
		else if (parts.pop() === undefined) return true
	}
	return false
}

function problemOf(rel, spec) {
	if (spec.startsWith(".")) return escapes(rel, spec) ? "escape" : null
	if (spec === "ts-morph") return rel.startsWith("extract/") ? null : "tsMorph"
	if (spec.startsWith("@workerstack/backend/") && /\/(?:src|dist)\//.test(`${spec}/`)) return "internal"
	return null
}

export const rule = {
	create(context) {
		const rel = locate(context.filename)
		if (rel === null) return {}
		const checkSource = (node) => {
			const spec = node.source?.type === "Literal" ? node.source.value : null
			if (typeof spec !== "string") return
			const problem = problemOf(rel, spec)
			if (problem !== null) context.report({ message: MESSAGES[problem], node })
		}
		return {
			ExportAllDeclaration: checkSource,
			ExportNamedDeclaration: checkSource,
			ImportDeclaration: checkSource,
			ImportExpression: checkSource,
		}
	},
}

export default {
	meta: { name: "honey" },
	rules: { boundaries: rule },
}
