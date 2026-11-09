/**
 * `release bump`: regenerate the product, decide each package's release from its digests, gate generated output on
 * prod, then write versions, regenerate at those versions, and record what was released. All or nothing: a refusal
 * writes nothing, and a failure before the states are written leaves them as they were, so a rerun decides the same.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { decide, type Decision, type Observed } from "./bump.ts"
import { CHANGELOG_FILE, ENOENT, MAX_OUTPUT_BYTES, PORCELAIN_PREFIX_LENGTH, RELEASE_STATE } from "./constants.ts"
import type { ReleaseContext } from "./context.ts"
import { handDigest, outputDigest } from "./digest.ts"
import { RELEASE_VERSIONS_ENV } from "./manifest.ts"
import type { PublicPackage, Release } from "./types.ts"
import { apiChanges, type ApiChange } from "./oasdiff.ts"
import { type ReleaseState, releaseStateSchema } from "./release-state.ts"
import { canonicalSha, checkDeployedSpec, describeDrift } from "./spec-gate.ts"
import { readVersions, writeVersions } from "./version-files.ts"

/** The header every CHANGELOG bump writes starts with; entries go directly under it, newest first. */
export const CHANGELOG_HEADER = "# Changelog\n\n"

/* codegen's own output goes to stderr's descriptor, so stdout stays bump's report */
const STDERR_FD = 2

/** `existing` with `entry` directly under the `# Changelog` header, which it gains when it had none. */
export function prependEntry(existing: string, entry: string): string {
	const body = existing.startsWith(CHANGELOG_HEADER) ? existing.slice(CHANGELOG_HEADER.length) : existing
	return `${CHANGELOG_HEADER}${entry}\n${body}`
}

/** The release `stateFile` records; undefined before a package's first release. Throws on a state that does not parse. */
export async function readPrevious(stateFile: string): Promise<ReleaseState | undefined> {
	try {
		const raw = await fs.readFile(stateFile, "utf8")
		return releaseStateSchema().parse(JSON.parse(raw))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === ENOENT) return undefined
		throw error
	}
}

async function prependChangelog(changelogFile: string, entry: string): Promise<void> {
	let existing = ""
	try {
		existing = await fs.readFile(changelogFile, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== ENOENT) throw error
	}
	await fs.writeFile(changelogFile, prependEntry(existing, entry), "utf8")
}

const git = (root: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES })

/* Runs the product's codegen from the repo root, in `env` with the release versions when given. */
function regenerate(release: Release, env: NodeJS.ProcessEnv, versions?: Record<string, string>): void {
	const [command = "", ...args] = release.codegen
	const result = spawnSync(command, args, {
		cwd: release.root,
		env: versions === undefined ? env : { ...env, [RELEASE_VERSIONS_ENV]: JSON.stringify(versions) },
		stdio: ["ignore", STDERR_FD, STDERR_FD],
	})
	if (result.error) throw new Error(`codegen could not start: ${result.error.message}`)
	if (result.status !== 0) throw new Error(`codegen (${release.codegen.join(" ")}) exited ${result.status}`)
}

/* The committed spec as HEAD holds it; refuses a working copy that differs, since the state records HEAD. */
function committedSpec({ root, spec }: Release): Observed["spec"] {
	const specPath = path.relative(root, spec.committedPath)
	const sha = canonicalSha(JSON.parse(readFileSync(spec.committedPath, "utf8")))
	let atHead: string
	try {
		atHead = canonicalSha(JSON.parse(git(root, "show", `HEAD:${specPath}`)))
	} catch {
		atHead = ""
	}
	if (atHead !== sha) {
		throw new Error(
			`${specPath} differs from HEAD: commit the spec first, so each release records the spec it was cut from`,
		)
	}
	return { commit: git(root, "rev-parse", "HEAD").trim(), path: specPath, sha }
}

/* oasdiff from each released spec to the committed one, run once per released spec. */
function changesSince(
	release: Release,
	env: NodeJS.ProcessEnv,
): (released: ReleaseState["spec"]) => readonly ApiChange[] {
	const found = new Map<string, readonly ApiChange[]>()
	return (released) => {
		const cached = found.get(released.sha)
		if (cached !== undefined) return cached
		const base = git(release.root, "show", `${released.commit}:${released.path}`)
		if (canonicalSha(JSON.parse(base)) !== released.sha) {
			throw new Error(`${released.commit}:${released.path} is not the spec the release recorded (${released.sha})`)
		}
		const dir = mkdtempSync(path.join(tmpdir(), "oss-release-spec-"))
		try {
			const file = path.join(dir, "released.json")
			writeFileSync(file, base)
			const changes = apiChanges(file, release.spec.committedPath, env)
			found.set(released.sha, changes)
			return changes
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}
}

/* Paths under `dir` that differ from HEAD (tracked or new, never ignored), repo-relative. */
function changedPaths(root: string, dir: string): string[] {
	return git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", dir)
		.split("\0")
		.filter((entry) => entry.length > PORCELAIN_PREFIX_LENGTH)
		.map((entry) => entry.slice(PORCELAIN_PREFIX_LENGTH))
}

type Planned = {
	decision: Decision
	dir: string
	/* the run's one clock: the CHANGELOG date and every state's publishedAt */
	now: Date
	observed: Observed
	pkg: PublicPackage
	previous?: ReleaseState
}

type Releasing = Planned & { decision: Exclude<Decision, { kind: "none" }> }

/* each package's decision from its digests now and its last release */
async function plan(release: Release, major: boolean, env: NodeJS.ProcessEnv): Promise<Planned[]> {
	const spec = committedSpec(release)
	const changes = changesSince(release, env)
	const now = new Date()
	const planned: Planned[] = []
	for (const pkg of release.packages) {
		const dir = path.join(release.root, pkg.path)
		/* a version file bump cannot read fails the run before anything is written */
		readVersions(dir)
		const previous = await readPrevious(path.join(dir, RELEASE_STATE))
		const observed = { hand: handDigest(release.root, pkg), output: outputDigest(release.root, pkg, spec.sha), spec }
		const decision = decide({
			changes,
			initialMessage: pkg.description,
			major,
			now,
			observed,
			previous,
		})
		planned.push({ decision, dir, now, observed, pkg, ...(previous === undefined ? {} : { previous }) })
	}
	return planned
}

/* writes one package's state and changelog, and reports every path its release touched */
async function record(
	release: Release,
	{ decision, dir, now, observed, pkg }: Releasing,
	versionFiles: string[],
	ctx: ReleaseContext,
) {
	const { root } = release
	const state: ReleaseState = {
		hand: handDigest(root, pkg),
		output: outputDigest(root, pkg, observed.spec.sha),
		publishedAt: now.toISOString(),
		spec: observed.spec,
		version: decision.nextVersion,
	}
	const stateFile = path.join(dir, RELEASE_STATE)
	const changelogFile = path.join(dir, CHANGELOG_FILE)
	await fs.writeFile(stateFile, `${JSON.stringify(state, null, "\t")}\n`, "utf8")
	await prependChangelog(changelogFile, decision.entry)

	const wrote = new Set([
		...versionFiles.map((file) => path.relative(root, file)),
		path.relative(root, stateFile),
		path.relative(root, changelogFile),
		...changedPaths(root, pkg.path),
	])
	const lines = [
		`=== ${pkg.name} ===`,
		`kind:         ${decision.kind}`,
		`nextVersion:  ${decision.nextVersion}`,
		...[...wrote].sort().map((file) => `wrote: ${file}`),
		"---",
		decision.entry,
		`bumped: ${pkg.name} ${decision.nextVersion} ${decision.kind}`,
	]
	for (const line of lines) ctx.out(`${line}\n`)
}

/**
 * Releases each package of `release` whose output or hand files changed since its last release, `major` making each
 * release a major; the exit code it ends with. Prints a `bumped: <name> <version> <kind>` line per release and a
 * `wrote: <path>` line per file it touched, which the bump workflow parses.
 */
export async function runBump(release: Release, major: boolean, ctx: ReleaseContext): Promise<number> {
	regenerate(release, ctx.env)
	const releasing = (await plan(release, major, ctx.env)).filter(
		(planned): planned is Releasing => planned.decision.kind !== "none",
	)
	const generated = releasing.filter(
		({ observed, pkg, previous }) => pkg.honey !== undefined && observed.output !== previous?.output,
	)
	if (generated.length > 0) {
		const gate = await checkDeployedSpec(release.spec, ctx.fetch)
		if (gate.status === "drift") {
			ctx.err(`${describeDrift(generated.map(({ pkg }) => pkg.name).join(", "), gate)}\n`)
			ctx.err("nothing was bumped\n")
			return 1
		}
	}
	if (releasing.length === 0) {
		ctx.out("no changes since last release\n")
		return 0
	}

	/* versions first, then codegen at those versions, so the recorded digests are the released output's */
	const written = releasing.map((planned) => ({
		files: writeVersions(planned.dir, planned.decision.nextVersion),
		planned,
	}))
	regenerate(
		release,
		ctx.env,
		Object.fromEntries(releasing.map(({ decision, pkg }) => [pkg.name, decision.nextVersion])),
	)
	for (const { files, planned } of written) await record(release, planned, files, ctx)
	return 0
}
