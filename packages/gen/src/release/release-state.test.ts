import { describe, expect, it } from "vitest"
import { releaseStateSchema } from "./release-state.ts"

const valid = {
	hand: "c".repeat(64),
	output: "d".repeat(64),
	publishedAt: "2026-04-20T12:00:00Z",
	spec: { commit: "1".repeat(40), path: "spec.json", sha: "a".repeat(64) },
	version: "1.0.0",
}

const failingPaths = (input: unknown) => {
	const result = releaseStateSchema().safeParse(input)
	return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."))
}

describe("ReleaseStateSchema", () => {
	it("parses a recorded release", () => {
		expect(releaseStateSchema().parse(valid)).toEqual(valid)
	})

	it.each([
		["version", { ...valid, version: "not-semver" }],
		["publishedAt", { ...valid, publishedAt: "2026-04-20" }],
		["output", { ...valid, output: "d".repeat(63) }],
		["hand", { ...valid, hand: "X".repeat(64) }],
		["spec.commit", { ...valid, spec: { ...valid.spec, commit: "abc1234" } }],
		["spec.path", { ...valid, spec: { ...valid.spec, path: "" } }],
		["spec.sha", { ...valid, spec: { ...valid.spec, sha: "fc10f36" } }],
	])("rejects a bad %s", (path, input) => {
		expect(failingPaths(input)).toContain(path)
	})

	it("rejects the per-operation state it replaced", () => {
		expect(
			failingPaths({
				openapiSha: "abc1234",
				operations: {},
				publishedAt: valid.publishedAt,
				version: "1.0.0",
			}),
		).toEqual(expect.arrayContaining(["hand", "output", "spec"]))
	})
})
