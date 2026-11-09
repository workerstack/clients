import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { SPAWN_TIMEOUT } from "../gen/__fixtures__/spawn-timeout.ts"
import { writeAll } from "./__fixtures__/release-repo.ts"
import { DEFAULT_COMMITTER, RELEASE_STATE } from "./constants.ts"
import { RELEASE_WORKFLOW } from "./release-workflow.ts"
import { buildCommitMessage, pendingTag, readSidecar, replaceTreeWithSource } from "./sync-tree.ts"
import type { PublicPackage } from "./types.ts"

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "sync-tree-"))
	dirs.push(dir)
	return dir
}

const ENTRY: PublicPackage = {
	branch: "main",
	codegen: ["true"],
	commitMessage: "c",
	committer: DEFAULT_COMMITTER,
	description: "d",
	homepage: "https://example.com",
	mirror: "git@github.com:acme/sdk.git",
	name: "sdk",
	path: "acme-release/sdk",
	project: "acme",
	registries: [],
	repo: "acme/sdk",
	spec: { committedPath: "/spec.json", deployedUrl: "https://api.example.com/spec.json" },
	topics: ["acme"],
}

describe("replaceTreeWithSource", () => {
	it(
		"fails with rsync's exit code and its own words when the source is not there",
		async () => {
			const args = { excludes: [], repoRoot: tmp(), sourcePath: "missing", worktree: tmp() }

			await expect(replaceTreeWithSource(args)).rejects.toThrow(/^rsync exit \d+: .*missing/)
		},
		SPAWN_TIMEOUT,
	)
})

describe("pendingTag", () => {
	it.each([
		["records no version", "{}\n"],
		["records an empty one", '{"version":""}\n'],
	])("throws naming the state of a self-publishing package that %s", async (_case, state) => {
		const [repoRoot, worktree] = [tmp(), tmp()]
		writeAll(worktree, { [RELEASE_WORKFLOW]: "on: push\n" })
		writeAll(repoRoot, { [join(ENTRY.path, RELEASE_STATE)]: state })

		await expect(pendingTag(ENTRY, repoRoot, worktree, "https://example.invalid/acme/sdk.git")).rejects.toThrow(
			`${join(ENTRY.path, RELEASE_STATE)} records no version`,
		)
	})
})

describe("readSidecar", () => {
	it("takes a sidecar holding only whitespace as no message", () => {
		const root = tmp()
		writeAll(root, { [join(ENTRY.path, ".publicsync-message")]: "  \n" })

		expect(readSidecar(root, ENTRY.path)).toBeUndefined()
	})
})

describe("buildCommitMessage", () => {
	it("stamps the default initial message when the run names none", () => {
		const message = buildCommitMessage({
			initialMessage: undefined,
			isInitial: true,
			sidecarMessage: undefined,
			templateMessage: "chore: sync",
		})

		expect(message).toMatch(/^chore: initial release \[\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\]$/)
	})
})
