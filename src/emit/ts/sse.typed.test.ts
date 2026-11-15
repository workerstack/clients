/**
 * A named-event SSE operation (an OpenAPI 3.2 `itemSchema` the IR reads into `events`) in the TS SDK: its events a
 * union keyed on `event`, each `data` typed, and on the wire each JSON event parsed by its name while a string event
 * stays text. An unnamed event is `message`, as `EventSource` names it; an operation without `events` is as before.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as morph from "ts-morph"
import { afterEach, describe, expect, it, vi } from "vitest"
import { consumerChecker, doc } from "./__fixtures__/consumer-types.ts"
import { emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"
import { generateSdk } from "./sdk.ts"

type Json = Record<string, unknown>

const EVENTS = JSON.parse(
	readFileSync(join(import.meta.dirname, "../../ir/__fixtures__/specs/streams/sse-item-schema.json"), "utf8"),
) as Json
const PLAIN = doc({
	"/events": {
		get: {
			operationId: "events.stream",
			responses: { 200: { content: { "text/event-stream": { schema: { type: "string" } } }, description: "" } },
		},
	},
})
const check = consumerChecker(morph)

/** An event-stream response of `text`. */
const eventStream = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } })

/** Every event `stream` of the SDK over `document` yields for the wire `text`. */
async function eventsOf(document: Json, call: (sdk: any) => AsyncIterable<unknown>, text: string) {
	const { TestSDK } = await emittedSdk(document)
	const { fetch } = recordingFetch(() => eventStream(text))
	const sdk = new (TestSDK as new (config: Json) => unknown)({ baseURL: "https://api.test", fetch })
	const out: unknown[] = []
	for await (const event of call(sdk)) out.push(event)
	return out
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("a named-event SSE operation's types", () => {
	it("writes the member line as a stream of SSEEventOf its events, in the order declared", () => {
		const { files, stem } = generateSdk(EVENTS, { name: "TestSDK" })
		const types = files[`${stem}.types.gen.ts`] ?? ""
		expect(types.match(/"?stream"?: HttpStream<.*>/g)).toEqual([
			"stream: HttpStream<{}, SSEEventOf<{ beat: number }>>",
			"stream: HttpStream<{}, SSEEventOf<{ tick: Tick; message: string }>>",
		])
	})

	it("types each event by its name: narrowing on event types data, and event is required", () => {
		const consumer = `type E = ReturnType<typeof sdk.ticks.stream> extends AsyncIterable<infer V> ? V : never
expectType<Equal<E, { data: { at: number }; event: "tick"; id?: string; retry?: number } | { data: string; event: "message"; id?: string; retry?: number }>>()
async function read() {
	for await (const e of sdk.ticks.stream()) {
		if (e.event === "tick") {
			const at: number = e.data.at
			void at
		} else {
			const text: string = e.data
			void text
		}
		// @ts-expect-error data is a Tick only once event is "tick"
		const unnarrowed: number = e.data.at
		void unnarrowed
		// @ts-expect-error "tock" is no event the operation declares
		if (e.event === "tock") void 0
	}
	for await (const b of sdk.beats.stream()) {
		const n: number = b.data
		void n
	}
}
void read`
		expect(check(EVENTS, consumer)).toEqual([])
	})

	it("keeps an operation without events as before: SSEEvent, event optional", () => {
		const consumer = `type E = ReturnType<typeof sdk.events.stream> extends AsyncIterable<infer V> ? V : never
expectType<Equal<E, { data: string; event?: string; id?: string; retry?: number }>>()`
		expect(check(PLAIN, consumer)).toEqual([])
	})
})

describe("a named-event SSE operation on the wire", () => {
	it("parses a JSON event by its name, keeps a string event as text, names an unnamed one message", async () => {
		const wire = 'event: tick\ndata: {"at":1}\nid: 1\n\ndata: plain\n\nevent: other\ndata: {"x":1}\n\n'
		expect(await eventsOf(EVENTS, (sdk) => sdk.ticks.stream(), wire)).toEqual([
			{ data: { at: 1 }, event: "tick", id: "1" },
			{ data: "plain", event: "message", id: "1" },
			{ data: '{"x":1}', event: "other", id: "1" },
		])
	})

	it("parses a number event's data, and fails the stream on a JSON event that does not parse", async () => {
		expect(await eventsOf(EVENTS, (sdk) => sdk.beats.stream(), "event: beat\ndata: 42\n\n")).toEqual([
			{ data: 42, event: "beat" },
		])
		await expect(eventsOf(EVENTS, (sdk) => sdk.beats.stream(), "event: beat\ndata: nope\n\n")).rejects.toThrow(
			"SSE an event is not valid JSON",
		)
	})

	it("leaves an operation without events as before: data text, an unnamed event with no event", async () => {
		expect(await eventsOf(PLAIN, (sdk) => sdk.events.stream(), "data: hi\n\nevent: x\ndata: y\n\n")).toEqual([
			{ data: "hi" },
			{ data: "y", event: "x" },
		])
	})
})
