/**
 * Release fixtures laid out the way a product outside any monorepo lays itself out: a git repo at `<tmp>`, its release
 * config at `<tmp>/<project>-release/release.config.ts`, each package's dir beside the config. Every repo is made
 * under the OS temp dir and removed by `removeRepos`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { gitRun } from "../git.ts"

const made: string[] = []

/** A fresh git repo under the OS temp dir, with a committer configured; `removeRepos` deletes it. */
export async function gitRepo(prefix: string): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), prefix))
	made.push(root)
	await gitRun(["init", "--quiet", "--initial-branch=main", "."], root)
	await gitRun(["config", "user.email", "dev@example.com"], root)
	await gitRun(["config", "user.name", "Dev"], root)
	return root
}

/** Deletes every repo `gitRepo` made since the last call. */
export function removeRepos(): void {
	for (const root of made.splice(0)) rmSync(root, { force: true, recursive: true })
}

/** The release config of `project` in the repo at `root`. */
export const configOf = (root: string, project = "acme") => join(root, `${project}-release`, "release.config.ts")

/** Writes `files` (path relative to `dir`, then content) under `dir`, making each parent dir. */
export function writeAll(dir: string, files: Readonly<Record<string, string>>): void {
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true })
		writeFileSync(join(dir, name), content)
	}
}

/** Writes `config` as the default export of `project`'s release config in `root`, and returns the config's path. */
export function writeConfig(root: string, config: unknown, project = "acme"): string {
	const path = configOf(root, project)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, `export default ${JSON.stringify(config)}\n`)
	return path
}
