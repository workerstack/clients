/**
 * The emitted `types.gen.d.ts` checked as a service sees it: a `consumer.ts` beside it states each
 * type as an `expectType<…>()` assertion, typechecked in-process with ts-morph's TypeScript.
 * `@workerstack/backend` resolves as a service's import does, through node_modules: backend's source in a
 * checkout (the `backend-source` condition), its declarations once installed (gen imports nothing from backend, H2),
 * so a name backend lacks is a real red (O6). ts-morph is injected, as `extractTypes` takes it (only extract/
 * imports it). One project per suite: backend's files parse once, each check swaps the emitted file and the consumer.
 */
import { resolve } from "node:path"
import type { TsMorph } from "../../../extract/walk.ts"

/** Every consumer starts with: the backend names, the always-emitted types, and the assertion helpers. */
const PRELUDE = `import type { HttpContext, HttpError } from "@workerstack/backend/http"
import type { BaseCtx, RouteCtx, RouteErrors, RouteErrorShapes, RouteErrorsByStatus, RouteInput, RouteMeta, RouteOutput, Routes } from "./types.gen"
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type IsAny<T> = 0 extends 1 & T ? true : false
type Same<A, B> = IsAny<A> extends true ? false : [A] extends [B] ? ([B] extends [A] ? true : false) : false
declare function expectType<T extends true>(): void
`

/**
 * A checker over one project: each call returns every diagnostic of the emitted `types` text, the
 * `consumer` (the prelude prepended), as `file:line: message`. `files` are further
 * modules beside them (`app.ts` for an `import()` the extracted types reference).
 */
export function typechecker(tsMorph: TsMorph) {
	const { ts } = tsMorph
	/* never written to disk: the emitted and consumer files live in the project's memory */
	const root = resolve(import.meta.dirname, "typecheck-root")
	const project = new tsMorph.Project({
		compilerOptions: {
			allowImportingTsExtensions: true,
			customConditions: ["backend-source"],
			lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			noEmit: true,
			skipLibCheck: true,
			strict: true,
			target: ts.ScriptTarget.ES2022,
			types: ["node"],
		},
		skipAddingFilesFromTsConfig: true,
	})
	return (types: string, consumer: string, files: Record<string, string> = {}): string[] => {
		for (const file of project.getSourceFiles(`${root}/**`)) project.removeSourceFile(file)
		const checked = [
			project.createSourceFile(`${root}/types.gen.d.ts`, types),
			project.createSourceFile(`${root}/consumer.ts`, `${PRELUDE}${consumer}\n`),
			...Object.entries(files).map(([name, text]) => project.createSourceFile(`${root}/${name}`, text)),
		]
		return checked.flatMap((file) =>
			file.getPreEmitDiagnostics().map((d) => {
				const text = d.getMessageText()
				const message = typeof text === "string" ? text : text.getMessageText()
				return `${file.getBaseName()}:${d.getLineNumber()}: ${message}`
			}),
		)
	}
}
