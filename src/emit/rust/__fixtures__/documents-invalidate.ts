/**
 * Plan 2's on_invalidate document in Rust's terms (plan 8), merged into the registry's `fixtures` crate under
 * `writes` (the registry holds its 16 documents, G17): a write of each selector kind, an event stream and a socket
 * that invalidate, a GET that does too, a write with no body, and a write whose namespace is renamed (`self` is
 * `self_`), so `by` is the operationId, never the member path.
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
function read(operationId: string, params: object[] = []) {
	return { operationId, parameters: params, responses: OK }
}

/** A write `operationId` with a JSON body over the path params `params`, invalidating `targets`. */
function write(operationId: string, params: object[], targets: string[]) {
	return { operationId, parameters: params, requestBody: BODY, responses: OK, "x-invalidate": targets }
}

/** The socket whose open stales its room's messages. */
const ROOM_SOCKET = {
	operationId: "rooms.live",
	parameters: [param("room")],
	responses: {},
	"x-invalidate": ["GET /rooms/:room/messages"],
	"x-websocket": true,
}

/** The document, made on use. */
export function invalidating() {
	return {
		info: { title: "Writes", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/docs": { get: read("docs.list") },
			"/docs/{id}": { get: read("docs.get", [param("id")]) },
			"/feed": { get: read("feed.get") },
			"/feed/live": { get: { operationId: "feed.live", responses: SSE, "x-invalidate": ["GET /feed"] } },
			"/feed/refresh": { get: { ...read("feed.refresh"), "x-invalidate": ["GET /feed"] } },
			"/files/{rest}": { get: read("files.get", [wildcardParam("rest")]) },
			"/items/{id}": { get: read("items.get", [param("id")]) },
			"/orgs/{org}": { put: write("orgs.update", [param("org")], ["GET /orgs/:org/members/:id"]) },
			"/orgs/{org}/members/{id}": { get: read("members.get", [param("org"), param("id")]) },
			"/rooms/{room}/live": { get: ROOM_SOCKET },
			"/rooms/{room}/messages": { get: read("rooms.messages", [param("room")]) },
			"/self/{id}/files/{rest}": {
				put: write(
					"self.save",
					[param("id"), wildcardParam("rest")],
					["GET /items/:id", "GET /files/*rest", "GET /docs/:id?"],
				),
			},
			"/users": { get: read("users.list"), post: write("users.create", [], ["GET /users"]) },
			"/users/{id}": {
				get: read("users.get", [param("id", "integer")]),
				patch: write("users.update", [param("id", "integer")], ["GET /users/:id"]),
			},
			"/users/{id}/avatar": {
				put: {
					...write("users.avatar", [param("id", "integer")], ["GET /users/:id"]),
					responses: { 204: { description: "saved" } },
				},
			},
		},
	}
}

/** A write naming a route no read answers and a non-GET route, beside the read it does make stale. */
export function unresolved() {
	const update = write("users.update", [param("id")], ["GET /nowhere", "POST /users", "GET /users"])
	return {
		info: { title: "unresolved", version: "1" },
		openapi: "3.1.0",
		paths: { "/users": { get: read("users.list") }, "/users/{id}": { put: update } },
	}
}
