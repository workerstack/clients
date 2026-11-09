/** The temporary worktree sync builds each public commit in, and the message that commit carries. */
import { spawn } from "node:child_process"
import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { MANIFEST } from "../gen/write.ts"
import { RELEASE_STATE } from "./constants.ts"
import { gitExitCode, gitOutput, gitRun } from "./git.ts"
import { RELEASE_WORKFLOW } from "./release-workflow.ts"
import type { PublicPackage } from "./types.ts"

const DATE_PART_DIGITS = 2

const SIDECAR_FILE = ".publicsync-message"

export async function prepareWorktree(
	worktree: string,
	httpsUrl: string,
	{ branch, committer }: PublicPackage,
	remoteTip: string | undefined,
): Promise<void> {
	await gitRun(["init", "--quiet", "--initial-branch", branch, worktree], worktree)
	await gitRun(["-C", worktree, "config", "user.name", committer.name], worktree)
	await gitRun(["-C", worktree, "config", "user.email", committer.email], worktree)
	await gitRun(["-C", worktree, "remote", "add", "origin", httpsUrl], worktree)

	if (remoteTip) {
		await gitRun(["-C", worktree, "fetch", "--depth=1", "origin", branch], worktree)
		await gitRun(["-C", worktree, "reset", "--hard", "FETCH_HEAD"], worktree)
		const tracked = await gitOutput(["-C", worktree, "ls-files"], worktree)
		if (tracked) {
			await gitRun(["-C", worktree, "rm", "-rf", "--quiet", "."], worktree)
		}
	}
}

export async function replaceTreeWithSource(args: {
	excludes: string[]
	repoRoot: string
	sourcePath: string
	worktree: string
}): Promise<void> {
	const sourceFull = join(args.repoRoot, args.sourcePath)
	await runRsync(`${sourceFull}/`, `${args.worktree}/`, args.excludes)

	/* the sidecar message file is the source's note to sync; it never lands in the public repo */
	const sidecarPath = join(args.worktree, SIDECAR_FILE)
	if (existsSync(sidecarPath)) {
		unlinkSync(sidecarPath)
	}
}

async function runRsync(src: string, dst: string, excludes: string[]): Promise<void> {
	/* honey's manifest is the source repo's record of what it generated, not part of the package */
	const args = ["-a", "--delete", "--exclude=.git", `--exclude=${MANIFEST}`]
	for (const glob of excludes) {
		args.push(`--exclude=${glob}`)
	}
	args.push(src, dst)

	await new Promise<void>((resolve, reject) => {
		const child = spawn("rsync", args, { stdio: ["ignore", "ignore", "pipe"] })
		let stderr = ""
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8")
		})
		child.on("error", reject)
		child.on("close", (code) => {
			if (code === 0) resolve()
			else reject(new Error(`rsync exit ${code}: ${stderr.trim()}`))
		})
	})
}

/**
 * The release tag the public commit equal to the source still needs: `v<version>` from the source's
 * `.release-state.json`, when the synced tree carries the release workflow and the public repo has no
 * such tag. An existing tag is never moved, wherever it points.
 */
export async function pendingTag(
	entry: PublicPackage,
	repoRoot: string,
	worktree: string,
	httpsUrl: string,
): Promise<string | undefined> {
	if (!existsSync(join(worktree, RELEASE_WORKFLOW))) return undefined
	const statePath = join(repoRoot, entry.path, RELEASE_STATE)
	if (!existsSync(statePath)) return undefined
	const { version } = JSON.parse(readFileSync(statePath, "utf8")) as { version?: unknown }
	if (typeof version !== "string" || version === "")
		throw new Error(`${join(entry.path, RELEASE_STATE)} records no version`)
	const tag = `v${version}`
	const existing = await gitOutput(["ls-remote", "--tags", httpsUrl, `refs/tags/${tag}`], worktree)
	return existing === "" ? tag : undefined
}

/* No force: a tag someone pushed in between makes this fail rather than move theirs. */
export async function pushTag(worktree: string, httpsUrl: string, tag: string): Promise<void> {
	await gitRun(["-C", worktree, "tag", tag, "HEAD"], worktree)
	await gitRun(["-C", worktree, "push", httpsUrl, `refs/tags/${tag}`], worktree)
}

export async function isTreeUnchanged(worktree: string): Promise<boolean> {
	/* -Af forces past the package's own .gitignore: a generated SDK may ship one that keeps its generated source out
	   of the source repo's git, and that filter must not apply here, where those files are what is published */
	await gitRun(["-C", worktree, "add", "-Af"], worktree)
	const diffCode = await gitExitCode(["-C", worktree, "diff", "--cached", "--quiet"], worktree)
	return diffCode === 0
}

export function readSidecar(repoRoot: string, sourcePath: string): string | undefined {
	const sidecar = join(repoRoot, sourcePath, SIDECAR_FILE)
	if (!existsSync(sidecar)) return undefined
	const raw = readFileSync(sidecar, "utf8").trim()
	return raw.length > 0 ? raw : undefined
}

export function buildCommitMessage(args: {
	initialMessage: string | undefined
	isInitial: boolean
	sidecarMessage: string | undefined
	templateMessage: string
}): string {
	const stamp = formatUtcStamp(new Date())
	if (args.sidecarMessage) {
		return `${args.sidecarMessage} [${stamp}]`
	}
	if (args.isInitial) {
		const initial = args.initialMessage ?? "chore: initial release"
		return `${initial} [${stamp}]`
	}
	return `${args.templateMessage} [${stamp}]`
}

function formatUtcStamp(d: Date): string {
	const yyyy = d.getUTCFullYear()
	const mm = String(d.getUTCMonth() + 1).padStart(DATE_PART_DIGITS, "0")
	const dd = String(d.getUTCDate()).padStart(DATE_PART_DIGITS, "0")
	const hh = String(d.getUTCHours()).padStart(DATE_PART_DIGITS, "0")
	const mi = String(d.getUTCMinutes()).padStart(DATE_PART_DIGITS, "0")
	return `${yyyy}-${mm}-${dd} ${hh}:${mi} UTC`
}

export async function commitAndPush(args: {
	branch: string
	expectedRemote: string
	httpsUrl: string
	message: string
	worktree: string
}): Promise<void> {
	await gitRun(["-C", args.worktree, "commit", "--quiet", "--message", args.message], args.worktree)
	await gitRun(
		[
			"-C",
			args.worktree,
			"push",
			`--force-with-lease=refs/heads/${args.branch}:${args.expectedRemote}`,
			"--force-if-includes",
			args.httpsUrl,
			`HEAD:refs/heads/${args.branch}`,
		],
		args.worktree,
	)
}
