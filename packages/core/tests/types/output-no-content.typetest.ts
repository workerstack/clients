/**
 * ctx.res.noContent() under `.output()`, as typed: there only where the route declares its 204 (`no_content`, in the
 * shorthand or under a media type), gone otherwise with the bodiless 204 out of the handler's answers, and whole on a
 * route with no `.output()`. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import type { TypedResponse } from "../../src/response/response.ts"
import { honey } from "../../src/routing/app.ts"
import type { DeclaredAnswer } from "../../src/routing/output-types.ts"

describe("ctx.res.noContent(): only on a route that declares its 204", () => {
	const row = z.object({ id: z.string() })

	it("is gone without a declared no_content, and an empty output declares none", () => {
		const app = honey<{}>()
		app
			.get("/a")
			.output({ ok: row })
			// @ts-expect-error noContent() answers a 204 the route does not declare
			.handler((c) => c.res.noContent())
		app
			.get("/b")
			.output({ "text/csv": { ok: true } })
			.handler((c) => {
				expectTypeOf(c.res).not.toHaveProperty("noContent")
				return c.res.csv("ok", "")
			})
		app
			.get("/c")
			.output({})
			.handler((c) => {
				expectTypeOf(c.res).not.toHaveProperty("noContent")
				return c.res.forward(new Response())
			})
		expectTypeOf<DeclaredAnswer<{ readonly "application/json": { readonly ok: typeof row } }>>().toEqualTypeOf<
			TypedResponse<"application/json", "ok"> | { id: string }
		>()
	})

	it("is there where no_content is declared, in the shorthand or under a media type", () => {
		const app = honey<{}>()
		app
			.get("/a/:id")
			.output({ no_content: true, ok: row })
			.handler((c) => (c.params.id === "gone" ? c.res.noContent() : c.res.json("ok", { id: c.params.id })))
		app
			.delete("/b")
			.output({ "application/json": { no_content: true, ok: row } })
			.handler((c) => c.res.noContent())
		app
			.delete("/c")
			.output({ "text/csv": { no_content: true, ok: true } })
			.handler((c) => c.res.noContent())
		expectTypeOf<
			DeclaredAnswer<{ readonly "application/json": { readonly no_content: true; readonly ok: typeof row } }>
		>().toEqualTypeOf<TypedResponse<"application/json", "no_content" | "ok"> | TypedResponse<"none", "no_content">>()
	})

	it("stays on a route with no .output(), which declares nothing it could be held to", () => {
		honey<{}>()
			.delete("/a")
			.handler((c) => {
				expectTypeOf(c.res.noContent()).toEqualTypeOf<TypedResponse<"none", "no_content">>()
				return c.res.noContent()
			})
	})
})

describe("a declared 204 or 205 is no body helper's status", () => {
	it("refuses no_content and reset_content to json, the text helpers and binary, which throw on a null-body status", () => {
		const row = z.object({ id: z.string() })
		const app = honey<{}>()
		app
			.delete("/a")
			.output({ no_content: true, ok: row, reset_content: true })
			.handler((c) => {
				// @ts-expect-error a 204 carries no body: noContent() answers it
				c.res.json("no_content", { id: "1" })
				// @ts-expect-error a 205 carries no body
				c.res.json("reset_content", { id: "1" })
				expectTypeOf<Parameters<typeof c.res.json>[0]>().toEqualTypeOf<"ok">()
				return c.res.json("ok", { id: "1" })
			})
		app
			.delete("/b")
			.output({ "text/csv": { no_content: true, ok: true } })
			.handler((c) => {
				// @ts-expect-error a 204 carries no body
				c.res.csv("no_content", "")
				expectTypeOf<Parameters<typeof c.res.csv>[0]>().toEqualTypeOf<"ok">()
				return c.res.csv("ok", "")
			})
		app
			.delete("/c")
			.output({
				"application/octet-stream": { no_content: true, ok: true },
				"image/png": { no_content: true, ok: true },
			})
			.handler((c) => {
				// @ts-expect-error a 204 carries no body
				c.res.binary("no_content", new Uint8Array(0))
				// @ts-expect-error a 204 carries no body, under an open type too
				c.res.binary("no_content", new Uint8Array(0), { contentType: "image/png" })
				return c.res.binary("ok", new Uint8Array(0))
			})
	})
})
