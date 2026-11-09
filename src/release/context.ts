import type { Release } from "./types.ts"

/** Where a release command writes and what it reads beside its arguments. */
export type ReleaseContext = {
	/** The environment: `GH_TOKEN`, and what codegen and Go run with. */
	readonly env: NodeJS.ProcessEnv
	/** The fetch the spec gate and the GitHub settings step use. */
	readonly fetch: typeof fetch
	/** Loads the release config at a path relative to the working directory (`loadRelease`). */
	readonly load: (config: string) => Promise<Release>
	/** Receives the command's standard output, whole lines ending in a newline. */
	readonly out: (text: string) => void
	/** Receives the command's standard error, whole lines ending in a newline. */
	readonly err: (text: string) => void
}

/** A mistake in how a release command was called: printed after `honey-clients: release <command>: `. */
export class ReleaseUsageError extends Error {
	/** Always `"ReleaseUsageError"`, so a caught error is told apart from a failure by name. */
	override name = "ReleaseUsageError"
}

/** `config` when the command was given one; a usage error naming the flag otherwise. */
export function requireConfig(config: string | undefined): string {
	if (config === undefined) throw new ReleaseUsageError("--config <path> is required")
	return config
}
