import { ClientError } from "./error.ts"
import { type Answer, parseBody } from "./response.ts"
import type { CallInput, SDKClient, ServiceEntry } from "./sdk.ts"
import type { FlightBatch, FlightOp, FlightRead } from "./single-flight-batch.ts"
import { bodyOf } from "./single-flight-body.ts"
import {
	BATCH_VERSION,
	FIRST_SUCCESS,
	LAST_SUCCESS,
	NO_ANSWER_STATUS,
	TIMED_OUT_STATUS,
} from "./single-flight.constants.ts"

/** How far the reads of one batch may go: their count, their time and their bytes in all. */
export type FlightLimits = { maxReadBytes: number; maxReads: number; readBudgetMs: number }

/** The write's answer: its status, `content-type` and declared headers, and its body. */
export type SingleFlightWrite = { body: unknown; headers: Record<string, string>; status: number }

/** A read that failed: the status it ended in, and the API's error body when it fit the byte budget. */
export type SingleFlightReadError = { body?: unknown; status: number }

/** One read's entry: its data, or the error it ended in. */
export type SingleFlightRead = { data: unknown; id: string } | { error: SingleFlightReadError; id: string }

/** The one answer a batch gets: the write's, then each read's in the order asked. */
export type SingleFlightEnvelope = { reads: SingleFlightRead[]; v: typeof BATCH_VERSION; write: SingleFlightWrite }

/** A batch run: its envelope, and the write's `Set-Cookie` values, apart. */
export type Flown = { cookies: string[]; envelope: SingleFlightEnvelope }

/** A REST call of the SDK, as `raw` makes it: its Response, unread. */
type RawCall = (input: CallInput) => Promise<Response>

/** The SDK as a walk over it sees it: a Proxy over the map's namespaces, each key a namespace or a call. */
type SdkMember = { readonly [key: string]: SdkMember | undefined }

/** What every read of a batch shares: the time left, as one signal, and the bytes left. */
type ReadRun = { budget: { left: number }; signal: AbortSignal }

/** Each read refetches past any cache. */
const NO_CACHE = { "cache-control": "no-cache" }

/** Whether `value` may hold members: an SDK namespace, a Proxy over the map's keys. */
function isMember(value: unknown): value is SdkMember {
	return (typeof value === "object" || typeof value === "function") && value !== null
}

/** Whether `value` is a call: the SDK's members at a map entry are functions. */
function isCall(value: unknown): value is RawCall {
	return typeof value === "function"
}

/** The SDK member at `path`: the call the service map names there, made with `raw` to answer its Response. */
function callOf(sdk: SDKClient, path: readonly string[]): RawCall {
	let member: unknown = sdk
	for (const key of path) member = isMember(member) ? member[key] : undefined
	if (!isCall(member)) throw new TypeError(`single-flight: the SDK has no call at ${path.join(".")}`)
	return member
}

/** The write's headers the envelope carries: `content-type` and the ones its entry declares, never any other. */
function headersOf(response: Response, entry: ServiceEntry) {
	const names = ["content-type", ...(entry.headers ?? [])]
	return Object.fromEntries(
		names.flatMap((name) => {
			const value = response.headers.get(name)
			return value === null ? [] : [[name, value]]
		}),
	)
}

/** The write's Response and its decoded body, of any status; a throw when it got no answer at all. */
async function answerOf(sdk: SDKClient, op: FlightOp, input: CallInput): Promise<Answer> {
	try {
		const response = await callOf(sdk, op.path)({ ...input, raw: true })
		const data = await parseBody(response, op.entry.method, op.entry.empty === true ? null : op.entry.accept)
		return { data, response }
	} catch (e) {
		if (!(e instanceof ClientError) || e.status === 0)
			throw new Error("single-flight: the write got no answer", { cause: e })
		return { data: e.body, response: e.response }
	}
}

/** The write run once with its input and its own Idempotency-Key. */
async function write(sdk: SDKClient, op: FlightOp, input: CallInput): Promise<Flown> {
	const { data, response } = await answerOf(sdk, op, input)
	const envelope: SingleFlightEnvelope = {
		reads: [],
		v: BATCH_VERSION,
		write: { body: data, headers: headersOf(response, op.entry), status: response.status },
	}
	return { cookies: response.headers.getSetCookie(), envelope }
}

/** `promise`, or the signal's reason once it aborts first. */
function within<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
	const aborted = new Promise<never>((_resolve, reject) => {
		if (signal.aborted) reject(signal.reason)
		signal.addEventListener("abort", () => reject(signal.reason), { once: true })
	})
	return Promise.race([promise, aborted])
}

/** `response`'s body, each chunk taken from what is left of the run's bytes; cancelled past it or at the deadline. */
async function counted(response: Response, run: ReadRun): Promise<Uint8Array<ArrayBuffer>> {
	function take(chunk: Uint8Array): boolean {
		run.budget.left -= chunk.byteLength
		return run.budget.left >= 0 && !run.signal.aborted
	}
	const bytes = await bodyOf({ body: response.body, signal: run.signal, take })
	if (bytes === undefined || run.signal.aborted) throw new RangeError("over the read budget")
	return bytes
}

/** The error a read that failed with `e` gets: the API's status and body when it answered, else ours. */
function errorOf(e: ClientError | undefined, run: ReadRun): SingleFlightReadError {
	if (e === undefined || e.status === 0) return { status: run.signal.aborted ? TIMED_OUT_STATUS : NO_ANSWER_STATUS }
	const size = e.body === null ? 0 : new TextEncoder().encode(JSON.stringify(e.body)).byteLength
	if (size === 0 || size > run.budget.left) return { status: e.status }
	run.budget.left -= size
	return { body: e.body, status: e.status }
}

/** One read: sent with no-cache and the run's signal, its body counted, then decoded; an error entry when it fails. */
async function read(sdk: SDKClient, entry: FlightRead, run: ReadRun): Promise<SingleFlightRead> {
	try {
		const input = { ...entry.input, headers: NO_CACHE, raw: true, signal: run.signal }
		const response = await within(run.signal, callOf(sdk, entry.op.path)(input))
		const bytes = await counted(response, run)
		const decoded = new Response(bytes, { headers: response.headers, status: response.status })
		return { data: await parseBody(decoded, entry.op.entry.method), id: entry.id }
	} catch (e) {
		return { error: errorOf(e instanceof ClientError ? e : undefined, run), id: entry.id }
	}
}

/** The reads, in parallel, cut at the time budget, sharing the byte budget; in the order asked. */
async function readAll(
	sdk: SDKClient,
	reads: readonly FlightRead[],
	limits: FlightLimits,
): Promise<SingleFlightRead[]> {
	const deadline = new AbortController()
	const timer = setTimeout(
		() => deadline.abort(new Error("single-flight: the read budget ran out")),
		limits.readBudgetMs,
	)
	const run: ReadRun = { budget: { left: limits.maxReadBytes }, signal: deadline.signal }
	try {
		return await Promise.all(reads.map((entry) => read(sdk, entry, run)))
	} finally {
		clearTimeout(timer)
	}
}

/** Run `batch` on `sdk`: the write once, then, only when it answered 2xx, the reads. */
export async function fly(sdk: SDKClient, batch: FlightBatch, limits: FlightLimits): Promise<Flown> {
	const flown = await write(sdk, batch.write, batch.input)
	const { status } = flown.envelope.write
	if (status < FIRST_SUCCESS || status > LAST_SUCCESS) return flown
	flown.envelope.reads = await readAll(sdk, batch.reads, limits)
	return flown
}
