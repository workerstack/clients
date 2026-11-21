/**
 * The `onInvalidate` cases' SDK (http.on-invalidate.test.ts, http.on-invalidate.hooks.test.ts): a document with a
 * write of each selector kind, an event stream and a socket that invalidate, a GET that does too, and a write whose
 * member is renamed; the emitted client over a recording fetch, its hooks' events and its onLog entries recorded.
 */
import { emittedSdk, recordingFetch } from "./emitted.ts"

/** A path param value a call takes. */
type ParamValue = boolean | number | string

/** One read a write made stale: its operationId and the write's values for its params. */
export type Target = { operationId: string; params: Readonly<Record<string, ParamValue>> }

/** What each hook is called with. */
export type InvalidateEvent = { by: string; targets: Target[] }

export type Hook = (event: InvalidateEvent) => Promise<void> | void

/** What these cases pass a call. */
type CallInput = { json?: object; params?: Readonly<Record<string, ParamValue>> }

/** A REST call: its data, a JSON object, or null for a 2xx with no body. */
type Call = (input?: CallInput) => Promise<object | null>

/** What a safe call resolves to. */
type Result = { ok: boolean }

/** The members these cases call; `state` is a root member, so its group is `state_`. */
export type Sdk = {
	readonly feed: Readonly<Record<"get" | "refresh", Call>> & { readonly live: () => AsyncIterable<string> }
	readonly orgs: Readonly<Record<"update", Call>>
	readonly rooms: { readonly live: (input: CallInput) => { on(event: string, handler: () => void): void } }
	readonly safe: { readonly users: Readonly<Record<"update", (input?: CallInput) => Promise<Result>>> }
	readonly state_: Readonly<Record<"save", Call>>
	readonly users: Readonly<Record<"avatar" | "create" | "list" | "update", Call>>
}

/** One onLog entry's fields these cases read. */
export type Log = { error?: Error; event: string; level: string }

/** A response hook's context, as these cases read it. */
type ResponseContext = { isRetry: boolean; response: Response; retry: () => Promise<Response> }

/** The config fields these cases set beside the base URL, fetch and hooks `sdkOf` passes. */
export type Config = {
	headers?: Readonly<Record<string, string>>
	invalidation?: { staleTime: number }
	onAuthExpired?: () => Promise<string>
	onInvalidate?: Hook[]
	onResponse?: Array<(ctx: ResponseContext) => Promise<Response> | undefined>
}

export type Answer = (request: Request) => Promise<Response> | Response

const BASE = "https://api.test"
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

const DOCUMENT = {
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
		"/state/{id}/files/{rest}": {
			put: write(
				"state.save",
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

/** The event `users.create` fires: the control write a case runs after the call it checks. */
export const CREATED: InvalidateEvent = { by: "users.create", targets: [{ operationId: "users.list", params: {} }] }

/** The event `users.update` with `id: 42` fires. */
export const UPDATED: InvalidateEvent = {
	by: "users.update",
	targets: [{ operationId: "users.get", params: { id: 42 } }],
}

/** What `sdkOf` hands a case: the requests sent, the events and log entries recorded, and the client. */
type Recorded = { calls: Request[]; events: InvalidateEvent[]; logs: Log[]; sdk: Sdk }

/**
 * The emitted SDK over DOCUMENT and a fetch answering `answer`, with `onInvalidate` recording each event in
 * `events` after `hooks`, and onLog recording in `logs`; `config` set over them.
 */
export async function sdkOf(answer: Answer = () => Response.json({}), config: Config = {}, hooks: Hook[] = []) {
	const emitted = await emittedSdk(DOCUMENT)
	const TestSDK = emitted["TestSDK"] as /* DOCUMENT emits these members */ new (config: object) => Sdk
	const { calls, fetch } = recordingFetch(answer)
	const events: InvalidateEvent[] = []
	const logs: Log[] = []
	function onLog(entry: Log): void {
		logs.push(entry)
	}
	const onInvalidate: Hook[] = [...hooks, (event) => void events.push(event)]
	const sdk = new TestSDK({ baseURL: BASE, fetch, onInvalidate, onLog, ...config })
	const recorded: Recorded = { calls, events, logs, sdk }
	return recorded
}

/** Answers the first request with `first()`, and every later one with `{}`. */
export function firstThenOk(first: () => Response): Answer {
	let isFirst = true
	return () => {
		const wasFirst = isFirst
		isFirst = false
		return wasFirst ? first() : Response.json({})
	}
}

/** A 401 an auth refresh or a retrying hook answers. */
export function unauthorized(): Response {
	return Response.json({ message: "expired" }, { status: 401 })
}

/** A hook that never settles. */
export function hung(): Promise<void> {
	return new Promise<void>(() => undefined)
}

/** Let queued microtasks and timers run. */
export function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0))
}
