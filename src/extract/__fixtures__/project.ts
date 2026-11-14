/**
 * A throwaway TypeScript project for the extract suites: a temp directory holding the app files a
 * case writes, a tsconfig, and `node_modules/@workerstack/backend` linked to the backend this package resolves,
 * so a fixture app imports it as a user app does: its source in a checkout (the `backend-source` condition), its
 * declarations once installed. gen itself imports nothing from backend (H2).
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import * as tsMorph from "ts-morph"
import { type ExtractedProp, type ExtractOptions, extractTypes } from "../extract.ts"

/** The root of the `@workerstack/backend` this package resolves: the workspace's in a checkout, npm's once installed. */
const backendRoot = (): string =>
	realpathSync(dirname(createRequire(import.meta.url).resolve("@workerstack/backend/package.json")))

/** The file backend's `/http` export names for a checker: its `backend-source` in a checkout, its `types` once installed. */
export function backendEntry(): string {
	const root = backendRoot()
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		exports: { "./http": Record<string, string> }
	}
	const entry = manifest.exports["./http"]
	return join(root, entry["backend-source"] ?? (entry.types as string))
}

export const COMPILER_OPTIONS = {
	allowImportingTsExtensions: true,
	customConditions: ["backend-source"],
	lib: ["ES2024", "DOM"],
	module: "ESNext",
	moduleResolution: "Bundler",
	noEmit: true,
	strict: true,
	target: "ES2022",
}

export type FixtureProject = {
	readonly root: string
	/** Write `content` at `rel` under the root; returns the absolute path. */
	write: (rel: string, content: string) => string
	dispose: () => void
}

/**
 * A fresh project root with a tsconfig (`compilerOptions` merged over the defaults) and, unless `linked` is false,
 * backend linked into its node_modules.
 */
export function fixtureProject(compilerOptions: Record<string, unknown> = {}, linked = true): FixtureProject {
	const root = mkdtempSync(join(tmpdir(), "clients-extract-"))
	const write = (rel: string, content: string): string => {
		const path = join(root, rel)
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, content, "utf8")
		return path
	}
	if (linked) {
		mkdirSync(join(root, "node_modules/@workerstack"), { recursive: true })
		symlinkSync(backendRoot(), join(root, "node_modules/@workerstack/backend"), "dir")
	}
	write("tsconfig.json", JSON.stringify({ compilerOptions: { ...COMPILER_OPTIONS, ...compilerOptions } }))
	return { dispose: () => rmSync(root, { force: true, recursive: true }), root, write }
}

export const lines = (...source: string[]): string => source.join("\n")

/** The caller's route id: the method and the type-level full path, with empty segments dropped. */
export const routeId = (method: string, path: string): string =>
	`${method} /${path.split("/").filter(Boolean).join("/")}`

/** `extractTypes` on the app exported as `app`, with ts-morph, and what it reported. */
export function extract(entryPath: string, options: Partial<ExtractOptions> = {}) {
	const reports: string[] = []
	const types = extractTypes({
		entryPath,
		exportName: "app",
		report: (m) => reports.push(m),
		routeId,
		tsMorph,
		...options,
	})
	return { reports, types: types as NonNullable<typeof types> }
}

/** The props as `name: type` lines, `?` on the optional ones. */
export const shown = (props: readonly ExtractedProp[] | undefined): string[] =>
	(props ?? []).map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`)

/* every case loads core's source through the checker: a few seconds each under load */
export const SLOW = 60_000
