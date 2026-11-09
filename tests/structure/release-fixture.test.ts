/**
 * The release fixture's recorded state matches its committed package: release-fixture.yml's bump job on main finds no
 * change only while every package's `.release-state.json` holds the hand digest of the files beside it. A file edited
 * there without the local bump the fixture's README asks for would otherwise open a real release PR.
 */
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../../src/gen/__fixtures__/spawn-timeout.ts"
import { handDigest } from "../../src/release/digest.ts"
import { loadRelease } from "../../src/release/load.ts"
import { releaseStateSchema } from "../../src/release/release-state.ts"

const CONFIG = resolve(import.meta.dirname, "../../.github/release-fixture/release.config.ts")

describe("the release fixture", () => {
	it("records the hand digest of each package as committed", { timeout: SPAWN_TIMEOUT }, async () => {
		const release = await loadRelease(CONFIG)
		expect(release.packages.length).toBeGreaterThan(0)
		for (const pkg of release.packages) {
			const state = releaseStateSchema().parse(
				JSON.parse(readFileSync(join(release.root, pkg.path, ".release-state.json"), "utf8")),
			)
			expect({ [pkg.path]: state.hand }).toEqual({ [pkg.path]: handDigest(release.root, pkg) })
		}
	})
})
