/**
 * Where the answer check lives (plan 40, phase 10): `#output-check` in the installed package. The real core tarball is
 * installed beside the repo's Vite and an app whose `/bad` route answers what its `.output()` refuses. A Worker that
 * `vite build` bundles through `honeyPlugin()` in production carries none of the check, built unminified so its one
 * marker, the `compileOutput` function only the check defines, would show; a development build, and a production
 * build with `honeyPlugin({ outputValidation: true })`, carry it and answer `/bad` with the 500. A node or bun bundle
 * keeps honey external and checks unless its runtime starts with `--conditions=honey-no-output-check`.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { withPinnedBun } from "../../../gen/src/gen/__fixtures__/pinned-bun.ts"
import { SPAWN_TIMEOUT } from "../fixture/spawn-timeout.ts"
import { consumer, pack, run, scratch, write } from "./fixture/packed.ts"

const BUN = withPinnedBun()
const files = scratch("output-check")
let dir = ""

const MARKER = "function compileOutput("

/* one route that answers what its .output() refuses, one with no .output(); a schema of its own, so no validator
 * library is installed */
const APP = `import { honey } from "@workerstack/backend"
const row = {
	"~standard": {
		validate: (value) => (typeof value?.id === "string" ? { value } : { issues: [{ message: "id is no string" }] }),
		vendor: "fixture",
		version: 1,
	},
}
export const app = honey().logger(false)
app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
app.get("/bad").output({ ok: row }).handler((ctx) => ctx.res.json("ok", { id: 1 }))
`

/* vite build of src/app.mjs for argv's target into argv's directory, unminified; "keep" sets outputValidation */
const BUILD = `import { build } from "vite"
import { createBuildPlugin } from "@workerstack/backend/build"
import { honeyPlugin } from "@workerstack/backend/plugin"
const [target, outDir, keep] = process.argv.slice(2)
await build({
	configFile: false,
	logLevel: "error",
	plugins: [
		honeyPlugin({ app: "src/app.mjs", codegen: { tree: false }, ...(keep === "keep" ? { outputValidation: true } : {}) }),
		createBuildPlugin({ minify: false, outDir, target }, { entry: "src/app.mjs", export: "app" }),
	],
	root: process.cwd(),
})
`

/* what a Worker module answers for /bad, called the way workerd calls its default export */
const CALL_WORKER = `const worker = await import(process.argv[2])
const answer = await worker.default.fetch(new Request("http://localhost/bad"), {}, { passThroughOnException() {}, waitUntil() {} })
console.log(answer.status, await answer.text())
`

beforeAll(() => {
	const tarballs = pack(files.out)
	dir = consumer(join(files.out, "app"), { "@workerstack/backend": `file:${tarballs.core}` }, ["vite"])
	write(dir, { "build.mjs": BUILD, "call-worker.mjs": CALL_WORKER, "src/app.mjs": APP })
}, 180_000)
afterAll(() => files.done())

/** `vite build` for `target` under `nodeEnv`, into dist/`name`: the bundle's text. */
function built(name: string, target: "bun" | "node" | "workers", nodeEnv: string, keep = false): string {
	const out = run("node", ["build.mjs", target, `dist/${name}`, keep ? "keep" : ""], dir, { NODE_ENV: nodeEnv })
	expect(out.code, out.out).toBe(0)
	return readFileSync(join(dir, `dist/${name}/index.js`), "utf8")
}

/** An answer as its status and, for a 500, its error key, else its body. */
function seen(status: number, text: string): string {
	return `${status} ${status === 500 ? (JSON.parse(text) as { error_key: string }).error_key : text}`
}

/** What the Worker built as dist/`name` answers for /bad. */
function workerAnswer(name: string): string {
	const out = run("node", ["call-worker.mjs", join(dir, `dist/${name}/index.js`)], dir)
	expect(out.code, out.out).toBe(0)
	const [status = "", ...text] = out.out.trim().split(" ")
	return seen(Number(status), text.join(" "))
}

const REFUSED = "500 output_validation_failed"

describe("a Worker built through honeyPlugin() (plan 40, phase 10)", () => {
	// v0: ac3e0f763d
	it(
		"in production carries no output check, and answers what its handler built",
		() => {
			const js = built("workers-production", "workers", "production")
			expect([js.includes(MARKER), workerAnswer("workers-production")]).toEqual([false, '200 {"id":1}'])
		},
		SPAWN_TIMEOUT,
	)

	// v0: f911fe03b0
	it(
		"in development carries the check, and answers the mismatch with the 500",
		() => {
			const js = built("workers-development", "workers", "development")
			expect([js.includes(MARKER), workerAnswer("workers-development")]).toEqual([true, REFUSED])
		},
		SPAWN_TIMEOUT,
	)

	it(
		"in production with outputValidation: true carries the check, and answers the mismatch with the 500",
		() => {
			const js = built("workers-kept", "workers", "production", true)
			expect([js.includes(MARKER), workerAnswer("workers-kept")]).toEqual([true, REFUSED])
		},
		SPAWN_TIMEOUT,
	)
})

/* the first ephemeral port (Linux's ip_local_port_range; macOS's range starts higher still) */
function ephemeralFloor(): number {
	try {
		return Number(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0])
	} catch {
		return 32_768
	}
}

function bindable(port: number): Promise<boolean> {
	return new Promise((done) => {
		const server = createServer()
		server.once("error", () => done(false))
		server.listen(port, "127.0.0.1", () => server.close(() => done(true)))
	})
}

/* a port below the ephemeral range, free now: one inside it can be drawn as an outgoing connection's source port */
async function freePort(): Promise<number> {
	const floor = ephemeralFloor()
	for (;;) {
		const port = 10_000 + Math.floor(Math.random() * (floor - 10_000))
		if (await bindable(port)) return port
	}
}

const servers: ChildProcess[] = []
afterEach(() => {
	for (const child of servers.splice(0)) child.kill("SIGTERM")
})

/** What the server `runtime args` starts answers for /bad once its /health answers: status and body. */
async function served(runtime: string, args: readonly string[]): Promise<string> {
	const port = await freePort()
	const child = spawn(runtime, args, { cwd: dir, env: { ...process.env, NODE_ENV: "production", PORT: String(port) } })
	servers.push(child)
	const logs: string[] = []
	child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()))
	child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()))
	const deadline = Date.now() + 20_000
	while (Date.now() < deadline) {
		const health = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null)
		if (health?.status === 200) {
			const bad = await fetch(`http://127.0.0.1:${port}/bad`)
			return seen(bad.status, await bad.text())
		}
		await new Promise((done) => setTimeout(done, 80))
	}
	throw new Error(`no server on ${port}:\n${logs.join("")}`)
}

describe("a node or bun bundle keeps honey external: its runtime's condition drops the check (plan 40, 10.3)", () => {
	it(
		"node checks by default, and checks nothing started with --conditions=honey-no-output-check",
		async () => {
			const js = built("node", "node", "production")
			expect([
				js.includes(MARKER),
				await served("node", ["dist/node/index.js"]),
				await served("node", ["--conditions=honey-no-output-check", "dist/node/index.js"]),
			]).toEqual([false, REFUSED, '200 {"id":1}'])
		},
		SPAWN_TIMEOUT,
	)

	it.skipIf(!BUN)(
		"bun checks by default, and checks nothing started with --conditions=honey-no-output-check",
		async () => {
			built("bun", "bun", "production")
			expect([
				await served(BUN as string, ["dist/bun/index.js"]),
				await served(BUN as string, ["--conditions=honey-no-output-check", "dist/bun/index.js"]),
			]).toEqual([REFUSED, '200 {"id":1}'])
		},
		SPAWN_TIMEOUT,
	)
})
