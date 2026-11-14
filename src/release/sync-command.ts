/** `release sync`: mirror each package of a release into its public repo, or only validate the release config. */
import { SHORT_SHA_LENGTH } from "./constants.ts"
import { type ReleaseContext, ReleaseUsageError, requireConfig } from "./context.ts"
import { repoSettingsSyncer } from "./repo-settings.ts"
import { memoizedSpecGate } from "./spec-gate.ts"
import { type PackageResult, syncAll } from "./sync.ts"

const MIN_NAME_WIDTH = 4

/** What `release sync --help` prints. */
export const HELP = `Usage: clients release sync --config <path> [options]

Options:
  --config <path>   The release config (required)
  --only <names>    Comma-separated package filter. Accepts short "name" (if unique) or "project/name"
  --dry-run         Log push commands without executing them
  --validate-only   Validate the release config and exit 0/1
  --help            Show this message

Env:
  GH_TOKEN          GitHub token (required unless --validate-only or --dry-run)
`

/** What `release sync` was asked for. */
export interface CliOptions {
	/** The release config's path; required unless `--help`. */
	config: string | undefined
	/** Report what would be pushed and push nothing. */
	dryRun: boolean
	/** Print the help and do nothing else. */
	help: boolean
	/** The packages to sync, by `name` or `project/name`; every package when absent. */
	only: string[] | undefined
	/** Only load and check the release config. */
	validateOnly: boolean
}

/** A parse that succeeded with `options`, or failed with an `error` to show the caller. */
export type ParsedArgs = { error: string; ok: false } | { ok: true; options: CliOptions }

/* Unknown arguments are ignored. */
const SWITCHES = {
	"--dry-run": "dryRun",
	"--help": "help",
	"--validate-only": "validateOnly",
	"-h": "help",
} as const
const VALUE_FLAGS = { "--config": "config", "--only": "only" } as const
const VALUE_REQUIRED = {
	config: "--config requires a value (the release config's path)",
	only: "--only requires a value (comma-separated names or project/name)",
} as const

const isSwitch = (arg: string): arg is keyof typeof SWITCHES => Object.hasOwn(SWITCHES, arg)
const isValueFlag = (arg: string): arg is keyof typeof VALUE_FLAGS => Object.hasOwn(VALUE_FLAGS, arg)

/** `release sync`'s flags; a value flag with no value is an error, any unknown argument is ignored. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
	const options: CliOptions = {
		config: undefined,
		dryRun: false,
		help: false,
		only: undefined,
		validateOnly: false,
	}

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string
		if (isSwitch(arg)) {
			options[SWITCHES[arg]] = true
			continue
		}
		if (!isValueFlag(arg)) continue
		const key = VALUE_FLAGS[arg]
		const next = argv[i + 1]
		if (!next || next.startsWith("--")) return { error: VALUE_REQUIRED[key], ok: false }
		if (key === "only") {
			options.only = next
				.split(",")
				.map((name) => name.trim())
				.filter(Boolean)
		} else {
			options.config = next
		}
		i++
	}

	return { ok: true, options }
}

/** The run's report: a header, a rule, and one line per package with its status and detail. */
export function formatResults(items: readonly PackageResult[]): string[] {
	const nameWidth = Math.max(MIN_NAME_WIDTH, ...items.map((result) => result.name.length))
	const statusWidth = 7

	const header = `${"NAME".padEnd(nameWidth)}  ${"STATUS".padEnd(statusWidth)}  DETAIL`

	return [
		header,
		"-".repeat(header.length),
		...items.map((result) => {
			const detail = [
				result.reason ?? (result.mirrorSha ? `mirror=${result.mirrorSha.slice(0, SHORT_SHA_LENGTH)}` : ""),
				result.tag === undefined ? "" : `tag=${result.tag}`,
				result.settings ?? "",
			]
				.filter((part) => part !== "")
				.join("  ")
			return `${result.name.padEnd(nameWidth)}  ${result.status.padEnd(statusWidth)}  ${detail}`
		}),
	]
}

/** Runs `release sync <argv>`: the exit code it ends with, 1 when any package failed. */
export async function sync(argv: readonly string[], ctx: ReleaseContext): Promise<number> {
	const parsed = parseArgs(argv)
	if (!parsed.ok) throw new ReleaseUsageError(parsed.error)
	const { options } = parsed
	if (options.help) {
		ctx.out(`${HELP}\n`)
		return 0
	}
	const config = requireConfig(options.config)

	if (options.validateOnly) {
		const { packages } = await ctx.load(config)
		ctx.out(`Manifests valid: ${packages.length} package(s)\n`)
		return 0
	}

	const token = ctx.env.GH_TOKEN ?? ""
	if (!token && !options.dryRun) {
		ctx.err("GH_TOKEN env is required (or use --dry-run)\n")
		return 1
	}

	const release = await ctx.load(config)
	const results = await syncAll(release.packages, {
		dryRun: options.dryRun,
		only: options.only,
		repoRoot: release.root,
		repoSettings: repoSettingsSyncer({ dryRun: options.dryRun, fetch: ctx.fetch, token }),
		specGate: memoizedSpecGate(ctx.fetch),
		token,
	})

	for (const line of formatResults(results)) ctx.out(`${line}\n`)
	return results.some((result) => result.status === "failed") ? 1 : 0
}
