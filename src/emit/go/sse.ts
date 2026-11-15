/**
 * A server-sent-events operation as a Go method (G12), opened when ranged. An operation that names its events (D7)
 * returns `iter.Seq2[<Op>Event, error]`: a sealed interface (D16) with one type per event name, each embedding
 * `SSEEvent[Data]` and decoded by its name, and `<Op>OtherEvent` for a name it does not declare. Any other returns
 * `iter.Seq2[SSEEvent[T], error]`, `T` the type of the declared event schema (`string` when the events are untyped).
 * `<Op>Opts.LastEventID` resumes it as the Last-Event-ID header, which also carries a declared Last-Event-ID header
 * param (Fd3). An error status at the opening is the stream's error value; its `Client.Safe()` twin opens the stream
 * on the call and answers that status as its Result's Err (bit 21 i3).
 */
import type { IRSseEvent } from "../../ir/model.ts"
import { isJsonEventData, type SdkOp, sseEvents } from "../../ir/sdk-model.ts"
import { goString, lineComment } from "../shared/escape.ts"
import { goExported } from "../shared/lang.ts"
import { type GoStream, sendArgs } from "./sdk-answer.ts"
import type { OptsField, StreamOpts } from "./sdk-opts.ts"
import { type GoTypeContext, goTypeOf } from "./types.ts"

/** Whether a declared param is the Last-Event-ID header (any casing), the resume channel an SSE dial sends. */
export const isLastEventIdHeader = (param: string, where: OptsField["in"]) =>
	where === "header" && param.toLowerCase() === "last-event-id"

/* LastEventID, sent only when set: an empty header would still name a position */
const SSE_OPTS: StreamOpts = {
	before: [],
	carries: isLastEventIdHeader,
	fields: [{ name: "LastEventID", type: "string" }],
	sets: ['if opts.LastEventID != "" {', '\tc.headers["Last-Event-ID"] = opts.LastEventID', "}"],
}

const DOC = "Breaking out of the loop closes the stream; ctx ends it quietly."

/** A stream method yielding `elem`, each event read off the wire by `decode`, as sent without one (G12). */
const streamOf = (elem: string, decode: string | undefined, calls: readonly string[]): GoStream => ({
	calls,
	doc: DOC,
	opts: SSE_OPTS,
	shape: {
		fail: `sseFail[${elem}](err)`,
		returns: `iter.Seq2[${elem}, error]`,
		tail: (client) => [
			decode === undefined
				? `\treturn streamText(${sendArgs(client)})`
				: `\treturn streamEvents(${sendArgs(client, decode)})`,
		],
	},
})

/** One declared event as its Go type: the name it is sent under, its type's name and its `Data` type. */
type Variant = { readonly event: string; readonly type: string; readonly data: string; readonly json: boolean }

/** A type of the sealed `iface`, embedding `SSEEvent[data]`, with its marker method. */
const variantDecl = (iface: string, type: string, data: string, doc: string) => [
	...lineComment(doc, "//"),
	`type ${type} struct {`,
	`\tSSEEvent[${data}]`,
	"}",
	"",
	`func (${type}) is${iface}() {}`,
]

/** The `case` of the decoder for `variant`: its data decoded from JSON, or its event as sent. */
const caseOf = ({ event, json, type, data }: Variant) => [
	`\tcase ${goString(event)}:`,
	...(json
		? [`\t\tev, err := sseData[${data}](raw)`, `\t\treturn ${type}{ev}, err`]
		: [`\t\treturn ${type}{raw}, nil`]),
]

/**
 * `<Op>Event` and its types, declared in one block in `at` (the interface, a type per event name in the order
 * declared, `<Op>OtherEvent`, the decoder); the interface's name and the decoder's.
 */
function namedEvents(op: SdkOp, events: readonly IRSseEvent[], at: GoTypeContext): { iface: string; decode: string } {
	const base = goExported(op.id)
	const iface = at.names.claimConst(`${base}Event`)
	const variants = events.map(({ data, name }): Variant => ({
		data: goTypeOf(data, { ...at, fieldName: name, parentName: op.id }).replace(/^\*/, ""),
		event: name,
		json: isJsonEventData(data, at.names.resolve),
		type: at.names.claimConst(`${base}${goExported(name)}Event`),
	}))
	const other = at.names.claimConst(`${base}OtherEvent`)
	const decode = at.names.claimConst(`decode${iface}`)
	const types = [...variants.map((variant) => variant.type), other]
	at.decls.set(
		iface,
		[
			...lineComment(
				`${iface} is one event of ${op.id}: ${types.slice(0, -1).join(", ")}, or ${other} for a name the operation does not declare. A type switch on it reads the event's Data.`,
				"//",
			),
			`type ${iface} interface {`,
			"\t// Untyped is the event with its Data as text.",
			"\tUntyped() SSEEvent[string]",
			`\tis${iface}()`,
			"}",
			"",
			...variants.flatMap((variant) => [
				...variantDecl(iface, variant.type, variant.data, `${variant.type} is the ${goString(variant.event)} event.`),
				"",
			]),
			...variantDecl(
				iface,
				other,
				"string",
				`${other} is an event of a name the operation does not declare, its Data as sent.`,
			),
			"",
			`// ${decode} is raw as its event's type, its Data decoded by its name; an unnamed event is "message".`,
			`func ${decode}(raw SSEEvent[string]) (${iface}, error) {`,
			'\tif raw.Event == "" {',
			'\t\traw.Event = "message"',
			"\t}",
			"\tswitch raw.Event {",
			...variants.flatMap(caseOf),
			"\t}",
			`\treturn ${other}{raw}, nil`,
			"}",
		].join("\n"),
	)
	return { decode, iface }
}

/** The method of the SSE operation `op`, its event types hoisted into `at`. */
export function sseStream(op: SdkOp, at: GoTypeContext): GoStream {
	const events = sseEvents(op.ir)
	if (events !== undefined) {
		const { decode, iface } = namedEvents(op, events, at)
		return streamOf(iface, decode, [decode])
	}
	const typed = op.events && goTypeOf(op.events, { ...at, fieldName: "Event", parentName: op.id }).replace(/^\*/, "")
	if (typed === undefined) return streamOf("SSEEvent[string]", undefined, [])
	return streamOf(`SSEEvent[${typed}]`, `sseData[${typed}]`, [])
}
