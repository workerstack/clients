import { describe, expect, it } from "vitest"
import * as z from "zod"
import { type StatusKey, statusKeyToCode } from "../response/status.ts"
import { honey } from "../routing/app.ts"
import { createNode, insertRoute, type RouteEntry, type RouteTree } from "../routing/tree.ts"
import { generateOpenApi } from "./generate.ts"
import { assertTreeOutputKeys } from "./output-keys.ts"

const STATUSES = Object.keys(statusKeyToCode).join(", ")
/* the slots by status class, from the codes: a body takes a 2xx, redirect a 3xx */
const KEYS = Object.keys(statusKeyToCode) as StatusKey[]
const SUCCESS = KEYS.filter((key) => Math.floor(statusKeyToCode[key] / 100) === 2)
const REDIRECTS = KEYS.filter((key) => Math.floor(statusKeyToCode[key] / 100) === 3)
const INFO = { title: "T", version: "1" }

/** A tree of one `GET /o` route holding `entry`. */
function treeOf(entry: RouteEntry): RouteTree {
	const root = createNode()
	return { meta: {}, root, routes: { [insertRoute(root, "GET", "/o")]: entry }, v: 2 }
}

/** An app whose `GET /o` declares `output`, a JS app's or a cast's: the types refuse a bad key, `.output()` takes it. */
function declaring(output: object, method: "get" | "post" = "get") {
	const app = honey<{}>()
	app[method]("/o")
		.output(output as { no_content: true })
		.handler((c) => c.res.noContent())
	return app
}

/** Documenting `app`, deferred. */
const documenting = (app: ReturnType<typeof declaring>) => () => generateOpenApi(app, { info: INFO })

describe("generateOpenApi: every output key a media type or a status", () => {
	it("refuses a key that names no status, under a media type, headers or redirect, naming it and every status", () => {
		const refusals = [
			[{ "application/json": { orders: z.string() } }, '"orders" under application/json'],
			[{ "text/plain": { __proto__: null, toString: true } }, '"toString" under text/plain'],
			[{ "application/json": { ok: z.string() }, headers: { 200: z.object({}) } }, '"200" under headers'],
			[{ redirect: { OK: true } }, '"OK" under redirect'],
		] as const
		for (const [output, named] of refusals)
			expect(documenting(declaring(output))).toThrow(`GET /o: .output() key ${named} is none of ${STATUSES}`)
	})

	it("refuses a status no slot answers: a non-2xx body, a non-3xx redirect, headers for neither", () => {
		const row = z.object({ x: z.string() })
		const refusals = [
			[
				{ not_found: row },
				'"not_found" under application/json is no 2xx status; an error answer is declared with .errors()',
			],
			[
				{ "text/csv": { internal_server_error: true } },
				'"internal_server_error" under text/csv is no 2xx status; an error answer is declared with .errors()',
			],
			[
				{ "text/csv": { found: true } },
				'"found" under text/csv is no 2xx status; a redirect is declared under redirect',
			],
			[{ ok: row, redirect: { not_found: true } }, '"not_found" under redirect is no 3xx status'],
			[{ ok: row, redirect: { ok: true } }, '"ok" under redirect is no 3xx status'],
			[{ ok: row, headers: { not_found: z.object({}) } }, '"not_found" under headers is no 2xx or 3xx status'],
		] as const
		for (const [output, refusal] of refusals)
			expect(documenting(declaring(output))).toThrow(`GET /o: .output() key ${refusal}`)
	})

	it("refuses an outer key that is no media type, headers or redirect", () => {
		expect(documenting(declaring({ orders: { ok: z.string() } }, "post"))).toThrow(
			'POST /o: .output() key "orders" is no type/subtype, headers or redirect',
		)
	})

	it("takes every 2xx under a media type, every 2xx and 3xx under headers, every 3xx under redirect, and none left", () => {
		const of = (keys: readonly string[], value: unknown) => Object.fromEntries(keys.map((key) => [key, value]))
		const declared = [
			{
				"image/gif": of(SUCCESS, true),
				headers: of([...SUCCESS, ...REDIRECTS], z.object({})),
				redirect: of(REDIRECTS, true),
			},
			{ "application/json": { ok: z.string() }, headers: undefined, redirect: undefined },
		]
		for (const output of declared) expect(documenting(declaring(output))).not.toThrow()
	})
})

describe("generateOpenApi: a response is keyed by its status code, never by a name", () => {
	it("documents every status key .output() takes, a 2xx body, a 3xx redirect and their headers, under its code alone", () => {
		const keys = [...SUCCESS, ...REDIRECTS]
		const app = honey<{}>()
		for (const key of keys)
			app
				.get(`/${key}`)
				.output({
					...(SUCCESS.includes(key) ? { "application/json": { [key]: z.string() } } : { redirect: { [key]: true } }),
					headers: { [key]: z.object({ "x-a": z.string() }) },
				} as unknown as { no_content: true })
				.handler((c) => c.res.noContent())
		const doc = generateOpenApi(app, { info: INFO })
		const named = keys.map((key) => [key, Object.keys(doc.paths[`/${key}`]?.get?.responses ?? {})])
		expect(named).toEqual(keys.map((key) => [key, [String(statusKeyToCode[key])]]))
	})

	it("documents no answer under a name: a route's or a loaded tree's output is keyed by code and media type", () => {
		const smuggled = [
			{ "application/json": { orders: z.string() } },
			{ "application/json": { ok: z.string() }, headers: { orders: z.object({}) } },
			{ redirect: { orders: true } },
			{ orders: { ok: z.string() } },
		]
		const apps = smuggled.flatMap((out) => [declaring(out), honey<{}>().routeTree(treeOf({ out: out as never }))])
		const named = apps.flatMap((app) => {
			let responses: object
			/* a refused document documents nothing */
			try {
				responses = generateOpenApi(app, { info: INFO }).paths["/o"]?.get?.responses ?? {}
			} catch {
				return []
			}
			return Object.entries(responses).flatMap(([code, response]) => [
				...(/^[1-5][0-9]{2}$/.test(code) ? [] : [code]),
				...Object.keys((response as { content?: object }).content ?? {}).filter((media) => !media.includes("/")),
			])
		})
		expect(named).toEqual([])
	})
})

describe("assertTreeOutputKeys: the tree generation writes", () => {
	it("refuses a route whose output holds a key that names no status, and takes a tree without one", () => {
		expect(() =>
			assertTreeOutputKeys(treeOf({ out: { "application/json": { orders: z.string() } } as never })),
		).toThrow('GET /o: .output() key "orders" under application/json is none of')
		for (const entry of [{ out: { "application/json": { ok: z.string() } } }, { out: null }, {}])
			expect(() => assertTreeOutputKeys(treeOf(entry))).not.toThrow()
	})
})
