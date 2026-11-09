import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { goEnv } from "../emit/go/__fixtures__/go-env.ts"
import { apiChanges } from "./oasdiff.ts"
import { SPAWN_TIMEOUT } from "../gen/__fixtures__/spawn-timeout.ts"

/* Real oasdiff through `go run`: the first call compiles it, so the timeout is generous. */
const TIMEOUT_MS = 180_000
const dir = mkdtempSync(path.join(os.tmpdir(), "oasdiff-test-"))
afterAll(() => rmSync(dir, { force: true, recursive: true }))

const operation = (id: string) => ({
	operationId: id,
	responses: { "200": { description: "ok" } },
})

function spec(name: string, paths: Record<string, Record<string, unknown>>): string {
	const file = path.join(dir, `${name}.json`)
	writeFileSync(file, JSON.stringify({ info: { title: "t", version: "1" }, openapi: "3.1.0", paths }))
	return file
}

const base = spec("base", { "/v1/widgets": { get: operation("widget.list") } })

describe("apiChanges", () => {
	it(
		"reports an added operation as endpoint-added, with nothing breaking",
		() => {
			const revision = spec("added", {
				"/v1/widgets": { get: operation("widget.list"), post: operation("widget.create") },
			})
			const changes = apiChanges(base, revision, goEnv())
			expect(changes).toContainEqual(
				expect.objectContaining({ id: "endpoint-added", operation: "POST", path: "/v1/widgets" }),
			)
			expect(changes.some((change) => change.level === 3)).toBe(false)
		},
		TIMEOUT_MS,
	)

	it(
		"reports a removed operation at ERR",
		() => {
			const changes = apiChanges(base, spec("removed", { "/v1/other": { get: operation("other.get") } }), goEnv())
			expect(changes).toContainEqual(expect.objectContaining({ level: 3, operation: "GET", path: "/v1/widgets" }))
		},
		TIMEOUT_MS,
	)

	it(
		"throws with oasdiff's error when a spec cannot be read",
		() => {
			expect(() => apiChanges(path.join(dir, "missing.json"), base, goEnv())).toThrow(/oasdiff[\s\S]*missing\.json/)
		},
		TIMEOUT_MS,
	)

	it(
		"reports nothing between a spec and itself",
		() => {
			expect(apiChanges(base, base, goEnv())).toEqual([])
		},
		TIMEOUT_MS,
	)

	it("says Go could not start when there is none on PATH", { timeout: SPAWN_TIMEOUT }, () => {
		expect(() => apiChanges(base, base, { PATH: "" })).toThrow(/oasdiff could not start \(it runs through Go on PATH\)/)
	})
})
