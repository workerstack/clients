import * as z from "zod"
import { GITHUB_API } from "./constants.ts"
import type { PublicPackage } from "./types.ts"

/* What a public repo shows on GitHub, kept equal to its package in release.config.ts. */
export type RepoSetting = "description" | "homepage" | "topics"

export type RepoSettingsResult = { changed: RepoSetting[]; status: "checked" } | { status: "unchecked: no token" }

export type RepoSettingsSync = (pkg: PublicPackage) => Promise<RepoSettingsResult>

/** The one fetch shape the step uses, so a test's fake GitHub needs no more than this. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n")

/**
 * Reads a public repo's description, website and topics, and writes back only what differs from its package:
 * a rerun after a crash or a hand edit converges, and one with nothing to change sends no write.
 * A dry run reports what it would change. With no token it checks nothing, since GitHub answers its
 * unauthenticated reads under a rate limit too low for every repo of a run.
 */
export function repoSettingsSyncer(io: { dryRun: boolean; fetch: Fetch; token: string }): RepoSettingsSync {
	const Repo = z.object({ description: z.string().nullable(), homepage: z.string().nullable() })
	const Topics = z.object({ names: z.array(z.string()) })
	const GitHubError = z.object({ message: z.string() })
	return async (pkg) => {
		if (io.token === "") return { status: "unchecked: no token" }

		const call = async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
			const response = await io.fetch(`${GITHUB_API}/repos/${pkg.repo}${path}`, {
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				headers: {
					accept: "application/vnd.github+json",
					authorization: `Bearer ${io.token}`,
				},
				method,
			})
			const json: unknown = await response.json()
			if (!response.ok) {
				const parsed = GitHubError.safeParse(json)
				throw new Error(
					`${pkg.repo}: GitHub answered ${method} ${path || "/"} with ${response.status}: ${parsed.success ? parsed.data.message : JSON.stringify(json)}`,
				)
			}
			return json
		}

		const [repo, topics] = await Promise.all([
			call("").then((json) => Repo.parse(json)),
			call("/topics").then((json) => Topics.parse(json)),
		])

		const changed: RepoSetting[] = []
		if (repo.description !== pkg.description) changed.push("description")
		if (repo.homepage !== pkg.homepage) changed.push("homepage")
		const topicsDrifted = !sameSet(topics.names, pkg.topics)
		if (topicsDrifted) changed.push("topics")

		if (io.dryRun) return { changed, status: "checked" }
		if (changed.includes("description") || changed.includes("homepage"))
			await call("", "PATCH", { description: pkg.description, homepage: pkg.homepage })
		if (topicsDrifted) await call("/topics", "PUT", { names: [...pkg.topics].sort() })
		return { changed, status: "checked" }
	}
}
