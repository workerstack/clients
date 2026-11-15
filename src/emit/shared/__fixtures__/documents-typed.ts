/**
 * The typed stream document every SDK's `*.typed.test.ts` legs compile and drive: the stream specs with declared
 * events and messages, merged, and the socket operations only a typed SDK reaches.
 */
import realtimeKeyed from "../../../ir/__fixtures__/specs/streams/realtime-keyed.json" with { type: "json" }
import realtimeMessages from "../../../ir/__fixtures__/specs/streams/realtime-messages.json" with { type: "json" }
import sseItemSchema from "../../../ir/__fixtures__/specs/streams/sse-item-schema.json" with { type: "json" }
import wsKeyed from "../../../ir/__fixtures__/specs/streams/ws-keyed.json" with { type: "json" }
import wsMessages from "../../../ir/__fixtures__/specs/streams/ws-messages.json" with { type: "json" }
import { merged } from "./merge.ts"

type Json = Readonly<Record<string, unknown>>

const STRING = { type: "string" }

/** One socket operation at `/tap`, `GET` answering 101, whose `x-websocket` is `socket`; realtime when `realtime`. */
const tap = (operationId: string, socket: Json, realtime = false): Json => ({
	info: { title: "Tap", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/tap": {
			get: {
				operationId,
				responses: { 101: { description: "Switching Protocols" } },
				...(realtime ? { "x-realtime": true } : {}),
				"x-websocket": socket,
			},
		},
	},
})

const said = (rest: Json, ...required: string[]): Json => ({ properties: rest, required, type: "object" })

/**
 * The typed stream documents as one: named SSE events (`sse`), WebSocket messages unkeyed and keyed (`ws`, `keyed`),
 * realtime messages unkeyed and keyed (`rt`, `room`), a keyed WebSocket union written inline (`inline`), a realtime
 * union whose only member is `message` (`only`), realtime messages holding an int64 and the resume cursor
 * (`count`), and a WebSocket that declares only what the server receives (`tell`).
 */
export function typedStreams(): Json {
	const inline = {
		send: {
			discriminator: { propertyName: "type" },
			oneOf: [
				said({ text: STRING, type: { const: "said" } }, "type", "text"),
				said({ type: { const: "left" } }, "type"),
			],
		},
	}
	const only = {
		send: { discriminator: { propertyName: "type" }, oneOf: [said({ type: { const: "message" } }, "type")] },
	}
	const count = {
		send: said({ id: STRING, n: { format: "int64", type: "integer" }, reconnect_token: STRING }, "n"),
	}
	const tell = { receive: said({ text: STRING }, "text") }
	return merged({
		sse: sseItemSchema,
		ws: wsMessages,
		keyed: wsKeyed,
		rt: realtimeMessages,
		room: realtimeKeyed,
		inline: tap("feed.join", inline),
		only: tap("feed.tap", only, true),
		count: tap("feed.count", count, true),
		tell: tap("feed.tell", tell),
	})
}
