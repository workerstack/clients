import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { MANIFEST } from "../gen/write.ts"
import { CHANGELOG_FILE, RELEASE_STATE } from "./constants.ts"
import type { PublicPackage } from "./types.ts"
import { canonicalSha, generatedFiles, generatedPaths } from "./spec-gate.ts"
import { VERSION_FILES, type VersionFileName } from "./version-files.ts"

/*
 * What a release is cut from, as two digests `.release-state.json` records: the generated output and the hand
 * files. A package releases when either moved since its last release.
 */

/* Files bump itself writes on every release, so they never count as a change. */
const BUMP_WRITES: readonly string[] = [RELEASE_STATE, CHANGELOG_FILE]
/* A version file hashes as if it held this version, so a release's own version move is not a change. */
const NORMALIZED_VERSION = "0.0.0"

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")

/**
 * sha256 over honey's `.honey-generated.json` file map in the package dir. A hand-kept package (no honey target)
 * publishes its product's spec, so its output is `specSha`.
 */
export function outputDigest(repoRoot: string, pkg: PublicPackage, specSha: string): string {
	if (pkg.honey === undefined) return specSha
	const files = generatedFiles(join(repoRoot, pkg.path))
	if (files === undefined) throw new Error(`${pkg.path} has no ${MANIFEST}: codegen did not generate it`)
	return canonicalSha(files)
}

/**
 * sha256 over the package's tracked files that are neither generated nor written by bump, by path and content;
 * each version file is hashed as if it held `0.0.0`.
 */
export function handDigest(repoRoot: string, pkg: PublicPackage): string {
	const dir = join(repoRoot, pkg.path)
	const generated = generatedPaths(dir)
	const tracked = execFileSync("git", ["ls-files", "-z", "--", pkg.path], {
		cwd: repoRoot,
		encoding: "utf8",
	})
		.split("\0")
		.filter((file) => file !== "")
		.map((file) => relative(pkg.path, file))
	const files: Record<string, string> = {}
	for (const rel of tracked) {
		if (rel === MANIFEST || BUMP_WRITES.includes(rel) || generated.has(rel)) continue
		const full = join(dir, rel)
		/* a tracked file deleted in the worktree is a change too */
		if (!existsSync(full)) {
			files[rel] = "deleted"
			continue
		}
		const versionFile = Object.hasOwn(VERSION_FILES, rel) ? VERSION_FILES[rel as VersionFileName] : undefined
		const text = readFileSync(full, "utf8")
		files[rel] = sha256(versionFile ? versionFile.write(text, NORMALIZED_VERSION) : text)
	}
	return canonicalSha(files)
}
