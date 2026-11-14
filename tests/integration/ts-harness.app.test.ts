/**
 * The reference app's own cross-request delivery on workerd: a realtime send (one request) answers past the cap, then
 * `{ n: 1 }` reaches the event stream another request opened. workerd refuses I/O on another request's objects, so a
 * send that wrote into the stream itself would leave it to be canceled as hung, ending with no frame.
 */
import { afterAll, beforeAll, expect, it } from "vitest"
import { type ReferenceApp, startReferenceApp } from "./conformance/harness.ts"

let app: ReferenceApp | undefined

beforeAll(async () => {
	app = await startReferenceApp()
}, 60_000)

afterAll(async () => {
	await app?.stop()
})

/** `reader`'s text until it holds `needle`, or with `<end>` once the stream ends or 5 s pass first. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
	const decoder = new TextDecoder()
	const timer = setTimeout(() => void reader.cancel(), 5000)
	let text = ""
	try {
		while (!text.includes(needle)) {
			const { done, value } = await reader.read()
			if (done) return `${text}<end>`
			text += decoder.decode(value, { stream: true })
		}
		return text
	} finally {
		clearTimeout(timer)
	}
}

it("delivers a realtime send's frame to the event stream another request opened", async () => {
	const { url } = app as ReferenceApp
	const stream = await fetch(`${url}/v1/realtime/capped`, { headers: { accept: "text/event-stream" } })
	expect(stream.status).toBe(200)
	const reader = (stream.body as ReadableStream<Uint8Array>).getReader()
	expect(await readUntil(reader, "retry: 1000")).toContain("retry: 1000")
	const sent = await fetch(`${url}/v1/realtime/capped`, {
		body: JSON.stringify({ say: "hi" }),
		headers: { "content-type": "application/json" },
		method: "POST",
	})
	expect(sent.status).toBe(200)
	expect(await readUntil(reader, '"n":1')).toContain('data: {"n":1}')
	await reader.cancel()
})
