/**
 * The emitted leg of the TanStack Query adapter's cases (tanstack-query.invalidate.test.ts): a document of users with
 * an integer id, a write that invalidates nothing and a renamed `state_` group, and the emitted SDK beside its emitted
 * adapter from one `generateSdk` run, over a recording fetch that counts each GET path's hits.
 */
import type { QueryClient } from "@tanstack/query-core"

import type { Surface } from "../../../runtime/ts-tanstack-query/query.ts"
import { emittedSdk, emittedTanstackQuery, recordingFetch } from "./emitted.ts"
import type { CallInput } from "./tanstack-query.ts"

const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const BODY = { content: { "application/json": { schema: { type: "object" } } } }

/** A required path parameter of `type`. */
function param(name: string, type = "string") {
	return { in: "path", name, required: true, schema: { type } }
}

/** A read `operationId` over the path params `params`. */
function read(operationId: string, params: object[] = []) {
	return { operationId, parameters: params, responses: OK }
}

/** A write `operationId` with a JSON body over `params`, invalidating `targets`. */
function write(operationId: string, params: object[], targets: string[]) {
	return { operationId, parameters: params, requestBody: BODY, responses: OK, "x-invalidate": targets }
}

const ID = param("id", "integer")

/** Users with an integer id, a write that invalidates nothing, and `state`, a client member renamed to `state_`. */
export const DOCUMENT = {
	info: { title: "t", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/state/{id}": { get: read("state.get", [ID]), put: write("state.save", [ID], ["GET /state/:id"]) },
		"/users": { get: read("users.list") },
		"/users/{id}": { get: read("users.get", [ID]), patch: write("users.update", [ID], ["GET /users/:id", "GET /users"]) },
		"/users/{id}/ping": { post: write("users.ping", [ID], []) },
	},
}

/** The calls these cases make on the emitted SDK. */
type Call = (input?: CallInput) => Promise<object>

/** The emitted SDK's members these cases call. */
export type EmittedSdk = {
	readonly state_: { readonly get: Call; readonly save: Call }
	readonly users: { readonly get: Call; readonly list: Call; readonly ping: Call; readonly update: Call }
}

/** What the emitted adapter exports. */
export type EmittedAdapter = {
	createQueryHelpers: (getSdk: () => EmittedSdk) => { mutation: Surface; query: Surface; queryKey: Surface }
	invalidateQueries: (client: QueryClient) => (event: object) => Promise<void>
}

/** What `emittedPair` hands a case: the adapter, the requests sent, and the SDK. */
type Pair = { adapter: EmittedAdapter; calls: Request[]; sdk: EmittedSdk }

/**
 * The emitted SDK over DOCUMENT and a fetch answering `answer`, beside the adapter emitted with it in one
 * `generateSdk` run, so both are the text an SDK ships; given `client`, the SDK is built after it, its `onInvalidate`
 * the adapter's `invalidateQueries(client)`, as an app wires the two.
 */
export async function emittedPair(answer: (request: Request) => Response, client?: QueryClient): Promise<Pair> {
	const options = { name: "TestSDK", tanstackQuery: true }
	const emitted = await emittedSdk(DOCUMENT, options)
	const { createQueryHelpers, invalidateQueries } = await emittedTanstackQuery(DOCUMENT, options)
	const adapter: EmittedAdapter = {
		createQueryHelpers: createQueryHelpers as /* the emitted file exports it */ EmittedAdapter["createQueryHelpers"],
		invalidateQueries: invalidateQueries as /* the emitted file exports it */ EmittedAdapter["invalidateQueries"],
	}
	const TestSDK = emitted["TestSDK"] as /* DOCUMENT emits these members */ new (config: object) => EmittedSdk
	const { calls, fetch } = recordingFetch(answer)
	const onInvalidate = client === undefined ? [] : [adapter.invalidateQueries(client)]
	const sdk = new TestSDK({ baseURL: "https://api.test", fetch, onInvalidate })
	return { adapter, calls, sdk }
}

/** A fetch answer counting each GET path's hits as `{ n }`; once `failAfter` hits of a path, a GET of it is a 500. */
export function countingAnswer(failAfter = Number.POSITIVE_INFINITY): (request: Request) => Response {
	const hits = new Map<string, number>()
	return (request) => {
		if (request.method !== "GET") return Response.json({ wrote: new URL(request.url).pathname })
		const path = new URL(request.url).pathname
		const n = (hits.get(path) ?? 0) + 1
		hits.set(path, n)
		return n > failAfter ? Response.json({ error: "down" }, { status: 500 }) : Response.json({ n })
	}
}
