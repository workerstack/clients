import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { canonicalSha, checkDeployedSpec, describeDrift, generatedPaths, memoizedSpecGate } from "./spec-gate.ts"

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

function tempDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "spec-gate-"))
	dirs.push(dir)
	return dir
}

const op = (operationId: string) => ({ operationId, responses: { "200": { description: "ok" } } })
const COMMITTED = {
	info: { title: "API", version: "1.0.0" },
	openapi: "3.1.0",
	paths: { "/v1/a": { get: op("getA") }, "/v1/x": { get: op("getX") } },
}
/* prod lacks GET /v1/x and serves POST /v1/y */
const DRIFTED = {
	info: { title: "API", version: "1.0.0" },
	openapi: "3.1.0",
	paths: { "/v1/a": { get: op("getA") }, "/v1/y": { post: op("postY") } },
}

let served: unknown = COMMITTED
let status = 200
let server: Server
let port = 0
beforeAll(async () => {
	server = createServer((_req, res) => {
		res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(served))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	port = (server.address() as AddressInfo).port
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

function source(spec: unknown = COMMITTED) {
	const dir = tempDir()
	const committedPath = path.join(dir, "spec.json")
	writeFileSync(committedPath, JSON.stringify(spec))
	return { committedPath, deployedUrl: `http://127.0.0.1:${port}/openapi/spec.json` }
}

describe("canonicalSha", () => {
	it("ignores key order and changes with content", () => {
		/* parsed, so the shuffled key order survives the formatter */
		expect(canonicalSha({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalSha(JSON.parse('{"b":{"d":3,"c":2},"a":1}')))
		expect(canonicalSha({ a: 1 })).not.toBe(canonicalSha({ a: 2 }))
	})
})

describe("checkDeployedSpec", () => {
	it("matches when prod serves the committed spec, keys in any order", async () => {
		served = JSON.parse(
			`{"paths":${JSON.stringify(COMMITTED.paths)},"openapi":"3.1.0","info":{"version":"1.0.0","title":"API"}}`,
		)
		status = 200
		expect(await checkDeployedSpec(source())).toEqual({
			sha: canonicalSha(COMMITTED),
			status: "match",
		})
	})

	it("reports drift with both hashes and the missing and extra operations", async () => {
		served = DRIFTED
		status = 200
		expect(await checkDeployedSpec(source())).toEqual({
			committedSha: canonicalSha(COMMITTED),
			deployedSha: canonicalSha(DRIFTED),
			extra: ["POST /v1/y"],
			missing: ["GET /v1/x"],
			status: "drift",
		})
	})

	it("throws naming the URL on a non-200", async () => {
		served = { error: "not_found" }
		status = 404
		const src = source()
		await expect(checkDeployedSpec(src)).rejects.toThrow(`${src.deployedUrl} answered 404`)
	})

	it("throws naming the URL when prod cannot be reached", async () => {
		const src = { ...source(), deployedUrl: "http://127.0.0.1:1/openapi/spec.json" }
		await expect(checkDeployedSpec(src)).rejects.toThrow(
			"could not fetch the deployed spec from http://127.0.0.1:1/openapi/spec.json",
		)
	})
})

describe("memoizedSpecGate", () => {
	it("fetches each deployed spec once per run", async () => {
		served = COMMITTED
		status = 200
		let fetches = 0
		const counting = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			fetches++
			return fetch(input, init)
		}) as typeof fetch
		const gate = memoizedSpecGate(counting)
		const src = source()
		const [a, b] = await Promise.all([gate(src), gate(src)])
		expect(a.status).toBe("match")
		expect(b).toBe(a)
		expect(fetches).toBe(1)
	})
})

describe("describeDrift", () => {
	it("names the package, both hashes, each operation, and what to do", () => {
		const text = describeDrift("acme/sdk-go", {
			committedSha: "c".repeat(64),
			deployedSha: "d".repeat(64),
			extra: ["POST /v1/y"],
			missing: ["GET /v1/x"],
			status: "drift",
		})
		expect(text).toContain("acme/sdk-go")
		expect(text).toContain(`committed ${"c".repeat(64)}`)
		expect(text).toContain(`deployed  ${"d".repeat(64)}`)
		expect(text).toContain("GET /v1/x")
		expect(text).toContain("POST /v1/y")
		expect(text).toMatch(/deploy the API so it serves the committed spec/i)
		expect(text).toMatch(/re-run the bump/)
	})
})

describe("generatedPaths", () => {
	it("lists the paths a dir's .honey-generated.json records", () => {
		const dir = tempDir()
		mkdirSync(path.join(dir, "src"))
		writeFileSync(
			path.join(dir, ".honey-generated.json"),
			JSON.stringify({ files: { "client.go": "a".repeat(64), "src/types.go": "b".repeat(64) } }),
		)
		expect([...generatedPaths(dir)].sort()).toEqual(["client.go", "src/types.go"])
	})

	it("is empty without a manifest", () => {
		expect(generatedPaths(tempDir()).size).toBe(0)
	})
})

describe("canonicalSha of arrays and pathless specs", () => {
	it("keeps array order, sorting the keys of the objects inside", () => {
		expect(canonicalSha({ tags: [{ b: 1, a: 2 }, "x"] })).toBe(canonicalSha({ tags: [{ a: 2, b: 1 }, "x"] }))
		expect(canonicalSha({ tags: ["x", "y"] })).not.toBe(canonicalSha({ tags: ["y", "x"] }))
	})
})

describe("checkDeployedSpec on odd answers", () => {
	it("reports drift against a deployed spec with no paths, listing every committed operation missing", async () => {
		const src = source()
		const gate = await checkDeployedSpec(src, async () => Response.json({ openapi: "3.1.0" }))
		expect(gate).toMatchObject({ extra: [], status: "drift" })
		expect(gate.status === "drift" ? gate.missing.length : 0).toBeGreaterThan(0)
	})

	it("names a fetch failure that has no cause, and one that is no Error", async () => {
		const src = source()
		await expect(checkDeployedSpec(src, () => Promise.reject(new Error("aborted")))).rejects.toThrow(
			`could not fetch the deployed spec from ${src.deployedUrl}: aborted`,
		)
		await expect(checkDeployedSpec(src, () => Promise.reject("refused"))).rejects.toThrow(
			`could not fetch the deployed spec from ${src.deployedUrl}: refused`,
		)
	})
})

describe("generatedPaths of a manifest that lists no files", () => {
	it("is empty", () => {
		const dir = tempDir()
		writeFileSync(path.join(dir, ".honey-generated.json"), "{}")
		expect(generatedPaths(dir).size).toBe(0)
	})
})
