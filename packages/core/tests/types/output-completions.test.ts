/**
 * What an editor offers inside `.output({ })`: the known media types and the answers a route can give, never an error
 * status, as TypeScript's own language server lists them. TypeScript 7 ships no LanguageService in JS, so this spawns
 * its native `tsc --lsp --stdio` (through the package's own getExePath) and asks it over JSON-RPC, as VS Code does.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../fixture/spawn-timeout.ts"

const CORE = join(import.meta.dirname, "../..")
/* the native server's path as the typescript package resolves it; the file sits outside the package's exports */
const GET_EXE_PATH = pathToFileURL(join(CORE, "../../node_modules/typescript/lib/getExePath.js")).href
const { default: getExePath } = (await import(GET_EXE_PATH)) as { default: () => string }

/* inside core, so `@workerstack/backend` resolves through the workspace link with core's honey-source condition */
mkdirSync(join(CORE, ".tmp"), { recursive: true })
const scratch = mkdtempSync(join(CORE, ".tmp/output-completions-"))
let server: ChildProcessWithoutNullStreams | undefined
afterAll(() => {
	/* only the server this file spawned, and only while it still runs */
	if (server && server.exitCode === null && server.signalCode === null) server.kill()
	rmSync(scratch, { force: true, recursive: true })
})

const SUCCESS = [
	"accepted",
	"already_reported",
	"created",
	"im_used",
	"multi_status",
	"no_content",
	"non_authoritative_information",
	"ok",
	"partial_content",
	"reset_content",
]
const MEDIA = [
	'"application/json"',
	'"application/octet-stream"',
	'"application/xml"',
	'"text/csv"',
	'"text/event-stream"',
	'"text/html"',
	'"text/plain"',
]
const REDIRECTS = [
	"found",
	"moved_permanently",
	"multiple_choices",
	"not_modified",
	"permanent_redirect",
	"see_other",
	"temporary_redirect",
]

/** The fixture: a custom media type and a typo that must compile, then the call completions are asked inside. */
const PRELUDE = [
	'import { honey } from "@workerstack/backend"',
	'import * as z from "zod"',
	"const row = z.object({ x: z.string() })",
	'const route = honey().get("/x")',
	'route.output({ "application/vnd.x+json": { ok: row }, "text/cs": { ok: row } })',
]
/** Each place completions are asked: the call, with `|` where the cursor stands. */
const CURSORS = {
	outer: "route.output({ | })",
	body: 'route.output({ "text/csv": { | } })',
	redirect: "route.output({ redirect: { | } })",
}

/** A JSON-RPC client over `child`'s stdio: `request` resolves with the answer to its id, `notify` sends one-way. */
function rpc(child: ChildProcessWithoutNullStreams) {
	let buffer = Buffer.alloc(0)
	let next = 0
	const waiting = new Map<number, (message: { result?: unknown }) => void>()
	const send = (message: object) => {
		const text = JSON.stringify({ jsonrpc: "2.0", ...message })
		child.stdin.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`)
	}
	child.stdout.on("data", (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk])
		for (let end = buffer.indexOf("\r\n\r\n"); end >= 0; end = buffer.indexOf("\r\n\r\n")) {
			const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1])
			if (buffer.length < end + 4 + length) return
			const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString()) as {
				id?: number
				method?: string
				result?: unknown
			}
			buffer = buffer.subarray(end + 4 + length)
			/* a request from the server (a configuration or registration ask) is answered empty */
			if (message.method !== undefined && message.id !== undefined) send({ id: message.id, result: null })
			else if (message.id !== undefined) waiting.get(message.id)?.(message)
		}
	})
	return {
		notify: (method: string, params?: object) => send({ method, params }),
		request: (method: string, params?: object) =>
			new Promise<{ result?: unknown }>((resolve) => {
				waiting.set(++next, resolve)
				send({ id: next, method, params })
			}),
	}
}

type Completion = { label: string }

/** The optional-property labels the server completes at each cursor, sorted, and its errors on the prelude. */
async function complete(): Promise<{ errors: string[]; labels: Record<string, string[]> }> {
	const file = join(scratch, "f.ts")
	writeFileSync(
		join(scratch, "tsconfig.json"),
		JSON.stringify({ extends: join(CORE, "tsconfig.json"), files: ["f.ts"], include: [] }),
	)
	const lines = [...PRELUDE, ...Object.values(CURSORS).map((call) => call.replace("|", "")), "export {}", ""]
	writeFileSync(file, lines.join("\n"))
	server = spawn(getExePath(), ["--lsp", "--stdio"], { cwd: scratch })
	const { notify, request } = rpc(server)
	const uri = pathToFileURL(file).href
	await request("initialize", { capabilities: {}, processId: process.pid, rootUri: pathToFileURL(scratch).href })
	notify("initialized", {})
	notify("textDocument/didOpen", {
		textDocument: { languageId: "typescript", text: lines.join("\n"), uri, version: 1 },
	})
	const labels: Record<string, string[]> = {}
	for (const [index, [name, call]] of Object.entries(CURSORS).entries()) {
		const position = { character: call.indexOf("|"), line: PRELUDE.length + index }
		const { result } = await request("textDocument/completion", { position, textDocument: { uri } })
		const items = (Array.isArray(result) ? result : (result as { items: Completion[] }).items) as Completion[]
		labels[name] = items
			.map(({ label }) => label)
			.filter((label) => label.endsWith("?"))
			.toSorted()
	}
	const { result } = await request("textDocument/diagnostic", { textDocument: { uri } })
	const errors = (result as { items: { message: string; range: { start: { line: number } } }[] }).items
		.filter(({ range }) => range.start.line < PRELUDE.length)
		.map(({ message }) => message)
	await request("shutdown")
	notify("exit")
	return { errors, labels }
}

const optional = (labels: string[]) => labels.map((label) => `${label}?`).toSorted()

describe(".output() completions: the known media types and the answers a route can give", () => {
	it(
		"lists the media types, the 2xx keys, headers and redirect; 2xx in a body; 3xx under redirect",
		async () => {
			const { errors, labels } = await complete()
			expect(labels).toEqual({
				body: optional(SUCCESS),
				outer: optional([...MEDIA, ...SUCCESS, "headers", "redirect"]),
				redirect: optional(REDIRECTS),
			})
			/* a custom media type and a typo of a known one gain no completion and no refusal */
			expect(errors).toEqual([])
		},
		SPAWN_TIMEOUT,
	)
})
