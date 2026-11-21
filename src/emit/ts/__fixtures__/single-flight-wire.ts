/**
 * The single-flight handler cases' wire (beside single-flight.ts): the requests a case sends the handler, the fake
 * API's scripted answers (big, hung, failed, met only in parallel), and readers of the handler's refusal and envelope.
 */
import { API, APP, type Envelope, type ReadEntry, type Route, type Routes } from "./single-flight.ts"

/** What a case sends the handler: a batch, or a string sent as it is. */
export type Sent = object | string

/** A POST of `body` (JSON-encoded unless a string) to the handler, as JSON, with `headers` over that. */
export function post(body: Sent, headers: Readonly<Record<string, string>> = {}): Request {
	return new Request(`${APP}/api/_mutate`, {
		body: typeof body === "string" ? body : JSON.stringify(body),
		headers: { "content-type": "application/json", ...headers },
		method: "POST",
	})
}

/** `bytes` as a stream of 1 KiB slices, counting in `pulled` how many bytes were taken. */
function sliced(bytes: Uint8Array, pulled: { bytes: number }): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (pulled.bytes >= bytes.length) return controller.close()
			const slice = bytes.subarray(pulled.bytes, pulled.bytes + 1024)
			pulled.bytes += slice.length
			controller.enqueue(slice)
		},
	})
}

/** A POST of `body`, streamed in 1 KiB chunks with no Content-Length; `pulled` counts what the handler took. */
export function streamedPost(body: object, pulled: { bytes: number } = { bytes: 0 }): Request {
	return new Request(`${APP}/api/_mutate`, {
		body: sliced(new TextEncoder().encode(JSON.stringify(body)), pulled),
		duplex: "half",
		headers: { "content-type": "application/json" },
		method: "POST",
	} as /* `duplex` is in undici's RequestInit, not yet in lib.dom's */ RequestInit)
}

/** A refusal's status, media type and problem `type`, to compare with `refusal()`. */
export async function problemOf(response: Response): Promise<{ contentType: string | null; status: number; type: unknown }> {
	const text = await response.text()
	const type = response.headers.get("content-type")?.includes("json") ? (JSON.parse(text) as { type?: unknown }).type : text
	return { contentType: response.headers.get("content-type"), status: response.status, type }
}

/** A valid JSON answer of a `bytes`-byte string, streamed in 1 KiB slices; `pulled` counts what was taken. */
export function bigJson(bytes: number, pulled: { bytes: number }): Response {
	const text = new TextEncoder().encode(JSON.stringify("x".repeat(bytes - 2)))
	return new Response(sliced(text, pulled), { headers: { "content-type": "application/json" } })
}

/** An answer that never comes unless the request is aborted, then rejects as fetch does. */
export function never(request: Request): Promise<Response> {
	return new Promise((_resolve, reject) => {
		request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
	})
}

/** Two routes that each answer their path only once the other's request was sent: met only when sent together. */
export function meeting(first: string, second: string): Routes {
	const arrived = new Set<string>()
	const waiting: Array<() => void> = []
	function route(key: string, other: string): Route {
		return async (request) => {
			arrived.add(key)
			for (const wake of waiting.splice(0)) wake()
			while (!arrived.has(other)) await new Promise<void>((resolve) => waiting.push(resolve))
			return Response.json({ path: new URL(request.url).pathname })
		}
	}
	return { [first]: route(first, second), [second]: route(second, first) }
}

/** The envelope a 200 answer holds. */
export async function envelopeFrom(response: Response): Promise<Envelope> {
	return (await response.json()) as Envelope
}

/** The read entry at `index`; a case that names one fails here when it is missing. */
export function entryAt(envelope: Envelope, index: number): ReadEntry {
	const entry = envelope.reads[index]
	if (entry === undefined) throw new Error(`the envelope has no read ${index}: ${JSON.stringify(envelope)}`)
	return entry
}

/**
 * Each read entry as `<id>: data` or `<id>: error(<its fields>)`, its status checked to be an integer: what a case
 * compares an entry by when its error's status is the runtime's own choice.
 */
export function outcomes(envelope: Envelope): string[] {
	return envelope.reads.map(({ error, id, ...rest }) => {
		const held = Object.keys(rest).sort().join(",")
		if (error === undefined) return `${id}: ${held}`
		const fields = Object.keys(error).sort().join(",")
		return `${id}: ${held === "" ? "" : `${held} `}error(${Number.isInteger(error.status) ? fields : "no status"})`
	})
}

/** The write answers a conflict. */
export function conflict(): Response {
	return Response.json({ error: "taken" }, { status: 409 })
}

/** A read answers not found. */
export function missing(): Response {
	return Response.json({ error: "missing" }, { status: 404 })
}

/** The network fails, its message naming the upstream. */
export function failed(): Promise<Response> {
	return Promise.reject(new TypeError(`fetch failed: ${API}/users secret-host`))
}

/** A JSON answer that does not decode. */
export function broken(): Response {
	return new Response("{not json", { headers: { "content-type": "application/json" } })
}
