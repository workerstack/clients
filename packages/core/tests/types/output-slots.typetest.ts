/**
 * `.output()` takes only answers a route can give: a body slot (a media type, or the shorthand) takes the 2xx keys,
 * `redirect` the 3xx keys, `headers` the 2xx and 3xx keys; an error answer is declared with `.errors()`. A custom media
 * type keeps every slot. The refusals' messages are held by output-messages.test.ts, and the completions by
 * output-completions.test.ts. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { honey } from "../../src/routing/app.ts"

describe(".output() slots: the answers a route can give", () => {
	const route = honey<{}>().get("/t")
	const row = z.object({ x: z.string() })

	it("takes 2xx bodies, 3xx redirects, 2xx and 3xx headers; refuses an error status, a 3xx body, a non-3xx redirect", () => {
		expectTypeOf(
			route.output({
				"application/vnd.x+json": { ok: row, no_content: true },
				headers: { ok: z.object({ etag: z.string() }), found: z.object({ "x-a": z.string() }) },
				redirect: { found: true, not_modified: true },
			}),
		).toHaveProperty("handler")
		// @ts-expect-error a 4xx body in the shorthand is an error answer, declared with .errors()
		route.output({ not_found: row })
		// @ts-expect-error a 5xx body under a media type is an error answer, declared with .errors()
		route.output({ "application/json": { internal_server_error: row } })
		// @ts-expect-error a 3xx in a body slot is a redirect, declared under redirect
		route.output({ "text/csv": { found: true } })
		// @ts-expect-error a 4xx under redirect is no 3xx status
		route.output({ ok: row, redirect: { not_found: true } })
		// @ts-expect-error a 2xx under redirect is no 3xx status
		route.output({ ok: row, redirect: { ok: true } })
		// @ts-expect-error headers for a 4xx: an error answer is declared with .errors()
		route.output({ ok: row, headers: { not_found: z.object({ "x-a": z.string() }) } })
	})
})
