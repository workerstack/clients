/**
 * `generateTypes` (F3): an app's `_gen/types.gen.d.ts` — the `Routes` map, each route's ctx,
 * input, output, errors and meta, the `HttpCodegen` `operationId` slot mapping each declared id
 * to its context, and `BaseCtx`. Read from the app's OpenAPI document (the IR), its route tree
 * (meta, O1) and the extracted ctx types (middleware, env, parsed inputs, O3), joined on
 * `x-backend-route`.
 */
import type { ExtractedProp, ExtractedTypes } from "../../extract/extract.ts"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import type { IR, IROperation, IRParam, IRResponse, IRSchema } from "../../ir/model.ts"
import { isJsonMedia, mediaEssence } from "../../ir/sdk-model.ts"
import { bodiesOf } from "../../ir/slots.ts"
import { tsString } from "../shared/escape.ts"
import { compareCodeUnits } from "../shared/lang.ts"
import { literalType, quoteKey } from "../shared/literals.ts"
import { statusKeyOf } from "../shared/status-keys.ts"
import { irToTs, type TypeOptions } from "../shared/type-emitter.ts"
import type { RouteTree } from "./route-tree.ts"
import { componentNames } from "./sdk-types.ts"

/**
 * What `generateTypes` reads: the app's document, route tree and extracted types, and how to report what could not be
 * joined.
 */
export type GenerateTypesOptions = {
	/** what the ctx base type is named; default `BaseCtx` */
	readonly baseCtxName?: string
	/** the app's OpenAPI document; an operation without an `operationId` gets a derived one */
	readonly document: Record<string, unknown>
	/** the app's extracted types; null without ts-morph (inputs then fall back to the document's) */
	readonly extracted: ExtractedTypes | null
	/** what could not be joined, said once each */
	readonly report: (message: string) => void
	/** the app's route tree, read for each route's meta */
	readonly tree: RouteTree
}

/* the names the file declares, which a component schema never takes */
const RESERVED = ["HttpContext", "HttpError", "HttpMeta", "Omit", "Partial", "Readonly", "Record", "Routes"]

/* the v1 error-factory signature of a key without a schema (core errors.ts ErrorFactoryOpts) */
const STANDARD_FACTORY =
	"(opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, number | string> }) => HttpError"

const EXTRACTORS: readonly (readonly [string, string])[] = [
	["RouteInput", "input"],
	["RouteOutput", "output"],
	["RouteErrors", "errors"],
	["RouteErrorShapes", "errorShapes"],
	["RouteErrorsByStatus", "errorsByStatus"],
	["RouteMeta", "meta"],
]

type Field = readonly [key: string, type: string]

/** `{ k: T; … }`, or `{}` when there is nothing in it. */
const objectText = (fields: readonly Field[]) =>
	fields.length === 0 ? "{}" : `{ ${fields.map(([key, type]) => `${key}: ${type}`).join("; ")} }`

const propsText = (props: readonly ExtractedProp[]) =>
	objectText(props.map((p) => [`${quoteKey(p.name)}${p.optional ? "?" : ""}`, p.type]))

/** The documented routes by route id; an operation without `x-backend-route` is reported and left out. */
function routesOf(ir: IR, report: (message: string) => void): Map<string, IROperation> {
	const routes = new Map<string, IROperation>()
	const missing: string[] = []
	for (const op of ir.operations) {
		const id = op.extensions.route
		if (op.extensions.websocket === true) continue
		if (id === undefined) missing.push(`${op.method} ${op.path}: no x-backend-route; left out of Routes`)
		/* `all()` and an optional param document one route as several operations: the first speaks for it */
		if (id !== undefined && !routes.has(id)) routes.set(id, op)
	}
	for (const message of missing.sort(compareCodeUnits)) report(message)
	return routes
}

/** A route pattern's params, as core's `ParamKeys` names them: `:name`, `:name?`, `*name`, an unnamed `*`. */
function paramsOf(pattern: string): Field[] {
	const names = [...pattern.matchAll(/:([^/?]+)\??|\*([^/]*)/g)].map((m) => m[1] ?? (m[2] === "" ? "*" : m[2]))
	return [...new Set(names as string[])].map((name) => [quoteKey(name), "string"])
}

type Ctx = { names: TypeOptions; resolve: (schema: IRSchema) => string }

/** The request as the document describes it (the wire type): its query, headers, cookies and body. */
function wireInput(op: IROperation, ctx: Ctx): Field[] {
	const group = (params: readonly IRParam[]) =>
		objectText(
			[...params]
				.sort((a, b) => compareCodeUnits(a.name, b.name))
				.map((p) => [`${quoteKey(p.name)}${p.required === true ? "" : "?"}`, ctx.resolve(p.schema)]),
		)
	const fields: Field[] = []
	if (op.params.query.length > 0) fields.push(["search", group(op.params.query)])
	if (op.params.header.length > 0) fields.push(["headers", group(op.params.header)])
	/* the IR sets `cookie` only when the operation declares one */
	if (op.params.cookie !== undefined) fields.push(["cookies", group(op.params.cookie)])
	const body = bodiesOf(op)[0]
	if (body?.kind === "stream")
		fields.push(["binary", `{ readonly bytes: Uint8Array<ArrayBuffer>; readonly type: ${tsString(body.contentType)} }`])
	else if (body !== undefined) {
		const essence = mediaEssence(body.contentType)
		const field = isJsonMedia(body.contentType) ? "json" : "form"
		if (field === "json" || essence === "application/x-www-form-urlencoded" || essence === "multipart/form-data")
			fields.push([field, ctx.resolve(body.schema)])
	}
	return fields
}

/**
 * Where a response with no body reads back as `.output()` declares it, with its type: a redirect carries its target and
 * a 304 (the other bodiless 3xx `.output()` declares under `redirect`) has none; a 204 or 205 is written with no body,
 * and reads back as the shorthand declares it, under JSON. `undefined` for a body, or any other bodiless status.
 */
function bodilessAt(response: IRResponse): readonly [media: string, type: string] | undefined {
	if (response.contents !== undefined) return undefined
	if (response.status === "204" || response.status === "205") return ["application/json", "unknown"]
	const located = response.headers?.some((h) => h.name.toLowerCase() === "location") === true
	return response.status.startsWith("3") && (located || response.status === "304") ? ["redirect", "true"] : undefined
}

/** What the route answers, error responses aside: `{ [media]: { [statusKey]: T } }`, a redirect as `redirect`. */
function outputOf(op: IROperation, ctx: Ctx): string {
	const media = new Map<string, Field[]>()
	const add = (type: string, field: Field) => media.set(type, [...(media.get(type) ?? []), field])
	for (const response of Object.values(op.responses).sort((a, b) => compareCodeUnits(a.status, b.status))) {
		const key = /^[0-9]{3}$/.test(response.status) ? statusKeyOf(Number(response.status)) : undefined
		if (response.error === true || key === undefined) continue
		const bodiless = bodilessAt(response)
		if (bodiless !== undefined) add(bodiless[0], [key, bodiless[1]])
		for (const { contentType, schema } of response.contents ?? [])
			add(contentType, [key, schema === undefined ? "unknown" : ctx.resolve(schema)])
	}
	return objectText([...media].map(([type, fields]) => [tsString(type), objectText(fields)]))
}

/** The route's declared errors: their union, each key's shape, and the shapes by status. */
function errorsOf(op: IROperation, ctx: Ctx): { factories: Field[]; fields: Field[] } {
	const declared = op.extensions.errors ?? {}
	const keys = Object.keys(declared).sort(compareCodeUnits)
	if (keys.length === 0) return { factories: [], fields: [["errors", "never"]] }
	const shape = (key: string) => {
		const schema = declared[key]?.schema
		return schema === undefined ? "null" : ctx.resolve(schema)
	}
	const byStatus = new Map<number, Set<string>>()
	for (const key of keys) {
		const status = declared[key]?.status
		if (typeof status === "number") byStatus.set(status, (byStatus.get(status) ?? new Set()).add(shape(key)))
	}
	const statuses = [...byStatus]
		.sort(([a], [b]) => a - b)
		.map(([code, shapes]): Field => [String(code), [...shapes].join(" | ")])
	const factory = (key: string) =>
		shape(key) === "null"
			? STANDARD_FACTORY
			: `(data: ${shape(key)}, opts?: { cause?: unknown; headers?: Record<string, string> }) => HttpError`
	return {
		factories: keys.map((key) => [quoteKey(key), factory(key)]),
		fields: [
			["errors", keys.map(tsString).join(" | ")],
			["errorShapes", objectText(keys.map((key) => [quoteKey(key), shape(key)]))],
			["errorsByStatus", objectText(statuses)],
		],
	}
}

/**
 * The ctx's `meta`: what the app declares, with the OpenAPI keys a route may add (bit 22 a), so a handler may pass
 * its own ctx to a function typed with the generated ctx. The tree's literals are narrower than the handler's type
 * — a route's `operationId` is `string` there, not its value — and would reject it; they stay the sibling field.
 * Without an extracted declaration (no ts-morph, or an app that declares no meta) the literals are all there is.
 */
function ctxMeta(extracted: ExtractedTypes | null | undefined, literal: string): string {
	/* with nothing extracted, the tree's literals are all there is */
	if (extracted === null || extracted === undefined) return literal
	/* the OpenAPI keys the declared meta does not redefine: a consumer that types `security` its own way holds
	   that type in the handler, and intersecting backend's would conflict with it. An app that declares none
	   holds them all, each widened by \`.meta()\` */
	const declared = extracted.meta
	return declared === null ? "Partial<HttpMeta>" : `Partial<Omit<HttpMeta, keyof ${declared}>> & ${declared}`
}

/** `ctx.params`: the type a param schema gives it as extracted, else each of the pattern's params a string. */
function ctxParams(extracted: ExtractedTypes | null | undefined, id: string, pattern: string): string {
	return extracted?.params[id] ?? objectText(paramsOf(pattern))
}

/**
 * The ctx's `meta` and `routePattern`. A mounted route's handler types the path it was registered at, never the one
 * it is served at, so its ctx keeps the base's `string` and that handler's own ctx still fits.
 */
function routeFields(extracted: ExtractedTypes | null | undefined, id: string, literal: string): Field[] {
	const fields: Field[] = [["readonly meta", `Readonly<${ctxMeta(extracted, literal)}>`]]
	if (!extracted?.mounted.includes(id)) fields.push(["readonly routePattern", tsString(id.slice(id.indexOf(" ") + 1))])
	return fields
}

/** One `Routes[pattern][method]` entry. */
function routeEntry(id: string, op: IROperation, options: GenerateTypesOptions, ctx: Ctx): string {
	const pattern = id.slice(id.indexOf(" ") + 1)
	const { extracted } = options
	const wire = objectText(wireInput(op, ctx))
	const input = extracted?.inputs[id] ?? wire
	const params = ctxParams(extracted, id, pattern)
	const { factories, fields } = errorsOf(op, ctx)
	const mt = options.tree.routes[id]?.mt
	/* the values the tree carries, as literals: what a consumer reads a route's configuration from */
	const literal = mt && Object.keys(mt).length > 0 ? literalType(mt) : "{}"
	const output = outputOf(op, ctx)
	const own: Field[] = []
	if (input !== "{}") own.push(["readonly input", input])
	if (params !== "{}") own.push(["readonly params", params])
	if (factories.length > 0) own.push(["readonly errors", objectText(factories)])
	own.push(...routeFields(extracted, id, literal))
	const base = options.baseCtxName ?? "BaseCtx"
	const parts = [factories.length > 0 ? `Omit<${base}, "errors">` : base]
	const adds = extracted?.routes[id]
	if (adds !== undefined && adds.length > 0) parts.push(propsText(adds))
	parts.push(objectText(own))
	const entry: Field[] = [
		["ctx", `WithOutput<${parts.join(" & ")}, ${output === "{}" ? "never" : output}>`],
		...fields,
		["input", input],
		["meta", literal],
		["output", output],
	]
	return entry.map(([key, type]) => `\t\t\t${key}: ${type}`).join("\n")
}

/** `BaseCtx`: the app's context over its env, with the middleware's additions. */
function baseCtx(extracted: ExtractedTypes | null, name: string): string {
	const parts = [`HttpContext<${extracted?.env ?? "Record<string, unknown>"}>`]
	const middleware = extracted?.middleware ?? []
	if (middleware.length > 0) parts.push(propsText(middleware))
	return `export type ${name} = ${parts.join(" & ")}`
}

/**
 * A WebSocket route's ctx, as core's `WSRouteCtx` types its callbacks: the base with the pattern's params, and the
 * search input `.input()` declares. Extracted additions are keyed by HTTP routes only, so none join here.
 */
function wsCtx(op: IROperation, id: string, options: GenerateTypesOptions, ctx: Ctx): string {
	const own: Field[] = []
	const search = wireInput(op, ctx).find(([key]) => key === "search")
	if (search !== undefined) own.push(["readonly input", objectText([search])])
	const params = ctxParams(options.extracted, id, pathOf(id))
	if (params !== "{}") own.push(["readonly params", params])
	const base = options.baseCtxName ?? "BaseCtx"
	return own.length === 0 ? base : `${base} & ${objectText(own)}`
}

/**
 * The `HttpCodegen` augmentation: each declared id (the route's own, before core's suffix) to its kind and ctx, in
 * code-unit order. An HTTP id names its `Routes` entry's ctx, a declared id over several routes its first route's in
 * code-unit order (D3: no union of contexts). An operation without `x-backend-route` has no entry: `routesOf`
 * reports an HTTP one, this a WebSocket one. Null with no operations, so core's plain string ids apply.
 */
function operationSlot(ir: IR, options: GenerateTypesOptions, ctx: Ctx): string | null {
	const routeIds = new Map<string, { op: IROperation; routes: string[] }>()
	const missing: string[] = []
	for (const op of ir.operations) {
		const route = op.extensions.route
		if (route === undefined) {
			if (op.extensions.websocket === true)
				missing.push(`${op.method} ${op.path}: no x-backend-route; left out of the operationId slot`)
			continue
		}
		const declared = op.extensions.declaredId ?? op.id
		const entry = routeIds.get(declared) ?? { op, routes: [] }
		if (!entry.routes.includes(route)) entry.routes.push(route)
		routeIds.set(declared, entry)
	}
	for (const message of missing.sort(compareCodeUnits)) options.report(message)
	if (routeIds.size === 0) return null
	const entries = [...routeIds].sort(([a], [b]) => compareCodeUnits(a, b))
	const lines = entries.map(([declared, { op, routes }]) => {
		const id = routes.sort(compareCodeUnits)[0] as string
		const method = id.slice(0, id.indexOf(" ")).toLowerCase()
		const entry =
			op.extensions.websocket === true
				? `kind: "ws"; ctx: ${wsCtx(op, id, options, ctx)}`
				: `kind: "http"; ctx: Routes[${tsString(pathOf(id))}][${tsString(method)}]["ctx"]`
		return `\t\t\t${tsString(declared)}: { ${entry} }`
	})
	return `declare module "@workerstack/backend/http" {\n\tinterface HttpCodegen {\n\t\toperationId: {\n${lines.join("\n")}\n\t\t}\n\t}\n}`
}

/** A route id's path: `GET /a` → `/a`. */
const pathOf = (id: string) => id.slice(id.indexOf(" ") + 1)

/** The `Routes` map: paths and methods in code-unit order. */
function routesType(routes: Map<string, IROperation>, options: GenerateTypesOptions, ctx: Ctx): string {
	const byPath = new Map<string, string[]>()
	const ids = [...routes.keys()].sort(compareCodeUnits)
	for (const id of ids.sort((a, b) => compareCodeUnits(pathOf(a), pathOf(b)) || compareCodeUnits(a, b))) {
		const method = id.slice(0, id.indexOf(" ")).toLowerCase()
		const entry = `\t\t${quoteKey(method)}: {\n${routeEntry(id, routes.get(id) as IROperation, options, ctx)}\n\t\t}`
		byPath.set(pathOf(id), [...(byPath.get(pathOf(id)) ?? []), entry])
	}
	const paths = [...byPath].map(([path, methods]) => `\t${tsString(path)}: {\n${methods.join("\n")}\n\t}`)
	return paths.length === 0 ? "export type Routes = {}" : `export type Routes = {\n${paths.join("\n")}\n}`
}

/** The `types.gen.d.ts` text for the app the options describe. */
export function generateTypes(options: GenerateTypesOptions): string {
	const ir = toIR(options.document as OpenApiDocument, { deriveOperationIds: true })
	const routes = routesOf(ir, options.report)
	const extra = Object.keys(options.extracted?.routes ?? {}).filter((id) => !routes.has(id))
	for (const id of extra.sort(compareCodeUnits))
		options.report(
			`${id}: extracted ctx additions match no documented operation (internal and filtered routes are not documented); not typed`,
		)
	const name = options.baseCtxName ?? "BaseCtx"
	const names: TypeOptions = { refName: componentNames(ir, [...RESERVED, name]) }
	const ctx: Ctx = { names, resolve: (schema) => irToTs(schema, names) }
	const hasErrors = [...routes.values()].some((op) => Object.keys(op.extensions.errors ?? {}).length > 0)
	/* HttpMeta once a route's ctx reads it: with anything extracted, the ctx's meta is built from its keys */
	const readsMeta = options.extracted !== null && options.extracted !== undefined && routes.size > 0
	const imports = ["HttpContext", "WithOutput", ...(hasErrors ? ["HttpError"] : []), ...(readsMeta ? ["HttpMeta"] : [])]
	const out = [`import type { ${imports.join(", ")} } from "@workerstack/backend/http"`]
	out.push(baseCtx(options.extracted, name))
	const slot = operationSlot(ir, options, ctx)
	if (slot !== null) out.push(slot)
	for (const schema of Object.keys(ir.schemas).sort(compareCodeUnits))
		out.push(`type ${names.refName?.(schema)} = ${ctx.resolve(ir.schemas[schema] as IRSchema)}`)
	out.push(routesType(routes, options, ctx))
	for (const [type, field] of EXTRACTORS)
		out.push(
			`export type ${type}<TPath extends keyof Routes, TMethod extends keyof Routes[TPath] & string> = Routes[TPath][TMethod] extends { ${field}: infer T } ? T : never`,
		)
	return `${out.join("\n\n")}\n`
}
