/**
 * An operation's WebSocket. Its dial runs no onRequest or onResponse hook, and a refused handshake's 401 is its error,
 * with no onAuthExpired refresh. The platform WebSocket exposes no ping and no message cap, so this socket has neither.
 */
import type { HTTPClient } from "./http.ts"
import { ClientError } from "./error.ts"
import type { RequestOptions } from "./request.ts"

/** What an untyped socket sends: strings, bytes and `Blob` as they are, any other value as JSON. */
export type WsFrame = ArrayBuffer | ArrayBufferView | Blob | object | string

/** The events every socket has; a message whose key is one of these names gets no `on(value)` of its own. */
type SocketEvent = "binary" | "close" | "error" | "message" | "open"

/** The values of `Out`'s field `K`, the lifecycle names left out. */
type KeyOf<Out, K extends string> = Exclude<
	Out extends { readonly [P in K]: infer V extends string } ? V : never,
	SocketEvent
>

/** `on(value)` and `off(value)` for a socket whose messages are keyed on `K`; nothing for an unkeyed one. */
type Keyed<Out, K extends string> = [K] extends [never]
	? unknown
	: {
			off(event: KeyOf<Out, K>, handler: (...args: never[]) => void): void
			/** The messages whose `K` is `event`, after `"message"` hears them. */
			on<V extends KeyOf<Out, K>>(event: V, handler: (data: Extract<Out, { readonly [P in K]: V }>) => void): void
		}

/**
 * A WebSocket typed both ways: `send` takes `In`, `on("message")` gets `Out`, and when `Out` is a union keyed on `K`,
 * `on(value)` gets the member whose `K` is `value` (D9). Untyped, it sends `WsFrame` and hears text.
 */
export type TypedWebSocket<In = WsFrame, Out = string, K extends string = never> = {
	close(code?: number, reason?: string): void
	off(event: SocketEvent, handler: (...args: never[]) => void): void
	/** Binary frames, as `ArrayBuffer`. Text frames go to `"message"`. */
	on(event: "binary", handler: (data: ArrayBuffer) => void): void
	on(event: "close", handler: (code: number, reason: string) => void): void
	/** A socket error; for a socket with declared messages, also a text frame that is no JSON, as a `ClientError`. */
	on(event: "error", handler: (error: unknown) => void): void
	/** Text frames: as text, or parsed as JSON for a socket with declared messages. */
	on(event: "message", handler: (data: Out) => void): void
	on(event: "open", handler: () => void): void
	readonly readyState: number
	/**
	 * Untyped, strings, `ArrayBuffer`, typed arrays and `Blob` are sent as-is and any other value is JSON-encoded; with
	 * declared messages every value is JSON. Sends before the socket opens are queued; after it closes they are dropped.
	 */
	send(data: In): void
} & Keyed<Out, K>

export type WSOptions = {
	protocols?: string | string[] | undefined
	/** Parse each text frame as JSON: the operation declares what the server sends. */
	decode?: boolean | undefined
	/** The field a parsed message is handed to `on(value)` by. */
	dispatch?: string | undefined
	/** Send every value as JSON: the operation declares what the server receives. */
	encode?: boolean | undefined
}

type Payload = Blob | string | Uint8Array<ArrayBuffer>
type Handler = (...args: never[]) => void

const WS_EVENTS: readonly string[] = ["binary", "close", "error", "message", "open"]

/** `data` as a frame: text and Blobs as they are, bytes copied, anything else as JSON. */
function toPayload(data: WsFrame): Payload {
	if (typeof data === "string") return data
	if (typeof Blob !== "undefined" && data instanceof Blob) return data
	if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
		const view =
			data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
		const copy = new Uint8Array(view.byteLength)
		copy.set(view)
		return copy
	}
	return JSON.stringify(data)
}

/** The error a text frame that is no JSON raises on a socket with declared messages. */
function notJson(frame: string, error: unknown): ClientError {
	const message = `WebSocket frame is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
	return new ClientError({ body: frame, message, response: Response.error(), status: 0 })
}

/** A WebSocket with typed events, a send queue until it opens, and nothing sent once it closes. */
class TypedSocket {
	readonly #ws: WebSocket
	readonly #opts: WSOptions
	readonly #handlers = new Map<string, Set<Handler>>()
	readonly #queue: Payload[] = []
	#state: "closed" | "connecting" | "open" = "connecting"

	constructor(ws: WebSocket, opts: WSOptions) {
		this.#ws = ws
		this.#opts = opts
		ws.binaryType = "arraybuffer"
		ws.addEventListener("open", () => {
			this.#state = "open"
			for (const msg of this.#queue) ws.send(msg)
			this.#queue.length = 0
			this.#emit("open")
		})
		ws.addEventListener("close", (e) => {
			this.#state = "closed"
			this.#queue.length = 0
			this.#emit("close", (e as CloseEvent).code, (e as CloseEvent).reason)
		})
		ws.addEventListener("error", (e) => this.#emit("error", e))
		ws.addEventListener("message", (e) => this.#frame((e as MessageEvent).data))
	}

	get readyState(): number {
		return this.#ws.readyState
	}

	#emit(event: string, ...args: unknown[]): void {
		const handlers = this.#handlers.get(event)
		if (handlers === undefined) return
		for (const handler of handlers) (handler as (...args: unknown[]) => void)(...args)
	}

	/** One frame from the server: bytes to `"binary"`, text to `"message"`, parsed and dispatched when typed. */
	#frame(data: unknown): void {
		if (data instanceof ArrayBuffer) return this.#emit("binary", data)
		if (typeof data !== "string") return
		if (this.#opts.decode !== true) return this.#emit("message", data)
		let value: unknown
		try {
			value = JSON.parse(data)
		} catch (error) {
			return this.#emit("error", notJson(data, error))
		}
		this.#emit("message", value)
		const { dispatch } = this.#opts
		const key = dispatch !== undefined && typeof value === "object" && value !== null ? value[dispatch as never] : null
		if (typeof key === "string" && !WS_EVENTS.includes(key)) this.#emit(key, value)
	}

	close(code?: number, reason?: string): void {
		this.#state = "closed"
		this.#queue.length = 0
		this.#ws.close(code, reason)
	}

	on(event: string, handler: Handler): void {
		if (!WS_EVENTS.includes(event) && this.#opts.dispatch === undefined) return
		const handlers = this.#handlers.get(event) ?? new Set<Handler>()
		this.#handlers.set(event, handlers)
		handlers.add(handler)
	}

	off(event: string, handler: Handler): void {
		this.#handlers.get(event)?.delete(handler)
	}

	send(data: WsFrame): void {
		if (this.#state === "closed") return
		const payload = this.#opts.encode === true ? JSON.stringify(data) : toPayload(data)
		if (this.#state === "connecting") this.#queue.push(payload)
		else this.#ws.send(payload)
	}
}

/** The WebSocket URL of `path`: its HTTP URL under the ws: or wss: scheme. */
export function wsUrl(http: HTTPClient, path: string, opts: RequestOptions): string {
	const url = new URL(http.buildUrl(path, opts))
	if (url.protocol === "https:") url.protocol = "wss:"
	else if (url.protocol === "http:") url.protocol = "ws:"
	return url.toString()
}

export function createTypedWebSocket(
	url: string,
	opts?: WSOptions,
	WebSocketImpl: typeof WebSocket = WebSocket,
): TypedWebSocket {
	const ws = opts?.protocols ? new WebSocketImpl(url, opts.protocols) : new WebSocketImpl(url)
	const socket = new TypedSocket(ws, opts ?? {})
	const typed: TypedWebSocket = {
		close: (code, reason) => socket.close(code, reason),
		off: (event, handler) => socket.off(event, handler),
		on: ((event: string, handler: Handler) => socket.on(event, handler)) as TypedWebSocket["on"],
		get readyState() {
			return socket.readyState
		},
		send: (data) => socket.send(data),
	}
	Object.defineProperty(typed, "_ws", { enumerable: false, value: ws })
	return typed
}
