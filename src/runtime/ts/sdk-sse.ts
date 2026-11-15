import type { RequestMeta } from "./config.ts"
import { ClientError } from "./error.ts"
import { interpolatePath } from "./path.ts"
import type { RequestOptions } from "./request.ts"
import { type Answer, resultOf } from "./response.ts"
import { type OperationCall, optionsFor, type SdkCore, type ServiceEntry, templateOf } from "./sdk.ts"
import type { SSEEvent } from "./sse.ts"
import { later, openStream } from "./stream.ts"

/** `event` with its `data` parsed as JSON; data that does not parse fails the stream, naming the event. */
function parsed(event: SSEEvent): SSEEvent<unknown> {
	try {
		return { ...event, data: JSON.parse(event.data) }
	} catch (e) {
		const name = event.id === undefined ? "an event" : `event ${JSON.stringify(event.id)}`
		const message = `SSE ${name} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
		throw new ClientError({ body: event.data, message, response: Response.error(), status: 0 })
	}
}

/**
 * The events of `events` as `entry` reads them: each parsed (`"json"`); or, for a stream that names its events, each
 * named `message` when it has no name and parsed when `sse` holds its name; else as they came.
 */
function eventsOf(events: AsyncIterable<SSEEvent>, sse: ServiceEntry["sse"]): AsyncIterable<SSEEvent<unknown>> {
	if (sse === "json") return mapEvents(events, parsed)
	if (typeof sse !== "object") return events
	return mapEvents(events, (raw) => {
		const event = { ...raw, event: raw.event ?? "message" }
		return sse.includes(event.event) ? parsed(event) : event
	})
}

/** `events`, each through `map`. */
function mapEvents(
	events: AsyncIterable<SSEEvent>,
	map: (event: SSEEvent) => SSEEvent<unknown>,
): AsyncIterable<SSEEvent<unknown>> {
	return {
		async *[Symbol.asyncIterator]() {
			for await (const event of events) yield map(event)
		},
	}
}

/** An SSE op opened: its stale view for the hooks, and its `x-invalidate` targets marked once the answer is ok. */
async function open(core: SdkCore, entry: ServiceEntry, input: RequestOptions): Promise<Answer> {
	const opts = optionsFor(entry, input)
	const template = templateOf(entry)
	let selector: string | undefined
	let meta: RequestMeta | undefined
	try {
		const path = interpolatePath(template, input.params)
		selector = `${entry.method} ${path}`
		meta = core.meta(selector, path, entry.method)
	} catch {
		/* a bad param fails the stream when it is sent, as for any call */
	}
	const onOpen = () => {
		if (selector !== undefined) core.mark(entry, input.params, selector)
	}
	const { data, response } = await openStream(core.http, { meta, method: entry.method, onOpen, opts, path: template })
	return { data: eventsOf(data, entry.sse), response }
}

/** An event stream: sent when iterated, or opened into a Result by the safe twin. */
export const sseOp: OperationCall = (core, entry, safe) => {
	const opened = (input?: RequestOptions) => open(core, entry, input ?? {})
	return safe
		? (input?: RequestOptions) => resultOf(opened(input))
		: (input?: RequestOptions) => later(() => opened(input))
}
