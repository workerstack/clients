import { interpolatePath } from "./path.ts"
import type { RequestOptions } from "./request.ts"
import { type OperationCall, templateOf } from "./sdk.ts"
import { createTypedWebSocket, type TypedWebSocket, wsUrl } from "./ws.ts"

/** A WebSocket call's input: the request's options, the subprotocols, and a resume token. */
type WsInput = RequestOptions & { protocols?: string | string[]; reconnectToken?: string }

/**
 * A WebSocket op: one socket per call, its `x-invalidate` targets marked once it opens, when the `onInvalidate` hooks
 * are called detached: the `open` listener is sync, so nothing waits on them.
 */
export const wsOp: OperationCall =
	(core, entry) =>
	(input: WsInput = {}): TypedWebSocket => {
		const url = new URL(wsUrl(core.http, templateOf(entry), { params: input.params, search: input.search }))
		if (input.reconnectToken) url.searchParams.append("reconnect_token", input.reconnectToken)
		const { decode, dispatch, encode } = entry
		const socket = createTypedWebSocket(url.toString(), { decode, dispatch, encode, protocols: input.protocols })
		if (entry.reads?.length) {
			const selector = `WS ${interpolatePath(templateOf(entry), input.params)}`
			socket.on("open", () => {
				core.mark(entry, input.params, selector)
				void core.invalidated(entry, input.params)
			})
		}
		return socket
	}
