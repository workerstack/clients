/**
 * A product's codegen, run the one way every release step runs it: its argv from the repo root, its output on stderr's
 * descriptor so stdout stays the command's report. Bump runs it before it decides and again at the released versions;
 * `release codegen` runs it alone, for the workflows that need generated output without a bump.
 */
import { spawnSync } from "node:child_process"
import { RELEASE_VERSIONS_ENV } from "./manifest.ts"
import type { Release } from "./types.ts"

/* codegen's own output goes to stderr's descriptor, so stdout stays the command's report */
const STDERR_FD = 2

/**
 * Runs the product's codegen from the repo root in `env`, with `versions` (package name to version) as
 * `RELEASE_VERSIONS` when given. Throws when it cannot start or exits non-zero, naming its argv.
 */
export function regenerate(
	release: Release,
	env: NodeJS.ProcessEnv,
	versions?: Readonly<Record<string, string>>,
): void {
	const [command = "", ...args] = release.codegen
	const result = spawnSync(command, args, {
		cwd: release.root,
		env: versions === undefined ? env : { ...env, [RELEASE_VERSIONS_ENV]: JSON.stringify(versions) },
		stdio: ["ignore", STDERR_FD, STDERR_FD],
	})
	if (result.error) throw new Error(`codegen could not start: ${result.error.message}`)
	if (result.status !== 0) throw new Error(`codegen (${release.codegen.join(" ")}) exited ${result.status}`)
}
