/**
 * A WebSocket operation's method (bit 16 phase d2a, K1/K2/K3; C#'s `ws.ts`): `TypedWebSocket<TIn, TOut>`, dialed by
 * the call through `WsDial.open` (no hook and no log), so a refused handshake throws before the method returns. An
 * operation that declares its messages (D9) reads `TIn`, what the server sends, each frame as JSON, and sends `TOut`,
 * what it receives, each a direction's declared type (an inline one hoisted as `<Op>Send` or `<Op>Receive`); a side it
 * does not declare reads `WsMessage`, each frame as it came, or sends `JsonNode`. A keyed read side (the sealed
 * interface models-union.ts declares) answers `<Read>Socket<TOut>`, one per read type, whose `on<Value>` per member
 * matches inside `onMessage` and returns the socket, none for a value whose handler the socket has (message, closed,
 * error); its name is claimed through the models scope after the union's wrappers, and a second value of one handler
 * name is numbered. The entry sits in the gated WebSocket files, as C#'s `SocketAsync` in WsDial.cs: an SDK without a
 * socket references none. Its fields, `protocols` (offered in order) and `reconnectToken` (sent as `reconnect_token`
 * after the declared query, only when set and non-empty); a declared `reconnect_token` query folds into the token,
 * and a param spelled like either field claims `…2`. A socket method is the same text in either mode: it answers no
 * Result.
 */
import type { SdkOp } from "../../ir/sdk-model.ts"
import { javaTypeName, NameScope } from "../shared/lang.ts"
import type { Dispatch } from "./json.ts"
import {
	bin,
	call as callOf,
	type Declaration,
	exprStmt,
	type Expr,
	id,
	ifOpen,
	lambda,
	lit,
	methodHeader,
	newOf,
	param,
	returnStmt,
	statement,
	typeHeader,
} from "./layout.ts"
import { declaredTypeOf, type JavaTypeContext, keyedArms } from "./models.ts"
import { JSON_NODE } from "./models-names.ts"
import { docOf } from "./sdk-decl.ts"

/** The query param the token travels in. */
export const RECONNECT_TOKEN = "reconnect_token"

/** The socket's Params fields: the subprotocols offered, then the resume token. */
export const PROTOCOLS = "protocols"
export const TOKEN = "reconnectToken"

/** Whether a declared query param is reconnect_token, the resume channel the token field carries. */
export const isReconnectTokenQuery = (name: string) => name === RECONNECT_TOKEN

/** The WebSocket runtime's files: the socket and its parts; only an SDK with a WebSocket operation ships them. */
export const WS_FILES = ["Keepalive", "Socket", "TypedWebSocket", "WsClose", "WsDial", "WsMessage"]

/**
 * What a generated reader extends: its base class, the handlers the base has (a member whose `on<Value>` one of them
 * names gets none), what its docs call it, and the suffix its name takes after the read type's.
 */
export type Reader = {
	readonly base: string
	readonly handlers: readonly string[]
	readonly noun: string
	readonly suffix: string
}

/** The socket's reader: its own handlers are onMessage, onClosed and onError. */
const SOCKET: Reader = {
	base: "TypedWebSocket",
	handlers: ["onMessage", "onClosed", "onError"],
	noun: "socket",
	suffix: "Socket",
}

/** The frame reader of an undeclared read side: each frame as it came. */
const asSent = () => lambda("m", id("m"))

/** What a socket method answers, the frame reader it hands the dial, and the wrap of the dialed socket. */
export type WsSocket = { readonly type: string; readonly read: Expr; readonly wrap: (dialed: Expr) => Expr }

/** One `on<Value>` of `sub`, named `name`: it matches `arm`'s wrapper inside onMessage and hands on its variant. */
const handlerLines = (reader: Reader, sub: string, name: string, { payload, wrapper }: Dispatch): string[] => [
	"",
	docOf(`Runs {@code handler} with the variant of each ${wrapper} message, inside onMessage; this ${reader.noun}.`),
	...methodHeader(2, {
		modifiers: ["public"],
		name,
		params: [param(`Consumer<${payload}>`, "handler")],
		returns: `${sub}<TOut>`,
	}),
	"    onMessage(",
	"        message -> {",
	...statement(10, ifOpen(bin("instanceof", "message", lit(`${wrapper} matched`)))),
	...statement(12, exprStmt(callOf("handler", "accept", [callOf("matched", "value")]))),
	"          }",
	"        });",
	...statement(4, returnStmt("this")),
	"  }",
]

/** The arms of `arms` that get an `on<Value>`: each but one whose handler `reader` has already. */
export const handledArms = (reader: Reader, arms: readonly Dispatch[]) =>
	arms.filter((arm) => !reader.handlers.includes(handlerName(arm)))

/* the handler an arm's first value spells */
const handlerName = (arm: Dispatch) => `on${javaTypeName(arm.values[0] ?? "")}`

/**
 * `<read><Suffix>`, hoisted into `ctx.decls` once per read type and reader with an `on<Value>` per arm of `arms` but
 * one whose handler `reader` has; its name. The wrappers were claimed first, so a member spelled like the subclass
 * keeps its wrapper and this one is numbered, and a second value of one handler name is numbered.
 */
export function keyedReader(reader: Reader, read: string, arms: readonly Dispatch[], ctx: JavaTypeContext): string {
	const sub = ctx.names.hoist(`${read}.${reader.noun}`, `${read}${reader.suffix}`)
	if (ctx.decls.has(sub)) return sub
	const scope = new NameScope(reader.handlers)
	const handlers = handledArms(reader, arms).flatMap((arm) =>
		handlerLines(reader, sub, scope.claim(handlerName(arm)), arm),
	)
	ctx.decls.set(
		sub,
		[
			docOf(`A ${reader.noun} reading ${read}: a handler per member, each matched inside onMessage.`, ""),
			...typeHeader(0, {
				end: "{",
				extends: `${reader.base}<${read}, TOut>`,
				kind: "class",
				modifiers: ["public", "final"],
				name: `${sub}<TOut>`,
			}),
			...methodHeader(2, { name: sub, params: [param(`${reader.base}<${read}, TOut>`, "opened")] }),
			...statement(4, exprStmt(callOf(null, "super", ["opened"]))),
			"  }",
			...handlers,
			"}",
		].join("\n"),
	)
	return sub
}

/** The dialed socket as it is: a socket whose read side has no members to handle. */
const AS_DIALED = (dialed: Expr) => dialed

/**
 * What `op`'s socket method answers and hands the dial: an op without messages `TypedWebSocket<WsMessage, JsonNode>`,
 * its frames as they came; else each declared side's type, a keyed read side's socket wrapping the dialed one.
 */
export function wsSocketOf(op: SdkOp, ctx: JavaTypeContext): WsSocket {
	const messages = op.ir.messages
	const at = (fieldName: string) => ({ ...ctx, fieldName, parentName: op.id, path: "" })
	const write = messages?.receive === undefined ? JSON_NODE : declaredTypeOf(messages.receive, at("Receive"))
	if (messages?.send === undefined) {
		return { read: asSent(), type: `TypedWebSocket<WsMessage, ${write}>`, wrap: AS_DIALED }
	}
	const read = declaredTypeOf(messages.send, at("Send"))
	const decode = callOf("TypedWebSocket", "json", [newOf(`TypeReference<${read}>`, [], true)])
	const arms = keyedArms(read, messages.send, ctx)
	if (arms.length === 0) return { read: decode, type: `TypedWebSocket<${read}, ${write}>`, wrap: AS_DIALED }
	const sub = keyedReader(SOCKET, read, arms, ctx)
	return { read: decode, type: `${sub}<${write}>`, wrap: (dialed) => newOf(`${sub}<${write}>`, [dialed]) }
}

/** What a socket method's lines need: its name and constant, its Params, and its Call's lines. */
export type WsSite = {
	readonly name: string
	readonly constant: string
	readonly params: string
	readonly call: readonly string[]
}

/** A socket method's lines: `op(params)`, delegating to `op(params, options)`, which dials. */
export function wsMethodLines(op: SdkOp, site: WsSite, ctx: JavaTypeContext): string[] {
	const { call, constant, name, params } = site
	const socket = wsSocketOf(op, ctx)
	const doc = docOf(
		`${op.id}: the open socket. A refused handshake throws; once open, no timeout bounds it. Close it, or open it in try-with-resources.`,
	)
	const signature = (args: readonly Declaration[]) =>
		methodHeader(2, { modifiers: ["public"], name, params: args, returns: socket.type })
	const dial = socket.wrap(
		callOf("WsDial", "open", ["exchange", constant, "call", "options", callOf("params", "protocols"), socket.read]),
	)
	return [
		doc,
		...signature([param(params, "params")]),
		...statement(4, returnStmt(callOf(null, name, ["params", "null"]))),
		"  }",
		"",
		doc,
		...signature([param(params, "params"), param("RequestOptions", "options")]),
		...call,
		...statement(4, returnStmt(dial)),
		"  }",
		"",
	]
}
