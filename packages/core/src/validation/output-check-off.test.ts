/**
 * The no-op `#output-check`, what the `honey-no-output-check` condition resolves (a Vite production build through
 * honeyPlugin(), or `--conditions=honey-no-output-check`): this file runs the app as such a build does, with
 * `#output-check` swapped for it. The check on a forwarded answer is no part of it and stays.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest"
import * as z from "zod"
import type { HoneyRes } from "../response/response.ts"
import { honey } from "../routing/app.ts"
import type * as real from "./output-check.ts"
import { outputCheck } from "./output-check-off.ts"

vi.mock("#output-check", () => import("./output-check-off.ts"))

const get = (path: string) => new Request(`http://localhost${path}`)

describe("output-check-off: what a build that drops the check runs", () => {
	it("checks nothing for any declaration, and stands where the real check does", () => {
		expectTypeOf(outputCheck).toExtend<typeof real.outputCheck>()
		expect([outputCheck(), outputCheck()]).toEqual([null, null])
	})

	// v0: 4c624708cb
	// v0: 9c832a61be
	// v0: e79f1ac117
	// v0: 5ca558cfea
	it("lets a mismatched answer through as its handler built it; a forwarded undeclared status is still the 500", async () => {
		const app = honey<{}>().logger(false)
		app
			.get("/bad")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: 1 } as never))
		app
			.get("/html")
			.output({ "text/plain": { ok: true } })
			.handler(
				(ctx) => (ctx.res as HoneyRes).raw(new Response("<p>", { headers: { "content-type": "text/html" } })) as never,
			)
		app
			.get("/forwarded")
			.output({ "text/plain": { ok: true } })
			.handler((ctx) => ctx.res.forward(new Response("x", { status: 409 })))
		const bad = await app.fetch(get("/bad"), {})
		const html = await app.fetch(get("/html"), {})
		const forwarded = await app.fetch(get("/forwarded"), {})
		expect([
			[bad.status, await bad.json()],
			[html.status, await html.text()],
			[forwarded.status, ((await forwarded.json()) as { error_key: string }).error_key],
		]).toEqual([
			[200, { id: 1 }],
			[200, "<p>"],
			[500, "output_validation_failed"],
		])
	})

	it("adds nothing: an answer breaking its declared headers is not checked, and stays synchronous", () => {
		const app = honey<{}>().logger(false)
		app
			.get("/t")
			.output({ "application/json": { ok: z.object({}) }, headers: { ok: z.object({ etag: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", {}, { headers: {} as never }))
		const answer = app.fetch(get("/t"), {})
		expect([answer instanceof Response, (answer as Response).status]).toEqual([true, 200])
	})
})
