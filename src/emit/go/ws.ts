/**
 * A WebSocket or realtime operation as a Go method. A WebSocket operation dials its socket and returns
 * `(*TypedWebSocket[In, Out], error)`, `In` what the server sends (its declared `send`, else the frame's bytes) and
 * `Out` what it receives (its `receive`, else `any`); a union keyed on one field (D9) is a sealed interface per
 * direction (D16), `<Op>Inbound` and `<Op>Outbound`, and a keyed `send` makes the answer `<Op>Socket`, whose
 * `On<Value>` methods take each member by its value (one whose method a handler already names excepted).
 * `<Op>Opts.ReconnectToken` rides as the `reconnect_token` query param after the declared ones, and `Protocols` are
 * the subprotocols it offers. A realtime operation returns `(*ResumableConnection[In, Out], error)`, already open over
 * the WebSocket, SSE and long-poll chain, its ctx bounding the open (Fd1): `In` its declared `send`, else the declared
 * event schema's type, `any` for a string or absent one; a keyed `send` makes the answer `<Op>Connection`, with an
 * `On<Value>` per member but `message`. Its Opts carry one `Transport TransportOpts`: the resume cursor, the
 * protocols and the reconnect policy, which the connection advances in its own copy. A declared param on a resume
 * channel the runtime sends itself is carried by it, so the wire holds one pair (Fd3).
 */
import type { IRSchema } from "../../ir/model.ts"
import { type Dispatch, dispatchOf, isJsonEventData, type SdkOp } from "../../ir/sdk-model.ts"
import { goString, lineComment } from "../shared/escape.ts"
import { goExported, NameScope } from "../shared/lang.ts"
import { type GoSends, type GoStream, sendArgs } from "./sdk-answer.ts"
import type { OptsField, StreamField, StreamOpts } from "./sdk-opts.ts"
import { isLastEventIdHeader } from "./sse.ts"
import { type GoTypeContext, goKeyedMembers, goTypeOf } from "./types.ts"

/** Whether a declared param is the `reconnect_token` query param a WebSocket dial sends. */
const isReconnectToken = (param: string, where: OptsField["in"]) => where === "query" && param === "reconnect_token"

/* both open a socket: a dial fails before any stream exists */
const FAIL = "nil, err"

const WS_OPTS: StreamOpts = {
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
}

/** One direction of a socket's messages: their Go type, and the runtime function reading or writing a frame. */
type Side = { readonly type: string; readonly codec: string }

/** A keyed `send` union's read side: its interface, its decoder, its key, and each member's value beside its Go type. */
type Keyed = Side & {
	readonly decode: string
	readonly key: string
	readonly members: readonly (readonly [string, string])[]
}

/** What a WebSocket and a realtime answer differ in: their runtime type, the handlers it has, what an op's own type is. */
type Kind = {
	readonly base: string
	/* the handlers it takes: a member whose On<Value> one of them names gets none */
	readonly handlers: readonly string[]
	readonly suffix: "Connection" | "Socket"
	readonly what: string
	/** The runtime call that opens it, given the client and each side's codec. */
	readonly open: (client: string, read: string, write: string) => string
}

const WS: Kind = {
	base: "TypedWebSocket",
	handlers: ["OnMessage", "OnClose", "OnError"],
	suffix: "Socket",
	what: "socket",
	open: (client, read, write) => `dialWebSocket(${sendArgs(client, read, write)})`,
}
const REALTIME: Kind = {
	base: "ResumableConnection",
	handlers: ["OnMessage"],
	suffix: "Connection",
	what: "connection",
	open: (client, read, write) => `newRealtime(${sendArgs(client, "topts", read, write)})`,
}

/** `<Op><direction>`, the sealed interface of the keyed union `schema`'s members, each marked as one; its lines. */
function sealed(op: SdkOp, members: readonly (readonly [string, string])[], iface: string, says: string): string[] {
	const types = [...new Set(members.map(([, type]) => type))]
	return [
		...lineComment(`${iface} is a message ${says} on ${op.id}: ${types.join(", ")}.`, "//"),
		`type ${iface} interface {`,
		`\tis${iface}()`,
		"}",
		...types.flatMap((type) => ["", `func (${type}) is${iface}() {}`]),
	]
}

/**
 * The read side of `op`'s socket from what the server sends (`send`): `<Op>Inbound` when keyed, declared in `at` with
 * `<Op>OtherMessage` for a value it does not declare and the decoder reading a frame by its key; else its Go type,
 * read as JSON; `untyped()` when it declares none.
 */
function inbound(op: SdkOp, send: IRSchema | undefined, untyped: () => Side, at: GoTypeContext): Side | Keyed {
	if (send === undefined) return untyped()
	const here = { ...at, fieldName: "Send", parentName: op.id }
	const dispatch = dispatchOf(send, at.names.resolve)
	if (dispatch !== undefined) return keyedInbound(op, send, dispatch, here)
	const type = goTypeOf(send, here).replace(/^\*/, "")
	return { codec: `frameJSON[${type}]`, type }
}

/** `<Op>Inbound`, its types, `<Op>OtherMessage` and its decoder, declared in one block in `at`. */
function keyedInbound(op: SdkOp, send: IRSchema, dispatch: Dispatch, at: GoTypeContext): Keyed {
	const members = goKeyedMembers(send, dispatch, at)
	const base = goExported(op.id)
	const iface = at.names.claimConst(`${base}Inbound`)
	const other = at.names.claimConst(`${base}OtherMessage`)
	const decode = at.names.claimConst(`decode${iface}`)
	const key = goString(dispatch.key)
	at.decls.set(
		iface,
		[
			...sealed(op, [...members, ["", other]], iface, "the server sends"),
			"",
			...lineComment(`${other} is a message whose ${key} ${op.id} does not declare, as sent.`, "//"),
			`type ${other} struct {`,
			"\tRaw json.RawMessage",
			"}",
			"",
			"// MarshalJSON is the message as sent.",
			`func (m ${other}) MarshalJSON() ([]byte, error) { return m.Raw.MarshalJSON() }`,
			"",
			`// ${decode} is a frame as the message its ${key} names.`,
			`func ${decode}(data []byte) (${iface}, error) {`,
			`\tkey, err := frameKey(data, ${key})`,
			"\tif err != nil {",
			"\t\treturn nil, err",
			"\t}",
			"\tswitch key {",
			...members.flatMap(([value, type]) => [
				`\tcase ${goString(value)}:`,
				`\t\tm, err := frameJSON[${type}](data)`,
				"\t\treturn m, err",
			]),
			"\t}",
			`\treturn ${other}{Raw: data}, nil`,
			"}",
		].join("\n"),
	)
	return { codec: decode, decode, key: dispatch.key, members, type: iface }
}

/** A write side, and what the server receives as the CLI checks a line against it; none for an untyped one. */
type Outbound = Side & { readonly sends?: GoSends }

/* a send of an op that declares none: as given */
const UNTYPED_OUT: Outbound = { codec: "messageAsIs", type: "any" }

/** The fields `schema` requires at its top level: an object's, none for any other schema. */
function requiredOf(schema: IRSchema, at: GoTypeContext): string[] {
	const resolved = at.names.resolve(schema)
	return resolved.kind === "object" ? resolved.fields.filter((field) => field.required).map((field) => field.name) : []
}

/** The write side of `op`'s socket from what the server receives (`receive`): `<Op>Outbound` when keyed, else its Go type, written as JSON; `any` when it declares none. */
function outbound(op: SdkOp, receive: IRSchema | undefined, at: GoTypeContext): Outbound {
	if (receive === undefined) return UNTYPED_OUT
	const here = { ...at, fieldName: "Receive", parentName: op.id }
	const dispatch = dispatchOf(receive, at.names.resolve)
	if (dispatch === undefined) {
		const type = goTypeOf(receive, here).replace(/^\*/, "")
		return { codec: `messageJSON[${type}]`, sends: { key: null, required: requiredOf(receive, at), type }, type }
	}
	const members = goKeyedMembers(receive, dispatch, here)
	const iface = at.names.claimConst(`${goExported(op.id)}Outbound`)
	at.decls.set(iface, sealed(op, members, iface, "the server receives").join("\n"))
	const sends: GoSends = {
		key: dispatch.key,
		members: members.map(([value, type], i) => ({
			required: requiredOf(dispatch.members[i]?.variant as IRSchema, at),
			type,
			value,
		})),
	}
	return { codec: `messageJSON[${iface}]`, sends, type: iface }
}

/** `<Op><suffix>` around `base`, an On<Value> per member whose method no handler names, declared in `at`; null when none is left. */
function socketType(
	op: SdkOp,
	kind: Kind,
	{ base, read }: { base: string; read: Keyed },
	at: GoTypeContext,
): string | null {
	const scope = new NameScope(kind.handlers)
	const handlers = read.members.flatMap(([value, type]) => {
		const method = `On${goExported(value)}`
		return scope.has(method) ? [] : [{ method: scope.claim(method), type, value }]
	})
	if (handlers.length === 0) return null
	const name = at.names.claimConst(`${goExported(op.id)}${kind.suffix}`)
	at.decls.set(
		name,
		[
			...lineComment(
				`${name} is the ${kind.what} of ${op.id}: each On<Value> takes the messages whose ${goString(read.key)} is that value.`,
				"//",
			),
			`type ${name} struct {`,
			`\t*${base}`,
			"}",
			...handlers.flatMap(({ method, type, value }) => [
				"",
				`// ${method} registers a handler for each ${goString(value)} message.`,
				`func (s *${name}) ${method}(handler func(${type})) {`,
				`\ts.OnMessage(func(m ${read.type}) {`,
				`\t\tif v, ok := m.(${type}); ok {`,
				"\t\t\thandler(v)",
				"\t\t}",
				"\t})",
				"}",
			]),
		].join("\n"),
	)
	return name
}

/** What a socket or connection reads and what it writes. */
type Sides = { readonly read: Side | Keyed; readonly write: Outbound }

/** `op`'s answer of `kind`: its runtime type of both sides, or its own type around it; the call that opens it; what it sends, typed. */
function answerOf(
	op: SdkOp,
	kind: Kind,
	{ read, write }: Sides,
	at: GoTypeContext,
): Pick<GoStream, "calls" | "sends" | "shape"> {
	const base = `${kind.base}[${read.type}, ${write.type}]`
	const call = (client: string) => kind.open(client, read.codec, write.codec)
	const keyed = "decode" in read ? read : undefined
	const own = keyed && socketType(op, kind, { base, read: keyed }, at)
	return {
		calls: keyed ? [keyed.decode] : [],
		...(write.sends === undefined ? {} : { sends: write.sends }),
		shape: own
			? {
					fail: FAIL,
					returns: `(*${own}, error)`,
					tail: (client) => [
						`\tconn, err := ${call(client)}`,
						"\tif err != nil {",
						"\t\treturn nil, err",
						"\t}",
						`\treturn &${own}{conn}, nil`,
					],
				}
			: { fail: FAIL, returns: `(*${base}, error)`, tail: (client) => [`\treturn ${call(client)}`] },
	}
}

/** The method of the WebSocket operation `op`, its message types hoisted into `at`. */
function wsStream(op: SdkOp, at: GoTypeContext): GoStream {
	const { receive, send } = op.ir.messages ?? {}
	const read = inbound(op, send, () => ({ codec: "frameBytes", type: "[]byte" }), at)
	return { ...answerOf(op, WS, { read, write: outbound(op, receive, at) }, at), doc: "", opts: WS_OPTS }
}

/* the realtime Opts' one own field, which `sets` copies: the method sets its Headers and HTTPClient */
const REALTIME_FIELDS: readonly StreamField[] = [
	{
		doc: "Transport is the resume cursor, the offered subprotocols and the reconnect policy; the connection advances its own copy, and the client sets Headers and HTTPClient.",
		name: "Transport",
		type: "TransportOpts",
	},
]

const REALTIME_OPTS: StreamOpts = {
	before: ["var topts TransportOpts"],
	/* the WebSocket and long-poll dials send the cursor as query params, the SSE dial its id as Last-Event-ID */
	carries: (param, where) =>
		isReconnectToken(param, where) ||
		(where === "query" && param === "last_event_id") ||
		isLastEventIdHeader(param, where),
	fields: REALTIME_FIELDS,
	sets: ["topts = opts.Transport"],
}

/** A realtime op's messages read without a declared `send`: the declared event schema's type, else each as its JSON value or text. */
function eventSide(op: SdkOp, at: GoTypeContext): Side {
	if (op.events === undefined || !isJsonEventData(op.events, at.names.resolve))
		return { codec: "framePayload", type: "any" }
	const type = goTypeOf(op.events, { ...at, fieldName: "Event", parentName: op.id }).replace(/^\*/, "")
	return { codec: `frameJSON[${type}]`, type }
}

/** The method of the realtime operation `op`, its message types hoisted into `at`. */
function realtimeStream(op: SdkOp, at: GoTypeContext): GoStream {
	const { receive, send } = op.ir.messages ?? {}
	const read = inbound(op, send, () => eventSide(op, at), at)
	return {
		...answerOf(op, REALTIME, { read, write: outbound(op, receive, at) }, at),
		doc: "The connection is open on return; Close it when done.",
		opts: REALTIME_OPTS,
	}
}

/** The method of a WebSocket or realtime operation, its message types hoisted into `at`. */
export const socketStream = (op: SdkOp, stream: "realtime" | "ws", at: GoTypeContext): GoStream =>
	stream === "ws" ? wsStream(op, at) : realtimeStream(op, at)
