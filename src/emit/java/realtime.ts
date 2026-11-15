/**
 * A realtime operation's method (bit 16 phase d2b, R1/R8, D9; C#'s `realtime.ts`, Fd6/Fd7):
 * `ResumableConnection<TIn, TOut>`, `TIn` what the server sends (`send`), else the declared event schema's type, else
 * `JsonNode`, and `TOut` what it receives (`receive`), else `JsonNode`; an inline side is hoisted as `<Op>Send` or
 * `<Op>Receive`. A keyed read side (the sealed interface models-union.ts declares) with a member to handle answers
 * `<Read>Connection<TOut>`, whose `on<Value>` per member matches inside `onMessage`, none for a `message` member; its
 * name is claimed after the union's wrappers, as ws.ts claims a socket's. An op that declares its messages connects
 * through `Realtime.typed`, which refuses a message that is no JSON; any other through `Realtime.open`, which reads it
 * as a JSON string; either before the method returns, over WebSocket, else SSE, else long-poll. Its five fields are
 * `TransportOptions.of`'s: the resume cursor (`lastEventId`, `reconnectToken`), the offered `protocols` and the
 * reconnect policy (`maxReconnectAttempts`, `reconnectDelay`). The runtime puts the cursor on each dial, so none of
 * them is a Call arg; a declared `last_event_id` or `reconnect_token` query, or a Last-Event-ID header, folds in, and a
 * param spelled like a field claims `…2`. A realtime method is the same text in either mode: it answers no Result.
 */
import type { SdkOp } from "../../ir/sdk-model.ts"
import {
	call as callOf,
	type Declaration,
	type Expr,
	local,
	methodHeader,
	newOf,
	param,
	returnStmt,
	statement,
} from "./layout.ts"
import { declaredTypeOf, type JavaTypeContext, javaTypeOf, keyedArms } from "./models.ts"
import { JSON_NODE } from "./models-names.ts"
import { docOf } from "./sdk-decl.ts"
import { CURSOR, isLastEventIdHeader } from "./sse.ts"
import { handledArms, isReconnectTokenQuery, keyedReader, PROTOCOLS, type Reader, TOKEN } from "./ws.ts"

/** The reconnect policy's Params fields. */
export const MAX_RECONNECT_ATTEMPTS = "maxReconnectAttempts"
export const RECONNECT_DELAY = "reconnectDelay"

/** A realtime op's own fields in `TransportOptions.of`'s order, each with its Java type. */
export const REALTIME_FIELDS = [
	{ field: CURSOR, type: "String" },
	{ field: TOKEN, type: "String" },
	{ field: PROTOCOLS, type: "List<String>" },
	{ field: MAX_RECONNECT_ATTEMPTS, type: "java.lang.Integer" },
	{ field: RECONNECT_DELAY, type: "Duration" },
] as const

/** Whether a declared param is on a realtime resume channel the cursor fields carry (C#'s `carries`). */
export const carriesRealtime = (name: string, where: "query" | "header") =>
	where === "query" ? isReconnectTokenQuery(name) || name === "last_event_id" : isLastEventIdHeader(name)

/**
 * The realtime runtime's files: the connection, its loop and options, the transport contract and the three default
 * adapters; only an SDK with a realtime operation ships them (with the WebSocket files, which its WebSocket adapter dials
 * through).
 */
export const REALTIME_FILES = [
	"ConnectionState",
	"LongPollAdapter",
	"Realtime",
	"RealtimeLoop",
	"ResumableConnection",
	"SseAdapter",
	"TransportAdapter",
	"TransportConnection",
	"TransportKind",
	"TransportMessage",
	"TransportOptions",
	"WsAdapter",
]

/** The connection's reader: its own handler is onMessage. */
const CONNECTION: Reader = {
	base: "ResumableConnection",
	handlers: ["onMessage"],
	noun: "connection",
	suffix: "Connection",
}

/**
 * What a realtime method answers: its type, the type its messages decode to, whether they must be JSON (the op
 * declares its messages), and the wrap of the opened connection.
 */
export type RealtimeConnection = {
	readonly type: string
	readonly read: string
	readonly strict: boolean
	readonly wrap: (opened: Expr) => Expr
}

/** The opened connection as it is: one whose read side has no member to handle. */
const AS_OPENED = (opened: Expr) => opened

/**
 * What `op`'s realtime method answers: `ResumableConnection<TIn, TOut>`, `TIn` the declared read side's type, else
 * the event schema's, else `JsonNode`, `TOut` the declared write side's, else `JsonNode`; a keyed read side with a
 * member to handle answers its `<Read>Connection<TOut>`, wrapping the opened one.
 */
export function connectionOf(op: SdkOp, ctx: JavaTypeContext): RealtimeConnection {
	const messages = op.ir.messages
	const at = (fieldName: string) => ({ ...ctx, fieldName, parentName: op.id, path: "" })
	const strict = messages !== undefined
	const write = messages?.receive === undefined ? JSON_NODE : declaredTypeOf(messages.receive, at("Receive"))
	const plain = (read: string): RealtimeConnection => ({
		read,
		strict,
		type: `ResumableConnection<${read}, ${write}>`,
		wrap: AS_OPENED,
	})
	if (messages?.send === undefined) {
		const events = { ...ctx, fieldName: "Event", parentName: op.id }
		return plain(op.events === undefined ? JSON_NODE : javaTypeOf(op.events, events))
	}
	const read = declaredTypeOf(messages.send, at("Send"))
	const arms = keyedArms(read, messages.send, ctx)
	if (handledArms(CONNECTION, arms).length === 0) return plain(read)
	const sub = keyedReader(CONNECTION, read, arms, ctx)
	return { read, strict, type: `${sub}<${write}>`, wrap: (opened) => newOf(`${sub}<${write}>`, [opened]) }
}

/** What a realtime method's lines need: its name and constant, its Params, and its Call's lines. */
export type RealtimeSite = {
	readonly name: string
	readonly constant: string
	readonly params: string
	readonly call: readonly string[]
}

/** A realtime method's lines: `op(params)`, delegating to `op(params, options)`, which connects. */
export function realtimeMethodLines(op: SdkOp, site: RealtimeSite, ctx: JavaTypeContext): string[] {
	const { call, constant, name, params } = site
	const connection = connectionOf(op, ctx)
	const doc = docOf(
		`${op.id}: the connection over WebSocket, else SSE, else long-poll. It reconnects after a drop and resumes after the last message it delivered; close() ends it.`,
	)
	const signature = (args: readonly Declaration[]) =>
		methodHeader(2, { modifiers: ["public"], name, params: args, returns: connection.type })
	const transport = callOf(
		"TransportOptions",
		"of",
		REALTIME_FIELDS.map((f) => callOf("params", f.field)),
	)
	const open = callOf("Realtime", connection.strict ? "typed" : "open", [
		"exchange",
		constant,
		"call",
		"options",
		"transport",
		newOf(`TypeReference<${connection.read}>`, [], true),
	])
	return [
		doc,
		...signature([param(params, "params")]),
		...statement(4, returnStmt(callOf(null, name, ["params", "null"]))),
		"  }",
		"",
		doc,
		...signature([param(params, "params"), param("RequestOptions", "options")]),
		...call,
		...statement(4, local({ init: transport, name: "transport", type: "TransportOptions" })),
		...statement(4, returnStmt(connection.wrap(open))),
		"  }",
		"",
	]
}
