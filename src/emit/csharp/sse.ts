/**
 * An SSE operation's answer (contract 50 §2, Fd1, Fd4), opened by awaiting the method (G15). An operation that names
 * its events (D7) answers `Task<EventStream<<Op>Event>>` through `NamedEventsAsync` (D17): `<Op>Event` is an
 * abstract record with a private constructor and one nested sealed record per event name in the order declared,
 * each holding `Data` (JSON decoded by its name through the context, a string event's text as sent), `Event`, `Id`
 * and `Retry`, then `Unknown` for a name the operation does not declare, its data as sent; an unnamed event is
 * `message`. A nested name that is one of the record's members, a type its decode spells or the enclosing type
 * takes the suffix `Event`. Any other operation answers `Task<EventStream<SseEvent<T>>>` through `EventsAsync`, `T`
 * the declared event schema's type, or `Task<EventStream<SseEvent<string>>>` through `TextEventsAsync` for untyped
 * events. Its one field, `lastEventId`, is sent as Last-Event-ID only when set and non-empty; a declared
 * Last-Event-ID header param is folded into that field.
 */
import type { IRSseEvent } from "../../ir/model.ts"
import { isJsonEventData, type SdkOp, sseEvents } from "../../ir/sdk-model.ts"
import { csString } from "../shared/escape.ts"
import { csTypeName, NameScope } from "../shared/lang.ts"
import { type CsStream, eventType } from "./sdk-answer.ts"
import { docLines } from "./sdk-doc.ts"
import type { MethodEnv } from "./sdk-method.ts"
import { csTypeOf } from "./types.ts"

/** The header the SSE and realtime dials resume an event stream with. */
export const LAST_EVENT_ID = "Last-Event-ID"

/** The resume cursor's event id, which the SSE method takes. */
const LAST_EVENT_ID_FIELD = { ident: "lastEventId", type: "string?" }

/** Whether a declared param is the Last-Event-ID header (any casing), the resume channel an SSE dial sends. */
export const isLastEventIdHeader = (name: string, where: string) =>
	where === "header" && name.toLowerCase() === LAST_EVENT_ID.toLowerCase()

/* the names a nested record never takes: the members, and the types the decode spells */
const TAKEN = [
	/* a nested record's members */
	"Data",
	"Event",
	"Id",
	"Retry",
	"Of",
	/* every record's */
	"Deconstruct",
	"EqualityContract",
	"Equals",
	"Finalize",
	"GetHashCode",
	"GetType",
	"MemberwiseClone",
	"PrintMembers",
	"ToString",
	/* the decode's */
	"JsonSerializerOptions",
	"JsonTypeInfo",
	"SseEvent",
	"TimeSpan",
	"Transport",
]

/** One declared event as a nested record: the name it is sent under, its record, its data's type, and whether it is JSON. */
type Nested = { readonly event: string; readonly record: string; readonly data: string; readonly json: boolean }

/** The decode arm of `nested`: its data from JSON through the context, or as sent. */
const armOf = ({ data, event, json, record }: Nested) => {
	const value = json
		? `Transport.EventData(e.Data, (JsonTypeInfo<${data}>)options.GetTypeInfo(typeof(${data})))`
		: "e.Data"
	return `            ${csString(event)} => new ${record}(${value}, ${csString(event)}, e.Id, e.Retry),`
}

/** A nested record's declaration: its data, then the event's name, id and retry. */
const recordOf = (record: string, data: string, name: string) =>
	`    public sealed record ${record}(${data} Data, string Event, string? Id, TimeSpan? Retry) : ${name};`

/** `<Op>Event`, hoisted into `env.at.decls` (never listed) with its nested records and its decode; its name. */
function namedEvents(op: SdkOp, events: readonly IRSseEvent[], env: MethodEnv): string {
	const { at } = env
	const name = at.names.claim(`${csTypeName(op.id)}Event`)
	at.unlisted.add(name)
	const typed = events.map(({ data, name: event }) => {
		const json = isJsonEventData(data, at.names.resolve)
		/* the decode throws on null, so the data is never null */
		const type = json ? csTypeOf(data, { ...at, fieldName: event, parentName: op.id }).replace(/\?$/, "") : "string"
		if (json) at.serialized.add(type)
		return { data: type, event, json }
	})
	/* a type a record's data spells would be shadowed by a nested record of its name */
	const spelled = typed.flatMap(({ data }) => data.split(/\W+/).filter((word) => word !== ""))
	const reserved = new Set([...TAKEN, ...spelled, name, "Unknown"])
	const scope = new NameScope(reserved)
	const nested = typed.map((t): Nested => {
		const base = csTypeName(t.event)
		return { ...t, record: scope.claim(reserved.has(base) ? `${base}Event` : base) }
	})
	const list = nested.map(({ record }) => record).join(", ")
	at.decls.set(
		name,
		[
			...docLines(
				"summary",
				`One event of ${op.id}: ${list}, or Unknown for a name the operation does not declare, its data as sent. An is match reads the event's data.`,
			),
			`public abstract record ${name}`,
			"{",
			`    private ${name}()`,
			"    {",
			"    }",
			"",
			...nested.map(({ data, record }) => recordOf(record, data, name)),
			recordOf("Unknown", "string", name),
			"",
			`    internal static ${name} Of(SseEvent<string> e, JsonSerializerOptions options) =>`,
			'        (e.Event is null or "" ? "message" : e.Event) switch',
			"        {",
			...nested.map(armOf),
			"            var named => new Unknown(e.Data, named, e.Id, e.Retry),",
			"        };",
			"}",
		].join("\n"),
	)
	return name
}

/** The SSE operation's answer, its one field and its `<returns>` text. */
export const sseStream: CsStream = {
	answer: (op, env) => {
		const named = sseEvents(op.ir)
		if (named !== undefined) {
			const name = namedEvents(op, named, env)
			return { args: [`${name}.Of`], render: () => [`Task<EventStream<${name}>>`, "NamedEventsAsync"], type: null }
		}
		const type = op.events === undefined ? null : eventType(op.events, op, env)
		return {
			render: (spell) =>
				type === null
					? ["Task<EventStream<SseEvent<string>>>", "TextEventsAsync"]
					: [`Task<EventStream<SseEvent<${spell.runtime(type)}>>>`, "EventsAsync"],
			type,
		}
	},
	args: ["lastEventId"],
	carries: isLastEventIdHeader,
	fields: [LAST_EVENT_ID_FIELD],
	returns:
		"The open stream: an error status throws before any event. No timeout bounds it after that; the token, leaving await foreach or DisposeAsync ends it.",
}
