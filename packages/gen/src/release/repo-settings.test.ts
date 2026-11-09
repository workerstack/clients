import { describe, expect, it } from "vitest"

import { repoSettingsSyncer, type Fetch } from "./repo-settings.ts"
import { DEFAULT_COMMITTER } from "./constants.ts"
import type { PublicPackage } from "./types.ts"

const PKG: PublicPackage = {
	branch: "main",
	codegen: ["true"],
	commitMessage: "c",
	committer: DEFAULT_COMMITTER,
	description: "Official Go SDK for Acme (example.com).",
	homepage: "https://example.com",
	mirror: "git@github.com:acme/sdk-go.git",
	name: "sdk-go",
	path: "acme-release/sdk-go",
	project: "acme",
	registries: [],
	repo: "acme/sdk-go",
	spec: { committedPath: "/spec.json", deployedUrl: "https://api.example.com/spec.json" },
	topics: ["acme", "go", "sdk"],
}

type Sent = { body: unknown; method: string; url: string }

/** A GitHub that holds one repo's settings, applies the writes it is sent, and records every request. */
function github(current: { description: string | null; homepage: string | null; topics: string[] }, status = 200) {
	const sent: Sent[] = []
	const fetch: Fetch = async (url, init) => {
		const method = init.method ?? "GET"
		const body: unknown = init.body === undefined ? undefined : JSON.parse(String(init.body))
		sent.push({ body, method, url })
		if (status !== 200) return Response.json({ message: "Resource not accessible by integration" }, { status })
		if (url.endsWith("/topics")) {
			if (method === "PUT") current.topics = (body as { names: string[] }).names
			return Response.json({ names: current.topics })
		}
		if (method === "PATCH") Object.assign(current, body)
		return Response.json({ description: current.description, homepage: current.homepage })
	}
	return { current, fetch, sent }
}

const writes = (sent: Sent[]) => sent.filter((request) => request.method !== "GET")

describe("repoSettingsSyncer writes only what drifted", () => {
	it("sends no write when the repo already matches, topics in any order", async () => {
		const gh = github({
			description: PKG.description,
			homepage: PKG.homepage,
			topics: ["sdk", "acme", "go"],
		})
		const sync = repoSettingsSyncer({ dryRun: false, fetch: gh.fetch, token: "tok" })

		expect(await sync(PKG)).toEqual({ changed: [], status: "checked" })
		expect(writes(gh.sent)).toEqual([])
	})

	it("writes a drifted description and homepage in one request and leaves matching topics alone", async () => {
		const gh = github({
			description: null,
			homepage: "https://old.example.com",
			topics: ["acme", "go", "sdk"],
		})
		const sync = repoSettingsSyncer({ dryRun: false, fetch: gh.fetch, token: "tok" })

		expect(await sync(PKG)).toEqual({ changed: ["description", "homepage"], status: "checked" })
		expect(writes(gh.sent)).toEqual([
			{
				body: { description: PKG.description, homepage: PKG.homepage },
				method: "PATCH",
				url: "https://api.github.com/repos/acme/sdk-go",
			},
		])
		expect(gh.current).toMatchObject({ description: PKG.description, homepage: PKG.homepage })
	})

	it("replaces a differing topic set whole", async () => {
		const gh = github({
			description: PKG.description,
			homepage: PKG.homepage,
			topics: ["acme", "stale"],
		})
		const sync = repoSettingsSyncer({ dryRun: false, fetch: gh.fetch, token: "tok" })

		expect(await sync(PKG)).toEqual({ changed: ["topics"], status: "checked" })
		expect(writes(gh.sent)).toEqual([
			{
				body: { names: ["acme", "go", "sdk"] },
				method: "PUT",
				url: "https://api.github.com/repos/acme/sdk-go/topics",
			},
		])
	})
})

describe("repoSettingsSyncer reruns, dry runs and auth", () => {
	it("converges: a second run after a write sends nothing", async () => {
		const gh = github({ description: null, homepage: null, topics: [] })
		const sync = repoSettingsSyncer({ dryRun: false, fetch: gh.fetch, token: "tok" })

		await sync(PKG)
		gh.sent.length = 0
		expect(await sync(PKG)).toEqual({ changed: [], status: "checked" })
		expect(writes(gh.sent)).toEqual([])
	})

	it("on a dry run reports what it would change and writes nothing", async () => {
		const gh = github({ description: null, homepage: null, topics: [] })
		const sync = repoSettingsSyncer({ dryRun: true, fetch: gh.fetch, token: "tok" })

		expect(await sync(PKG)).toEqual({
			changed: ["description", "homepage", "topics"],
			status: "checked",
		})
		expect(writes(gh.sent)).toEqual([])
	})

	it("sends every request with the token", async () => {
		const gh = github({ description: null, homepage: null, topics: [] })
		const seen: Array<string | null> = []
		const fetch: Fetch = async (url, init) => {
			seen.push(new Headers(init.headers).get("authorization"))
			return gh.fetch(url, init)
		}
		await repoSettingsSyncer({ dryRun: false, fetch, token: "tok" })(PKG)

		expect(seen.length).toBeGreaterThan(0)
		expect(new Set(seen)).toEqual(new Set(["Bearer tok"]))
	})
})

describe("repoSettingsSyncer refused or unauthenticated", () => {
	it("throws naming the repo, the status and GitHub's message when GitHub refuses", async () => {
		const gh = github({ description: null, homepage: null, topics: [] }, 403)
		const sync = repoSettingsSyncer({ dryRun: false, fetch: gh.fetch, token: "tok" })

		await expect(sync(PKG)).rejects.toThrow(/acme\/sdk-go[\s\S]*403[\s\S]*Resource not accessible by integration/)
	})

	it("without a token checks nothing and says so", async () => {
		const gh = github({ description: null, homepage: null, topics: [] })
		const sync = repoSettingsSyncer({ dryRun: true, fetch: gh.fetch, token: "" })

		expect(await sync(PKG)).toEqual({ status: "unchecked: no token" })
		expect(gh.sent).toEqual([])
	})
})

describe("repoSettingsSyncer on an error GitHub does not explain", () => {
	it("names the body GitHub answered when it carries no message", async () => {
		const fetch: Fetch = async () => Response.json({ errors: ["nope"] }, { status: 502 })
		const sync = repoSettingsSyncer({ dryRun: false, fetch, token: "t" })
		await expect(sync(PKG)).rejects.toThrow('acme/sdk-go: GitHub answered GET / with 502: {"errors":["nope"]}')
	})
})
