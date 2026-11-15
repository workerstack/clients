/**
 * A WebSocket operation's answer (contract 50 §2, Fd5), opened by awaiting the method and dialed offering
 * `protocols`, its `reconnectToken` sent as one query param only when set and non-empty; a declared
 * `reconnect_token` query param is folded into that field. An operation that declares its messages (D9) answers
 * `Task<TypedWebSocket<TIn, TOut>>` through `TypedSocketAsync`, given both types' infos: `TIn` is what the server
 * sends (`send`), `TOut` what it receives (`receive`), each as types-messages.ts writes it, a side it does not
 * declare `JsonElement`; a keyed read side gets its `On<Value>` extensions, none for a value that names one of the
 * socket's events (message, close, error). Any other operation answers `Task<TypedWebSocket>` through
 * `SocketAsync`, its frames as bytes.
 */
import type { SdkOp } from "../../ir/sdk-model.ts"
import type { CsAnswer, CsStream } from "./sdk-answer.ts"
import type { MethodEnv, Spelling } from "./sdk-method.ts"
import { JSON_ELEMENT } from "./types.ts"
import { messageType, type Reader, valueHandlers } from "./types-messages.ts"

/** The subprotocols a WebSocket dial offers. */
const PROTOCOLS = { ident: "protocols", type: "IReadOnlyList<string>?" }

/** The resume cursor's token, which the WebSocket method takes. */
const RECONNECT_TOKEN = { ident: "reconnectToken", type: "string?" }

/* the typed socket, and its own events: a member whose On<Value> one of them names gets none */
const READER: Reader = { base: "TypedWebSocket", handlers: ["OnMessage", "OnClose", "OnError"], receiver: "socket" }

/** Whether a declared param is the `reconnect_token` query param, the resume channel a socket dial sends. */
export const isReconnectToken = (name: string, where: string) => where === "query" && name === "reconnect_token"

/** The WebSocket operation `op`'s answer, its message types hoisted into `env.at`. */
function wsAnswer(op: SdkOp, { at }: MethodEnv): CsAnswer {
	if (op.ir.messages === undefined) return { render: () => ["Task<TypedWebSocket>", "SocketAsync"], type: null }
	const { receive, send } = op.ir.messages
	const read = send === undefined ? { type: JSON_ELEMENT } : messageType(op, send, "Send", at)
	const write = receive === undefined ? { type: JSON_ELEMENT } : messageType(op, receive, "Receive", at)
	valueHandlers(READER, read, at)
	return {
		infos: [read.type, write.type],
		render: (spell: Spelling) => [
			`Task<TypedWebSocket<${spell.runtime(read.type)}, ${spell.runtime(write.type)}>>`,
			"TypedSocketAsync",
		],
		type: null,
	}
}

/** The WebSocket operation's answer, its two fields and its `<returns>` text. */
export const wsStream: CsStream = {
	answer: wsAnswer,
	args: ["protocols", "reconnectToken"],
	carries: isReconnectToken,
	fields: [PROTOCOLS, RECONNECT_TOKEN],
	returns:
		"The open socket: a refused handshake throws its status's exception; the token, CloseAsync or DisposeAsync ends it.",
}
