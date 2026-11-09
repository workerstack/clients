import { describe, expect, it } from "vitest"
import { type DecideInput, decide, type Observed } from "./bump.ts"
import type { ApiChange } from "./oasdiff.ts"
import type { ReleaseState } from "./release-state.ts"

const NOW = new Date("2026-11-03T12:00:00.000Z")
const SPEC_A = { commit: "1".repeat(40), path: "spec.json", sha: "a".repeat(64) }
const SPEC_B = { commit: "2".repeat(40), path: "spec.json", sha: "b".repeat(64) }

const PREVIOUS: ReleaseState = {
	hand: "c".repeat(64),
	output: "d".repeat(64),
	publishedAt: "2026-04-20T12:00:00.000Z",
	spec: SPEC_A,
	version: "1.2.3",
}

const SAME: Observed = { hand: PREVIOUS.hand, output: PREVIOUS.output, spec: SPEC_A }

const change = (overrides: Partial<ApiChange>): ApiChange => ({
	id: "response-optional-property-added",
	level: 1,
	operation: "GET",
	operationId: "widget.list",
	path: "/v1/widgets",
	text: "a property was added",
	...overrides,
})

const never = (): readonly ApiChange[] => {
	throw new Error("changes() must not be called")
}

const run = (observed: Observed, changes: DecideInput["changes"] = never, previous = PREVIOUS, major = false) =>
	decide({ changes, initialMessage: "first cut", major, now: NOW, observed, previous })

describe("decide on a first release or a patch", () => {
	it("releases 1.0.0 with the initial message when nothing was released", () => {
		const decision = decide({
			changes: never,
			initialMessage: "first cut",
			now: NOW,
			observed: SAME,
		})
		expect(decision).toMatchObject({ kind: "initial", nextVersion: "1.0.0" })
		expect(decision.kind !== "none" && decision.entry).toContain("## 1.0.0 — 2026-11-03")
		expect(decision.kind !== "none" && decision.entry).toContain("first cut")
	})

	it("releases nothing when output and hand files match, even though the spec moved", () => {
		expect(run({ ...SAME, spec: SPEC_B })).toEqual({ kind: "none" })
	})

	it("patches an output change on the same spec, without diffing the API", () => {
		const decision = run({ ...SAME, output: "e".repeat(64) })
		expect(decision).toMatchObject({ kind: "patch", nextVersion: "1.2.4" })
		expect(decision.kind !== "none" && decision.entry).toContain("### Generated code")
	})

	it("patches a hand-file change and says the package changed", () => {
		const decision = run({ ...SAME, hand: "e".repeat(64), spec: SPEC_B })
		expect(decision).toMatchObject({ kind: "patch", nextVersion: "1.2.4" })
		expect(decision.kind !== "none" && decision.entry).toContain("### Package")
	})

	it("patches an output change whose spec moved without an API change", () => {
		expect(run({ ...SAME, output: "e".repeat(64), spec: SPEC_B }, () => [])).toMatchObject({
			kind: "patch",
		})
	})
})

describe("decide on an API change", () => {
	it("makes INFO and WARN entries a minor and lists the operations", () => {
		const decision = run({ ...SAME, output: "e".repeat(64), spec: SPEC_B }, () => [
			change({}),
			change({ id: "endpoint-added", operation: "POST", operationId: "widget.create" }),
			change({
				level: 2,
				operation: "DELETE",
				operationId: "widget.delete",
				path: "/v1/widgets/{id}",
			}),
		])
		expect(decision).toMatchObject({ kind: "minor", nextVersion: "1.3.0" })
		const entry = decision.kind === "none" ? "" : decision.entry
		expect(entry).toMatch(/### Added\n- `POST \/v1\/widgets` \(widget\.create\)/)
		expect(entry).toMatch(
			/### Changed\n- `DELETE \/v1\/widgets\/\{id\}` \(widget\.delete\)\n- `GET \/v1\/widgets` \(widget\.list\)/,
		)
		expect(entry).not.toContain("### Breaking")
		expect(entry).not.toContain("### Generated code")
	})

	it("makes any ERR entry a minor and lists the operation as breaking, once", () => {
		const decision = run({ ...SAME, output: "e".repeat(64), spec: SPEC_B }, () => [
			change({ level: 3 }),
			change({ level: 3, text: "another" }),
			change({ level: 1, operation: undefined, operationId: undefined, path: undefined }),
		])
		expect(decision).toMatchObject({ kind: "minor", nextVersion: "1.3.0" })
		const entry = decision.kind === "none" ? "" : decision.entry
		expect(entry.match(/`GET \/v1\/widgets`/g)).toHaveLength(1)
		expect(entry).toMatch(/### Breaking\n- `GET \/v1\/widgets` \(widget\.list\)/)
		expect(entry).toContain(`Generated from openapi@${"b".repeat(7)}.`)
	})
})

describe("decide under --major", () => {
	it("makes a major only when asked, for any change", () => {
		const decision = run({ ...SAME, output: "e".repeat(64) }, never, PREVIOUS, true)
		expect(decision).toMatchObject({ kind: "major", nextVersion: "2.0.0" })
		expect(decision.kind !== "none" && decision.entry).toContain("## 2.0.0 — 2026-11-03")
	})

	it("releases nothing when asked for a major with nothing changed", () => {
		expect(run(SAME, never, PREVIOUS, true)).toEqual({ kind: "none" })
	})

	it("keeps a first release at 1.0.0 when asked for a major", () => {
		const decision = decide({
			changes: never,
			initialMessage: "first cut",
			major: true,
			now: NOW,
			observed: SAME,
		})
		expect(decision).toMatchObject({ kind: "initial", nextVersion: "1.0.0" })
	})
})

describe("decide on a change oasdiff names no operationId for", () => {
	it("lists the operation by method and path alone", () => {
		const decision = run({ ...SAME, output: "e".repeat(64), spec: SPEC_B }, () => [change({ operationId: undefined })])
		expect(decision.kind === "none" ? "" : decision.entry).toMatch(/### Changed\n- `GET \/v1\/widgets`\n/)
	})

	it("diffs from the released spec", () => {
		const seen: unknown[] = []
		run({ ...SAME, output: "e".repeat(64), spec: SPEC_B }, (released) => {
			seen.push(released)
			return []
		})
		expect(seen).toEqual([SPEC_A])
	})
})
