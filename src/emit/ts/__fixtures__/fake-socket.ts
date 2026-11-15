/** A scripted browser `WebSocket` for the TS socket tests: no socket ever reaches the network. */

/** A browser WebSocket the test scripts: it records its URL, protocols and frames; the test opens, feeds and closes it. */
export class FakeSocket extends EventTarget {
	static sockets: FakeSocket[] = []
	binaryType = "blob"
	readyState = 0
	readonly protocols: string | string[] | undefined
	readonly sent: unknown[] = []
	readonly url: string

	constructor(url: string | URL, protocols?: string | string[]) {
		super()
		this.url = String(url)
		this.protocols = protocols
		FakeSocket.sockets.push(this)
	}

	/** The handshake completes. */
	accept(): void {
		this.readyState = 1
		this.dispatchEvent(new Event("open"))
	}

	/** A frame from the server. */
	receive(data: unknown): void {
		this.dispatchEvent(new MessageEvent("message", { data }))
	}

	send(data: unknown): void {
		this.sent.push(data)
	}

	/** Closes once: as on the platform, a socket already closed fires no second `close`. */
	close(code = 1005, reason = ""): void {
		if (this.readyState === 3) return
		this.readyState = 3
		this.dispatchEvent(Object.assign(new Event("close"), { code, reason }))
	}
}
