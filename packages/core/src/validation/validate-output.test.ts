import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { createNodeServer } from "../adapters/node/server.ts"
import { HoneyError } from "../errors/error.ts"
import { rangeResponse } from "../response/range.ts"
import { HoneyRes } from "../response/response.ts"
import { honey } from "../routing/app.ts"
import { recorder } from "../telemetry/__fixtures__/recording-tracer.ts"
import type { StandardSchemaLike } from "./standard-schema.ts"
import { compileOutput } from "./output-check.ts"
import { validateOutput, withOutput } from "./validate-output.ts"

/** A Response the route does not declare: a fault injected on purpose, past the handler's typed return. */
const undeclared = (ctx: { readonly res: object }, response: Response) => (ctx.res as HoneyRes).raw(response) as never

afterEach(() => {
	vi.restoreAllMocks()
})

/** A schema that answers `issues` (none: the value), synchronously or through a promise. */
function schemaOf(issues: { message: string; path?: PropertyKey[] }[] = [], async = false): StandardSchemaLike {
	const result = (value: unknown) => (issues.length > 0 ? { issues } : { value })
	return {
		"~standard": { validate: (v) => (async ? Promise.resolve(result(v)) : result(v)), vendor: "test", version: 1 },
	}
}

/** The status and JSON body of an answer. */
async function answer(res: Response | Promise<Response>): Promise<[number, Record<string, unknown>]> {
	const r = await res
	return [r.status, (await r.json()) as Record<string, unknown>]
}

const get = (path: string) => new Request(`http://localhost${path}`)
const bytes = (text: string) => new TextEncoder().encode(text)
const post = (path: string) => new Request(`http://localhost${path}`, { method: "POST" })

/** A response honey did not build, of `type`. */
const foreign = (type: string) => new Response('{"a":1}', { headers: { "content-type": type } })

describe("validateOutput: one body against its status's schema", () => {
	// v0: 9f02525354
	it("a valid body passes, synchronously for a sync validator, through a promise for an async one", async () => {
		const sync = validateOutput(schemaOf(), "ok", { id: "a" })
		const later = validateOutput(schemaOf([], true), "ok", { id: "a" })
		expect([sync, later instanceof Promise, await later]).toEqual([undefined, true, undefined])
	})

	// v0: 4e95803da9
	// v0: e26b087fec
	it("an invalid body is a 500 output_validation_failed naming the status key, its issues kept off the error", async () => {
		const error = (() => {
			try {
				validateOutput(schemaOf([{ message: "SECRET_ISSUE", path: ["id"] }]), "created", { wrong: true })
			} catch (thrown) {
				return thrown as HoneyError
			}
			throw new Error("did not throw")
		})()
		const rejected = (await (validateOutput(schemaOf([{ message: "x" }], true), "ok", {}) as Promise<void>).catch(
			(e: unknown) => e,
		)) as HoneyError
		expect([
			error instanceof HoneyError,
			error.status,
			error.errorKey,
			error.vars,
			{ ...error.fields },
			rejected.errorKey,
		]).toEqual([true, 500, "output_validation_failed", { statusKey: "created" }, {}, "output_validation_failed"])
	})
})

/** An app with one route per case under /: every app checks the answers of its `.output()` routes. */
function validating() {
	return honey<{}>().logger(false)
}

describe("output validation through the app: the body", () => {
	// v0: 98e60c1130
	// v0: 0fe366f06e
	// v0: 449dc2edc6
	// v0: 832a2bb161
	// v0: e23ffca92e
	// v0: acf4e3056f
	// v0: 6465cdf2f2
	// v0: d54726d0bf
	// v0: b1944585ce
	it("a valid body passes as sent; an invalid one is a 500 that names no issue", async () => {
		const app = validating()
		const out = { "application/json": { ok: z.strictObject({ id: z.string().describe("SECRET_SCHEMA") }) } }
		app
			.get("/good")
			.output(out)
			.handler((ctx) => ctx.res.json("ok", { id: "abc" }))
		app
			.get("/bad")
			.output(out)
			.handler((ctx) => ctx.res.json("ok", { id: 1 } as never))
		app
			.get("/extra")
			.output(out)
			.handler((ctx) => ctx.res.json("ok", { extra: true, id: "a" } as never))
		const bad = await app.fetch(get("/bad"), {})
		const text = await bad.text()
		expect([
			await answer(app.fetch(get("/good"), {})),
			[
				bad.status,
				(JSON.parse(text) as { error_key: string }).error_key,
				text.includes("SECRET"),
				text.includes("expected"),
			],
			(await app.fetch(get("/extra"), {})).status,
		]).toEqual([[200, { id: "abc" }], [500, "output_validation_failed", false, false], 500])
	})
})

describe("output validation through the app: the status key", () => {
	// v0: 7f5d86fb38
	// v0: 083e63686c
	// v0: fd14d3af26
	// v0: b7fb13e9d7
	// v0: cd570ab228
	it("each status key is validated against its own schema; a status with none passes", async () => {
		const app = validating()
		const out = {
			"application/json": { created: z.object({ id: z.string() }), ok: z.object({ items: z.array(z.string()) }) },
		}
		app
			.get("/ok")
			.output(out)
			.handler((ctx) => ctx.res.json("ok", { items: ["a"] }))
		app
			.post("/created")
			.output(out)
			.handler((ctx) => ctx.res.json("created", { id: "1" }))
		app
			.post("/swapped")
			.output(out)
			.handler((ctx) => ctx.res.json("created", { items: [] } as never))
		app
			.get("/accepted")
			.output(out)
			.handler((ctx) => ctx.res.json("accepted" as never, { anything: 1 } as never))
		expect([
			(await app.fetch(get("/ok"), {})).status,
			(await app.fetch(post("/created"), {})).status,
			(await app.fetch(post("/swapped"), {})).status,
			(await app.fetch(get("/accepted"), {})).status,
		]).toEqual([200, 201, 500, 202])
	})

	// v0: 8f244bcf18
	// v0: 280aee2644
	it("skips an answer with no body and a status no key names", async () => {
		const app = validating()
		const strict = { "application/json": { ok: schemaOf([{ message: "always fails" }]) } }
		app
			.delete("/gone")
			.output(strict)
			/* the types refuse a 204 the route does not declare; this is the answer that reaches the check anyway */
			.handler((ctx) => (ctx.res as unknown as HoneyRes).noContent() as never)
		app
			.get("/partial")
			.output(strict)
			.handler((ctx) =>
				undeclared(
					ctx,
					new Response('{"partial":true}', { headers: { "content-type": "application/json" }, status: 206 }),
				),
			)
		expect([
			(await app.fetch(new Request("http://localhost/gone", { method: "DELETE" }), {})).status,
			(await app.fetch(get("/partial"), {})).status,
		]).toEqual([204, 206])
	})
})

describe("output validation through the app: the content type", () => {
	// v0: a678f62896
	// v0: 18cd65f361
	// v0: abea9769d0
	it("an answer of an undeclared media type is a 500 output_content_type_mismatch, compared by exact essence", async () => {
		const app = validating()
		const out = { "application/json": { ok: schemaOf() } }
		app
			.get("/text")
			.output(out)
			.handler((ctx) => undeclared(ctx, foreign("text/plain")))
		app
			.get("/json5")
			.output(out)
			.handler((ctx) => undeclared(ctx, foreign("application/json5")))
		app
			.get("/charset")
			.output(out)
			.handler((ctx) => undeclared(ctx, foreign("Application/JSON; charset=utf-8")))
		app
			.get("/redirect")
			.output({ ...out, redirect: { found: true } })
			.handler((ctx) => ctx.res.redirect("found", "/x"))
		expect([
			await answer(app.fetch(get("/text"), {})),
			(await answer(app.fetch(get("/json5"), {})))[1].error_key,
			(await app.fetch(get("/charset"), {})).status,
			(await app.fetch(get("/redirect"), {})).status,
		]).toEqual([
			[500, expect.objectContaining({ error_key: "output_content_type_mismatch" })],
			"output_content_type_mismatch",
			200,
			302,
		])
	})
})

describe("output validation through the app: a type other than JSON", () => {
	// v0: 13920939e0
	// v0: bb78fc44db
	// v0: 2bf6ce4a01
	// v0: f86079d3a3
	// v0: d739acb505
	it("a non-JSON declared type is a type contract: its schema never runs, its answer passes", async () => {
		const never = schemaOf([{ message: "must not run" }])
		const app = validating()
		app
			.get("/html")
			.output({ "text/html": { ok: never } })
			.handler((ctx) => ctx.res.html("ok", "<b>x</b>"))
		app
			.get("/text")
			.output({ "text/plain": { ok: never } })
			.handler((ctx) => ctx.res.text("ok", "x"))
		app
			.get("/xml")
			.output({ "application/xml": { ok: never } })
			.handler((ctx) => ctx.res.xml("ok", "<x/>"))
		app
			.get("/csv")
			.output({ "text/csv": { ok: never } })
			.handler((ctx) => ctx.res.csv("ok", "a,b"))
		const types = await Promise.all(
			["/html", "/text", "/xml", "/csv"].map(async (path) => {
				const res = await app.fetch(get(path), {})
				return [res.status, res.headers.get("content-type")]
			}),
		)
		expect(types).toEqual([
			[200, "text/html; charset=utf-8"],
			[200, "text/plain; charset=utf-8"],
			[200, "application/xml"],
			[200, "text/csv; charset=utf-8"],
		])
	})
})

describe("output validation through the app: where the body is read from", () => {
	// v0: 5c990e0a3a
	it("a body honey built is validated from what it retained: never cloned, still whole for the client", async () => {
		const clone = vi.spyOn(Response.prototype, "clone")
		const app = validating()
		app
			.get("/t")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: "abc" }))
		expect([await answer(app.fetch(get("/t"), {})), clone.mock.calls.length]).toEqual([[200, { id: "abc" }], 0])
	})

	it("a body honey kept as bytes is validated from them", async () => {
		const app = validating()
		const out = { "application/json": { ok: z.object({ id: z.string() }) } }
		app
			.get("/good")
			.output(out)
			.handler((ctx) =>
				undeclared(ctx, rangeResponse(ctx.req, bytes('{"id":"a"}'), { contentType: "application/json" })),
			)
		app
			.get("/bad")
			.output(out)
			.handler((ctx) => undeclared(ctx, rangeResponse(ctx.req, bytes('{"id":1}'), { contentType: "application/json" })))
		expect([
			await answer(app.fetch(get("/good"), {})),
			(await answer(app.fetch(get("/bad"), {})))[1].error_key,
		]).toEqual([[200, { id: "a" }], "output_validation_failed"])
	})

	it("an empty body honey built is validated as null, on the native and the Node path", async () => {
		const check = compileOutput({ "application/json": { created: z.null(), ok: z.object({ id: z.string() }) } }, null)
		const answers = await Promise.all(
			[new HoneyRes(), new HoneyRes(true)].map(async (res) => {
				const passed = await check(res.json("created", undefined))
				const failed = (await Promise.resolve()
					.then(() => check(res.json("ok", undefined)))
					.catch((e: unknown) => e)) as HoneyError
				return [passed.status, failed.errorKey]
			}),
		)
		expect(answers).toEqual([
			[201, "output_validation_failed"],
			[201, "output_validation_failed"],
		])
	})

	it("a body honey did not build is read from a clone, and the client still gets it whole", async () => {
		const app = validating()
		app
			.get("/t")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) =>
				undeclared(ctx, new Response('{"id":"raw"}', { headers: { "content-type": "application/json" } })),
			)
		expect(await answer(app.fetch(get("/t"), {}))).toEqual([200, { id: "raw" }])
	})
})

describe("output validation through the app: a stream honey produced", () => {
	it("is never buffered: its producer is not drained to validate it", async () => {
		const validate = vi.fn(() => ({ value: {} }))
		let produced = 0
		const app = validating()
		app
			.get("/stream")
			.output({ "application/json": { ok: { "~standard": { validate, vendor: "test", version: 1 } } } })
			.handler(
				(ctx) =>
					/* generate() is not on a ctx.res narrowed to json, nor is its answer a declared one; the runtime has both */
					(ctx.res as unknown as HoneyRes).generate(
						(function* () {
							for (;;) yield `${++produced}\n`
						})(),
						{ contentType: "application/json" },
					) as never,
			)
		const res = await app.fetch(get("/stream"), {})
		const reader = (res.body as ReadableStream<Uint8Array>).getReader()
		await reader.read()
		await reader.cancel()
		expect([res.status, validate.mock.calls.length, produced < 100]).toEqual([200, 0, true])
	})
})

describe("withOutput: the wrap that runs a check on what a handler answers", () => {
	it("a handler that answered nothing is not checked, sync or async", async () => {
		const check = vi.fn((response: Response) => response)
		const sync = withOutput(check, () => undefined as unknown as Response)({})
		const later = await withOutput(check, async () => undefined as unknown as Response)({})
		expect([sync, later, check.mock.calls.length]).toEqual([undefined, undefined, 0])
	})
})

describe("output validation through the app: on with nothing set", () => {
	// v0: 07ded1e522
	// v0: ceb527377f
	// v0: 22076a3067
	it("a mismatched .output() answer is the 500 with no setting and no plugin; a route without .output() is not checked", async () => {
		const app = honey<{}>().logger(false)
		app
			.get("/t")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: 1 } as never))
		app.get("/plain").handler((ctx) => ctx.res.raw(new Response("text", { headers: { "content-type": "text/plain" } })))
		expect([await answer(app.fetch(get("/t"), {})), (await app.fetch(get("/plain"), {})).status]).toEqual([
			[500, expect.objectContaining({ error_key: "output_validation_failed" })],
			200,
		])
	})

	it("a sync handler and a sync check still answer app.fetch with the Response itself; an async validator, a promise", () => {
		const sync = validating()
		sync
			.get("/t")
			.output({ "application/json": { ok: schemaOf() } })
			.handler((ctx) => ctx.res.json("ok", {}))
		const later = validating()
		later
			.get("/t")
			.output({ "application/json": { ok: schemaOf([], true) } })
			.handler((ctx) => ctx.res.json("ok", {}))
		expect([sync.fetch(get("/t"), {}) instanceof Response, later.fetch(get("/t"), {}) instanceof Promise]).toEqual([
			true,
			true,
		])
	})
})

describe("output validation beside the rest of the request", () => {
	// v0: fdde3375b0
	it("a failed check reaches onError and telemetry as the thrown error it is", async () => {
		const seen: string[] = []
		const app = validating()
		app.onError((error) => void seen.push((error as HoneyError).errorKey))
		const { telemetry } = recorder()
		app.telemetry({ ...telemetry, onError: (report) => void seen.push(`telemetry:${report.honeyError.errorKey}`) })
		app
			.get("/t")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) =>
				undeclared(ctx, new Response('{"wrong":true}', { headers: { "content-type": "application/json" } })),
			)
		expect((await app.fetch(get("/t"), {})).status).toBe(500)
		expect(seen).toEqual(["output_validation_failed", "telemetry:output_validation_failed"])
	})

	// v0: 3dc97b1ac7
	// v0: 23dddae562
	// v0: e940c64936
	// v0: 3c39b02ac0
	// v0: 71226efd86
	it("runs after input: invalid input is a 400 the output check never sees; valid input with invalid output a 500", async () => {
		const validate = vi.fn((value: unknown) => ({ value }))
		const app = validating()
		app
			.post("/u")
			.input({ json: z.object({ name: z.string() }) })
			.output({ "application/json": { created: { "~standard": { validate, vendor: "test", version: 1 } } } })
			.handler((ctx) => ctx.res.json("created", { name: ctx.input.json.name.toUpperCase() }))
		const send = (body: string) =>
			app.fetch(
				new Request("http://localhost/u", { body, headers: { "content-type": "application/json" }, method: "POST" }),
				{},
			)
		const [bad, good] = [await send('{"name":1}'), await answer(send('{"name":"ada"}'))]
		expect([bad.status, good, validate.mock.calls]).toEqual([400, [201, { name: "ADA" }], [[{ name: "ADA" }]]])
	})
})

describe("output validation over real HTTP", () => {
	// v0: 9c1b0baf81
	// v0: 9b32e7fceb
	it("a valid answer arrives as sent; an invalid one arrives as a 500 output_validation_failed", async () => {
		const app = validating()
		const out = { "application/json": { ok: z.object({ id: z.string() }) } }
		app
			.get("/valid")
			.output(out)
			.handler((ctx) => ctx.res.json("ok", { id: "abc" }))
		app
			.get("/bad")
			.output(out)
			.handler((ctx) => undeclared(ctx, foreign("application/json")))
		const server = createNodeServer(app, { env: {}, hostname: "127.0.0.1", port: 0 })
		await new Promise((resolve) => server.once("listening", resolve))
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		try {
			expect([await answer(fetch(`${base}/valid`)), (await answer(fetch(`${base}/bad`)))[1].error_key]).toEqual([
				[200, { id: "abc" }],
				"output_validation_failed",
			])
		} finally {
			await server.shutdown(0)
		}
	})
})
