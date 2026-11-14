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

/** A mistake in how a release command was called: printed after `clients: release <command>: `. */
export class ReleaseUsageError extends Error {
	/** Always `"ReleaseUsageError"`, so a caught error is told apart from a failure by name. */
	override name = "ReleaseUsageError"
}

/** `config` when the command was given one; a usage error naming the flag otherwise. */
export function requireConfig(config: string | undefined): string {
	if (config === undefined) throw new ReleaseUsageError("--config <path> is required")
	return config
}

/** What a command that takes only `--config <path>` and `--help` was asked for. */
export type ConfigOnlyArgs = { readonly help: true } | { readonly config: string; readonly help: false }

/**
 * The flags of a command that takes only `--config <path>` (required) and `--help` (`-h`). Any other argument, or
 * `--config` with no value, is a usage error naming it.
 */
export function parseConfigOnly(argv: readonly string[]): ConfigOnlyArgs {
	let config: string | undefined
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string
		if (arg === "--help" || arg === "-h") return { help: true }
		if (arg !== "--config") throw new ReleaseUsageError(`unknown flag: ${arg}`)
		const value = argv[i + 1]
		if (value === undefined || value.startsWith("--")) throw new ReleaseUsageError("--config requires a value")
		config = value
		i++
	}
	return { config: requireConfig(config), help: false }
}
