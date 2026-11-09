import { repoPath } from "./repo-path.js"
/* The logger is the one console owner (00-rules "Gates"): every other line logs through it, so the level check, the
 * redaction and the sink choice live in one place. Tests were excluded at bit 00 without a recorded reason; a stray
 * log landed in source.test (caa906b); scope widened at bit 20 to every file under src/, tests/ and lint/: tests, fixtures and
 * helpers alike. A console call inside a string a test spawns is no
 * member expression and stays allowed. */
/* The scripts whose stdout is their protocol, each by exact path with its reason; any other file is fixed instead. */
export const PROTOCOL = new Map([["tests/integration/conformance/gate.ts", "a CLI gate: its verdict is its output"]])

function inScope(filename) {
	const path = repoPath(filename)
	return path !== undefined && /^(?:src|tests|lint)\//.test(path) && !PROTOCOL.has(path)
}

export const rule = {
	create(context) {
		if (!inScope(context.filename)) return {}
		return {
			MemberExpression(node) {
				if (node.object.type !== "Identifier" || node.object.name !== "console") return
				context.report({
					message: "console is for no source or test here: write through the io a command is handed",
					node,
				})
			},
		}
	},
}

export default {
	meta: { name: "honey" },
	rules: { "no-console": rule },
}
