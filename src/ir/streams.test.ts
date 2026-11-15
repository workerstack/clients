import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "./build.ts"

const SPECS = join(import.meta.dirname, "__fixtures__/specs/streams")

/** The operations `toIR` reads from the streams fixture `name`, by id. */
function opsOf(name: string) {
	const document = JSON.parse(readFileSync(join(SPECS, `${name}.json`), "utf8")) as OpenApiDocument
	return Object.fromEntries(toIR(document).operations.map((op) => [op.id, op]))
}

const ref = (name: string) => ({ kind: "ref", name })
const string = { kind: "scalar", type: "string" }

describe("toIR: an OpenAPI 3.2 document", () => {
	it("reads a 3.2.1 operation as it reads a 3.1 one", () => {
		const { "health.get": op } = opsOf("openapi-3.2")
		expect([op?.method, op?.responses["200"]?.contentType, op?.responses["200"]?.schema?.kind]).toEqual([
			"GET",
			"application/json",
			"object",
		])
	})
})

describe("toIR: SSE itemSchema events", () => {
	it("names each event by its event const, message when it has none, and reads data from contentSchema first", () => {
		const ops = opsOf("sse-item-schema")
		expect({
			beats: ops["beats.stream"]?.responses["200"]?.events,
			sse: [ops["ticks.stream"]?.extensions.sse, ops["ticks.stream"]?.responses["200"]?.schema],
			ticks: ops["ticks.stream"]?.responses["200"]?.events,
		}).toEqual({
			beats: [{ data: { kind: "scalar", type: "integer" }, name: "beat" }],
			sse: [true, undefined],
			ticks: [
				{ data: ref("Tick"), name: "tick" },
				{ data: string, name: "message" },
			],
		})
	})
})

describe("toIR: the rich x-websocket", () => {
	it("marks the operation a websocket and keeps receive and send, a discriminated union kept by its ref", () => {
		const { "chat.open": op } = opsOf("ws-messages")
		expect([op?.extensions, op?.messages]).toEqual([
			{ websocket: true },
			{ receive: ref("ClientFrame"), send: ref("ServerFrame") },
		])
	})

	it("keeps the upgrade's path, header and cookie params beside the messages", () => {
		const { chat: op } = opsOf("ws-upgrade-params")
		expect({
			cookie: op?.params.cookie?.map(({ name }) => name),
			ext: op?.extensions,
			header: op?.params.header.map(({ name }) => name),
			messages: op?.messages,
			path: op?.params.path.map(({ name }) => name),
		}).toEqual({
			cookie: ["session"],
			ext: { websocket: true },
			header: ["x-tenant"],
			messages: { receive: string, send: string },
			path: ["id"],
		})
	})

	it("reads x-realtime beside the rich x-websocket's messages", () => {
		const { "room.join": op } = opsOf("realtime-messages")
		expect([op?.extensions, op?.messages]).toEqual([
			{ realtime: true, websocket: true },
			{ receive: ref("RoomIn"), send: ref("RoomOut") },
		])
	})
})

describe("toIR: a malformed stream shape is ignored, never refused", () => {
	it("drops a non-object itemSchema, member, event const or direction; a member with no properties is a message of unknown data", () => {
		const ops = opsOf("malformed")
		expect({
			badDirections: ops["ws.badDirections"]?.messages,
			badMembers: ops["sse.badMembers"]?.responses["200"]?.events,
			notObject: ops["sse.notObject"]?.responses["200"]?.events,
			receiveOnly: [ops["ws.receiveOnly"]?.extensions, ops["ws.receiveOnly"]?.messages],
		}).toEqual({
			badDirections: { send: string },
			badMembers: [
				{ data: string, name: "kept" },
				{ data: { kind: "unknown" }, name: "message" },
			],
			notObject: undefined,
			receiveOnly: [{ websocket: true }, { receive: string }],
		})
	})
})
