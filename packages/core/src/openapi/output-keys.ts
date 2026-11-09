/**
 * What `KnownStatusKeys` refuses in the types, refused where an app is documented or its tree generated: an output
 * declaration whose outer key is no media type (`type/subtype`), `headers` or `redirect`, whose inner key names no
 * status, or names one its slot cannot answer: a body is a 2xx, `redirect` a 3xx, `headers` a 2xx or 3xx, and an
 * error answer is declared with `.errors()`. Every document keys an answer by its status's code, so such a key would
 * be documented under none, or as an answer the route never gives. It sits on the generation paths only
 * (collectRoutes, and the tree `honey generate` writes), never on the request path: an app that serves no document
 * bundles none of it, and the types refuse the key where it is written.
 */
import { type StatusKey, statusKeyToCode } from "../response/status.ts"
import type { OutputSchemas } from "../routing/output-types.ts"
import type { RouteTree } from "../routing/tree.ts"

/** Throws, naming route `id` and the key, when `output` holds a key that is no media type or no status its slot takes. */
export function assertOutputKeys(output: OutputSchemas, id: string): void {
	for (const [outer, statuses] of Object.entries(output)) {
		if (!/\/|^headers$|^redirect$/.test(outer))
			throw new Error(`${id}: .output() key "${outer}" is no type/subtype, headers or redirect`)
		for (const key of Object.keys(statuses ?? {})) {
			const refusal = refusalOf(outer, key)
			if (refusal !== null) throw new Error(`${id}: .output() key "${key}" under ${outer} ${refusal}`)
		}
	}
}

/** Why `key` cannot sit under `outer` (a media type, `headers` or `redirect`), or null when it can. */
function refusalOf(outer: string, key: string): string | null {
	if (!Object.hasOwn(statusKeyToCode, key)) return `is none of ${Object.keys(statusKeyToCode).join(", ")}`
	const hundreds = Math.floor(statusKeyToCode[key as StatusKey] / 100)
	if (outer === "redirect") return hundreds === 3 ? null : "is no 3xx status"
	if (outer === "headers") return hundreds === 2 || hundreds === 3 ? null : "is no 2xx or 3xx status"
	if (hundreds === 2) return null
	return hundreds === 3
		? "is no 2xx status; a redirect is declared under redirect"
		: "is no 2xx status; an error answer is declared with .errors()"
}

/** Throws as `assertOutputKeys` does for the first route of `tree` whose output holds such a key. */
export function assertTreeOutputKeys(tree: RouteTree): void {
	for (const [id, { out }] of Object.entries(tree.routes)) if (out) assertOutputKeys(out, id)
}
