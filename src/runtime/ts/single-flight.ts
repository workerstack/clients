import { parseMediaType } from "./media-type.ts"
import type { SDKClient, ServiceMap } from "./sdk.ts"
import { type FlightOp, type Json, operationsOf, parseBatch } from "./single-flight-batch.ts"
import { bodyOf } from "./single-flight-body.ts"
import { type FlightLimits, fly, type Flown, type SingleFlightEnvelope } from "./single-flight-run.ts"
import {
	ANSWERED_STATUS,
	BATCH_MEDIA_TYPE,
	BATCH_METHOD,
	DEFAULT_MAX_BODY_BYTES,
	DEFAULT_MAX_READ_BYTES,
	DEFAULT_MAX_READS,
	DEFAULT_READ_BUDGET_MS,
	REFUSED,
	REFUSED_STATUS,
	SAME_ORIGIN,
	UNANSWERED,
	UNANSWERED_STATUS,
} from "./single-flight.constants.ts"

/** How far a single-flight batch may go, and who may send one. */
export type SingleFlightOptions = {
	/** the origins a browser may send from; the handler's own origin when left out */
	allowedOrigins?: readonly string[]
	/** the most bytes a batch's body may hold, counted while it is read. Default 64 KiB. */
	maxBodyBytes?: number
	/** the most bytes the reads' bodies may hold in all, counted before they are decoded. Default 1 MiB. */
	maxReadBytes?: number
	/** the most reads one batch may ask for. Default 10. */
	maxReads?: number
	/** how long the reads may take in all, in milliseconds, once the write answered. Default 2000. */
	readBudgetMs?: number
}

/** The SDK a request runs on: the app's, made for that request, forwarding only the auth it chooses. */
export type SingleFlightSdk<S extends SDKClient> = (request: Request) => S

const DEFAULT_LIMITS: FlightLimits = {
	maxReadBytes: DEFAULT_MAX_READ_BYTES,
	maxReads: DEFAULT_MAX_READS,
	readBudgetMs: DEFAULT_READ_BUDGET_MS,
}

/** `options`' limits, each left out one its default. */
function limitsOf(options: SingleFlightOptions): FlightLimits {
	return {
		maxReadBytes: options.maxReadBytes ?? DEFAULT_LIMITS.maxReadBytes,
		maxReads: options.maxReads ?? DEFAULT_LIMITS.maxReads,
		readBudgetMs: options.readBudgetMs ?? DEFAULT_LIMITS.readBudgetMs,
	}
}

/** `text` parsed as JSON, or undefined when it is none. */
function parsedJson(text: string): Json | undefined {
	try {
		return JSON.parse(text) /* JSON.parse answers only JSON values */ as Json
	} catch {
		return undefined
	}
}

/**
 * Run a batch on `sdk`: `{ v: 1, op, input, reads: [{ id, operationId, input }] }`, validated against the service
 * map before anything runs (a refusal throws a TypeError), then the write once, then its reads in parallel. Its
 * `Set-Cookie` headers are not in the envelope: `singleFlightHandler` copies them onto its answer.
 */
export async function runFlight(map: ServiceMap, sdk: SDKClient, body: Json): Promise<SingleFlightEnvelope> {
	const parsed = parseBatch(operationsOf(map), body, DEFAULT_LIMITS.maxReads)
	if ("refused" in parsed) throw new TypeError(`single-flight: refused: ${parsed.refused}`)
	const flown = await fly(sdk, parsed.batch, DEFAULT_LIMITS)
	return flown.envelope
}

/** An `application/problem+json` answer of `type`, saying why in `detail`. */
function problem(status: number, type: string, detail: string): Response {
	const headers = { "cache-control": "no-store", "content-type": "application/problem+json" }
	return new Response(JSON.stringify({ detail, status, title: "Single-flight batch not run", type }), {
		headers,
		status,
	})
}

/** Why `request` is refused before its body is read: its method, media type, or the browser's site or origin. */
function headerRefusal(request: Request, allowed: readonly string[] | undefined): string | undefined {
	const site = request.headers.get("sec-fetch-site")
	const origin = request.headers.get("origin")
	if (request.method !== BATCH_METHOD) return "a batch is POSTed"
	if (parseMediaType(request.headers.get("content-type"))?.essence !== BATCH_MEDIA_TYPE) return "the body is not JSON"
	if (site !== null && site !== SAME_ORIGIN) return "the browser sent it from another site"
	if (origin !== null && !(allowed ?? [new URL(request.url).origin]).includes(origin))
		return "the origin is not allowed"
	return undefined
}

/** `request`'s body as text, read no further than `max` bytes; undefined past it. */
async function bodyText(request: Request, max: number): Promise<string | undefined> {
	if (Number(request.headers.get("content-length") ?? 0) > max) return undefined
	let size = 0
	function take(chunk: Uint8Array): boolean {
		size += chunk.byteLength
		return size <= max
	}
	const bytes = await bodyOf({ body: request.body, take })
	return bytes === undefined ? undefined : new TextDecoder().decode(bytes)
}

/** The envelope as the handler's 200: JSON, never cached, the write's cookies each a header of its own. */
function answered(flown: Flown): Response {
	const headers = new Headers({ "cache-control": "no-store", "content-type": BATCH_MEDIA_TYPE })
	for (const cookie of flown.cookies) headers.append("set-cookie", cookie)
	return new Response(JSON.stringify(flown.envelope), { headers, status: ANSWERED_STATUS })
}

/** What a handler holds for every request: the map's operations, its SDK maker and its limits. */
type Served = {
	allowedOrigins: readonly string[] | undefined
	getSdk: SingleFlightSdk<SDKClient>
	limits: FlightLimits
	maxBodyBytes: number
	ops: ReadonlyMap<string, FlightOp>
}

/** One batch request: checked, read, validated, then run on the request's own SDK. */
async function handle(request: Request, served: Served): Promise<Response> {
	const header = headerRefusal(request, served.allowedOrigins)
	if (header !== undefined) return problem(REFUSED_STATUS, REFUSED, header)
	const text = await bodyText(request, served.maxBodyBytes)
	if (text === undefined) return problem(REFUSED_STATUS, REFUSED, "the body is over maxBodyBytes")
	const parsed = parseBatch(served.ops, parsedJson(text) ?? null, served.limits.maxReads)
	if ("refused" in parsed) return problem(REFUSED_STATUS, REFUSED, parsed.refused)
	try {
		return answered(await fly(served.getSdk(request), parsed.batch, served.limits))
	} catch {
		return problem(UNANSWERED_STATUS, UNANSWERED, "the write got no answer; it may or may not have run")
	}
}

/**
 * A fetch handler for single-flight batches over `map`: it refuses a batch before anything runs unless it is a
 * JSON POST, from no browser or from an allowed origin, within `maxBodyBytes`, of one REST write and at most
 * `maxReads` REST JSON reads with only params, search, json (the write's) and idempotencyKey (an idempotent write's).
 * Then it runs the write once on `getSdk(request)`, with the caller's Idempotency-Key and no retry of its own (the
 * SDK's own hooks may retry), and only after a 2xx the reads, in parallel, within `readBudgetMs` and `maxReadBytes`.
 * It answers 200 with the envelope, never cached, the write's Set-Cookie headers copied on: a cookie only sticks
 * when the API shares the handler's site. Make the SDK per request; it outlives none.
 */
export function handlerOf<S extends SDKClient>(
	map: ServiceMap,
	getSdk: SingleFlightSdk<S>,
	options: SingleFlightOptions = {},
): (request: Request) => Promise<Response> {
	const served: Served = {
		allowedOrigins: options.allowedOrigins,
		getSdk,
		limits: limitsOf(options),
		maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
		ops: operationsOf(map),
	}
	return (request) => handle(request, served)
}
