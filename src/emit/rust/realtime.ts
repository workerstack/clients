/**
 * A realtime operation's answer (contract 20 §2.0, §2.3): `ResumableConnection<In, Out>`, opened before the call
 * resolves over WebSocket, else SSE, else long-poll. `In` is what the server sends (`send`), else the declared event
 * schema's type, `Out` what it receives (`receive`), an inline union hoisted as `<Op>Send` or `<Op>Receive`; an op
 * without them keeps the defaults, `serde_json::Value` read from JSON else text. A read side keyed on one field (D9)
 * gets an `on_<value>` per member but `message`. Its Opts carry the resume cursor, the offered subprotocols and the
 * reconnect policy as one `transport: TransportOpts`; a declared param on a resume channel is folded into it.
 */
import type { SdkOp } from "../../ir/sdk-model.ts";
import type { StreamAnswer, StreamOpts } from "./sdk-opts.ts";
import { eventType, isLastEventIdHeader } from "./sse.ts";
import type { RustTypeContext } from "./types.ts";
import { isReconnectToken, messageType, typeParams, valueHandlers } from "./ws.ts";

// the WebSocket and long-poll dials send the cursor as query params, the SSE dial its id as Last-Event-ID
const REALTIME: StreamOpts = {
  carries: (param, where) =>
    isReconnectToken(param, where) ||
    (where === "query" && param === "last_event_id") ||
    isLastEventIdHeader(param, where),
  fields: [
    { doc: "The resume cursor, offered subprotocols and reconnect policy.", ident: "transport", type: "TransportOpts" },
  ],
  sends: [],
};

const DOC =
  "Resolves once the connection is open over WebSocket, else SSE, else long-poll; `recv` reconnects after a drop and resumes after the last message it delivered. `cancel_on` ends it quietly; dropping it closes it.";

/** The realtime operation `op`'s answer, its message types hoisted into `at`. */
export function realtimeAnswer(op: SdkOp, at: RustTypeContext): StreamAnswer {
  const { receive, send } = op.ir.messages ?? {};
  const read = send && messageType(op, send, "Send", at);
  const write = receive && messageType(op, receive, "Receive", at);

  if (send !== undefined && read !== undefined)
    valueHandlers("ResumableConnection", ["on_message"], { schema: send, type: read }, at);
  // declared messages are JSON: one that is not is an error; an event type or none reads text too
  const loop = read === undefined && write === undefined ? "connect" : "typed";

  const params = typeParams(
    read ?? (op.events === undefined ? undefined : eventType(op, op.events, at)),
    write,
    "serde_json::Value",
  );

  const run = `crate::realtime_loop::${loop}(opts.transport.clone())`;

  return { doc: DOC, run, stream: REALTIME, type: `ResumableConnection${params}` };
}
