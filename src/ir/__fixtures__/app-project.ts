/**
 * A project whose `@workerstack/backend` stands as a checkout (bit 19 h2): the package carries tsconfig.json and
 * backend's export shape over a `src` link to the runtime tree of the backend this package resolves (its `src/` in a
 * checkout, its built `dist/` once installed), each subpath's `honey-source` that tree's file and its `default` an
 * unbuilt dist/ (bit 20: no `bun` condition, which backend dropped and which pointed Bun at the source), so `--app`
 * resolves backend from the app as a checkout would. An install copies the tree instead, its `default` the tree's
 * file too. Test-only: backend is found by its package name, never imported.
 */
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const ENTRIES = { "./http": "routing/app", "./http/openapi": "openapi/register" }

/** The backend this package resolves: its root, and its runtime tree (`src/`, `.ts` in a checkout; `dist/`, `.js` installed). */
export function backend(): { root: string; tree: string; ext: string } {
	const root = realpathSync(dirname(createRequire(import.meta.url).resolve("@workerstack/backend/package.json")))
	return existsSync(join(root, "src")) ? { ext: "ts", root, tree: "src" } : { ext: "js", root, tree: "dist" }
}

/**
 * `files` written into a fresh project beside its core checkout, or as an install with no tsconfig.json when
 * `installed`, its `default` then the source standing in for dist/; `done()` removes it.
 */
export function appProject(
	files: Readonly<Record<string, string>>,
	options: { installed?: boolean } = {},
): { dir: string; done: () => void } {
	const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "codegen-app-"))
	const core = join(dir, "node_modules/@workerstack/backend")
	mkdirSync(core, { recursive: true })
	const { root, tree, ext } = backend()
	const installed = options.installed === true
	if (installed)
		cpSync(join(root, tree), join(core, "src"), { filter: (path) => !path.endsWith(".test.ts"), recursive: true })
	else symlinkSync(join(root, tree), join(core, "src"), "dir")
	const { imports } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		imports: Record<string, { "honey-source"?: string; default: string }>
	}
	/* the tree's file for an import target: its honey-source in a checkout, its default (dist) once installed */
	const inTree = (target: { "honey-source"?: string; default: string }) =>
		(target["honey-source"] ?? target.default).replace(/^\.\/(src|dist)\//, "./src/")
	const own = Object.fromEntries(
		Object.entries(imports).map(([name, target]) => {
			const source = inTree(target)
			return [
				name,
				{
					"honey-source": source,
					default: installed ? source : source.replace(/^\.\/src\/(.*)\.[jt]s$/, "./dist/$1.js"),
				},
			]
		}),
	)
	const exports = Object.fromEntries(
		Object.entries(ENTRIES).map(([subpath, file]) => {
			const source = `./src/${file}.${ext}`
			return [subpath, { "honey-source": source, default: installed ? source : `./dist/${file}.js` }]
		}),
	)
	/* a plain subpath and one with no source condition, as a real exports map has */
	const all = { ...exports, "./package.json": "./package.json", "./plain": { default: `./src/routing/app.${ext}` } }
	writeFileSync(
		join(core, "package.json"),
		JSON.stringify({ exports: all, imports: own, name: "@workerstack/backend", type: "module" }),
	)
	if (!installed) writeFileSync(join(core, "tsconfig.json"), "{}\n")
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true })
		writeFileSync(join(dir, path), text)
	}
	return { dir, done: () => rmSync(dir, { force: true, recursive: true }) }
}
