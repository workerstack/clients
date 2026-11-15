/**
 * A realtime operation's answer (contract 50 §2, Fd6, Fd7): `Task<ResumableConnection<T>>` through `RealtimeAsync`,
 * `T` the declared event schema's type (`JsonElement` for a string or absent one), opened by awaiting the method over
 * WebSocket, else SSE, else long-poll. Its one field is `TransportOptions? transport`: the resume cursor, the offered
 * subprotocols and the reconnect policy. The connection advances a copy, so the caller's value stays as it was and
 * `rc.Options` resumes past the last message. A declared param on a resume channel is carried by it, and one named
 * `transport` is claimed as `transport2` (`sdk-method.ts`).
 */
import { type CsStream, eventType } from "./sdk-answer.ts"
import { isLastEventIdHeader } from "./sse.ts"
import { isReconnectToken } from "./ws.ts"

/** The realtime operation's answer, its one field and its `<returns>` text. */
export const realtimeStream: CsStream = {
	answer: (op, env) => {
		const type = op.events === undefined ? "JsonElement" : eventType(op.events, op, env)
		return {
			render: (spell) => [`Task<ResumableConnection<${spell.runtime(type)}>>`, "RealtimeAsync"],
			type,
		}
	},
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
