/**
 * `generateTypes` ctx: `BaseCtx` from the extracted env and middleware, with `HttpContext`'s defined-tap `tap`; each
 * route's own middleware additions; its parsed `ctx.input` (O3); the ctx shape mirroring v1 `HandlerCtx` (O9). Each
 * consumer reads a route's ctx as a handler is typed, `OperationCtx<"<id>">` through the operationId slot.
 */
import * as tsMorph from "ts-morph"
import { describe, expect, it } from "vitest"
import type { ExtractedTypes } from "../../extract/extract.ts"
import { extracted, type HttpApp, httpDoc, object } from "./__fixtures__/http-doc.ts"
import { typechecker } from "./__fixtures__/typecheck.ts"
import { generateTypes } from "./type-gen.ts"

const typecheck = typechecker(tsMorph)

const STRING = { type: "string" }

/** generateTypes over `app`, what it reported and its text, and each diagnostic of `consumer` beside it. */
function check(app: HttpApp, consumer: string, types: ExtractedTypes | null, files: Record<string, string> = {}) {
	const reports: string[] = []
	const text = generateTypes({ ...app, extracted: types, report: (m) => reports.push(m) })
	return { diagnostics: typecheck(text, consumer, files), reports, text }
}

/** An app of `GET` routes at `patterns`, each declaring its pattern's first segment as its operationId. */
const gets = (...patterns: string[]): HttpApp =>
	httpDoc(patterns.map((pattern) => ({ meta: { operationId: pattern.slice(1) }, method: "GET", pattern })))

/** Every consumer here reads ctx through core's own generic. */
const OPERATION_CTX = `import type { OperationCtx } from "@workerstack/backend/http"\n`

describe("BaseCtx", () => {
	// v0: 8c8a800da4
	it("is HttpContext<Record<string, unknown>> with nothing extracted, imported without HttpError", () => {
		const consumer = `${OPERATION_CTX}expectType<Equal<BaseCtx, HttpContext<Record<string, unknown>>>>()`
		const { diagnostics, text } = check(gets("/health"), consumer, null)
		expect({
			diagnostics,
			imports: text.includes('import type { HttpContext, WithOutput } from "@workerstack/backend/http"'),
		}).toEqual({
			diagnostics: [],
			imports: true,
		})
	})

	// v0: 5b5963dc6a
	it("takes the extracted env as HttpContext's generic and the middleware additions beside it", () => {
		const types = extracted({
			env: "{ DB: string; KV: Map<string, string> }",
			middleware: { user: "{ id: string; role: string }" },
		})
		const consumer = `${OPERATION_CTX}expectType<Same<BaseCtx["env"], { DB: string; KV: Map<string, string> }>>()
expectType<Same<BaseCtx["user"], { id: string; role: string }>>()
expectType<BaseCtx extends HttpContext<{ DB: string; KV: Map<string, string> }> ? true : false>()
expectType<Same<OperationCtx<"health">["user"], { id: string; role: string }>>()`
		expect(check(gets("/health"), consumer, types).diagnostics).toEqual([])
	})

	// v0: b762ffb505
	it("is HttpContext<env> alone when middleware added nothing", () => {
		const consumer = `${OPERATION_CTX}expectType<Equal<BaseCtx, HttpContext<{ DB: string }>>>()`
		expect(check(gets("/health"), consumer, extracted({ env: "{ DB: string }" })).diagnostics).toEqual([])
	})

	// v0: 5c381daca0
	it("carries what app.context() added into every route's ctx", () => {
		const types = extracted({ env: "{ SECRET: string }", middleware: { db: "string" } })
		const consumer = `${OPERATION_CTX}expectType<Equal<OperationCtx<"test">["db"], string>>()
expectType<Same<OperationCtx<"test">["env"], { SECRET: string }>>()`
		expect(check(gets("/test"), consumer, types).diagnostics).toEqual([])
	})
})

/* a Standard Schema typed `{ action: "create" | "delete" }`, as a validation library hands defineTap one */
const AUDIT_TAP = `import { defineTap } from "@workerstack/backend/http"
type Audit = { action: "create" | "delete"; resource: string }
declare const schema: { readonly "~standard": { readonly version: 1; readonly vendor: "test"; readonly validate: (value: unknown) => { readonly value: Audit }; readonly types?: { readonly input: Audit; readonly output: Audit } } }
const audit = defineTap("audit", schema, () => undefined)
`

describe("taps", () => {
	it("keeps HttpContext's tap(tap, payload): a defined tap's payload checks against its schema", () => {
		const consumer = `${OPERATION_CTX}${AUDIT_TAP}declare const base: BaseCtx
declare const ctx: OperationCtx<"test">
base.tap(audit, { action: "create", resource: "r" })
ctx.tap(audit, { action: "delete", resource: "r" })
// @ts-expect-error: a payload outside the schema's literals
ctx.tap(audit, { action: "update", resource: "r" })
// @ts-expect-error: a string key is no longer a tap
ctx.tap("audit", { action: "create", resource: "r" })`
		const { diagnostics, text } = check(gets("/test"), consumer, extracted())
		expect({ diagnostics, tapMap: /TapMap|tap</.test(text) }).toEqual({ diagnostics: [], tapMap: false })
	})
})

describe("a step shared by several operations", () => {
	it("types OperationCtx over two ids as their merged ctx: c.with and the errors both declare", () => {
		const app = httpDoc([
			{
				errors: { not_found: { status: 404 } },
				meta: { operationId: "users.get" },
				method: "GET",
				pattern: "/users/:id",
			},
			{
				errors: { conflict: { status: 409 }, not_found: { status: 404 } },
				meta: { operationId: "users.update" },
				method: "PUT",
				pattern: "/users/:id",
			},
		])
		const consumer = `${OPERATION_CTX}declare const c: OperationCtx<"users.get" | "users.update">
const derived = c.with({ user: { id: "u1" } })
expectType<Same<typeof derived.user, { id: string }>>()
expectType<Equal<ReturnType<typeof c.errors.not_found>, HttpError>>()
// @ts-expect-error: only users.update declares conflict
c.errors.conflict`
		const types = extracted({ middleware: { user: "{ id: string }" } })
		expect(check(app, consumer, types).diagnostics).toEqual([])
	})
})

describe("per-route additions", () => {
	// v0: 697b381e1a
	it("extends only that route's ctx", () => {
		const types = extracted({ routes: { "GET /private": { auth: "{ sub: string }" } } })
		const consumer = `${OPERATION_CTX}expectType<Same<OperationCtx<"private">["auth"], { sub: string }>>()
expectType<Equal<"auth" extends keyof OperationCtx<"public"> ? true : false, false>>()`
		expect(check(gets("/public", "/private"), consumer, types).diagnostics).toEqual([])
	})

	// v0: 1a7a0badb1
	it("combines with the route's input and declared errors", () => {
		const app = httpDoc([
			{
				errors: { forbidden: { status: 403 } },
				input: { json: object({ action: STRING }) },
				meta: { operationId: "admin.action" },
				method: "POST",
				pattern: "/admin/action",
			},
		])
		const types = extracted({ routes: { "POST /admin/action": { auth: "{ role: string; sub: string }" } } })
		const consumer = `${OPERATION_CTX}type C = OperationCtx<"admin.action">
expectType<Same<C["auth"], { role: string; sub: string }>>()
expectType<Same<C["input"], { json: { action: string } }>>()
expectType<Equal<RouteErrors<"/admin/action", "post">, "forbidden">>()
expectType<Equal<ReturnType<C["errors"]["forbidden"]>, HttpError>>()`
		expect(check(app, consumer, types).diagnostics).toEqual([])
	})

	// v0: 0a41708edf
	it("leaves a route without an entry on plain BaseCtx, and reports an entry no operation documents", () => {
		const types = extracted({ routes: { "GET /other": { auth: "string" } } })
		const consumer = `${OPERATION_CTX}expectType<Equal<"auth" extends keyof OperationCtx<"health"> ? true : false, false>>()
expectType<Equal<OperationCtx<"health">["env"], BaseCtx["env"]>>()`
		const { diagnostics, reports } = check(gets("/health"), consumer, types)
		expect({ diagnostics, reports }).toEqual({
			diagnostics: [],
			reports: [
				"GET /other: extracted ctx additions match no documented operation (internal and filtered routes are not documented); not typed",
			],
		})
	})

	// v0: a5b73c73eb
	it("gives two routes with different additions each their own ctx extension", () => {
		const types = extracted({
			routes: {
				"GET /admin-area": { admin: "{ level: number }", auth: "{ sub: string }" },
				"GET /user-area": { auth: "{ sub: string }" },
			},
		})
		const consumer = `${OPERATION_CTX}expectType<Same<OperationCtx<"user-area">["auth"], { sub: string }>>()
expectType<Equal<"admin" extends keyof OperationCtx<"user-area"> ? true : false, false>>()
expectType<Same<OperationCtx<"admin-area">["auth"], { sub: string }>>()
expectType<Same<OperationCtx<"admin-area">["admin"], { level: number }>>()
expectType<Equal<"auth" extends keyof OperationCtx<"public"> ? true : false, false>>()`
		expect(check(gets("/public", "/user-area", "/admin-area"), consumer, types).diagnostics).toEqual([])
	})
})

/* the app's own module, as the Serializer references it by import(): a pipe's recursive output types */
const APP_TS = `export type FieldsNode = { relations: Record<string, FieldsNode | null>; scalars: string[] }
export type FilterNode = { conditions: { field: string; operator: string; value: unknown }[]; logic: "and" | "or"; subgroups: FilterNode[] }`

describe("the ctx shape", () => {
	// v0: 08970024e7
	it("types ctx.input by the extracted parsed type: a pipe's recursive output, never { root: unknown }", () => {
		const search = object({ filter: STRING, limit: { type: "integer" }, select: STRING }, [])
		const input = `{ search: { filterAst: { root: import("./app").FilterNode } | null; limit: number; parsedFields: { root: import("./app").FieldsNode } | null } }`
		const types = extracted({ inputs: { "GET /items": input } })
		const consumer = `${OPERATION_CTX}type S = OperationCtx<"items">["input"]["search"]
type ParsedFields = { root: { relations: Record<string, ParsedFields["root"] | null>; scalars: string[] } }
expectType<Same<S["parsedFields"], ParsedFields | null>>()
expectType<Equal<NonNullable<S["filterAst"]>["root"]["subgroups"][number]["logic"], "and" | "or">>()
expectType<Equal<"filter" extends keyof S ? true : false, false>>()`
		const app = httpDoc([{ input: { search }, meta: { operationId: "items" }, method: "GET", pattern: "/items" }])
		expect(check(app, consumer, types, { "app.ts": APP_TS }).diagnostics).toEqual([])
	})

	it("mirrors v1 HandlerCtx: readonly input, the route's meta and its pattern", () => {
		const app = httpDoc([
			{
				input: { search: object({ q: STRING }) },
				meta: { auth: true, operationId: "users.get" },
				method: "GET",
				pattern: "/users/:id",
			},
		])
		const consumer = `${OPERATION_CTX}declare const ctx: OperationCtx<"users.get">
expectType<Equal<typeof ctx.routePattern, "/users/:id">>()
expectType<Equal<typeof ctx.meta.auth, true>>()
expectType<Same<typeof ctx.input, { search: { q: string } }>>()
// @ts-expect-error: input is readonly
ctx.input = { search: { q: "" } }`
		expect(check(app, consumer, null).diagnostics).toEqual([])
	})

	it("types ctx.params by the extracted type where a param schema declares one, else the path's strings", () => {
		const app = httpDoc([
			{ meta: { operationId: "scans.run" }, method: "POST", pattern: "/scans/:scan" },
			{ meta: { operationId: "items.get" }, method: "GET", pattern: "/items/:id" },
		])
		const consumer = `${OPERATION_CTX}expectType<Equal<OperationCtx<"scans.run">["params"]["scan"], "daily" | "weekly">>()
expectType<Equal<OperationCtx<"items.get">["params"]["id"], string>>()`
		const types = extracted({ params: { "POST /scans/:scan": '{ scan: "daily" | "weekly"; [key: string]: string }' } })
		expect(check(app, consumer, types).diagnostics).toEqual([])
	})

	it("falls back to the document's wire input when the route has no extracted input", () => {
		const app = httpDoc([
			{ input: { search: object({ q: STRING }) }, meta: { operationId: "find" }, method: "GET", pattern: "/find" },
		])
		const consumer = `${OPERATION_CTX}expectType<Same<OperationCtx<"find">["input"], { search: { q: string } }>>()`
		expect(check(app, consumer, extracted({ inputs: { "GET /other": "{ json: number }" } })).diagnostics).toEqual([])
	})
})
