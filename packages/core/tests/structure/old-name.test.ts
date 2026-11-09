import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../fixture/spawn-timeout.ts"

const REPO = resolve(import.meta.dirname, "../../../..")
const SELF = "packages/core/tests/structure/old-name.test.ts"

/* honey moved to the workerstack org in 1.0.0-rc.23: @lovrozagar/honey is @workerstack/backend, @lovrozagar/honey-clients
 * is @workerstack/clients, and the repo is github.com/workerstack/backend. The old name stays only where history is
 * recorded: the changelog, the migration notes (migration.md's before blocks are the code a v0 or rc user wrote; its
 * after blocks are compiled, so an old name there fails the docs tests), the blueprint and the lessons' evidence. */
const OLD = /lovrozagar(?:\\?\/|-)honey|lovrozagar%2fhoney/i /* \/ too: a regex literal escapes the slash */
const HISTORY = ["CHANGELOG.md", "docs/migrating-to-workerstack.md", "docs/migration.md"]
const HISTORY_TREES = ["blueprint/", ".rulesync/lessons/"]

/** Whether `file` records history, where the old name stays. */
function historical(file: string): boolean {
	return HISTORY.includes(file) || HISTORY_TREES.some((tree) => file.startsWith(tree))
}

/** Every file git tracks or would add, but this guard, which spells what it refuses. */
function tracked(): string[] {
	const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		cwd: REPO,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	})
	return out.split("\0").filter((file) => file !== "" && file !== SELF)
}

/** Each place `file` names the old package or repo, as `<file>:<line> names …`. */
function named(file: string): string[] {
	const path = join(REPO, file)
	if (!existsSync(path)) return []
	const bytes = readFileSync(path)
	if (bytes.includes(0)) return []
	return bytes
		.toString("utf8")
		.split("\n")
		.flatMap((line, i) =>
			OLD.test(line)
				? [
						`${file}:${i + 1} names lovrozagar/honey: it is @workerstack/backend (or @workerstack/clients, github.com/workerstack/backend) since 1.0.0-rc.23`,
					]
				: [],
		)
}

describe("honey ships under the workerstack names (1.0.0-rc.23)", () => {
	it("no file outside the history names @lovrozagar/honey or its repo", { timeout: SPAWN_TIMEOUT }, () => {
		expect(
			tracked()
				.filter((file) => !historical(file))
				.flatMap(named),
		).toEqual([])
	})

	it("every history exemption is a file or tree that exists", () => {
		expect(HISTORY.filter((file) => !existsSync(join(REPO, file)))).toEqual([])
		expect(HISTORY_TREES.filter((tree) => !existsSync(join(REPO, tree)))).toEqual([])
	})
})
