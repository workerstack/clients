/**
 * Loads a `release.config.ts` the way an installgen config loads: a config outside any install (a fixture dir, a repo
 * that runs `bunx`) has no `node_modules` to resolve `@workerstack/clients/release` from, so that one import is
 * mapped to the running package's own entry while the config is imported (a Node resolve hook, deregistered after;
 * a Bun virtual module). jiti would resolve it against a local install, which is exactly what is missing.
 */
import { existsSync, realpathSync } from "node:fs"
import { dirname, extname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { registerBunHook } from "../installers/config/hooks/bun.ts"
import { registerNodeHook, type RegisterHooks } from "../installers/config/hooks/node.ts"
import { detectRuntime, type RuntimeInfo, stripsTypes } from "../installers/config/load.ts"
import { gitOutput } from "./git.ts"
import { placeRelease } from "./manifest.ts"
import type { Release } from "./types.ts"

/** The specifier a release config imports `defineRelease` from, resolved to the running package. */
export const RELEASE_SPECIFIER = "@workerstack/clients/release"

type Importer = (url: string) => Promise<Record<string, unknown>>

/** What a load runs on beside the config's path; each defaults to the running process's own. */
export type LoadReleaseOptions = {
	/** The runtime the config is imported on: Node needs 22.18 (23.6 on 23) for a `.ts` config. */
	readonly runtime?: RuntimeInfo
	/** The entry the config's `@workerstack/clients/release` import resolves to: this package's `release/index`. */
	readonly selfUrl?: string
	/** Imports a module by URL: `import()`. */
	readonly importModule?: Importer
	/** Node's `module.registerHooks`. */
	readonly registerHooks?: RegisterHooks
}

/* the config's default export, imported with the self-resolve hook in place for the import alone */
async function importConfig(path: string, options: LoadReleaseOptions): Promise<unknown> {
	const runtime = options.runtime ?? detectRuntime()
	const ext = extname(path)
	if (runtime.runtime === "node" && (ext === ".ts" || ext === ".mts") && !stripsTypes(runtime.nodeVersion)) {
		throw new Error(
			`${path}: a TypeScript release config needs Node >= 22.18 (23.6 on Node 23; this is ${runtime.nodeVersion}); ` +
				"run honey-clients with Bun, or upgrade Node",
		)
	}
	const importModule = options.importModule ?? ((url) => import(url) as Promise<Record<string, unknown>>)
	/* the sibling entry in this module's own form: index.ts from a checkout's source, index.js from an install */
	const selfUrl =
		options.selfUrl ?? new URL(`./index${extname(new URL(import.meta.url).pathname)}`, import.meta.url).href

	let hook: ReturnType<RegisterHooks> | undefined
	if (runtime.bun) await registerBunHook(runtime.bun, RELEASE_SPECIFIER, selfUrl, importModule)
	else hook = registerNodeHook(RELEASE_SPECIFIER, selfUrl, options.registerHooks)
	try {
		return (await importModule(pathToFileURL(path).href)).default
	} catch (error) {
		throw new Error(`failed to load ${path}: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error,
		})
	} finally {
		hook?.deregister()
	}
}

/**
 * The release `configPath` (relative to the working directory) describes, imported on `options`' runtime: its
 * packages placed beside it, in the repo whose git toplevel holds it. Throws naming the config when it is not there,
 * sits outside a git repository, has no default export, or is invalid.
 */
export async function readRelease(configPath: string, options: LoadReleaseOptions): Promise<Release> {
	if (!existsSync(configPath)) throw new Error(`${configPath}: no such release config`)
	/* git reports its toplevel with symlinks resolved, so the config's path is too: one is made relative to the other */
	const path = realpathSync(resolve(configPath))
	const root = await gitOutput(["rev-parse", "--show-toplevel"], dirname(path)).catch((error: unknown) => {
		throw new Error(`${configPath}: not inside a git repository`, { cause: error })
	})
	const raw = await importConfig(path, options)
	if (raw === undefined)
		throw new Error(`${configPath} has no default export; write \`export default defineRelease({ ... })\``)
	return placeRelease(raw, root, path)
}

/**
 * The release `configPath` (relative to the working directory) describes: its packages placed beside it, in the repo
 * whose git toplevel holds it. Throws naming the config when it is not there, sits outside a git repository, has no
 * default export, or is invalid.
 */
export function loadRelease(configPath: string): Promise<Release> {
	return readRelease(configPath, {})
}
