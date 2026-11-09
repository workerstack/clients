/**
 * `honey-clients release bump|sync|bootstrap|codegen|toolchains --config <path>`: cut a product's versions, mirror its
 * packages into their public repos, and make the first push to a new one, all from the product's `release.config.ts`.
 * `codegen` and `toolchains` serve the release workflows: what to install before codegen, and codegen run alone.
 */
import type { Io } from "../cli.ts"
import { bootstrap } from "./bootstrap.ts"
import { parseBumpArgs } from "./bump-args.ts"
import { runBump } from "./bump-command.ts"
import { regenerate } from "./codegen.ts"
import { parseConfigOnly, type ReleaseContext, ReleaseUsageError } from "./context.ts"
import { type LoadReleaseOptions, readRelease } from "./load.ts"
import { sync } from "./sync-command.ts"

/* the usage entries of the commands that take only --config, each also its own --help */
const CODEGEN_USAGE = `codegen --config <path>
      run the config's codegen from the repo root, as bump does before it decides
`
const TOOLCHAINS_USAGE = `toolchains --config <path>
      print the config's toolchains, one per line: the system.config.ts names its codegen needs
`

/** What `honey-clients release` prints when it is given no command, or one it does not know. */
export const USAGE = `usage: honey-clients release <command> --config <path> [options]

  bump --config <path> [--major]
      regenerate, then release each package whose output or hand files changed: any API change is a minor,
      --major makes each release a major
  sync --config <path> [--only <names>] [--dry-run] [--validate-only]
      mirror each package into its public repo (release sync --help says more)
  bootstrap --config <path> (--all | --only <names>) [--force-bootstrap]
      the first push to an empty public repo, or over the stub a new one starts with
  ${CODEGEN_USAGE}  ${TOOLCHAINS_USAGE}`

/* `release bump <argv>`: the release its config describes, bumped */
async function bump(argv: readonly string[], ctx: ReleaseContext): Promise<number> {
	const parsed = parseBumpArgs(argv)
	if (!parsed.ok) throw new ReleaseUsageError(parsed.error)
	return runBump(await ctx.load(parsed.value.config), parsed.value.major, ctx)
}

/* `release codegen <argv>`: the config's codegen, run as bump runs it */
async function codegen(argv: readonly string[], ctx: ReleaseContext): Promise<number> {
	const parsed = parseConfigOnly(argv)
	if (parsed.help) {
		ctx.out(`usage: honey-clients release ${CODEGEN_USAGE}`)
		return 0
	}
	regenerate(await ctx.load(parsed.config), ctx.env)
	return 0
}

/* `release toolchains <argv>`: the config's toolchains, one per line, for a workflow to install before codegen */
async function toolchains(argv: readonly string[], ctx: ReleaseContext): Promise<number> {
	const parsed = parseConfigOnly(argv)
	if (parsed.help) {
		ctx.out(`usage: honey-clients release ${TOOLCHAINS_USAGE}`)
		return 0
	}
	for (const name of (await ctx.load(parsed.config)).toolchains) ctx.out(`${name}\n`)
	return 0
}

const COMMANDS = { bootstrap, bump, codegen, sync, toolchains } as const

const isCommand = (name: string | undefined): name is keyof typeof COMMANDS =>
	name !== undefined && Object.hasOwn(COMMANDS, name)

/** What a release run reads beside its arguments; each defaults to the running process's own. */
export type ReleaseOptions = {
	/** The environment: `GH_TOKEN`, and what codegen and Go run with. */
	readonly env?: NodeJS.ProcessEnv
	/** The fetch the spec gate and the GitHub settings step use. */
	readonly fetch?: typeof fetch
	/** How the release config is imported (`loadRelease`'s options). */
	readonly load?: LoadReleaseOptions
}

/**
 * Runs `honey-clients release <argv>`: the exit code it ends with. A usage mistake is one line naming the command; any
 * other failure is its message, never a stack.
 */
export async function release(argv: readonly string[], io: Io, options: ReleaseOptions = {}): Promise<number> {
	const [command, ...rest] = argv
	if (command === "--help" || command === "-h") {
		io.out(USAGE)
		return 0
	}
	if (!isCommand(command)) {
		io.err(USAGE)
		return 1
	}
	const ctx: ReleaseContext = {
		env: options.env ?? process.env,
		err: io.err,
		fetch: options.fetch ?? fetch,
		load: (config) => readRelease(config, options.load ?? {}),
		out: io.out,
	}
	try {
		return await COMMANDS[command](rest, ctx)
	} catch (error) {
		const prefix = error instanceof ReleaseUsageError ? `release ${command}: ` : ""
		io.err(`honey-clients: ${prefix}${error instanceof Error ? error.message : String(error)}\n`)
		return 1
	}
}
