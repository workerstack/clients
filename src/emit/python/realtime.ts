/**
 * A realtime operation's answer (contract 34 §2.0, §2.3; Fd3): `ResumableConnection[E]`, `E` the declared event
 * schema's type (`Any` for a string or absent one), opened by awaiting the method over WebSocket, else SSE, else
 * long-poll. Its one field is `transport: TransportOpts | None`: the resume cursor, the offered subprotocols and the
 * reconnect policy, which the connection advances in its own copy, so `rc.opts` resumes past the last message. A
 * declared param on a resume channel is carried by it, and one named `transport` is claimed as `transport2`
 * (`sdk-method.ts`).
 */
import { eventType, type PyStream } from "./sdk-answer.ts"
import { isLastEventIdHeader } from "./sse.ts"
import { pyTypeOf } from "./types.ts"
import { isReconnectToken } from "./ws.ts"

/** The realtime operation's answer, its one field and its docstring's lines. */
export const realtimeStream: PyStream = {
	answer: (op, env) => {
		const events = eventType(op, env, () => pyTypeOf({ kind: "unknown" }, env.at))
		return { returns: `ResumableConnection[${events}]`, run: "realtime", type: events }
	},
	/* the WebSocket and long-poll dials send the cursor as query params, the SSE dial its id as Last-Event-ID */
	carries: (name, where) =>
		isReconnectToken(name, where) ||
		(where === "query" && name === "last_event_id") ||
		isLastEventIdHeader(name, where),
	doc: [
		"Opens the connection over WebSocket, else SSE, else long-poll; recv() reconnects after a drop and",
		"resumes after the last message it delivered.",
	],
	fields: ["transport: TransportOpts | None = None"],
}
