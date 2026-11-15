/**
 * A tool's outputSchema (bit 18 phase d, D1): from its operation's success answer as the TS SDK picks it, when that is
 * JSON with a schema. An object schema goes as it is. Any other shape is wrapped `{result}`, since structuredContent is
 * an object (2025-11-25), and so is an answer whose operation declares response headers (Q11), as `{result, headers}`:
 * a body key named `headers` then never meets them. Each header is a string, as it arrives. No JSON success schema
 * means no outputSchema: the result is text only. An event stream's collect (phase e) is `{events, last_event_id,
 * ended}`, each event's data its declared schema, else a string. A stream that names its events (D7) types each event
 * by its name, as the TS SDK yields it: the names sharing one data schema are one `anyOf` member, `event` their const
 * (one name) or enum (several), and a last member takes a name the operation does not declare, its data the raw text.
 */
import type { IR, IRSseEvent } from "../../ir/model.ts"
import { type SdkOp, sseEvents } from "../../ir/sdk-model.ts"
import { irResolver } from "../../ir/schema.ts"
import { jsonSchemaOf, type JsonSchema } from "./schema.ts"

/** A tool's outputSchema, and whether its structuredContent wraps the answer. */
export type Output = { readonly outputSchema: JsonSchema; readonly wrap?: true }

const STRING: JsonSchema = { type: "string" }

/** An event of a stream that does not name its events: its data as `data` says, its name and id when it has them. */
const unnamedOf = (data: JsonSchema): JsonSchema => ({
	type: "object",
	properties: { data, event: STRING, id: STRING },
	required: ["data"],
})

/**
 * An event of a stream that names `events` (D7). An event whose data is JSON is one `anyOf` member per distinct data
 * schema, `event` its const (one name) or enum (several). Any other event's data arrives as its text, so one string
 * member holds the rest, declared or not; `event` names every declared name as an example.
 */
function namedOf(events: readonly IRSseEvent[], ir: IR): JsonSchema {
	const resolve = irResolver(ir.schemas)
	const groups = new Map<string, { readonly data: JsonSchema; readonly names: string[] }>()
	const names: string[] = []
	for (const { data, name } of events) {
		if (!names.includes(name)) names.push(name)
		const schema = resolve(data).kind === "unknown" ? STRING : jsonSchemaOf(data, ir.schemas)
		const key = JSON.stringify(schema)
		if (key === JSON.stringify(STRING)) continue
		const group = groups.get(key) ?? { data: schema, names: [] }
		if (!group.names.includes(name)) group.names.push(name)
		groups.set(key, group)
	}
	const event = { type: "string", examples: names }
	const required = ["data", "event"]
	if (groups.size === 0) return { type: "object", properties: { data: STRING, event, id: STRING }, required }
	const members = [...groups.values()].map((group) => ({
		properties: {
			event: group.names.length === 1 ? { const: group.names[0] } : { enum: group.names },
			data: group.data,
		},
	}))
	return {
		type: "object",
		properties: { event, id: STRING },
		required,
		anyOf: [...members, { properties: { data: STRING } }],
	}
}

/** What a collect gathered, each event as `item` says. */
const collectedOf = (item: JsonSchema): JsonSchema => ({
	type: "object",
	properties: {
		events: { type: "array", items: item },
		last_event_id: { anyOf: [{ type: "string" }, { type: "null" }] },
		ended: { type: "string", enum: ["end", "max_events", "cap", "timeout"] },
	},
	required: ["events", "last_event_id", "ended"],
})

/** The outputSchema `op`'s success answer gives, or none. */
export function outputOf(op: SdkOp, ir: IR): Output | undefined {
	if (op.stream === "sse") {
		const named = sseEvents(op.ir)
		if (named !== undefined) return { outputSchema: collectedOf(namedOf(named, ir)) }
		return {
			outputSchema: collectedOf(unnamedOf(op.events === undefined ? STRING : jsonSchemaOf(op.events, ir.schemas))),
		}
	}
	/* the SDK model gives a success its schema only when it is JSON */
	if (op.success.schema === undefined) return undefined
	const result = jsonSchemaOf(op.success.schema, ir.schemas)
	const names = [...new Set((op.ir.responses[op.success.status]?.headers ?? []).map(({ name }) => name.toLowerCase()))]
	if (result.type === "object" && names.length === 0) return { outputSchema: result }
	/* null-prototype: a header named __proto__ is a property, never the object's prototype */
	const headers: Record<string, JsonSchema> = Object.create(null) as Record<string, JsonSchema>
	for (const name of names.sort()) headers[name] = { type: "string" }
	const properties = names.length === 0 ? { result } : { result, headers: { type: "object", properties: headers } }
	return { outputSchema: { type: "object", properties, required: ["result"] }, wrap: true }
}
