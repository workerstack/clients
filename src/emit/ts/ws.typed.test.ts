/**
 * A WebSocket operation with declared messages (the rich `x-websocket` the IR reads into `messages`) in the TS SDK:
 * `send` takes what the server receives, `on("message")` gets what it sends, and a union keyed on one field adds
 * `on(value)` per member (D9). On the wire every send is JSON and every text frame is parsed; a frame that is no JSON
 * reaches `on("error")`. A scripted `WebSocket` stands in for the browser's.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as morph from "ts-morph"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { consumerChecker, doc } from "./__fixtures__/consumer-types.ts"
import { emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"
import { FakeSocket } from "./__fixtures__/fake-socket.ts"
import { generateSdk } from "./sdk.ts"

type Json = Record<string, unknown>
type Socket = { on(event: string, handler: (...args: never[]) => void): void; send(data: unknown): void }

const spec = (name: string) =>
	JSON.parse(
		readFileSync(join(import.meta.dirname, `../../ir/__fixtures__/specs/streams/${name}.json`), "utf8"),
	) as Json
const KEYED = spec("ws-keyed")
const MESSAGES = spec("ws-messages")
const UPGRADE = spec("ws-upgrade-params")
const check = consumerChecker(morph)

/** The socket member lines of the SDK over `document`. */
function memberLines(document: Json) {
	const { files, stem } = generateSdk(document, { name: "TestSDK" })
	return (files[`${stem}.types.gen.ts`] ?? "").match(/"?open"?\(.*\): TypedWebSocket.*/g)
}

/** A socket op at `path` with the rich `x-websocket` `messages`. */
const socketAt = (path: string, messages: Json) => ({
	[path]: {
		get: { operationId: `${path.slice(1)}.open`, responses: { 101: { description: "" } }, "x-websocket": messages },
	},
})

/** A socket that declares no messages, and one whose server only receives. */
const BARE = doc({ ...socketAt("/bare", {}), ...socketAt("/hears", { receive: { type: "string" } }) })

/** The `chat.open` socket of the SDK over `document`, and the scripted socket under it, opened. */
async function open(document: Json, op: "chat" | "notes" = "chat"): Promise<{ raw: FakeSocket; socket: Socket }> {
	const { TestSDK } = (await emittedSdk(document)) as unknown as {
		TestSDK: new (config: Json) => Record<string, { open: () => Socket }>
	}
	const sdk = new TestSDK({ baseURL: "https://api.test", fetch: recordingFetch().fetch })
	const socket = (sdk[op] as { open: () => Socket }).open()
	const raw = FakeSocket.sockets.at(-1) as FakeSocket
	raw.accept()
	return { raw, socket }
}

/** What `socket` hands each of `events`, in order, as `[event, ...args]`. */
function heard(socket: Socket, events: readonly string[]): unknown[][] {
	const out: unknown[][] = []
	for (const event of events) socket.on(event, (...args: never[]) => out.push([event, ...args]))
	return out
}

beforeEach(() => {
	FakeSocket.sockets = []
	vi.stubGlobal("WebSocket", FakeSocket)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("a WebSocket operation with declared messages: its types", () => {
	it("writes the member line with what it sends, what it hears, and the key it dispatches on", () => {
		expect([memberLines(KEYED), memberLines(BARE)]).toEqual([
			[
				'open(input?: WsOptions): TypedWebSocket<ChatIn, ChatOut, "type">',
				"open(input?: WsOptions): TypedWebSocket<WsFrame, Note>",
			],
			["open(input?: WsOptions): TypedWebSocket", "open(input?: WsOptions): TypedWebSocket<string>"],
		])
	})

	it("sends only a member, narrows on(value) to it, and hands on(message) the whole union", () => {
		const consumer = `const chat = sdk.chat.open()
chat.send({ type: "say", text: "hi" })
chat.send({ type: "ping" })
// @ts-expect-error "shout" is no message the server receives
chat.send({ type: "shout" })
// @ts-expect-error a typed socket sends a member, not text
chat.send("hi")
chat.on("said", (m) => {
	const text: string = m.text
	void text
})
chat.on("message", (m) => {
	expectType<Equal<typeof m, { type: "said"; text: string } | { type: "close"; reason: string }>>()
})
chat.on("close", (code: number, reason: string) => void [code, reason])
// @ts-expect-error "left" is no value the server sends
chat.on("left", () => {})
const notes = sdk.notes.open()
notes.on("message", (n) => {
	expectType<Equal<typeof n, { body: string } | string>>()
})
notes.send("anything")
// @ts-expect-error an unkeyed union gets no on(value)
notes.on("body", () => {})`
		expect(check(KEYED, consumer)).toEqual([])
	})

	it("keeps an unkeyed send schema to on(message) alone", () => {
		const consumer = `const chat = sdk.chat.open()
chat.on("message", (m) => {
	const text: string = m.text
	void text
})
chat.send({ type: "leave" })`
		expect(check(MESSAGES, consumer)).toEqual([])
	})

	it("takes no headers or cookies, which a browser socket cannot send, though the upgrade declares them", () => {
		const consumer = `void sdk.chat({ params: { id: "1" } })
// @ts-expect-error a WebSocket call takes no headers
void sdk.chat({ headers: { "x-tenant": "t" }, params: { id: "1" } })
// @ts-expect-error a WebSocket call takes no cookies
void sdk.chat({ cookies: { session: "s" }, params: { id: "1" } })`
		expect(check(UPGRADE, consumer)).toEqual([])
	})
})

describe("a WebSocket operation with declared messages: on the wire", () => {
	it("sends every value as JSON, a string too", async () => {
		const { raw, socket } = await open(KEYED, "chat")
		socket.send({ text: "hi", type: "say" })
		socket.send("hi")
		expect(raw.sent).toEqual(['{"text":"hi","type":"say"}', '"hi"'])
	})

	it("hands a JSON frame to on(message) parsed and to on(value) by its key, never to a lifecycle event", async () => {
		const { raw, socket } = await open(KEYED)
		const out = heard(socket, ["message", "said", "close", "error"])
		raw.receive('{"type":"said","text":"hi"}')
		raw.receive('{"type":"close","reason":"bye"}')
		expect(out).toEqual([
			["message", { text: "hi", type: "said" }],
			["said", { text: "hi", type: "said" }],
			["message", { reason: "bye", type: "close" }],
		])
	})

	it("hands a text frame that is no JSON to on(error), and nothing to on(message)", async () => {
		const { raw, socket } = await open(KEYED)
		const out = heard(socket, ["message", "error"])
		raw.receive("not json")
		const message = expect.stringMatching(/^WebSocket frame is not valid JSON: /)
		expect(out).toEqual([["error", expect.objectContaining({ message })]])
	})

	it("parses frames for an unkeyed send schema and dispatches no value", async () => {
		const { raw, socket } = await open(KEYED, "notes")
		const out = heard(socket, ["message", "body"])
		raw.receive('{"body":"b"}')
		raw.receive('"plain"')
		expect(out).toEqual([
			["message", { body: "b" }],
			["message", "plain"],
		])
	})
})
