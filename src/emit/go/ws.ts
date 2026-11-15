/**
 * A WebSocket or realtime operation as a Go method. A WebSocket operation dials its socket and
 * returns `(*TypedWebSocket, error)`: `<Op>Opts.ReconnectToken` rides as the `reconnect_token`
 * query param after the declared ones, and `Protocols` are the subprotocols it offers. A realtime
 * operation returns `(*ResumableConnection, error)`, already open over the WebSocket, SSE and
 * long-poll chain, its ctx bounding the open (Fd1); its Opts carry one `Transport TransportOpts`: the
 * resume cursor, the protocols and the reconnect policy, which the connection advances in its own copy.
 * A declared param on a resume channel the runtime sends itself is carried by it, so the wire holds one
 * pair (Fd3). Neither declares a response a caller receives.
 */
import { type GoStream, sendArgs } from "./sdk-answer.ts"
import type { OptsField, StreamField } from "./sdk-opts.ts"
import { isLastEventIdHeader } from "./sse.ts"

/** Whether a declared param is the `reconnect_token` query param a WebSocket dial sends. */
const isReconnectToken = (param: string, where: OptsField["in"]) => where === "query" && param === "reconnect_token"

/* both open a socket: a dial fails before any stream exists */
const FAIL = "nil, err"

const WS_STREAM: GoStream = {
	doc: "",
	opts: {
		before: [],
		carries: isReconnectToken,
		fields: [
			{ name: "ReconnectToken", type: "string" },
			{ name: "Protocols", type: "[]string" },
		],
		sets: [
			'if opts.ReconnectToken != "" {',
			'\tc.query.set("reconnect_token", opts.ReconnectToken)',
			"}",
			"c.protocols = opts.Protocols",
		],
	},
	shape: {
		fail: FAIL,
		returns: "(*TypedWebSocket, error)",
		tail: (client) => [`\treturn dialWebSocket(${sendArgs(client)})`],
	},
}

/* the realtime Opts' one own field, which `sets` copies: the method sets its Headers and HTTPClient */
const REALTIME_FIELDS: readonly StreamField[] = [
	{
		doc: "Transport is the resume cursor, the offered subprotocols and the reconnect policy; the connection advances its own copy, and the client sets Headers and HTTPClient.",
		name: "Transport",
		type: "TransportOpts",
	},
]

const REALTIME_STREAM: GoStream = {
	doc: "The connection is open on return; Close it when done.",
	opts: {
		before: ["var topts TransportOpts"],
		/* the WebSocket and long-poll dials send the cursor as query params, the SSE dial its id as Last-Event-ID */
		carries: (param, where) =>
			isReconnectToken(param, where) ||
			(where === "query" && param === "last_event_id") ||
			isLastEventIdHeader(param, where),
		fields: REALTIME_FIELDS,
		sets: ["topts = opts.Transport"],
	},
	shape: {
		fail: FAIL,
		returns: "(*ResumableConnection, error)",
		tail: (client) => [`\treturn newRealtime(${sendArgs(client, "topts")})`],
	},
}

/** The method of a WebSocket or realtime operation. */
export const socketStream = (stream: "realtime" | "ws"): GoStream => (stream === "ws" ? WS_STREAM : REALTIME_STREAM)
