/**
 * An emitted project checked under the strict-consumer flag set (`tests/e2e/strict-consumer/tsconfig.json`): the
 * files written under `.tmp/<name>` (inside the repository, so workspace packages resolve), then `tsc -p` run on them;
 * and the same files bundled for a browser.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"

const STRICT = {
	compilerOptions: {
		exactOptionalPropertyTypes: true,
		module: "ESNext",
		moduleResolution: "bundler",
		noEmit: true,
		noFallthroughCasesInSwitch: true,
		noImplicitOverride: true,
		noImplicitReturns: true,
		noPropertyAccessFromIndexSignature: true,
		noUncheckedIndexedAccess: true,
		noUnusedLocals: true,
		noUnusedParameters: true,
		skipLibCheck: true,
		strict: true,
		target: "ESNext",
		types: [],
		verbatimModuleSyntax: true,
	},
	include: ["./**/*.ts"],
}

/** What `tsc` says about `files` written under `.tmp/<name>`: `""` when they are clean. */
export function strictDiagnostics(name: string, files: Record<string, string>): string {
	const dir = join(resolve(import.meta.dirname, "../../../.."), ".tmp", name)
	rmSync(dir, { force: true, recursive: true })
	mkdirSync(dir, { recursive: true })
	for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
	writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify(STRICT, null, "\t")}\n`)
	const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc")
	try {
		execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], { encoding: "utf8" })
		return ""
	} catch (error) {
		return String((error as { stdout?: string }).stdout ?? error)
	}
}

/**
 * `entry` (one of `files`) bundled by `bun build --target browser` from `.tmp/<name>`, as a browser app's bundler
 * would take it: tree-shaken, not minified, so the names it keeps can be read off the output.
 */
export function browserBundle(bun: string, name: string, files: Record<string, string>, entry: string): string {
	const dir = join(resolve(import.meta.dirname, "../../../.."), ".tmp", name)
	rmSync(dir, { force: true, recursive: true })
	mkdirSync(dir, { recursive: true })
	for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
	const out = spawnSync(bun, ["build", entry, "--target", "browser"], { cwd: dir, encoding: "utf8" })
	if (out.status !== 0) throw new Error(`bun build ${entry} failed: ${out.stderr}`)
	return out.stdout
}
