/**
 * The reference app as a Cloudflare Worker: what workerd runs. `default` serves the primary origin and the drop
 * front's relay, `Alt` (a named entrypoint, so its own direct socket) the alt origin; one app, so one wire log, behind
 * both. The launcher binds the sockets first, then PUTs the three origins to `/__conformance/origins` once.
 */
import type { McpHandler } from "@workerstack/backend/mcp"
import { mcp } from "@workerstack/backend/mcp"
import { workersWebSocket } from "@workerstack/backend/ws/workers"
import { createConformanceApp, type Origins } from "./app.ts"

/** The worker's module, with `handler` mounted at /mcp when there is one. */
export function createWorker(handler?: McpHandler) {
	let origins: Origins | null = null
	const app = createConformanceApp(workersWebSocket(), () => origins)
	if (handler !== undefined) mcp(app, "/mcp", handler)
	const worker = {
		async fetch(request: Request, env: unknown, ctx: unknown) {
			if (new URL(request.url).pathname === "/__conformance/origins") {
				origins = (await request.json()) as Origins
				return new Response(null, { status: 204 })
			}
			return app.fetch(request, env as never, ctx as never)
		},
	}
	return { Alt: worker, worker }
}
