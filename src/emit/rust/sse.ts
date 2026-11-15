/**
 * An SSE operation's answer (contract 20 §2.0–2.1) and its Opts' `last_event_id`, sent as Last-Event-ID only
 * when set and non-empty; a declared Last-Event-ID header param is folded into that field (Fd3). An operation that
 * names its events (D7) answers `EventStream<<Op>Event>`: an enum with one variant per event name, holding
 * `SseEvent<Data>` decoded by its name, and `Unknown(SseEvent<String>)` for a name it does not declare; it serializes
 * as the `SseEvent` it holds (`{data, event, id, retry}`), so one reader takes any stream's events. Any other answers
 * `EventStream<SseEvent<T>>`, `T` the declared event schema's type, or `EventStream` for untyped events.
 */
import type { IRSchema, IRSseEvent } from "../../ir/model.ts"
import { isJsonEventData, type SdkOp, sseEvents } from "../../ir/sdk-model.ts"
import { lineComment, rustString } from "../shared/escape.ts"
import { NameScope, rustTypeIdent } from "../shared/lang.ts"
import { typeAt } from "./sdk-body.ts"
import type { OptsField, StreamAnswer, StreamOpts } from "./sdk-opts.ts"
import type { RustTypeContext } from "./types.ts"
import { variantOf } from "./types-enum.ts"

/** The resume cursor's id, which the SSE and realtime Opts carry. */
export const LAST_EVENT_ID = { ident: "last_event_id", type: "Option<String>" }

/** Whether a declared param is the Last-Event-ID header (any casing), the resume channel an SSE dial sends. */
export const isLastEventIdHeader = (param: string, where: OptsField["in"]) =>
	where === "header" && param.toLowerCase() === "last-event-id"

/** The type of the events `op` declares as `events`. */
export const eventType = (op: SdkOp, events: IRSchema, at: RustTypeContext) => typeAt(events, op.id, "Event", at)

/* Last-Event-ID, sent only when set: an empty cursor names no position */
const SSE: StreamOpts = {
	carries: isLastEventIdHeader,
	fields: [LAST_EVENT_ID],
	sends: ['spec.header("Last-Event-ID", &crate::request::cursor(&opts.last_event_id));'],
}

const DOC =
	"Resolves once the stream is open: an error status is the answer's error (`Err(Error::Api)`, on `client.safe()` an `Answer::Err`). No timeout bounds the stream after that; `cancel_on` ends it quietly, and dropping it closes it."

/** One declared event as a variant: the name it is sent under, its variant and its data's type. */
type Variant = { readonly event: string; readonly variant: string; readonly data: string; readonly json: boolean }

/** The match arm decoding `variant`: its data from JSON, or the event as sent. */
const armOf = ({ event, json, variant }: Variant) =>
	`            ${rustString(event)} => ${json ? `crate::events::named_data(e).map(Self::${variant})` : `Ok(Self::${variant}(e))`},`

/** `<Op>Event`, declared in `at` with its variants in the order declared and its decode; its name. */
function namedEvents(op: SdkOp, events: readonly IRSseEvent[], at: RustTypeContext): string {
	const name = at.names.claim(`${rustTypeIdent(op.id)}Event`)
	const scope = new NameScope(["Unknown"])
	const variants = events.map(({ data, name: event }): Variant => ({
		data: typeAt(data, op.id, event, at),
		event,
		json: isJsonEventData(data, at.names.resolve),
		variant: variantOf(event, scope),
	}))
	const list = variants.map((v) => `\`${v.variant}\``).join(", ")
	at.decls.set(
		name,
		[
			...lineComment(
				`One event of ${op.id}: ${list}, or \`Unknown\` for a name the operation does not declare, its data as sent. A match on it reads the event's data; it serializes as the \`SseEvent\` it holds.`,
				"///",
			),
			"#[derive(Debug, Clone, PartialEq, serde::Serialize)]",
			"#[serde(untagged)]",
			`pub enum ${name} {`,
			...variants.map((v) => `    ${v.variant}(crate::SseEvent<${v.data}>),`),
			"    Unknown(crate::SseEvent<String>),",
			"}",
			"",
			`impl crate::events::Named for ${name} {`,
			"    fn named(mut e: crate::SseEvent) -> Result<Self, crate::Error> {",
			"        if e.event.is_empty() {",
			'            e.event = "message".to_owned();',
			"        }",
			"        match e.event.as_str() {",
			...variants.map(armOf),
			"            _ => Ok(Self::Unknown(e)),",
			"        }",
			"    }",
			"}",
		].join("\n"),
	)
	return name
}

/** The SSE operation `op`'s answer: its events by name, else as text or JSON decoded into the event type. */
export function sseAnswer(op: SdkOp, at: RustTypeContext): StreamAnswer {
	const named = sseEvents(op.ir)
	if (named !== undefined) {
		const name = namedEvents(op, named, at)
		return { doc: DOC, run: `crate::events::named::<${name}>`, stream: SSE, type: `EventStream<${name}>` }
	}
	if (op.events === undefined) return { doc: DOC, run: "crate::events::text", stream: SSE, type: "EventStream" }
	const events = eventType(op, op.events, at)
	return { doc: DOC, run: `crate::events::json::<${events}>`, stream: SSE, type: `EventStream<SseEvent<${events}>>` }
}
