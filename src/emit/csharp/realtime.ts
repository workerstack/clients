/**
 * A realtime operation's answer (contract 50 §2, Fd6, Fd7, D9): `Task<ResumableConnection<TIn, TOut>>`, opened by
 * awaiting the method over WebSocket, else SSE, else long-poll, given both types' infos. `TIn` is what the server
 * sends (`send`), else the declared event schema's type, else `JsonElement`; `TOut` what it receives (`receive`),
 * else `JsonElement`; each declared side as types-messages.ts writes it, and a keyed read side gets its `On<Value>`
 * extensions, none for a `message` member, which the connection's `Message` event names. An operation that declares
 * its messages opens through `TypedRealtimeAsync`, which refuses a message that is no JSON; any other through
 * `RealtimeAsync`, which reads it as a JSON string. Its one field is `TransportOptions? transport`: the resume
 * cursor, the offered subprotocols and the reconnect policy. The connection advances a copy, so the caller's value
 * stays as it was and `rc.Options` resumes past the last message. A declared param on a resume channel is carried
 * by it, and one named `transport` is claimed as `transport2` (`sdk-method.ts`).
 */
import type { SdkOp } from "../../ir/sdk-model.ts"
import { type CsAnswer, type CsStream, eventType } from "./sdk-answer.ts"
import type { MethodEnv, Spelling } from "./sdk-method.ts"
import { isLastEventIdHeader } from "./sse.ts"
import { JSON_ELEMENT } from "./types.ts"
import { messageType, type Reader, valueHandlers } from "./types-messages.ts"
import { isReconnectToken } from "./ws.ts"

/* the connection, and its own event: a member whose On<Value> it names gets none */
const READER: Reader = { base: "ResumableConnection", handlers: ["OnMessage"], receiver: "connection" }

/** The realtime operation `op`'s answer, its message types hoisted into `env.at`. */
function realtimeAnswer(op: SdkOp, env: MethodEnv): CsAnswer {
	const { receive, send } = op.ir.messages ?? {}
	const read = send === undefined ? undefined : messageType(op, send, "Send", env.at)
	const write = receive === undefined ? JSON_ELEMENT : messageType(op, receive, "Receive", env.at).type
	if (read !== undefined) valueHandlers(READER, read, env.at)
	const type = read?.type ?? (op.events === undefined ? JSON_ELEMENT : eventType(op.events, op, env))
	const run = send === undefined && receive === undefined ? "RealtimeAsync" : "TypedRealtimeAsync"
	return {
		infos: [type, write],
		render: (spell: Spelling) => [`Task<ResumableConnection<${spell.runtime(type)}, ${spell.runtime(write)}>>`, run],
		type: null,
	}
}

/** The realtime operation's answer, its one field and its `<returns>` text. */
export const realtimeStream: CsStream = {
	answer: realtimeAnswer,
	args: ["(transport ?? new()).Copy()"],
	/* the WebSocket and long-poll dials send the cursor as query params, the SSE dial its id as Last-Event-ID */
	carries: (name, where) =>
		isReconnectToken(name, where) ||
		(where === "query" && name === "last_event_id") ||
		isLastEventIdHeader(name, where),
	fields: [{ ident: "transport", type: "TransportOptions?" }],
	returns:
		"The connection over WebSocket, else SSE, else long-poll: it reconnects after a drop and resumes after the last message it delivered; the token, CloseAsync or DisposeAsync ends it.",
}
