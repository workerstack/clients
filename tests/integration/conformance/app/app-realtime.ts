/**
 * The conformance app's realtime feeds (bit 19 e, bit 21 i7), split out of app.ts for its 500-line cap: the refusal
 * routes every transport dials, and `realtime.capped`, a send's answer past a small response cap.
 */
import * as z from "zod"
import type { ConformanceApp, errors } from "./app.ts"
import type { HoneyRes } from "@workerstack/backend"

/** How often an open `realtime.capped` stream looks for a send it has not framed yet. */
const POLL_MS = 10

/** A Response the route does not declare: a fault injected on purpose, past the handler's typed return. */
const undeclared = (ctx: { readonly res: object }, response: Response) => (ctx.res as HoneyRes).raw(response) as never

/**
 * The realtime feeds every transport dials (bit 19 e): `realtime.refused` refuses each with 403; `realtime.mixed`
 * 404s the upgrade, 503s every poll and the first event stream since the wire mark, then streams `{ n: 1 }`.
 */
export function realtimeRoutes(app: ConformanceApp, streams: { dialed: number }, factory: typeof errors): void {
	const feed = { "text/event-stream": { ok: z.object({ n: z.number().int() }) } }
	app
		.get("/realtime/refused")
		.meta({ extensions: { "x-realtime": true }, operationId: "realtime.refused", mcp: true })
		.errors("limit_reached")
		.output(feed)
		.handler(() => {
			throw factory.limit_reached()
		})
	app
		.get("/realtime/mixed")
		.meta({ extensions: { "x-realtime": true }, operationId: "realtime.mixed", mcp: true })
		.output(feed)
		.handler((ctx) => {
			if (ctx.req.headers.get("upgrade") !== null) return undeclared(ctx, new Response(null, { status: 404 }))
			const stream = ctx.req.headers.get("accept")?.includes("text/event-stream") === true
			if (!stream || streams.dialed++ === 0) return undeclared(ctx, new Response(null, { status: 503 }))
			return ctx.res.sse(async (sse) => {
				await sse.send({ data: { n: 1 }, event: "message", id: "1" })
				sse.close()
			})
		})
	cappedRoutes(app, feed)
}

/**
 * `realtime.capped` (bit 21 i7): a send's answer past a small response cap. The upgrade 404s, so the SDK dials the
 * event stream, which stays open with only a retry directive (a streamed answer's headers go out with its first
 * bytes); each send (a POST, internal so in no generated artifact) answers a 2xx past 16 bytes, then `{ n: 1 }` goes
 * to every open stream, so a client that took that answer reads a frame. The send only counts: each stream writes
 * the frame itself, from its own request, since workerd refuses I/O on another request's stream.
 */
function cappedRoutes(app: ConformanceApp, feed: { "text/event-stream": { ok: z.ZodType } }): void {
	let sends = 0
	app
		.get("/realtime/capped")
		.meta({ extensions: { "x-realtime": true }, operationId: "realtime.capped" })
		.output(feed)
		.handler((ctx) => {
			if (ctx.req.headers.get("upgrade") !== null) return undeclared(ctx, new Response(null, { status: 404 }))
			if (ctx.req.headers.get("accept")?.includes("text/event-stream") !== true)
				return undeclared(ctx, new Response(null, { status: 503 }))
			return ctx.res.sse(
				async (sse) => {
					let seen = sends
					while (!sse.signal.aborted) {
						await new Promise((resolve) => setTimeout(resolve, POLL_MS))
						if (sends === seen || sse.signal.aborted) continue
						seen = sends
						await sse.send({ data: { n: 1 }, event: "message", id: "1" })
					}
				},
				{ defaultRetry: 1000 },
			)
		})
	app
		.post("/realtime/capped")
		.meta({ internal: true })
		.handler((ctx) => {
			sends++
			return ctx.res.raw(Response.json({ accepted: "the send, answered past the cap" }))
		})
}
