/**
 * A body to read whole: each chunk is offered to `take` first; the read stops once it refuses one or `signal`
 * aborts.
 */
export type BodySource = {
	body: ReadableStream<Uint8Array> | null
	signal?: AbortSignal
	take: (chunk: Uint8Array) => boolean
}

/** A body being read: its reader, the chunks kept so far, and what decides whether the next is kept. */
type Drain = { chunks: Uint8Array[]; reader: ReadableStreamDefaultReader<Uint8Array>; take: BodySource["take"] }

/** A settled cancel: a body is given up on whether or not its cancel succeeds. */
function nothing(): undefined {
	return undefined
}

/** `chunks` as one buffer. */
function joined(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
	let size = 0
	for (const chunk of chunks) size += chunk.byteLength
	const out = new Uint8Array(size)
	let at = 0
	for (const chunk of chunks) {
		out.set(chunk, at)
		at += chunk.byteLength
	}
	return out
}

/** Read `drain` to its end: false, with the body cancelled, once `take` refuses a chunk. */
async function drained(drain: Drain): Promise<boolean> {
	const next = await drain.reader.read()
	if (next.done) return true
	if (!drain.take(next.value)) {
		/* not awaited: the refusal stands whether or not the body cancels cleanly */
		void drain.reader.cancel().catch(nothing)
		return false
	}
	drain.chunks.push(next.value)
	return drained(drain)
}

/** `source`'s body read whole, or undefined once `take` refused a chunk; an abort cancels it where it stands. */
export async function bodyOf(source: BodySource): Promise<Uint8Array<ArrayBuffer> | undefined> {
	if (source.body === null) return new Uint8Array(0)
	const reader = source.body.getReader()
	function stop(): void {
		void reader.cancel().catch(nothing)
	}
	source.signal?.addEventListener("abort", stop, { once: true })
	try {
		const drain: Drain = { chunks: [], reader, take: source.take }
		return (await drained(drain)) ? joined(drain.chunks) : undefined
	} finally {
		source.signal?.removeEventListener("abort", stop)
	}
}
