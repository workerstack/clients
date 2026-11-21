/**
 * The onInvalidate cases the C# and Java legs share (plan 9; plan 2's cases 1.3-1.5): each case a section of one
 * program and the notes it must make, so a language's test files hold only its program and its run. Notes name an
 * event `invalidated <by> | <operationId> [key=value ...]`, keys sorted; a boolean prints as the language prints it.
 */
import type { Reply } from "./recording-server.ts"

/** How a language prints `false` and `true` (C#'s `False`, Java's `false`). */
export type Printed = { readonly no: string; readonly yes: string }

/** A case: its title, the program section it reads, and the notes that section must make. */
export type Case = readonly [title: string, section: string, notes: readonly string[]]

/** A 200 `{}`: the answer every write and read gets unless a case says otherwise. */
export const OK: Reply = { json: {}, status: 200 }

/** A 401 that the auth refresh hook answers with a fresh token. */
export const EXPIRED: Reply = { json: { message: "expired" }, status: 401 }

/** The note `users.update` with id 42 makes: its one target, `users.get` with the id as the call took it. */
export const UPDATED = "invalidated users.update | users.get [id=42]"

/** The note `users.create` makes: the control write a case runs after the call it checks. */
export const CREATED = "invalidated users.create | users.list []"

/** A write naming a route no read answers and a non-GET route, beside the read it does make stale. */
export const UNRESOLVED = {
	info: { title: "unresolved", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/users": { get: { operationId: "users.list", responses: { 200: { description: "ok" } } } },
		"/users/{id}": {
			put: {
				operationId: "users.update",
				parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
				responses: { 200: { description: "ok" } },
				"x-invalidate": ["GET /nowhere", "POST /users", "GET /users"],
			},
		},
	},
}

/** The notices UNRESOLVED's generation makes, each under the emitter's `prefix` (`csharp`, `java`). */
export function unresolvedNotices(prefix: string): readonly string[] {
	return [
		`${prefix}: users.update: x-invalidate "GET /nowhere" matches no GET read; skipped`,
		`${prefix}: users.update: x-invalidate "POST /users" names a POST route; only GET reads are cached; skipped`,
	]
}

/**
 * The outcome program's answers in hop order (its sections: renamed, partial, string, then 4xx, 5xx and network each
 * before a control create, get and get-invalidating each before one, undecodable, empty, invalidation): the 404 and
 * 500 writes, the undecodable 2xx and the 204; 200 `{}` for every other call.
 */
export const OUTCOME_REPLIES: readonly Reply[] = [
	OK,
	OK,
	OK,
	{ json: { error: "missing" }, status: 404 },
	OK,
	{ json: { error: "fail" }, status: 500 },
	OK,
	OK,
	OK,
	OK,
	OK,
	OK,
	{ headers: { "content-type": "application/json" }, status: 200, text: "{not json" },
	{ status: 204 },
]

/** The outcome program's cases: which answers call the hooks, and with which event. */
export const OUTCOME_CASES: readonly Case[] = [
	[
		"names the write by operationId, not its renamed member; fills `:id`, `*rest` and `:id?` targets",
		"renamed",
		["invalidated safe.save | items.get [id=7] | files.get [rest=a/b.txt] | docs.list [] | docs.get [id=7]"],
	],
	["omits a target param the write does not know", "partial", ["invalidated orgs.update | members.get [org=acme]"]],
	["gives an integer param as the string the call took, with no invalidation config", "string", [UPDATED]],
	["calls nothing for a 4xx write, then once for the next 2xx write", "4xx", ["failed true", CREATED]],
	["calls nothing for a 5xx write, then once for the next 2xx write", "5xx", ["failed true", CREATED]],
	["calls nothing for a write that never connected, then once for the next", "network", ["failed true", CREATED]],
	["calls nothing for a GET", "get", [CREATED]],
	["calls nothing for a GET that declares x-invalidate", "get-invalidating", [CREATED]],
	["calls them for a 2xx whose body does not decode, the call failing as a decode", "undecodable", [UPDATED, "decode true"]],
	["calls them for a 2xx with no body", "empty", ["invalidated users.avatar | users.get [id=42]", "avatar done"]],
	["calls them with an invalidation config", "invalidation", [UPDATED]],
]

/** The SSE open's answer, the socket's 101, then the throwing client's SSE open. */
export const OPEN_REPLIES: readonly Reply[] = [
	{ sse: { end: "close", steps: ["data: x\n\n"] }, status: 200 },
	{ status: 101, ws: { steps: [] } },
	{ sse: { end: "close", steps: ["data: y\n\n"] }, status: 200 },
]

/** The opens program's cases, `shown` how the language prints a boolean: detached hooks, once per open. */
export function openCases(shown: Printed): readonly Case[] {
	return [
		["calls them once as an SSE stream opens, not waiting on a held hook", "sse", [
			"event x",
			`held ${shown.no}`,
			"invalidated feed.live | feed.get []",
		]],
		["calls them once as a WS socket opens, not waiting on a held hook", "ws", [
			"dial done",
			`held ${shown.no}`,
			"invalidated rooms.live | rooms.messages [room=r1]",
			"more 0",
		]],
		[
			"logs a throwing hook on a stream's open, the next hook still called",
			"sse-throw",
			["event y", "log error error", "invalidated feed.live | feed.get []"],
		],
	]
}

/** The calls program's answers: the auth gate's 401, then `{saved: true}` for each of its (at most 8) writes. */
export const CALL_REPLIES: readonly Reply[] = [EXPIRED, ...Array.from({ length: 8 }, () => ({ json: { saved: true }, status: 200 }))]

/** The calls program's shared cases, `shown` how the language prints a boolean. */
export function callCases(shown: Printed): readonly Case[] {
	return [
		["calls them once for a 401 that the refresh hook turns into a 2xx", "auth", [
			`sent retry=${shown.no}`,
			`sent retry=${shown.yes}`,
			UPDATED,
		]],
		["returns only after a slow hook returned", "waits", [UPDATED, `done ${shown.yes}`]],
		["calls them from the safe client", "safe", [UPDATED, `ok ${shown.yes}`]],
	]
}

/** What a write past a failing hook notes: OnLog's error, the next hook's event, the write's data (one key). */
export const PAST_FAILED: readonly string[] = ["log error error", UPDATED, "data 1"]

/** A run of the program that noted `out`. */
export function ran(out: readonly string[]) {
	return { out, ran: true }
}
