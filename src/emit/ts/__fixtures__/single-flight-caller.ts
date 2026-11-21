/**
 * The single-flight caller's cases' harness (http.single-flight*.test.ts, tanstack-query.single-flight.test.ts): a
 * document with an idempotent and a plain write, writes that must go direct (a CSV answer, a 204, an event stream, a
 * GET that invalidates), and the reads they make stale; the SDK emitted with its single-flight handler and its TanStack
 * adapter in one run; a client over an app fetch that hands `/api/_mutate` to that handler and every other `/api` path
 * to a recording fake API, the handler's per-request SDK forwarding the batch's Authorization header.
 */
import { dirname, join } from "node:path"

import type { QueryClient } from "@tanstack/query-core"

import type { Surface } from "../../../runtime/ts-tanstack-query/query.ts"
import { emittedSdkEntry, recordingFetch } from "./emitted.ts"

/** The fake API's origin, and the app's, whose `/api` the client is based on. */
export const API = "https://api.test"
export const APP = "https://app.test"

/** The batch path every case's client posts to. */
export const MUTATE = "/api/_mutate"

/** A path param value a call takes. */
type ParamValue = boolean | number | string

/** One read a write made stale. */
export type Target = { operationId: string; params: Readonly<Record<string, ParamValue>> }

/** One read a batch asks for. */
export type ReadRequest = { id: string; input: object; operationId: string }

/** The reads a batch brought back, by id, as the hooks get them. */
export type Fresh = { data: Map<string, unknown>; failed: Set<string> }

/** What each `onInvalidate` hook is called with. */
export type InvalidateEvent = { by: string; fresh?: Fresh; targets: Target[] }

/** A hook of `onInvalidate`. */
export type Hook = (event: InvalidateEvent) => Promise<void> | void

/** A path param value a batch's input carries. */
type Params = Readonly<Record<string, ParamValue>>

/** The batch a client sends, as JSON. */
export type Batch = {
	input: { idempotencyKey?: string; json?: object; params?: Params }
	op: string
	reads: ReadRequest[]
	v: number
}

/** A case's `select`. */
export type Select = (targets: Target[]) => ReadRequest[]

/** What a single-flight config holds. */
export type SingleFlight = {
	exclude?: readonly string[]
	maxReads?: number
	path?: string
	select: Select
	send?: (batch: Batch) => Promise<object>
}

/** The input these cases pass a call. */
export type CallInput = {
	baseURL?: string
	body?: Uint8Array
	cookies?: Record<string, string>
	form?: Record<string, string>
	headers?: Record<string, string>
	idempotencyKey?: string
	json?: object
	params?: Params
	raw?: boolean
	signal?: AbortSignal
	singleFlight?: boolean
}

/** What a call resolves: JSON, text, or nothing for a 204. */
export type Data = object | string | undefined

/** A REST call: its data. */
type Call = (input?: CallInput) => Promise<Data>

/** The members these cases call. */
export type Sdk = {
	readonly exports: { readonly create: Call }
	readonly feed: { readonly publish: (input?: CallInput) => AsyncIterable<unknown>; readonly refresh: Call }
	readonly users: Readonly<Record<"avatar" | "create" | "get" | "list" | "ping" | "update", Call>>
}

/** A request hook's context, as these cases read it. */
type RequestContext = { method: string; path: string; url: string }

/** The config fields a case sets beside the base URL, fetch, hooks and single-flight config `flightOf` passes. */
export type Config = {
	onAuthExpired?: () => Promise<string>
	onRequest?: Array<(ctx: RequestContext) => void>
	onResponse?: Array<(ctx: { response: Response }) => undefined>
	singleFlight?: SingleFlight | undefined
}

const JSON_OK = { 200: { content: { "application/json": { schema: {} } }, description: "ok" } }
const BODY = { content: { "application/json": { schema: { type: "object" } } } }
const SSE = { 200: { content: { "text/event-stream": { schema: { type: "string" } } }, description: "events" } }
const CSV = { 200: { content: { "text/csv": { schema: { type: "string" } } }, description: "csv" } }
const ID = { in: "path", name: "id", required: true, schema: { type: "integer" } }

/** A write `operationId` with a JSON body over `params`, answering `responses`, invalidating `targets`. */
function write(operationId: string, targets: string[], params: object[] = [], responses: object = JSON_OK) {
	return { operationId, parameters: params, requestBody: BODY, responses, "x-invalidate": targets }
}

/** The cases' API. */
export const DOCUMENT = {
	info: { title: "t", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/exports": { post: write("exports.create", ["GET /users"], [], CSV) },
		"/feed/publish": { post: write("feed.publish", ["GET /users"], [], SSE) },
		"/feed/refresh": { get: { operationId: "feed.refresh", responses: JSON_OK, "x-invalidate": ["GET /users"] } },
		"/users": {
			get: { operationId: "users.list", responses: JSON_OK },
			post: { ...write("users.create", ["GET /users"]), "x-idempotency-key": true },
		},
		"/users/{id}": {
			get: { operationId: "users.get", parameters: [ID], responses: JSON_OK },
			patch: write("users.update", ["GET /users/:id", "GET /users"], [ID]),
		},
		"/users/{id}/avatar": {
			put: write("users.avatar", ["GET /users/:id"], [ID], { 204: { description: "saved" } }),
		},
		"/users/{id}/ping": { post: write("users.ping", [], [ID]) },
	},
}

/** One `generateSdk` run: the client, its handler and its TanStack adapter. */
export const OPTIONS = { name: "TestSDK", singleFlight: true, stem: "test-sdk", tanstackQuery: true }

/** A fake API answer for one request. */
export type Route = (request: Request) => Promise<Response> | Response

/** The fake API's answers that replace the defaults, by `METHOD /path`. */
export type Routes = Readonly<Partial<Record<string, Route>>>

/** The default answers: a read its path and how often it was read, a write what it got. */
function defaultApi(): Route {
	const hits = new Map<string, number>()
	return async (request) => {
		const { pathname } = new URL(request.url)
		if (request.method === "GET") {
			const n = (hits.get(pathname) ?? 0) + 1
			hits.set(pathname, n)
			return Response.json({ n, path: pathname })
		}
		return Response.json({ got: await request.text(), path: pathname })
	}
}

/** Every read of `targets` brought back, each named `r<index>`, with the target's params. */
export function everyRead(targets: Target[]): ReadRequest[] {
	return targets.map((target, index) => ({ id: `r${index}`, input: { params: target.params }, operationId: target.operationId }))
}

/** The handler's options a case sets. */
export type HandlerOptions = { maxReads?: number }

/**
 * One case's setup: the fake API's answers over the defaults, the client's config, the handler's own options, the
 * answer the app gives a batch in place of the handler's, and hooks run before the one recording each event.
 */
export type Setup = {
	batch?: Route
	config?: Config
	handler?: HandlerOptions
	hooks?: Hook[]
	routes?: Routes
}

/** The emitted TanStack adapter, as these cases call it. */
export type Adapter = {
	activeReads: (client: QueryClient) => Select
	createQueryHelpers: (getSdk: () => Sdk) => { mutation: Surface; query: Surface }
	invalidateQueries: (client: QueryClient) => Hook
}

/** What `flightOf` hands a case. */
export type Flight = {
	/** every request the fake API got, in order */
	readonly api: Request[]
	/** every request the client sent the app, in order */
	readonly app: Request[]
	/** each event the client's hooks got, in order */
	readonly events: InvalidateEvent[]
	/** `runSingleFlight` over a fresh server SDK */
	readonly run: (batch: Batch) => Promise<object>
	/** the client */
	readonly sdk: Sdk
}

/** Each module of the one `generateSdk` run: the index, the handler's file and the adapter. */
export async function emittedModules() {
	const entry = emittedSdkEntry(DOCUMENT, OPTIONS)
	const dir = dirname(entry)
	const index = (await import(entry)) as Record<string, unknown>
	const handler = (await import(join(dir, "test-sdk.single-flight.gen.ts"))) as Record<string, unknown>
	const adapter = (await import(join(dir, "test-sdk.tanstack-query.gen.ts"))) as /* the emitted file exports it */ Adapter
	return { adapter, handler, index }
}

/** The forwarded Authorization header of `request`, when it has one. */
function forwarded(request: Request): Record<string, string> {
	const auth = request.headers.get("authorization")
	return auth === null ? {} : { authorization: auth }
}

type Handler = (request: Request) => Promise<Response>

/**
 * The emitted client over the app, its config `setup.config` over a single-flight config bringing back every read, its
 * hooks `setup.hooks` then one recording each event; the fake API answering `setup.routes` over the defaults.
 */
export async function flightOf(setup: Setup = {}): Promise<Flight> {
	const { handler, index } = await emittedModules()
	const TestSDK = index["TestSDK"] as /* DOCUMENT emits these members */ new (config: object) => Sdk
	const fallback = defaultApi()
	const routes = setup.routes ?? {}
	const api = recordingFetch((request) => (routes[`${request.method} ${new URL(request.url).pathname}`] ?? fallback)(request))
	const serverSdk = (request: Request) => new TestSDK({ baseURL: API, fetch: api.fetch, headers: forwarded(request) })
	const handle = (handler["singleFlightHandler"] as /* the emitted file exports it */ (getSdk: typeof serverSdk, options: object) => Handler)(
		serverSdk,
		setup.handler ?? {},
	)
	const client = recordingFetch(async (request) => {
		const url = new URL(request.url)
		if (url.pathname === MUTATE) return (setup.batch ?? handle)(request)
		const body = request.method === "GET" ? null : await request.arrayBuffer()
		const init = { body, headers: request.headers, method: request.method, signal: request.signal }
		return api.fetch(`${API}${url.pathname.slice("/api".length)}${url.search}`, init)
	})
	const events: InvalidateEvent[] = []
	const onInvalidate: Hook[] = [...(setup.hooks ?? []), (event) => void events.push(event)]
	const singleFlight: SingleFlight = { select: everyRead }
	const sdk = new TestSDK({ baseURL: `${APP}/api`, fetch: client.fetch, onInvalidate, singleFlight, ...setup.config })
	const runSingleFlight = handler["runSingleFlight"] as /* the emitted file exports it */ (sdk: Sdk, body: Batch) => Promise<object>
	const run = (batch: Batch) => runSingleFlight(new TestSDK({ baseURL: API, fetch: api.fetch }), batch)
	return { api: api.calls, app: client.calls, events, run, sdk }
}

/** Each request as `METHOD path?search`, relative to its origin. */
export function sent(calls: readonly Request[]): string[] {
	return calls.map((call) => {
		const url = new URL(call.url)
		return `${call.method} ${url.pathname}${url.search}`
	})
}

/** The batch the client sent at `index` of `calls`. */
export async function batchAt(calls: readonly Request[], index = 0): Promise<Batch> {
	const call = calls[index]
	if (call === undefined) throw new Error(`no request ${index}: ${sent(calls).join(", ")}`)
	return (await call.clone().json()) as /* the client sent it as JSON */ Batch
}

/** A call's error, as a direct and a batched one are compared: its name, status, body and message. */
export type Rejection = { body: unknown; message: string; name: string; status: number }

/** What `call` rejects with, as a Rejection; undefined when it resolves. */
export async function rejectionOf(call: Promise<unknown>): Promise<Rejection | undefined> {
	try {
		await call
		return undefined
	} catch (e) {
		const { body, message, name, status } = e as /* every call here rejects with a ClientError */ Rejection
		return { body, message, name, status }
	}
}

/** An event stream of one event. */
export function stream(): Response {
	return new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } })
}

/** A 401 the write answers until the request carries `Bearer fresh`. */
export function expiredUntilFresh(request: Request): Response {
	if (request.headers.get("authorization") === "Bearer fresh") return Response.json({ ok: true })
	return Response.json({ message: "expired" }, { status: 401 })
}

/** The write answers a conflict. */
export function conflict(): Response {
	return Response.json({ message: "taken" }, { status: 409 })
}

/** The network fails before any answer. */
export function failed(): Promise<Response> {
	return Promise.reject(new TypeError("fetch failed"))
}

/** A read answers not found. */
export function missing(): Response {
	return Response.json({ message: "missing" }, { status: 404 })
}
