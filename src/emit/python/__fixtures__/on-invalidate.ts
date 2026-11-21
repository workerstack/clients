/**
 * The Python `on_invalidate` cases' SDK (http.on-invalidate.test.ts, http.on-invalidate.hooks.test.ts): plan 2's
 * document in Python's terms, a write of each selector kind, an event stream and a socket that invalidate, a GET that
 * does too, and a write whose member is renamed (`safe` is `safe_`, beside the client's `safe` mirror); a consumer
 * program's helpers that note each event a client's hooks see and each on_log entry that carries a hook's error, on
 * either client.
 */
import type { Consumer, Run } from "./consumer.ts"

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

/** The registry's `invalidate` document (documents.ts): Go's (emit/go/__fixtures__/on-invalidate.ts), path for path. */
export function invalidateDocument() {
	return {
		components: { securitySchemes: { bearer: { scheme: "bearer", type: "http" } } },
		info: { title: "t", version: "1" },
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
			"/rooms/{room}/live": {
				get: {
					operationId: "rooms.live",
					parameters: [param("room")],
					responses: {},
					"x-invalidate": ["GET /rooms/:room/messages"],
					"x-websocket": true,
				},
			},
			"/rooms/{room}/messages": { get: read("rooms.messages", [param("room")]) },
			"/safe/{id}/files/{rest}": {
				put: write(
					"safe.save",
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
		security: [{ bearer: [] }],
	}
}

/** A write naming a route no read answers and a non-GET route, beside the read it does make stale. */
export function unresolvedDocument() {
	const update = write("users.update", [param("id")], ["GET /nowhere", "POST /users", "GET /users"])
	return {
		info: { title: "unresolved", version: "1" },
		openapi: "3.1.0",
		paths: { "/users": { get: read("users.list") }, "/users/{id}": { put: update } },
	}
}

/**
 * The program's helpers: `BOOM`, the text a failing hook raises; `shown`, an event as one note (`by`, then each
 * target's operation_id and params as sorted JSON, `|` between); `done`, a call's value awaited when it is awaitable,
 * so one body drives both clients; `hooked`, a plain hook as `kind`'s (a coroutine function on `async`); `recorded`, a
 * `kind` client over a mock transport (or `config`'s own) whose hooks run `hooks` then note `invalidated <event>`, and
 * whose on_log notes `log <level> <event> <error>` for an entry carrying BOOM. The transport answers `REPLIES` by
 * `METHOD /path` (200 `{}` past them), counts each request in `SENT`, and under `gate` answers `Bearer fresh` 200 and
 * anything else 401, noting each token.
 */
const PRELUDE = `import inspect
import httpx2

BOOM = "boom"
REPLIES = {}
SENT = []


def shown(e):
    return " | ".join([e.by, *(f"{t.operation_id} {json.dumps(t.params, sort_keys=True)}" for t in e.targets)])


async def done(value):
    return await value if inspect.isawaitable(value) else value


def hooked(kind, hook):
    if kind == "sync":
        return hook

    async def run(e):
        return hook(e)

    return run


def answer(request, gate=False):
    SENT.append(request.url.path)
    if gate:
        token = request.headers.get("authorization", "")
        note(f"sent {token}")
        ok = token == "Bearer fresh"
        return httpx2.Response(200 if ok else 401, json={} if ok else {"message": "expired"})
    status, body = REPLIES.get(f"{request.method} {request.url.path}", (200, "{}"))
    return httpx2.Response(status, headers={"content-type": "application/json"}, content=body.encode())


def transport(kind, gate=False):
    mock = httpx2.MockTransport(lambda request: answer(request, gate))
    if kind == "sync":
        return {"http_client": httpx2.Client(transport=mock)}
    return {"async_http_client": httpx2.AsyncClient(transport=mock)}


def logged(entry):
    if BOOM in (entry.error or ""):
        note(f"log {entry.level} {entry.event} {entry.error}")


def recorded(kind, *hooks, gate=False, **config):
    def record(e):
        note(f"invalidated {shown(e)}")

    listed = [*hooks, hooked(kind, record)]
    fields = {"base_url": "http://api.test", "on_log": logged, **transport(kind, gate), **config}
    fields["on_invalidate_sync" if kind == "sync" else "on_invalidate"] = listed
    config = sdk.ClientConfig(**fields)
    return sdk.SDK(config) if kind == "sync" else sdk.AsyncSDK(config)
`

/** What `consume` takes to run `body` after PRELUDE against the registry's `invalidate` package: it spawns nothing. */
export function invalidating(body: string, base?: string): Consumer {
	return { ...(base === undefined ? {} : { base }), body: `${PRELUDE}\n${body}` }
}

/** What a case reads of `run`: whether it ran to the end, and the notes of `section`. */
export function noted(run: Run, section: string) {
	return { out: run.out?.[section], ran: run.ran }
}

/** A run that ran to the end, its section's notes `out`. */
export function clean(out: readonly string[]) {
	return { out, ran: true }
}

/** The note `users.update` with id 42 makes: its one target, `users.get` with the id as the call took it. */
export const UPDATED = 'invalidated users.update | users.get {"id": "42"}'

/** The note `users.create` makes: the control write a case runs after the call it checks. */
export const CREATED = "invalidated users.create | users.list {}"

/** The clients every REST case runs on, each section prefixed with its client's kind. */
export const KINDS = ["async", "sync"] as const
