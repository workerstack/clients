/**
 * A realtime operation with declared messages (the rich `x-websocket` beside `x-realtime`) in the Python SDK: its
 * connection is `ResumableConnection[Out, In]`, `Out` what the server sends and `In` what it receives, so `send`
 * takes only a member and a read gets the union; a union keyed on one field (D9) adds `on("<value>", handler)` per
 * member on a per-op `<Op>Connection`, except a `message` member, which reaches `on("message")` alone. Every message
 * reaches `on("message")` and the reader both. On the wire every send is JSON, and a message that is no JSON raises
 * from `recv()` while the connection reads on. An operation without messages reads `ResumableConnection[E, object]`,
 * `E` its event type, as before.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as streams from "../shared/__fixtures__/documents-streams.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { checked, consume } from "./__fixtures__/consumer.ts"
import { withPython } from "./__fixtures__/python-env.ts"
import { generatePythonSdk } from "./sdk.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }

type Json = Record<string, unknown>

const spec = (name: string) =>
	JSON.parse(
		readFileSync(join(import.meta.dirname, `../../ir/__fixtures__/specs/streams/${name}.json`), "utf8"),
	) as Json

/** A keyed realtime op whose union has a member keyed `message`, the one value a realtime `on` takes for itself. */
const CLASH: Json = {
	components: {
		schemas: {
			Message: {
				properties: { body: { type: "string" }, type: { const: "message" } },
				required: ["type", "body"],
				type: "object",
			},
			Feed: {
				discriminator: { propertyName: "type" },
				oneOf: [{ $ref: "#/components/schemas/Said" }, { $ref: "#/components/schemas/Message" }],
			},
			Said: {
				properties: { text: { type: "string" }, type: { const: "said" } },
				required: ["type", "text"],
				type: "object",
			},
		},
	},
	info: { title: "Clash", version: "1" },
	openapi: "3.2.1",
	paths: {
		"/feed": {
			get: {
				operationId: "feed.join",
				responses: { 101: { description: "Switching Protocols" } },
				"x-realtime": true,
				"x-websocket": { send: { $ref: "#/components/schemas/Feed" } },
			},
		},
	},
}

/** A keyed realtime op whose one member is keyed `message`: no member is left for a class of its own. */
const ONLY_MESSAGE: Json = {
	info: { title: "Only", version: "1" },
	openapi: "3.2.1",
	paths: {
		"/feed": {
			get: {
				operationId: "feed.join",
				responses: { 101: { description: "Switching Protocols" } },
				"x-realtime": true,
				"x-websocket": {
					send: {
						discriminator: { propertyName: "type" },
						oneOf: [
							{
								properties: { body: { type: "string" }, type: { const: "message" } },
								required: ["type", "body"],
								type: "object",
							},
						],
					},
				},
			},
		},
	},
}

/** The lines of `file` in the package for `document` that match `pattern`, each from `from` on. */
function lines(document: Json, file: string, pattern: RegExp, from = /^/): string[] {
	const text = generatePythonSdk(document).files[`src/http_sdk/${file}`] ?? ""
	return text
		.split("\n")
		.filter((line) => pattern.test(line))
		.map((line) => line.slice(line.search(from)).trim())
}

describe("a realtime operation with declared messages: its types", () => {
	it("answers ResumableConnection of what the server sends and receives, a keyed op its own connection class", () => {
		expect({
			keyed: lines(spec("realtime-keyed"), "client.py", /async def join\(/, /-> /),
			unkeyed: lines(spec("realtime-messages"), "client.py", /async def join\(/, /-> /),
			untyped: lines(streams.realtime(), "client.py", /async def \w+\(.*transport:/, /-> /),
		}).toEqual({
			keyed: ["-> RoomJoinConnection:"],
			unkeyed: ["-> ResumableConnection[RoomOut, RoomIn]:"],
			untyped: ["-> ResumableConnection[Payload, object]:", "-> ResumableConnection[Any, object]:"],
		})
	})

	it("keeps an op whose only member is keyed message on ResumableConnection, with no class", () => {
		expect({
			classes: lines(ONLY_MESSAGE, "types.py", /^class /),
			method: lines(ONLY_MESSAGE, "client.py", /async def join\(/, /-> /),
		}).toEqual({
			classes: ["class FeedJoinSendMessage(TypedDict):"],
			method: ["-> ResumableConnection[FeedJoinSendMessage, object]:"],
		})
	})

	it("writes the connection class: an on overload per member, then message, a message member left out", () => {
		expect({
			base: lines(spec("realtime-keyed"), "types.py", /^class RoomJoinConnection/),
			clash: lines(CLASH, "types.py", /def on\(/, /event: /),
			on: lines(spec("realtime-keyed"), "types.py", /def on\(/, /event: /),
		}).toEqual({
			base: ['class RoomJoinConnection(ResumableConnection["RoomOut", "RoomIn"]):'],
			clash: [
				'event: Literal["said"], handler: Callable[[Said], None]) -> None: ...',
				'event: Literal["message"], handler: Callable[[Feed], None]) -> None: ...',
				"event: str, handler: Callable[[Any], None]) -> None:",
			],
			on: [
				'event: Literal["said"], handler: Callable[[RoomSaid], None]) -> None: ...',
				'event: Literal["left"], handler: Callable[[RoomLeft], None]) -> None: ...',
				'event: Literal["message"], handler: Callable[[RoomOut], None]) -> None: ...',
				"event: str, handler: Callable[[Any], None]) -> None:",
			],
		})
	})
})

/** A program mypy checks against the `typed` package: what `send`, `recv` and `on` take. */
const TYPES = [
	"from typing import assert_type",
	"",
	"import http_sdk as sdk",
	"",
	"",
	"def said(m: sdk.RealtimeKeyedRoomSaid) -> None:",
	"    print(m['text'])",
	"",
	"",
	"def any_out(m: sdk.RealtimeKeyedRoomOut) -> None:",
	"    print(m)",
	"",
	"",
	"def plain_out(m: sdk.RealtimeMessagesRoomOut) -> None:",
	"    print(m['said'])",
	"",
	"",
	"async def run(c: sdk.AsyncSDK) -> None:",
	"    rc = await c.realtime_keyed.room.join()",
	"    await rc.send({'type': 'say', 'text': 'hi'})",
	"    await rc.send({'type': 'shout'})",
	"    assert_type(await rc.recv(), sdk.RealtimeKeyedRoomOut | None)",
	"    rc.on('said', said)",
	"    rc.on('message', any_out)",
	"    rc.on('message', said)",
	"    rc.on('close', said)",
	"    plain = await c.realtime_messages.room.join('r')",
	"    await plain.send({'say': 'x'})",
	"    assert_type(await plain.recv(), sdk.RealtimeMessagesRoomOut | None)",
	"    plain.on('message', plain_out)",
	"    plain.on('said', plain_out)",
]
/** The line of TYPES a finding is at, and its error code. */
const codeAt = (finding: string) => {
	const [, line, code] = /:(\d+): error: .*\[([a-z-]+)\]$/.exec(finding) ?? []
	return `${TYPES[Number(line) - 1]?.trim()} [${code}]`
}

describe.skipIf(!PY)("a realtime operation with declared messages under mypy", SLOW, () => {
	it("sends only a member, reads the union, narrows on(value) to its member, and refuses the rest", () => {
		const findings = checked("typed", `${TYPES.join("\n")}\n`)
		expect(findings.filter((line) => line.includes(": error: ")).map(codeAt)).toEqual([
			"await rc.send({'type': 'shout'}) [typeddict-item]",
			"rc.on('message', said) [call-overload]",
			"rc.on('close', said) [call-overload]",
			"plain.on('said', plain_out) [arg-type]",
		])
	})
})

/** Sends, reads and handler calls on the keyed room, noted in order. */
const ROOM = `async with aclient() as c:
    rc = await c.realtime_keyed.room.join()
    rc.on("message", lambda m: note(["message", m]))
    rc.on("said", lambda m: note(["said", m]))
    rc.on("left", lambda m: note(["left", m]))
    await rc.send({"type": "say", "text": "hi"})
    await rc.send("plain")
    note(["recv", await rc.recv()])
    try:
        await rc.recv()
    except sdk.DecodeError as error:
        note(["raised", str(error)])
    note(["recv", await rc.recv()])
    await rc.close()`

describe.skipIf(!PY)("a realtime operation with declared messages on the wire", SLOW, () => {
	it("sends JSON, hands a message to on(message) and on(value), and raises one that is no JSON, reading on", async () => {
		const reply: Reply = {
			status: 101,
			ws: {
				steps: [
					{ receive: 2 },
					{ json: { text: "yo", type: "said" } },
					{ text: "not json" },
					{ json: { type: "left" } },
				],
			},
		}
		const { received, run } = await served([reply], async (server) => ({
			run: await consume("typed", "keyed_room", { base: server.url, body: ROOM }),
			received: server.streams[0]?.received ?? [],
		}))
		expect({ out: run.out?.main?.map((line) => JSON.parse(line)), ran: run.ran }, run.stderr).toEqual({
			out: [
				["message", { text: "yo", type: "said" }],
				["said", { text: "yo", type: "said" }],
				["recv", { text: "yo", type: "said" }],
				["raised", "WebSocket frame is not valid JSON: Expecting value: line 1 column 1 (char 0)"],
				["message", { type: "left" }],
				["left", { type: "left" }],
				["recv", { type: "left" }],
			],
			ran: true,
		})
		expect(received.flatMap((frame) => (frame.kind === "text" ? [JSON.parse(frame.text)] : []))).toEqual([
			{ text: "hi", type: "say" },
			"plain",
		])
	})
})
