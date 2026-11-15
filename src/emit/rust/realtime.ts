/**
 * A realtime operation's answer (contract 20 §2.0, §2.3): `ResumableConnection<E>`, `E` the declared event
 * schema's type (`serde_json::Value` for a string or absent one), opened before the call resolves over
 * WebSocket, else SSE, else long-poll. Its Opts carry the resume cursor, the offered subprotocols and the
 * reconnect policy as one `transport: TransportOpts`; a declared param on a resume channel is folded into it.
 */
import type { SdkOp } from "../../ir/sdk-model.ts"
import type { StreamAnswer, StreamOpts } from "./sdk-opts.ts"
import { eventType, isLastEventIdHeader } from "./sse.ts"
import type { RustTypeContext } from "./types.ts"
import { isReconnectToken } from "./ws.ts"

/* the WebSocket and long-poll dials send the cursor as query params, the SSE dial its id as Last-Event-ID */
const REALTIME: StreamOpts = {
	carries: (param, where) =>
		isReconnectToken(param, where) ||
		(where === "query" && param === "last_event_id") ||
		isLastEventIdHeader(param, where),
	fields: [
		{ doc: "The resume cursor, offered subprotocols and reconnect policy.", ident: "transport", type: "TransportOpts" },
	],
	sends: [],
}

const DOC =
	"Resolves once the connection is open over WebSocket, else SSE, else long-poll; `recv` reconnects after a drop and resumes after the last message it delivered. `cancel_on` ends it quietly; dropping it closes it."

/** The realtime operation `op`'s answer. */
export function realtimeAnswer(op: SdkOp, at: RustTypeContext): StreamAnswer {
	const events = eventType(op, at, "serde_json::Value")
	const run = `crate::realtime_loop::connect::<${events}>(opts.transport.clone())`
	return { doc: DOC, run, stream: REALTIME, type: `ResumableConnection<${events}>` }
}
