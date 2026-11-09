/**
 * Mirrors packages into their public repos: each package's source tree becomes one snapshot commit by the release's
 * committer, with the release tag its state records and the repo settings its config names.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { gitOutput, getRemoteTip, sshToHttps } from "./git.ts"
import { packageKey } from "./manifest.ts"
import type { PublicPackage, SpecSource } from "./types.ts"
import { RELEASE_WORKFLOW, releaseWorkflow } from "./release-workflow.ts"
import type { RepoSettingsResult, RepoSettingsSync } from "./repo-settings.ts"
import { describeDrift, generatedPaths, type SpecGate } from "./spec-gate.ts"
import {
	buildCommitMessage,
	commitAndPush,
	isTreeUnchanged,
	pendingTag,
	prepareWorktree,
	pushTag,
	readSidecar,
	replaceTreeWithSource,
} from "./sync-tree.ts"

/** How one sync run behaves: the repo it reads, what it may push, and the steps it is handed. */
export interface SyncOptions {
	/** When true, use entry.bootstrapExclude globs as rsync excludes. Caller opts-in per run. */
	applyBootstrapExclude?: boolean
	/** Report what would be pushed and push nothing. */
	dryRun?: boolean
	/** The message of the first commit to an empty public repo; `chore: initial release` by default. */
	initialMessage?: string
	/** Package names (`name` or `project/name`) to sync; every package when absent or empty. */
	only?: string[]
	/** Push over a tip the sync bot did not commit. Bootstrap only: it has already judged the repo. */
	overwriteForeignTip?: boolean
	/** The git toplevel every package path is relative to. */
	repoRoot: string
	/** Keeps the public repo's description, website and topics equal to the package's. */
	repoSettings: RepoSettingsSync
	/** Compares prod's spec with the committed one; asked only when a package's generated output changed. */
	specGate: (spec: SpecSource) => Promise<SpecGate>
	/** The GitHub token every push and API call authenticates with. */
	token: string
}

/** What syncing one package did: pushed, skipped as unchanged, or failed, and why. */
export interface PackageResult {
	mirrorSha?: string
	name: string
	reason?: string
	/** What the repo settings step found or changed. */
	settings?: string
	sourceSha?: string
	status: "failed" | "skipped" | "synced"
	/** The release tag pushed (or, on a dry run, that would be) at the public commit equal to the source. */
	tag?: string
}

function describeSettings(result: RepoSettingsResult, dryRun: boolean): string {
	if (result.status !== "checked") return `settings ${result.status}`
	if (result.changed.length === 0) return "settings in step"
	return `settings ${dryRun ? "would change" : "changed"}: ${result.changed.join(", ")}`
}

/* Applies the repo settings after the tree step, whatever it did: a failure there fails the package but keeps
 * what already landed (the pushed commit and tag) in the result. */
async function withSettings(entry: PublicPackage, options: SyncOptions, result: PackageResult): Promise<PackageResult> {
	try {
		return {
			...result,
			settings: describeSettings(await options.repoSettings(entry), options.dryRun === true),
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		return {
			...result,
			reason: result.reason === undefined ? reason : `${result.reason}; ${reason}`,
			status: "failed",
		}
	}
}

/* one package's sync, in its temporary worktree */
type Run = {
	readonly entry: PublicPackage
	readonly headSha: string
	readonly httpsUrl: string
	readonly key: string
	readonly message: string
	readonly options: SyncOptions
	readonly remoteTip: string | undefined
	readonly worktree: string
}

const tagged = (tag: string | undefined) => (tag === undefined ? {} : { tag })

/* Only the bot commits to a public repo. Any other committer is a hand edit there that a snapshot would silently
   erase: its reason, or undefined when the tip is the bot's, there is none, or bootstrap judged it already. */
async function foreignTip({ entry, options, remoteTip, worktree }: Run): Promise<string | undefined> {
	if (!remoteTip || options.overwriteForeignTip) return undefined
	const committer = await gitOutput(["-C", worktree, "log", "-1", "--format=%ce", "FETCH_HEAD"], worktree)
	if (committer === entry.committer.email) return undefined
	return `external push detected on mirror; reconcile manually (tip=${remoteTip}, committer=${committer})`
}

/* The source's tree over the public tip, with the release workflow its registries render (a package that ships its
   own lists none): why it cannot be, or undefined. */
async function stageTree({ entry, options, worktree }: Run): Promise<string | undefined> {
	await replaceTreeWithSource({
		excludes: options.applyBootstrapExclude && entry.bootstrapExclude ? [...entry.bootstrapExclude] : [],
		repoRoot: options.repoRoot,
		sourcePath: entry.path,
		worktree,
	})
	if (entry.registries.length === 0) return undefined
	const workflow = join(worktree, RELEASE_WORKFLOW)
	if (existsSync(workflow)) {
		return `${join(entry.path, RELEASE_WORKFLOW)} exists and the package lists registries: drop one, the other writes it`
	}
	mkdirSync(dirname(workflow), { recursive: true })
	writeFileSync(workflow, releaseWorkflow(entry.registries))
	return undefined
}

/* Generated output prod does not serve must not ship; hand files go out regardless: the refusal, or undefined. */
async function drift({ entry, key, options, worktree }: Run): Promise<string | undefined> {
	const generated = generatedPaths(join(options.repoRoot, entry.path))
	const changed = (await gitOutput(["-C", worktree, "diff", "--cached", "--name-only"], worktree)).split("\n")
	if (!changed.some((path) => generated.has(path))) return undefined
	const gate = await options.specGate(entry.spec)
	return gate.status === "drift" ? describeDrift(key, gate) : undefined
}

/* the tip is the bot's and equals the source, so a tag a stopped run never pushed goes on it */
async function skipUnchanged(run: Run): Promise<PackageResult> {
	const { entry, httpsUrl, key, options, worktree } = run
	const tag = await pendingTag(entry, options.repoRoot, worktree, httpsUrl)
	if (tag !== undefined && !options.dryRun) await pushTag(worktree, httpsUrl, tag)
	return withSettings(entry, options, {
		name: key,
		reason: "content identical to mirror tip",
		status: "skipped",
		...tagged(tag),
	})
}

/* the snapshot committed and pushed, then its tag; on a dry run, what would be */
async function push(run: Run): Promise<PackageResult> {
	const { entry, headSha, httpsUrl, key, message, options, remoteTip, worktree } = run
	const tag = await pendingTag(entry, options.repoRoot, worktree, httpsUrl)
	if (options.dryRun) {
		return withSettings(entry, options, {
			name: key,
			reason: `dry-run: would push to ${entry.branch} with message "${message}"${tag === undefined ? "" : ` and tag ${tag}`}`,
			sourceSha: headSha,
			status: "synced",
			...tagged(tag),
		})
	}
	await commitAndPush({ branch: entry.branch, expectedRemote: remoteTip ?? "", httpsUrl, message, worktree })
	const mirrorSha = await gitOutput(["-C", worktree, "rev-parse", "HEAD"], options.repoRoot)
	if (tag !== undefined) await pushTag(worktree, httpsUrl, tag)
	return withSettings(entry, options, { mirrorSha, name: key, sourceSha: headSha, status: "synced", ...tagged(tag) })
}

/* each step in turn; the first that refuses fails the package */
async function syncIn(run: Run): Promise<PackageResult> {
	await prepareWorktree(run.worktree, run.httpsUrl, run.entry, run.remoteTip)
	const foreign = await foreignTip(run)
	if (foreign !== undefined) return { name: run.key, reason: foreign, status: "failed" }
	const conflict = await stageTree(run)
	if (conflict !== undefined) return { name: run.key, reason: conflict, status: "failed" }
	if (await isTreeUnchanged(run.worktree)) return skipUnchanged(run)
	const refused = await drift(run)
	if (refused !== undefined) return { name: run.key, reason: refused, status: "failed" }
	return push(run)
}

/**
 * Mirrors one package into its public repo: a snapshot commit when its tree changed (generated output only when prod
 * serves the committed spec), the release tag its state records, and its repo settings. Refuses a public tip another
 * committer pushed unless `overwriteForeignTip`.
 */
export async function syncPackage(entry: PublicPackage, options: SyncOptions): Promise<PackageResult> {
	const key = packageKey(entry)
	const headSha = await gitOutput(["rev-parse", "HEAD"], options.repoRoot)
	const httpsUrl = sshToHttps(entry.mirror, options.token)
	const remoteTip = await getRemoteTip(httpsUrl, entry.branch, options.repoRoot)
	const message = buildCommitMessage({
		initialMessage: options.initialMessage,
		isInitial: !remoteTip,
		sidecarMessage: readSidecar(options.repoRoot, entry.path),
		templateMessage: entry.commitMessage,
	})
	const worktree = mkdtempSync(join(tmpdir(), `public-sync-${key.replace(/\//g, "-")}-`))
	try {
		return await syncIn({ entry, headSha, httpsUrl, key, message, options, remoteTip, worktree })
	} finally {
		rmSync(worktree, { force: true, recursive: true })
	}
}

/** Syncs each of `packages` that `options.only` keeps, one after another; a package that throws fails alone. */
export async function syncAll(packages: readonly PublicPackage[], options: SyncOptions): Promise<PackageResult[]> {
	const results: PackageResult[] = []

	for (const entry of filterPackages(packages, options)) {
		try {
			results.push(await syncPackage(entry, options))
		} catch (err) {
			results.push({
				name: packageKey(entry),
				reason: err instanceof Error ? err.message : String(err),
				status: "failed",
			})
		}
	}

	return results
}

/** The packages `--only` keeps, by short "name" or full "project/name"; every package when it names none. */
export function filterPackages(
	packages: readonly PublicPackage[],
	options: Pick<SyncOptions, "only">,
): PublicPackage[] {
	if (!options.only || options.only.length === 0) return [...packages]
	const set = new Set(options.only)
	return packages.filter((p) => set.has(p.name) || set.has(packageKey(p)))
}
