/**
 * Starts the conformance app (worker.ts) on workerd and prints `{"url","alt","drop"}` once the worker holds its three
 * origins. The app runs in Miniflare's workerd, the primary and the alt origin each a direct socket the OS assigned
 * (port 0, read back, never released and re-bound); the drop origin is a raw TCP front (drop-front.ts) in this process
 * relaying to the worker through Miniflare. Stops on SIGTERM, SIGINT or a closed stdin. With $HONEY_CONFORMANCE_MCP
 * naming a generated MCP handler module, the worker mounts it at /v1/mcp.
 */
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import { listenDropFront } from "./drop-front.ts"

const HOST = "127.0.0.1"
const here = (file: string) => fileURLToPath(new URL(file, import.meta.url))

/** The worker bundled to one ES module's source (web APIs only), with the generated MCP module mounted when there is one. */
async function bundle(mcpModule: string | undefined): Promise<string> {
	const entry = `import { createWorker } from ${JSON.stringify(here("./worker.ts"))}
${mcpModule === undefined ? "" : `import { mcpHandler } from ${JSON.stringify(mcpModule)}\n`}const { Alt, worker } = createWorker(${mcpModule === undefined ? "" : "mcpHandler"})
export { Alt }
export default worker
`
	const result = await Bun.build({
		conditions: ["honey-source", "workerd", "worker", "browser"],
		entrypoints: ["worker-entry.ts"],
		files: { "worker-entry.ts": entry },
		format: "esm",
		target: "browser",
	})
	if (!result.success) throw new Error(`the worker did not bundle:\n${result.logs.join("\n")}`)
	return (result.outputs[0] as { text(): Promise<string> }).text()
}

async function main(): Promise<void> {
	const script = await bundle(process.env.HONEY_CONFORMANCE_MCP)
	let miniflare: Miniflare | undefined
	/* the drop front binds first and relays through `miniflare` once it is up, bodiless requests only (drop-front.ts) */
	const drop = await listenDropFront({
		fetch: (request) =>
			(miniflare as Miniflare).dispatchFetch(request.url, {
				headers: [...request.headers],
				method: request.method,
			}) as never,
	})
	miniflare = new Miniflare({
		compatibilityDate: "2026-01-20",
		host: HOST,
		modules: [{ contents: script, path: "worker.js", type: "ESModule" }],
		/* both origins are direct sockets of the worker: Miniflare's entry worker gzips a 101 for a client that sends
		   Accept-Encoding (.NET's), which a direct socket does not; the entry serves the drop front's relay and the
		   origins request alone */
		port: 0,
		unsafeDirectSockets: [
			{ host: HOST, port: 0 },
			{ entrypoint: "Alt", host: HOST, port: 0 },
		],
	})
	await miniflare.ready
	const [url, alt] = await Promise.all([miniflare.unsafeGetDirectURL(), miniflare.unsafeGetDirectURL(undefined, "Alt")])
	const origins = { url: url.origin, alt: alt.origin, drop: drop.url }
	const set = await miniflare.dispatchFetch("http://worker.internal/__conformance/origins", {
		body: JSON.stringify(origins),
		method: "PUT",
	})
	if (set.status !== 204) throw new Error(`the worker refused its origins: ${set.status}`)
	process.stdout.write(`${JSON.stringify(origins)}\n`)
	let stopping = false
	const stop = () => {
		if (stopping) return
		stopping = true
		drop.server.close()
		void (miniflare as Miniflare).dispose().finally(() => process.exit(0))
	}
	process.once("SIGTERM", stop)
	process.once("SIGINT", stop)
	process.stdin.once("end", stop)
	process.stdin.resume()
}

if (import.meta.main) void main()
