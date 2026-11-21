/**
 * Plan 2's onInvalidate document as the C# and Java legs (plan 9) build it: a write of each selector kind (`:id`,
 * `*rest`, `:id?`), one whose target the write knows only in part, an integer-keyed write and its 204 twin, a GET
 * that invalidates, an event stream and a socket that do too, and a write under the root group `safe`, which both
 * clients rename beside their `Safe` mirror. No security scheme: a bearer token goes in `Authorization` by default.
 */
const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const SSE = { 200: { content: { "text/event-stream": { schema: { type: "string" } } }, description: "" } }
const BODY = { content: { "application/json": { schema: { type: "object" } } } }

/** A required path parameter of `type`. */
function param(name: string, type = "string") {
	return { in: "path", name, required: true, schema: { type } }
}

/** A required path parameter that spans segments (`x-backend-wildcard`). */
function wildcardParam(name: string) {
	return { ...param(name), "x-backend-wildcard": true }
}

/** A read `operationId` over the path params `params`. */
function read(operationId: string, params: readonly object[] = []) {
	return { operationId, parameters: params, responses: OK }
}

/** A write `operationId` with a JSON body over the path params `params`, invalidating `targets`. */
function write(operationId: string, params: readonly object[], targets: readonly string[]) {
	return { operationId, parameters: params, requestBody: BODY, responses: OK, "x-invalidate": targets }
}

/** The socket that invalidates its room's messages on open. */
const ROOM = {
	operationId: "rooms.live",
	parameters: [param("room")],
	responses: {},
	"x-invalidate": ["GET /rooms/:room/messages"],
	"x-websocket": true,
}

/** The document's paths, each a read the writes target or a write (or stream) that targets them. */
export function invalidatePaths() {
	const user = param("id", "integer")
	const save = ["GET /items/:id", "GET /files/*rest", "GET /docs/:id?"]
	return {
		"/docs": { get: read("docs.list") },
		"/docs/{id}": { get: read("docs.get", [param("id")]) },
		"/feed": { get: read("feed.get") },
		"/feed/live": { get: { operationId: "feed.live", responses: SSE, "x-invalidate": ["GET /feed"] } },
		"/feed/refresh": { get: { ...read("feed.refresh"), "x-invalidate": ["GET /feed"] } },
		"/files/{rest}": { get: read("files.get", [wildcardParam("rest")]) },
		"/items/{id}": { get: read("items.get", [param("id")]) },
		"/orgs/{org}": { put: write("orgs.update", [param("org")], ["GET /orgs/:org/members/:id"]) },
		"/orgs/{org}/members/{id}": { get: read("members.get", [param("org"), param("id")]) },
		"/rooms/{room}/live": { get: ROOM },
		"/rooms/{room}/messages": { get: read("rooms.messages", [param("room")]) },
		"/safe/{id}/files/{rest}": { put: write("safe.save", [param("id"), wildcardParam("rest")], save) },
		"/users": { get: read("users.list"), post: write("users.create", [], ["GET /users"]) },
		"/users/{id}": { get: read("users.get", [user]), patch: write("users.update", [user], ["GET /users/:id"]) },
		"/users/{id}/avatar": {
			put: { ...write("users.avatar", [user], ["GET /users/:id"]), responses: { 204: { description: "saved" } } },
		},
	}
}

/** The whole document: its paths under one title, no servers (a client takes its base URL). */
export function invalidateDocument() {
	return { info: { title: "Invalidate", version: "1" }, openapi: "3.1.0", paths: invalidatePaths() }
}
