/**
 * A route registered on a sub-app and mounted with `.route()` is typed at the ids it is served at: under each chain of
 * mounts that carries its app, built as a chain or by statements, imported or local. A sub reached only through a
 * function parameter, or mounted at a path that is no literal, keeps its own path. Split from extract.test.ts at its
 * 500-line cap.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { extract, type FixtureProject, fixtureProject, lines, SLOW, shown } from "./__fixtures__/project.ts"

let project: FixtureProject
beforeAll(() => {
	project = fixtureProject()
})
afterAll(() => project.dispose())

const IMPORT = 'import { createMiddleware, httpApp, type HttpApp } from "@workerstack/backend/http"'
/** A Standard schema producing `output` from a string. */
const schema = (name: string, output: string) =>
	`const ${name} = { '~standard': { types: undefined as unknown as { input: string; output: ${output} }, validate: (v: unknown) => ({ value: v as never }), vendor: 'x', version: 1 as const } }`
const DB = "const withDb = createMiddleware((_c, next) => next({ db: { name: 'd' } as { name: string } }))"
const OK = '(c) => c.res.text("ok", "ok")'

describe("routes: a mounted group, as kitchen mounts it", () => {
	it(
		"types each mounted route at its mounted id, with its middleware and input, and says nothing",
		() => {
			const entryPath = project.write(
				"mount/kitchen.ts",
				lines(
					IMPORT,
					DB,
					"const withGreeter = createMiddleware((_c, next) => next({ greeter: 'bob' as string }))",
					"const cors = createMiddleware((_c, next) => next({}))",
					schema("search", "{ q: string }"),
					schema("body", "{ name: string }"),
					"const base = () => httpApp<{}>().use(withDb)",
					"function helloRoutes() {",
					`\tconst list = base().get("/").input({ search }).handler(${OK})`,
					`\tconst create = base().use(withGreeter).post("/").input({ json: body }).handler(${OK})`,
					"\treturn { create, list }",
					"}",
					"const hello = helloRoutes()",
					'export const app = httpApp<{}>().basePath("/api")',
					"const corsed = app.use(cors)",
					'corsed.route("/hello", hello.list)',
					'corsed.route("/hello", hello.create)',
				),
			)
			const { reports, types } = extract(entryPath)
			expect(Object.keys(types.routes).sort()).toEqual(["GET /api/hello", "POST /api/hello"])
			expect(shown(types.routes["GET /api/hello"])).toEqual(["db: { name: string }"])
			expect(shown(types.routes["POST /api/hello"])).toEqual(["db: { name: string }", "greeter: string"])
			expect(types.inputs).toEqual({
				"GET /api/hello": "{ search: { q: string } }",
				"POST /api/hello": "{ json: { name: string } }",
			})
			expect(reports).toEqual([])
		},
		SLOW,
	)
})

describe("routes: a sub built by statements, in another module", () => {
	it(
		"follows a sub registered by statements and imported from another module",
		() => {
			project.write(
				"mount/readme/admin.ts",
				lines(IMPORT, DB, "export const admin = httpApp<{}>()", `admin.use(withDb).get("/stats").handler(${OK})`),
			)
			const entryPath = project.write(
				"mount/readme/app.ts",
				lines(
					'import { httpApp } from "@workerstack/backend/http"',
					'import { admin } from "./admin.ts"',
					'export const app = httpApp<{}>().basePath("/api")',
					'app.route("/admin", admin)',
				),
			)
			const { routes } = extract(entryPath).types
			expect(Object.keys(routes)).toEqual(["GET /api/admin/stats"])
			expect(shown(routes["GET /api/admin/stats"])).toEqual(["db: { name: string }"])
		},
		SLOW,
	)
})

describe("routes: a mount with no prefix", () => {
	it(
		"mounts a sub with no prefix under its own base path, its typed params included",
		() => {
			const entryPath = project.write(
				"mount/bare.ts",
				lines(
					IMPORT,
					DB,
					schema("scan", '"daily" | "weekly"'),
					'const sub = httpApp<{}>().basePath("/v2")',
					`sub.use(withDb).get("/items/:scan").input({ params: { scan } }).handler(${OK})`,
					'export const app = httpApp<{}>().basePath("/api")',
					"app.route((sub as typeof sub))",
				),
			)
			const { params, routes } = extract(entryPath).types
			expect(Object.keys(routes)).toEqual(["GET /api/v2/items/:scan"])
			expect(shown(routes["GET /api/v2/items/:scan"])).toEqual(["db: { name: string }"])
			expect(params).toEqual({ "GET /api/v2/items/:scan": '{ scan: "daily" | "weekly"; [key: string]: string }' })
		},
		SLOW,
	)
})

/** A group mounting a sub, itself mounted with `.use()` between; `group` is the export when `exported`. */
const nested = (exported: boolean) =>
	lines(
		IMPORT,
		DB,
		"const mw = createMiddleware((_c, next) => next({}))",
		"const sub = httpApp<{}>()",
		`sub.use(withDb).get("/x").handler(${OK})`,
		`${exported ? "export " : ""}const group = httpApp<{}>()`,
		'group.route("/v1", sub)',
		`${exported ? "" : "export "}const app = httpApp<{}>().basePath("/api")`,
		'app.route("/g", group.use(mw))',
	)

describe("routes: nested mounts", () => {
	it(
		"composes nested mounts and never types the inner mount's own id, unless that group is the export",
		() => {
			const inner = extract(project.write("mount/nested.ts", nested(false))).types.routes
			expect(Object.keys(inner)).toEqual(["GET /api/g/v1/x"])
			const outer = extract(project.write("mount/nested-export.ts", nested(true)), { exportName: "group" }).types
			expect(Object.keys(outer.routes).sort()).toEqual(["GET /api/g/v1/x", "GET /v1/x"])
		},
		SLOW,
	)
})

describe("routes: one id from two mounts", () => {
	it(
		"reports two subs mounted at one id with different middleware, and types one sub at each of its mounts",
		() => {
			const entryPath = project.write(
				"mount/conflict.ts",
				lines(
					IMPORT,
					DB,
					"const other = createMiddleware((_c, next) => next({ other: 1 }))",
					`const a = httpApp<{}>().use(withDb).get("/").handler(${OK})`,
					`const b = httpApp<{}>().use(other).get("/").handler(${OK})`,
					`const both = httpApp<{}>().use(withDb).get("/").handler(${OK})`,
					'export const app = httpApp<{}>().basePath("/api")',
					'app.route("/c", a)',
					'app.route("/c", b)',
					'app.route("/one", both)',
					'app.route("/two", both)',
				),
			)
			const { reports, types } = extract(entryPath)
			expect(Object.keys(types.routes).sort()).toEqual(["GET /api/one", "GET /api/two"])
			expect(shown(types.routes["GET /api/two"])).toEqual(["db: { name: string }"])
			expect(reports).toEqual(['"GET /api/c" is registered with different middleware; its ctx is not extracted'])
		},
		SLOW,
	)
})

describe("routes: what a mount does not follow", () => {
	it(
		"keeps a sub's own path through a parameter or a mount path that is no literal, and ends on a cycle",
		() => {
			const entryPath = project.write(
				"mount/unfollowed.ts",
				lines(
					IMPORT,
					DB,
					'export const app = httpApp<{}>().basePath("/api")',
					"function mount(sub: HttpApp<{}>) {",
					'\tapp.route("/p", sub)',
					"}",
					"const viaParam = httpApp<{}>()",
					`viaParam.use(withDb).get("/param").handler(${OK})`,
					"mount(viaParam)",
					'const prefix: string = "/dyn"',
					"const dynamic = httpApp<{}>()",
					`dynamic.use(withDb).get("/dynamic").handler(${OK})`,
					"app.route(prefix, dynamic)",
					"const ping = httpApp<{}>()",
					"const pong = httpApp<{}>()",
					`ping.use(withDb).get("/ping").handler(${OK})`,
					'ping.route("/pong", pong)',
					'pong.route("/ping", ping)',
					"/* a sub typed any names no binding: it is its own app */",
					"declare const loose: any",
					'app.route("/loose", loose.app)',
				),
			)
			const { reports, types } = extract(entryPath)
			expect(Object.keys(types.routes).sort()).toEqual(["GET /dynamic", "GET /param"])
			expect(reports).toEqual([
				expect.stringMatching(
					/mount\/unfollowed\.ts:13: the mount's path is not a literal type; the routes it mounts keep their own paths$/,
				),
			])
		},
		SLOW,
	)
})

describe("routes: a .route() that is no app's mount", () => {
	it(
		"takes no .route() that is no app's for a mount, and says a base path that is no literal",
		() => {
			const entryPath = project.write(
				"mount/lookalike.ts",
				lines(
					IMPORT,
					DB,
					"class Lookalike<TEnv> { declare readonly $ctx: {}; declare readonly $env: TEnv; route(..._args: unknown[]) { return this } }",
					"const sub = httpApp<{}>()",
					`sub.use(withDb).get("/s").handler(${OK})`,
					"const router = { route: (_path: string, _sub: unknown) => router }",
					'router.route("/r", sub)',
					"new Lookalike<{}>().route()",
					'new Lookalike<{}>().route("/a", sub, 1)',
					'new Lookalike<{}>().route("/a", sub)',
					"class Plain { declare readonly $ctx: {}; declare readonly $env: {}; route(..._args: unknown[]) { return this } }",
					'new Plain().route("/p", sub)',
					"const literal = { $ctx: {}, $env: {}, route: (..._args: unknown[]) => literal }",
					'literal.route("/l", sub)',
					'const dynamic: string = "/d"',
					"export const app = httpApp<{}>().basePath(dynamic)",
					'app.route("/b", sub)',
				),
			)
			const { reports, types } = extract(entryPath)
			expect(Object.keys(types.routes)).toEqual(["GET /s"])
			/* every lookalike that carries an app's members but no literal base path, and the app whose base is none */
			expect(reports.map((r) => r.slice(project.root.length + 1))).toEqual(
				[10, 12, 14, 17].map(
					(line) =>
						`mount/lookalike.ts:${line}: the mount's path is not a literal type; the routes it mounts keep their own paths`,
				),
			)
		},
		SLOW,
	)
})
