import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { getRemoteTip, gitExitCode, gitOutput, gitRun } from "./git.ts"

const workdirs: string[] = []

function tmp(prefix: string): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
	workdirs.push(dir)
	return dir
}

/** A throwaway repo with one commit, so nothing here touches the checkout under test. */
async function sandboxRepo(): Promise<string> {
	const dir = tmp("public-sync-git-")
	await gitRun(["init", "--quiet", "--initial-branch=main", "."], dir)
	await gitRun(["config", "user.email", "test@example.com"], dir)
	await gitRun(["config", "user.name", "Test"], dir)
	writeFileSync(path.join(dir, "README.md"), "# sandbox\n")
	await gitRun(["add", "README.md"], dir)
	await gitRun(["commit", "--quiet", "-m", "initial"], dir)
	return dir
}

afterEach(() => {
	for (const dir of workdirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

describe("a sandbox, under the environment a git hook gives its children", () => {
	/*
	 * git exports GIT_DIR (and GIT_WORK_TREE, GIT_INDEX_FILE) to a hook, and every child process
	 * inherits them. A `cwd` does not override them: with GIT_DIR set, `git init` in a sandbox
	 * re-initialises the enclosing repository and the sandbox's commit lands there. The pre-push
	 * hook runs this suite, so a sandbox that inherits them commits into the repository being
	 * pushed.
	 */
	const leaked = ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"] as const

	afterEach(() => {
		for (const key of leaked) delete process.env[key]
	})

	it("keeps its commits out of the enclosing repository", async () => {
		const enclosing = await sandboxRepo()
		const before = await gitOutput(["rev-list", "--count", "HEAD"], enclosing)

		process.env.GIT_DIR = path.join(enclosing, ".git")
		const sandbox = await sandboxRepo()
		for (const key of leaked) delete process.env[key]

		expect(await gitOutput(["rev-list", "--count", "HEAD"], enclosing)).toBe(before)
		expect(await gitOutput(["log", "--format=%s"], sandbox)).toBe("initial")
	})

	/*
	 * `git config user.email` with no scope writes the repository's own config, so the one GIT_DIR
	 * names. A sandbox that sets an identity for its throwaway commits then renames the author of
	 * every commit made in the enclosing checkout afterwards — which is how eight commits came to be
	 * authored `Test <test@example.com>` before this was found.
	 */
	it("keeps the identity it sets out of the enclosing repository's config", async () => {
		const enclosing = await sandboxRepo()
		await gitRun(["config", "user.email", "owner@example.org"], enclosing)

		process.env.GIT_DIR = path.join(enclosing, ".git")
		process.env.GIT_WORK_TREE = enclosing
		const sandbox = await sandboxRepo()
		for (const key of leaked) delete process.env[key]

		expect(await gitOutput(["config", "--local", "user.email"], enclosing)).toBe("owner@example.org")
		expect(await gitOutput(["config", "--local", "user.email"], sandbox)).toBe("test@example.com")
	})
})

describe("gitOutput", () => {
	it("returns trimmed stdout", async () => {
		const dir = await sandboxRepo()

		expect(await gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], dir)).toBe("main")
	})

	it("runs in the directory it is given, not the process cwd", async () => {
		const dir = await sandboxRepo()

		expect(await gitOutput(["rev-parse", "--show-toplevel"], dir)).toContain(path.basename(dir))
	})

	it("throws with the command and git's own stderr when git fails", async () => {
		const dir = await sandboxRepo()

		await expect(gitOutput(["rev-parse", "no-such-ref"], dir)).rejects.toThrow(
			/git rev-parse no-such-ref failed: .*no-such-ref/s,
		)
	})

	it("throws outside a repository", async () => {
		const dir = tmp("public-sync-git-bare-")

		await expect(gitOutput(["status"], dir)).rejects.toThrow(/failed:/)
	})
})

describe("gitRun", () => {
	it("resolves when the command succeeds", async () => {
		const dir = await sandboxRepo()

		await gitRun(["status", "--porcelain"], dir)

		expect(await gitOutput(["rev-parse", "--abbrev-ref", "HEAD"], dir)).toBe("main")
	})

	it("rejects when the command fails, so a caller cannot continue past a broken step", async () => {
		const dir = await sandboxRepo()

		await expect(gitRun(["checkout", "no-such-branch"], dir)).rejects.toThrow(/failed:/)
	})
})

describe("gitExitCode", () => {
	it("reports 0 for a command that succeeds", async () => {
		const dir = await sandboxRepo()

		expect(await gitExitCode(["rev-parse", "HEAD"], dir)).toBe(0)
	})

	it("reports non-zero instead of throwing, which is why callers use it to probe", async () => {
		const dir = await sandboxRepo()

		expect(await gitExitCode(["rev-parse", "no-such-ref"], dir)).not.toBe(0)
	})
})

describe("getRemoteTip", () => {
	it("returns the sha the mirror branch points at", async () => {
		const source = await sandboxRepo()
		const mirror = tmp("public-sync-mirror-")
		await gitRun(["clone", "--quiet", "--bare", source, mirror], source)
		const expected = await gitOutput(["rev-parse", "HEAD"], source)

		expect(await getRemoteTip(mirror, "main", source)).toBe(expected)
	})

	it("returns undefined when the branch does not exist on the mirror", async () => {
		const source = await sandboxRepo()
		const mirror = tmp("public-sync-mirror-")
		await gitRun(["clone", "--quiet", "--bare", source, mirror], source)

		expect(await getRemoteTip(mirror, "no-such-branch", source)).toBeUndefined()
	})

	it("returns undefined when the mirror itself is unreachable", async () => {
		const source = await sandboxRepo()

		expect(await getRemoteTip(path.join(source, "no-such-remote"), "main", source)).toBeUndefined()
	})
})

describe("gitExitCode of a git that dies", () => {
	it("reports a git killed by a signal as a failure, not a success", async () => {
		const dir = await sandboxRepo()

		/* a shell alias runs as git's child, so $PPID is git itself */
		expect(await gitExitCode(["-c", "alias.die=!kill -KILL $PPID", "die"], dir)).toBe(1)
	})
})
