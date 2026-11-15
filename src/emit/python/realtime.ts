/**
 * A realtime operation's answer (contract 34 §2.0, §2.3; Fd3): `ResumableConnection[Out, In]`, opened by awaiting the
 * method over WebSocket, else SSE, else long-poll. `Out` is what the server sends (its declared `send`, else the
 * declared event schema's type, `Any` for a string or absent one) and `In` what it receives (its `receive`, else
 * `object`). A `send` union keyed on one field (D9) makes the answer `<Op>Connection`, a subclass hoisted beside the
 * types whose `on` overloads give each member's value its member's type; a `message` member gets none. Its one field
 * is `transport: TransportOpts | None`: the resume cursor, the offered subprotocols and the reconnect policy, which
 * the connection advances in its own copy, so `rc.opts` resumes past the last message. A declared param on a resume
 * channel is carried by it, and one named `transport` is claimed as `transport2` (`sdk-method.ts`).
 */
import { eventType, type PyStream } from "./sdk-answer.ts";
import { isLastEventIdHeader } from "./sse.ts";
import { pyTypeOf } from "./types.ts";
import { isReconnectToken, socketAnswer } from "./ws.ts";

/** The realtime operation's answer, its one field and its docstring's lines. */
export const realtimeStream: PyStream = {
  answer: (op, env) =>
    socketAnswer(op, env, {
      base: "ResumableConnection",
      in: "object",
      // the one event a connection's `on` takes for itself
      lifecycle: (out) => [["message", out]],
      out: () => eventType(op, env, () => pyTypeOf({ kind: "unknown" }, env.at)),
      run: "realtime",
      suffix: "Connection",
    }),
  // the WebSocket and long-poll dials send the cursor as query params, the SSE dial its id as Last-Event-ID
  carries: (name, where) =>
    isReconnectToken(name, where) ||
    (where === "query" && name === "last_event_id") ||
    isLastEventIdHeader(name, where),
  doc: [
    "Opens the connection over WebSocket, else SSE, else long-poll; recv() reconnects after a drop and",
    "resumes after the last message it delivered.",
  ],
  fields: ["transport: TransportOpts | None = None"],
};
