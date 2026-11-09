/**
 * The answer check `#output-check` resolves to by default, on its own: what it lets through unread, and that a
 * route's check runs its declared headers before its body. Its run through an app is validate-output.test.ts's.
 */
import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { HoneyRes } from "../response/response.ts"
import type { StandardSchemaLike } from "./standard-schema.ts"
import { compileOutput, outputCheck } from "./output-check.ts"

/** A schema that answers `issues` (none: the value), synchronously. */
function schemaOf(issues: { message: string }[] = []): StandardSchemaLike {
	return {
		"~standard": { validate: (v) => (issues.length > 0 ? { issues } : { value: v }), vendor: "test", version: 1 },
	}
}

describe("compileOutput: answers it lets through unread", () => {
	const failing = { "application/json": { ok: schemaOf([{ message: "always fails" }]) } }

	it("a body with no content type, and a status no status key names, pass unread", () => {
		const check = compileOutput(failing, null)
		const untyped = new Response(new Blob(["{}"]).stream())
		const unnamed = new Response("{}", { headers: { "content-type": "application/json" }, status: 299 })
		expect([check(untyped), check(unnamed)]).toEqual([untyped, unnamed])
	})

	it("passes a forwarded answer unread, whatever its media type: forwardCheck judges it", () => {
		const forwarded = new HoneyRes().forward(
			new Response("<p>", { headers: { "content-type": "text/html" }, status: 404 }),
		)
		expect(compileOutput(failing, null)(forwarded)).toBe(forwarded)
	})

	it("checks the declared headers first: an async header check makes the answer a promise", async () => {
		const later = vi.fn(async () => undefined)
		const check = compileOutput({ "application/json": { ok: schemaOf() } }, later)
		const response = new HoneyRes().json("ok", {})
		const answered = check(response)
		expect([answered instanceof Promise, await answered, later.mock.calls]).toEqual([true, response, [[response]]])
	})
})

describe("outputCheck: a route's whole check, its declared headers compiled in", () => {
	it("refuses an answer missing a declared header, and passes one that carries it", async () => {
		const check = outputCheck({
			"application/json": { ok: z.object({}) },
			headers: { ok: z.object({ etag: z.string() }) },
		})
		const refused = await Promise.resolve()
			.then(() => check?.(new HoneyRes().json("ok", {})))
			.catch((error: unknown) => (error as { errorKey: string }).errorKey)
		const tagged = new HoneyRes().json("ok", {}, { headers: { etag: '"v1"' } as never })
		expect([refused, check?.(tagged)]).toEqual(["output_validation_failed", tagged])
	})
})
