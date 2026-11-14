/**
 * `release bootstrap`: the first push to an empty public repo, or over the stub README a new GitHub repo starts with.
 * It overwrites the branch, so it is told exactly what to target and never blasts a repo with real history.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SHORT_SHA_LENGTH } from "./constants.ts"
import { type ReleaseContext, ReleaseUsageError, requireConfig } from "./context.ts"
import { getRemoteTip, gitOutput, gitRun, sshToHttps } from "./git.ts"
import { packageKey } from "./manifest.ts"
import type { PublicPackage, Release, SpecSource } from "./types.ts"
import { repoSettingsSyncer, type RepoSettingsSync } from "./repo-settings.ts"
import { memoizedSpecGate, type SpecGate } from "./spec-gate.ts"
import { filterPackages, syncPackage } from "./sync.ts"

const DECIMAL_RADIX = 10

/** The most commits a public repo's branch may hold for `--force-bootstrap` to overwrite it: a stub, not history. */
export const FORCE_COMMIT_LIMIT = 2

/** What `release bootstrap` prints when it is not told what to target. */
export const USAGE = [
	"Usage: clients release bootstrap --config <path> (--all | --only <names>) [--force-bootstrap]",
	"",
	"Tip: get a token via: gh auth token",
]

/**
 * Returns commit count on the remote branch, capped at FORCE_COMMIT_LIMIT + 1.
 * Used to gate --force-bootstrap: only mirrors with ≤FORCE_COMMIT_LIMIT commits
 * may be overwritten. Refuses to blast real history.
 */
export async function countRemoteCommits(httpsUrl: string, branch: string): Promise<number> {
	const tmpDir = mkdtempSync(join(tmpdir(), "public-sync-count-"))
	try {
		await gitRun(["init", "--quiet", tmpDir], tmpDir)
		await gitRun(["-C", tmpDir, "remote", "add", "origin", httpsUrl], tmpDir)
		try {
			await gitRun(["-C", tmpDir, "fetch", `--depth=${FORCE_COMMIT_LIMIT + 1}`, "origin", branch], tmpDir)
		} catch {
			return 0
		}
		const count = await gitOutput(["-C", tmpDir, "rev-list", "--count", "FETCH_HEAD"], tmpDir)
		return Number.parseInt(count, DECIMAL_RADIX)
	} finally {
		rmSync(tmpDir, { force: true, recursive: true })
	}
}

/** What `release bootstrap` was asked for. */
export interface BootstrapOptions {
	/** Every package of the release. */
	all: boolean
	/** The release config's path; required. */
	config: string | undefined
	/** Overwrite a stub branch of at most `FORCE_COMMIT_LIMIT` commits. */
	forceBootstrap: boolean
	/** The packages to bootstrap, by `name` or `project/name`. */
	only: string[] | undefined
}

/** A parse that succeeded with `options`, or failed with an `error` to show the caller. */
export type ParsedArgs = { error: string; ok: false } | { ok: true; options: BootstrapOptions }

/* Unknown arguments are ignored. */
const SWITCHES = { "--all": "all", "--force-bootstrap": "forceBootstrap" } as const
const VALUE_FLAGS = { "--config": "config", "--name": "only", "--only": "only" } as const

const isSwitch = (arg: string): arg is keyof typeof SWITCHES => Object.hasOwn(SWITCHES, arg)
const isValueFlag = (arg: string): arg is keyof typeof VALUE_FLAGS => Object.hasOwn(VALUE_FLAGS, arg)

/** `release bootstrap`'s flags; a value flag with no value is an error naming it, any unknown argument is ignored. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
	const options: BootstrapOptions = { all: false, config: undefined, forceBootstrap: false, only: undefined }
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string
		if (isSwitch(arg)) {
			options[SWITCHES[arg]] = true
			continue
		}
		if (!isValueFlag(arg)) continue
		const next = argv[i + 1]
		if (!next || next.startsWith("--")) return { error: `${arg} requires a value`, ok: false }
		if (VALUE_FLAGS[arg] === "only") {
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

/** Bootstrap must be told what to target; an empty argv would mean "every mirror". */
export function hasTarget(options: BootstrapOptions): boolean {
	return options.all || options.only !== undefined
}

/** Whether bootstrap may overwrite a public repo's branch, and why not when it may not. */
export type MirrorVerdict = { proceed: false; reason: string } | { proceed: true; reason?: undefined }

/**
 * Whether bootstrap may overwrite this mirror branch.
 *
 * - empty branch                              → proceed
 * - ≤FORCE_COMMIT_LIMIT + --force-bootstrap   → proceed (stub README + initial commit)
 * - ≤FORCE_COMMIT_LIMIT, no force             → refuse (require explicit force)
 * - >FORCE_COMMIT_LIMIT                       → refuse always (cannot blast real history)
 */
export function judgeMirror(input: {
	branch: string
	commitCount: number
	forceBootstrap: boolean
	tip: string | undefined
}): MirrorVerdict {
	if (!input.tip) return { proceed: true }

	const shortTip = input.tip.slice(0, SHORT_SHA_LENGTH)

	if (input.commitCount > FORCE_COMMIT_LIMIT) {
		return {
			proceed: false,
			reason: `mirror branch ${input.branch} has ${input.commitCount}+ commits (tip=${shortTip}…). Bootstrap refuses to overwrite real history.\n         Bootstrap is for a new repo; release sync keeps one with history current. To start over, delete the repo and recreate it empty.`,
		}
	}

	if (!input.forceBootstrap) {
		return {
			proceed: false,
			reason: `mirror branch ${input.branch} is non-empty (${input.commitCount} commit(s), tip=${shortTip}…). Pass --force-bootstrap to overwrite the stub.`,
		}
	}

	return { proceed: true }
}

/* what every package of one bootstrap run shares */
type Run = {
	readonly forceBootstrap: boolean
	readonly repoSettings: RepoSettingsSync
	readonly root: string
	readonly specGate: (spec: SpecSource) => Promise<SpecGate>
	readonly token: string
}

/* one package bootstrapped: its outcome, reported as it goes */
async function bootstrapOne(
	entry: PublicPackage,
	run: Run,
	ctx: ReleaseContext,
): Promise<"failed" | "skipped" | "synced"> {
	ctx.out(`\n→ ${packageKey(entry)} → ${entry.mirror}\n`)
	const httpsUrl = sshToHttps(entry.mirror, run.token)
	const tip = await getRemoteTip(httpsUrl, entry.branch, run.root)
	const verdict = judgeMirror({
		branch: entry.branch,
		commitCount: tip ? await countRemoteCommits(httpsUrl, entry.branch) : 0,
		forceBootstrap: run.forceBootstrap,
		tip,
	})
	if (!verdict.proceed) {
		ctx.err(`  fail: ${verdict.reason}\n`)
		return "failed"
	}

	/* Bootstrap commits force-overwrite the mirror with a fresh "initial release" snapshot. bootstrapExclude globs
	   skip generated source on the initial push, so the next sync adds it cleanly. A repo bootstrap creates is exactly
	   one whose description, website and topics are empty, so the settings step fills them. */
	const result = await syncPackage(entry, {
		applyBootstrapExclude: true,
		dryRun: false,
		initialMessage: "chore: initial release",
		overwriteForeignTip: true,
		repoRoot: run.root,
		repoSettings: run.repoSettings,
		specGate: run.specGate,
		token: run.token,
	})
	if (result.status === "failed") {
		ctx.err(`  fail: ${result.reason}\n`)
		return "failed"
	}
	if (result.status === "skipped") {
		ctx.out(`  skip: ${result.reason}\n`)
		return "skipped"
	}
	/* a push that is no dry run always reports both shas */
	const [source, mirror] = [result.sourceSha, result.mirrorSha] as [string, string]
	ctx.out(`  ok: source=${source.slice(0, SHORT_SHA_LENGTH)} mirror=${mirror.slice(0, SHORT_SHA_LENGTH)}\n`)
	return "synced"
}

/* the packages a bootstrap targets, bootstrapped one after another; the exit code it ends with */
async function bootstrapAll(release: Release, options: BootstrapOptions, token: string, ctx: ReleaseContext) {
	const targets = filterPackages(release.packages, { only: options.only })
	if (targets.length === 0) {
		ctx.err(`No packages match. Available: ${release.packages.map((entry) => packageKey(entry)).join(", ")}\n`)
		return 1
	}
	const run: Run = {
		forceBootstrap: options.forceBootstrap,
		repoSettings: repoSettingsSyncer({ dryRun: false, fetch: ctx.fetch, token }),
		root: release.root,
		specGate: memoizedSpecGate(ctx.fetch),
		token,
	}
	const outcomes = { failed: 0, skipped: 0, synced: 0 }
	for (const entry of targets) outcomes[await bootstrapOne(entry, run, ctx)]++
	ctx.out(`\nBootstrap done: ${outcomes.synced} synced, ${outcomes.skipped} skipped, ${outcomes.failed} failed.\n`)
	return outcomes.failed > 0 ? 1 : 0
}

/**
 * Runs `release bootstrap <argv>`: the target is checked before the token, and both before the config loads, so the
 * first mistake is the one reported. The exit code it ends with.
 */
export async function bootstrap(argv: readonly string[], ctx: ReleaseContext): Promise<number> {
	const parsed = parseArgs(argv)
	if (!parsed.ok) throw new ReleaseUsageError(parsed.error)
	const { options } = parsed
	const config = requireConfig(options.config)
	if (!hasTarget(options)) {
		for (const line of USAGE) ctx.err(`${line}\n`)
		return 1
	}
	const token = ctx.env.GH_TOKEN
	if (!token) {
		ctx.err("GH_TOKEN env is required. Get one via: GH_TOKEN=$(gh auth token)\n")
		return 1
	}
	return bootstrapAll(await ctx.load(config), options, token, ctx)
}
