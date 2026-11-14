/**
 * The program an app is read from: its tsconfig, the exported app, and every route registration in
 * the program's own files. A registration is a `.handler()` call on a route builder, recognized by
 * the type-only `$ctx`, `$method` and `$path` it carries, whatever method or helper started it. Its
 * path is the one its own app gives it; a `.route()` mount serves it under the mount's prefix, so its
 * paths follow every chain of mounts that carries that app.
 */
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { Project, ts } from "ts-morph"
import { compareCodeUnits } from "../emit/shared/lang.ts"
import type { Compiler } from "./serialize.ts"

/** ts-morph, passed in by the caller: an optional peer this package never imports. */
export type TsMorph = typeof import("ts-morph")

/** Which exported app to read. */
export type EntryOptions = {
	/** The path of the source file that holds the app. */
	entryPath: string
	/**
	 * The app's export name in that file (`default` for a default export); an unexported variable of that name also
	 * counts. Throws when neither exists.
	 */
	exportName: string
	/** the tsconfig to read the project with; else the nearest one (`findTsConfig`) */
	tsconfigPath?: string
}

export type LoadedEntry = {
	/** the exported declaration: a variable, or for `export default <expr>` the expression */
	appNode: ts.Node
	/** the app's type */
	appType: ts.Type
	checker: ts.TypeChecker
	compiler: Compiler
	project: Project
}

/* the type-only members every route builder carries */
const BUILDER_MEMBERS = ["$ctx", "$method", "$path"]

/* the type-only members every app carries */
const APP_MEMBERS = ["$ctx", "$env"]

/** One route a `.handler()` call registers: where, its methods, the full paths it is served at and its ctx. */
export type Registration = {
	at: string
	ctx: ts.Type
	/** `ctx.input` as the handler receives it (parsed), or null when the route declares no input */
	input: ts.Type | null
	/** `ctx.params` as the handler receives it, or null when every param is the path's string */
	params: ts.Type | null
	methods: string[]
	/**
	 * the full paths the route is served at: under each chain of mounts that carries its app, else the path it was
	 * registered at; null when that path is not a literal. Code-unit sorted, without duplicates.
	 */
	paths: string[] | null
}

/**
 * The tsconfig that governs `fromPath`: the nearest one walking up, but never past the project root
 * (the nearest directory with a package.json); a stray tsconfig above it is not this project's.
 */
export function findTsConfig(fromPath: string): string | undefined {
	for (let dir = dirname(resolve(fromPath)), prev = ""; dir !== prev; prev = dir, dir = dirname(dir)) {
		if (existsSync(resolve(dir, "tsconfig.json"))) return resolve(dir, "tsconfig.json")
		if (existsSync(resolve(dir, "package.json"))) return undefined
	}
	return undefined
}

/**
 * Load the entry and its app: `export const app`, an export list, an unexported declaration of the name, or `export default`.
 * The program is the entry, what it imports, and the tsconfig's own declaration files: an ambient one that only
 * `include` names (wrangler's `worker-configuration.d.ts`) declares globals the app's types use, as under `tsc -p`.
 */
export function loadEntry(tsMorph: TsMorph, options: EntryOptions): LoadedEntry {
	const tsConfigFilePath = options.tsconfigPath ?? findTsConfig(options.entryPath)
	const project = new tsMorph.Project({ skipAddingFilesFromTsConfig: true, tsConfigFilePath })
	project.addSourceFilesAtPaths(options.entryPath)
	if (tsConfigFilePath !== undefined) {
		const { ts } = tsMorph
		const { config } = ts.readConfigFile(tsConfigFilePath, ts.sys.readFile)
		const { fileNames } = ts.parseJsonConfigFileContent(config, ts.sys, dirname(tsConfigFilePath))
		for (const name of fileNames) if (name.endsWith(".d.ts")) project.addSourceFileAtPath(name)
	}
	project.resolveSourceFileDependencies()
	const file = project.getSourceFileOrThrow(options.entryPath)
	const decl =
		file.getExportedDeclarations().get(options.exportName)?.[0] ?? file.getVariableDeclaration(options.exportName)
	if (decl === undefined) throw new Error(`Export "${options.exportName}" not found in ${options.entryPath}`)
	const checker = project.getTypeChecker().compilerObject
	/* for `export default <expr>` the declaration is the expression itself */
	return {
		appNode: decl.compilerNode,
		appType: checker.getTypeAtLocation(decl.compilerNode),
		checker,
		compiler: tsMorph.ts,
		project,
	}
}

/** The string literal values among `type` (itself, or a union's members). */
function literals(type: ts.Type): string[] {
	return (type.isUnion() ? type.types : [type]).filter((t) => t.isStringLiteral()).map((t) => t.value)
}

/** Where an app value comes from: the expression that made it, or the symbol it is only read through (a parameter). */
type AppNode = ts.Node | ts.Symbol

/** A `.route()` call: the sub's app served inside the receiver's under `prefix`, the receiver's base path joined in. */
type Mount = { prefix: string; receiver: AppNode; sub: AppNode }

/** Core's `MergePath`: `"/"` gives the other side, anything else is joined as is (the router normalizes the result). */
const mergePath = (a: string, b: string): string => (a === "/" ? b : b === "/" ? a : `${a}${b}`)

/** `file:line` of a node, as reports name a place. */
function placeOf(node: ts.Node): string {
	const file = node.getSourceFile()
	return `${file.fileName}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`
}

/** The single string literal `type` is, or null. */
function literalOf(type: ts.Type): string | null {
	const values = literals(type)
	return values.length === 1 && !type.isUnion() ? (values[0] as string) : null
}

/**
 * The origin of each app expression. A handle (`use`, `basePath`, a route builder, `.handler()`, `.route()`) is its
 * receiver's app; a variable, an import or an object's property is what it was bound to; anything else, `httpApp()` or
 * a factory's call, makes its own app.
 */
function appOrigins(entry: LoadedEntry): (node: ts.Node) => AppNode {
	const { checker, compiler } = entry
	const memo = new Map<ts.Node, AppNode>()
	const carries = (node: ts.Node) => checker.getTypeAtLocation(node).getProperty("$ctx") !== undefined
	const bound = (symbol: ts.Symbol | undefined, at: ts.Node): AppNode => {
		if (symbol === undefined) return at
		const target = symbol.flags & compiler.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
		const decl = target.valueDeclaration
		if (decl !== undefined && compiler.isShorthandPropertyAssignment(decl))
			return bound(checker.getShorthandAssignmentValueSymbol(decl), decl)
		const init =
			decl !== undefined && (compiler.isVariableDeclaration(decl) || compiler.isPropertyAssignment(decl))
				? decl.initializer
				: undefined
		return init === undefined ? target : origin(init)
	}
	const step = (expr: ts.Node): AppNode => {
		if (
			compiler.isParenthesizedExpression(expr) ||
			compiler.isAsExpression(expr) ||
			compiler.isSatisfiesExpression(expr) ||
			compiler.isNonNullExpression(expr)
		)
			return origin(expr.expression)
		if (compiler.isIdentifier(expr)) return bound(checker.getSymbolAtLocation(expr), expr)
		if (compiler.isPropertyAccessExpression(expr)) return bound(checker.getSymbolAtLocation(expr.name), expr)
		const callee = compiler.isCallExpression(expr) ? expr.expression : undefined
		if (
			callee !== undefined &&
			compiler.isPropertyAccessExpression(callee) &&
			carries(callee.expression) &&
			carries(expr)
		)
			return origin(callee.expression)
		return expr
	}
	const origin = (expr: ts.Node): AppNode => {
		const known = memo.get(expr)
		if (known !== undefined) return known
		/* a binding that reads itself ends at the expression */
		memo.set(expr, expr)
		const found = step(expr)
		memo.set(expr, found)
		return found
	}
	return origin
}

/** The receiver's base path: its `HttpApp` type argument `TBasePath`, when that is one literal. */
function basePathOf(entry: LoadedEntry, app: ts.Type): string | null {
	const { checker, compiler } = entry
	/* a class's instance type is a reference to it: its type arguments are the app's */
	const decl = app.getSymbol()?.declarations?.find((d) => compiler.isClassDeclaration(d))
	const index = decl?.typeParameters?.findIndex((p) => p.name.text === "TBasePath") ?? -1
	const arg = index < 0 ? undefined : checker.getTypeArguments(app as ts.TypeReference)[index]
	return arg === undefined ? null : literalOf(arg)
}

/** The mount a call is, if it is `<app>.route(sub)` or `<app>.route(prefix, sub)`; a path no literal is said, never guessed. */
function mountOf(
	entry: LoadedEntry,
	call: ts.CallExpression,
	origin: (node: ts.Node) => AppNode,
	report: (message: string) => void,
): Mount | null {
	const { checker, compiler } = entry
	if (!compiler.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "route") return null
	const receiver = call.expression.expression
	const app = checker.getTypeAtLocation(receiver)
	const sub = call.arguments.at(-1)
	if (sub === undefined || call.arguments.length > 2 || APP_MEMBERS.some((m) => app.getProperty(m) === undefined))
		return null
	const base = basePathOf(entry, app)
	const first = call.arguments[0] as ts.Expression
	const prefix = call.arguments.length === 1 ? "/" : literalOf(checker.getTypeAtLocation(first))
	if (base === null || prefix === null) {
		report(`${placeOf(call)}: the mount's path is not a literal type; the routes it mounts keep their own paths`)
		return null
	}
	return { prefix: mergePath(base, prefix), receiver: origin(receiver), sub: origin(sub) }
}

/**
 * The prefixes an app is served under: `"/"` when no mount takes it as a sub, or when it is the export; else the
 * mount's prefix under each of its receiver's. An app mounted only inside a cycle is served nowhere.
 */
function servedPrefixes(mounts: readonly Mount[], exported: AppNode): (node: AppNode) => string[] {
	const bySub = new Map<AppNode, Mount[]>()
	for (const mount of mounts) bySub.set(mount.sub, [...(bySub.get(mount.sub) ?? []), mount])
	const visiting = new Set<AppNode>()
	const prefixes = (node: AppNode): string[] => {
		const edges = bySub.get(node) ?? []
		if (edges.length === 0) return ["/"]
		if (visiting.has(node)) return []
		visiting.add(node)
		const out = edges.flatMap((m) => prefixes(m.receiver).map((outer) => mergePath(outer, m.prefix)))
		visiting.delete(node)
		return node === exported ? [...out, "/"] : out
	}
	return prefixes
}

/** A registration before its mounts are known: the path its own app gives it, and the builder that app comes from. */
type Found = Omit<Registration, "paths"> & { builder: ts.Expression; path: string | null }

/** The registration a call is, if it is `<route builder>.handler(…)`. */
function registrationOf(entry: LoadedEntry, call: ts.CallExpression): Found | null {
	const { checker, compiler } = entry
	if (!compiler.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "handler") return null
	const receiver = call.expression.expression
	const builder = checker.getTypeAtLocation(receiver)
	const phantoms = BUILDER_MEMBERS.map((name) => {
		const sym = builder.getProperty(name)
		return sym === undefined ? undefined : checker.getTypeOfSymbol(sym)
	})
	if (phantoms.includes(undefined)) return null
	const [ctx, method, path] = phantoms as ts.Type[]
	/* the handler callback's ctx parameter carries `input`, which the builder's `$ctx` phantom leaves out */
	const handler = checker.getResolvedSignature(call)?.parameters[0]
	const param = handler && checker.getTypeOfSymbol(handler).getCallSignatures()[0]?.parameters[0]
	const input = param && checker.getTypeOfSymbol(param).getProperty("input")
	const params = param && checker.getTypeOfSymbol(param).getProperty("params")
	const paramsType = params && checker.getTypeOfSymbol(params)
	/* a param schema shows as a key that is not a string: only then does the path's own typing fall short */
	const typed = paramsType
		?.getProperties()
		.some((key) => !(checker.getTypeOfSymbol(key).flags & compiler.TypeFlags.String))
	return {
		at: placeOf(call),
		builder: receiver,
		ctx: ctx as ts.Type,
		input: input ? checker.getTypeOfSymbol(input) : null,
		params: typed === true ? (paramsType as ts.Type) : null,
		/* `.on()`'s methods are literals by its signature; a path is one only as a single literal */
		methods: literals(method as ts.Type),
		path: literalOf(path as ts.Type),
	}
}

/**
 * Every route the program's own files register (not declaration files, not packages), in file order then source order,
 * at the paths the program's mounts serve it at. A mount whose path is no literal is said through `report`.
 */
export function registrations(entry: LoadedEntry, report: (message: string) => void): Registration[] {
	const { appNode, compiler } = entry
	const origin = appOrigins(entry)
	const found: Found[] = []
	const mounts: Mount[] = []
	const visit = (node: ts.Node): void => {
		if (compiler.isCallExpression(node)) {
			const registration = registrationOf(entry, node)
			if (registration !== null) found.push(registration)
			const mount = registration === null ? mountOf(entry, node, origin, report) : null
			if (mount !== null) mounts.push(mount)
		}
		compiler.forEachChild(node, visit)
	}
	const files = entry.project
		.getSourceFiles()
		.map((file) => file.compilerNode)
		.filter((file) => !file.isDeclarationFile && !/[\\/]node_modules[\\/]/.test(file.fileName))
		.sort((a, b) => compareCodeUnits(a.fileName, b.fileName))
	for (const file of files) visit(file)
	/* the export resolves as any binding of it does: through its name, or as the default export's expression */
	const prefixes = servedPrefixes(mounts, origin(compiler.isVariableDeclaration(appNode) ? appNode.name : appNode))
	return found.map(({ builder, path, ...registration }) => ({
		...registration,
		paths:
			path === null
				? null
				: [...new Set(prefixes(origin(builder)).map((prefix) => mergePath(prefix, path)))].sort(compareCodeUnits),
	}))
}
