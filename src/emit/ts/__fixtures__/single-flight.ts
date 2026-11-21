/**
 * The single-flight handler cases' harness (http.single-flight-handler*.test.ts): a document with an idempotent and a
 * plain write, reads of each kind the handler takes or refuses, and writes it refuses; the SDK emitted under
 * `singleFlight: true`, its `<stem>.single-flight.gen.ts` imported alone, its handler over a per-request SDK whose
 * fetch is a scripted fake API that records every request it gets.
 */
import { dirname, join } from "node:path"
import { emittedSdkEntry, recordingFetch } from "./emitted.ts"

/** Where the fake API lives: another origin than the app's. */
export const API = "https://api.test"

/** The app's own origin: where the handler is mounted. */
export const APP = "https://app.test"

/** The problem `type` every refusal answers. */
export const REFUSED = "urn:workerstack:single-flight:refused"

/** A fake API answer for one `METHOD /path` (search left out), by request. */
export type Route = (request: Request) => Promise<Response> | Response

/** The fake API's answers that replace the defaults, by `METHOD /path`. */
export type Routes = Readonly<Partial<Record<string, Route>>>

/** One read's entry in the envelope: its data, or the error it ended in. */
export type ReadEntry = { data?: unknown; error?: { body?: unknown; status: number }; id: string }

/** The envelope the handler answers 200 with. */
export type Envelope = {
	reads: ReadEntry[]
	v: 1
	write: { body: unknown; headers: Record<string, string>; status: number }
}

/** The handler's options these cases set. */
export type Options = {
	allowedOrigins?: readonly string[]
	maxBodyBytes?: number
	maxReadBytes?: number
	maxReads?: number
	readBudgetMs?: number
}

type Handler = (request: Request) => Promise<Response>
type HandlerOf = (getSdk: (request: Request) => object, options?: Options) => Handler
type Run = (sdk: object, body: unknown) => Promise<Envelope>

const JSON_OK = { 200: { content: { "application/json": { schema: {} } }, description: "ok" } }
const BODY = { content: { "application/json": { schema: { type: "object" } } }, required: true }
const REQUEST_ID = { "X-Request-Id": { schema: { type: "string" } } }
const SSE = { 200: { content: { "text/event-stream": { schema: { type: "string" } } }, description: "events" } }
const ID = { in: "path", name: "id", required: true, schema: { type: "integer" } }
const ROOM = { in: "path", name: "room", required: true, schema: { type: "string" } }
const LIMIT = { in: "query", name: "limit", schema: { type: "integer" } }

/** A JSON success answer of `status` that declares `X-Request-Id`. */
function declared(status: number) {
	return { [status]: { content: { "application/json": { schema: {} } }, description: "done", headers: REQUEST_ID } }
}

/** The handler cases' API. */
export const DOCUMENT = {
	info: { title: "t", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/feed/live": { get: { operationId: "feed.live", responses: SSE } },
		"/feed/publish": {
			post: { operationId: "feed.publish", requestBody: BODY, responses: SSE, "x-invalidate": ["GET /users"] },
		},
		"/feed/refresh": { get: { operationId: "feed.refresh", responses: JSON_OK, "x-invalidate": ["GET /users"] } },
		"/ping": { get: { operationId: "ping", responses: { 204: { description: "up" } } } },
		"/reports/{id}": {
			get: {
				operationId: "reports.get",
				parameters: [ID],
				responses: { 200: { content: { "text/csv": { schema: { type: "string" } } }, description: "csv" } },
			},
		},
		"/rooms/{room}/live": {
			get: {
				operationId: "rooms.live",
				parameters: [ROOM],
				responses: {},
				"x-invalidate": ["GET /users"],
				"x-websocket": true,
			},
		},
		"/users": {
			get: { operationId: "users.list", parameters: [LIMIT], responses: JSON_OK },
			post: {
				operationId: "users.create",
				requestBody: BODY,
				responses: declared(201),
				"x-idempotency-key": true,
				"x-invalidate": ["GET /users"],
			},
		},
		"/users/{id}": {
			get: { operationId: "users.get", parameters: [ID], responses: JSON_OK },
			patch: {
				operationId: "users.update",
				parameters: [ID],
				requestBody: BODY,
				responses: declared(200),
				"x-invalidate": ["GET /users/:id"],
			},
		},
	},
}

const OPTIONS = { name: "TestSDK", singleFlight: true, stem: "test-sdk" }

/** The default answers: a write echoes what it got, a read answers its own path. */
async function defaultAnswer(request: Request): Promise<Response> {
	const { pathname } = new URL(request.url)
	if (request.method === "GET") return Response.json({ path: pathname })
	return Response.json({ got: await request.json(), path: pathname }, { status: request.method === "POST" ? 201 : 200 })
}

/** The fake API: `routes` by `METHOD /path`, else the defaults. */
function fakeApi(routes: Routes): Route {
	return (request) => {
		const route = routes[`${request.method} ${new URL(request.url).pathname}`]
		return route === undefined ? defaultAnswer(request) : route(request)
	}
}

/** What `flightOf` hands a case. */
export type Flight = {
	/** every request the fake API got, in order */
	readonly calls: Request[]
	/** the handler, over a fresh SDK per request */
	readonly handle: Handler
	/** `runSingleFlight` over a fresh SDK */
	readonly run: (body: unknown) => Promise<Envelope>
}

/** The emitted handler over the fake API with `routes`, built with `options`. */
export async function flightOf(routes: Routes = {}, options: Options = {}): Promise<Flight> {
	const entry = emittedSdkEntry(DOCUMENT, OPTIONS)
	const index = (await import(entry)) as Record<string, unknown>
	const module = (await import(join(dirname(entry), "test-sdk.single-flight.gen.ts"))) as Record<string, unknown>
	const TestSDK = index["TestSDK"] as new (config: object) => object
	const { calls, fetch } = recordingFetch(fakeApi(routes))
	const sdk = () => new TestSDK({ baseURL: API, fetch })
	const handle = (module["singleFlightHandler"] as HandlerOf)(sdk, options)
	const run = (body: unknown) => (module["runSingleFlight"] as Run)(sdk(), body)
	return { calls, handle, run }
}

/** A valid plain-write batch at least `bytes` long: its JSON body's `name` padded. */
export function paddedBatch(bytes: number): object {
	return batch(UPDATE.op, { json: { name: "x".repeat(bytes) }, params: { id: 42 } })
}

/** What every refusal is. */
export const REFUSAL = { contentType: "application/problem+json", status: 400, type: REFUSED }

/** A batch of `op` with `input` and `reads`, as version 1. */
export function batch(op: string, input: unknown, reads: object[] = []): object {
	return { input, op, reads, v: 1 }
}

/** The plain write these cases send when the write is not what they check. */
export const UPDATE = { op: "users.update", input: { json: { name: "b" }, params: { id: 42 } } }

/** A read of `operationId` with `input`, named `id`. */
export function read(id: string, operationId: string, input: object = {}): object {
	return { id, input, operationId }
}
