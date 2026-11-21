import type { FreshReads, SingleFlightBatch, SingleFlightConfig } from "./config.ts"
import { ClientError, DecodeError } from "./error.ts"
import { AUTH_TOKEN, type HTTPClient, REFRESH_AUTH } from "./http.ts"
import { isJsonMediaType, parseMediaType } from "./media-type.ts"
import { requestSignal } from "./request.ts"
import type { Sent } from "./response.ts"
import { targetsOf } from "./sdk-invalidate.ts"
import {
	BATCH_VERSION,
	DEFAULT_FLIGHT_PATH,
	DEFAULT_MAX_READS,
	MAX_WRITE_STATUS,
	MIN_WRITE_STATUS,
	NO_BODY_STATUSES,
	REFUSED,
	REFUSED_STATUS,
	UNAUTHORIZED_STATUS,
	WRITE_METHODS,
} from "./sdk-single-flight.constants.ts"
import type { CallInput, ServiceEntry } from "./sdk.ts"

/** The input a call keeps to itself: a write sent with any goes direct. */
const DIRECT_KEYS = ["baseURL", "body", "cookies", "form", "headers"] as const

/** One eligible write: its config and the batch it sends. */
export type Flight = { batch: SingleFlightBatch; config: SingleFlightConfig }

/** The client a write is sent by: its single-flight config, its HTTP client and its dispose signal. */
export type FlightClient = { config: SingleFlightConfig | undefined; disposal: AbortSignal; http: HTTPClient }

/** One eligible write as it is sent: the client, the batch and the call's input. */
type FlightCall = { disposal: AbortSignal; flight: Flight; http: HTTPClient; input: CallInput }

/** What a batch brought back: the write's answer, rebuilt, and the reads, by id. */
export type Flown = { fresh: FreshReads; sent: Sent }

/** Whether `entry` never goes in a batch under `config`: no REST JSON write with reads, or one it excludes. */
function isDirectEntry(config: SingleFlightConfig, entry: ServiceEntry): boolean {
	if (!WRITE_METHODS.includes(entry.method) || entry.accept !== undefined || entry.call !== undefined) return true
	return entry.empty === true || config.exclude?.includes(entry.id) === true || (entry.reads?.length ?? 0) === 0
}

/** Whether a call with `input` goes direct: it opts out, wants the raw answer, or sets what a batch cannot carry. */
function isDirectInput(input: CallInput): boolean {
	if (input.singleFlight === false || input.raw === true) return true
	return DIRECT_KEYS.some((key) => input[key] !== undefined)
}

/** The write's input as a batch carries it: only what the handler takes, an idempotent write's key included. */
function batchInput(entry: ServiceEntry, input: CallInput): SingleFlightBatch["input"] {
	const out: SingleFlightBatch["input"] = {}
	if (input.params !== undefined) out.params = input.params
	if (input.search !== undefined) out.search = input.search
	if (input.json !== undefined) out.json = input.json
	if (entry.idempotent === true && input.idempotencyKey !== undefined) out.idempotencyKey = input.idempotencyKey
	return out
}

/** The batch `entry` called with `input` sends under `config`, or none when it goes direct. */
function flightOf(config: SingleFlightConfig | undefined, entry: ServiceEntry, input: CallInput): Flight | undefined {
	if (config === undefined || isDirectEntry(config, entry) || isDirectInput(input)) return undefined
	const picked = config.select(targetsOf(entry.reads ?? [], input.params))
	const reads = picked.slice(0, Math.max(config.maxReads ?? DEFAULT_MAX_READS, 0))
	if (reads.length === 0) return undefined
	return { batch: { input: batchInput(entry, input), op: entry.id, reads, v: BATCH_VERSION }, config }
}

/** Whether `value` is an object whose keys can be read. */
function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Whether `value` is text. */
function isString(value: unknown): value is string {
	return typeof value === "string"
}

/** Whether `body` is a handler's refusal problem. */
function isRefusal(body: unknown): body is { type: typeof REFUSED } {
	return isObject(body) && "type" in body && body.type === REFUSED
}

/** `promise`, or the abort of `signal` first. */
function raced<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return promise
	return new Promise<T>((resolve, reject) => {
		function onAbort(): void {
			reject(signal?.reason)
		}
		signal.addEventListener("abort", onAbort, { once: true })
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
	})
}

/** What `send` resolves: what the batch got back, a stand-in Response its read errors carry. */
async function sentBy(send: NonNullable<SingleFlightConfig["send"]>, call: FlightCall) {
	const { done, signal } = requestSignal([call.input.signal, call.disposal], call.input.timeout)
	try {
		signal?.throwIfAborted()
		return { response: new Response(null), value: await raced(send(call.flight.batch), signal) }
	} finally {
		done()
	}
}

/** What one sending of the batch got back, and its response; undefined for a refusal. */
async function sendOnce(call: FlightCall) {
	const { config, batch } = call.flight
	if (config.send !== undefined) return sentBy(config.send, call)
	const opts = { json: batch, signal: call.input.signal, timeout: call.input.timeout }
	try {
		const answer = await call.http.requestOperation({ method: "POST", opts, path: config.path ?? DEFAULT_FLIGHT_PATH })
		return { response: answer.response, value: answer.data }
	} catch (e) {
		if (e instanceof ClientError && e.status === REFUSED_STATUS && isRefusal(e.body)) return undefined
		throw e
	}
}

/** The write's answer of an envelope. */
type EnvelopeWrite = { body: unknown; headers: Readonly<Record<string, string>>; status: number }

/** An envelope as the client reads it: the write's answer and each read's entry, still unread. */
type Envelope = { reads: readonly unknown[]; write: EnvelopeWrite }

/** One read's entry that came back with data. */
type AnsweredRead = { data: unknown; id: string }

/** Whether `value` is the write's answer: a status 200 to 599, headers of strings, and a body. */
function isWrite(value: unknown): value is EnvelopeWrite {
	if (!isObject(value) || !("body" in value) || !("headers" in value) || !("status" in value)) return false
	const { headers, status } = value
	if (typeof status !== "number" || !Number.isInteger(status)) return false
	if (status < MIN_WRITE_STATUS || status > MAX_WRITE_STATUS) return false
	return isObject(headers) && Object.values(headers).every(isString)
}

/** Whether `value` is an envelope of the one batch version. */
function isEnvelope(value: unknown): value is Envelope {
	if (!isObject(value) || !("v" in value) || !("write" in value) || !("reads" in value)) return false
	return value.v === BATCH_VERSION && isWrite(value.write) && Array.isArray(value.reads)
}

/** Whether `value` is a read's entry that came back with data. */
function isAnswered(value: unknown): value is AnsweredRead {
	return isObject(value) && "data" in value && "id" in value && isString(value.id)
}

/** What came back as an envelope; a DecodeError, carrying `response`, when it is none. */
function envelopeOf(got: { response: Response; value: unknown }): Envelope {
	if (isEnvelope(got.value)) return got.value
	const { response } = got
	const message = "Single-flight answer is no version 1 envelope"
	throw new DecodeError({ body: null, message, response, status: response.status })
}

/** The reads `flight` asked for that `envelope` brought back by id, and those it did not. */
function freshOf(envelope: Envelope, flight: Flight): FreshReads {
	const data = new Map<string, unknown>()
	for (const read of envelope.reads) if (isAnswered(read)) data.set(read.id, read.data)
	const failed = new Set(flight.batch.reads.map((read) => read.id).filter((id) => !data.has(id)))
	return { data, failed }
}

/** The write's answer as the Response a direct call would have read. */
function responseOf(write: EnvelopeWrite): Response {
	const isJson = isJsonMediaType(parseMediaType(write.headers["content-type"]))
	let body: string | null = null
	if (!NO_BODY_STATUSES.includes(write.status) && write.body !== null)
		body = isString(write.body) && !isJson ? write.body : JSON.stringify(write.body)
	return new Response(body, { headers: write.headers, status: write.status })
}

/** What a batch brought back, the write's answer as a Sent with nothing to release. */
function flownOf(envelope: Envelope, flight: Flight): Flown {
	const response = responseOf(envelope.write)
	const sent = {
		done: () => undefined,
		exemptFromTimeout: () => undefined,
		failed: (cause: unknown) => cause,
		response,
	}
	return { fresh: freshOf(envelope, flight), sent }
}

/**
 * Send `entry` called with `input` in a single-flight batch when it is eligible, and read its envelope: the write's
 * answer and the reads brought back. Undefined when the call goes direct, or the handler refused the batch. A write's
 * 401 refreshes the token once, as a direct call's does, and sends the batch again.
 */
export async function fly(client: FlightClient, entry: ServiceEntry, input: CallInput): Promise<Flown | undefined> {
	const flight = flightOf(client.config, entry, input)
	if (flight === undefined) return undefined
	const call = { disposal: client.disposal, flight, http: client.http, input }
	const token = client.http[AUTH_TOKEN]
	const got = await sendOnce(call)
	if (got === undefined) return undefined
	const envelope = envelopeOf(got)
	if (envelope.write.status !== UNAUTHORIZED_STATUS || !(await client.http[REFRESH_AUTH](token)))
		return flownOf(envelope, flight)
	const again = await sendOnce(call)
	return again === undefined ? undefined : flownOf(envelopeOf(again), flight)
}
