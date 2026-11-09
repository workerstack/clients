import * as z from "zod"

const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const HEX64 = /^[a-f0-9]{64}$/

/** The schema of `.release-state.json`: what a package's last release was cut from. */
export function releaseStateSchema() {
	return z.object({
		/** sha256 over the package's tracked hand files at release, version lines normalized (`digest.ts`) */
		hand: z.string().regex(HEX64),
		/** sha256 over the package's generated output at release, or its product's spec sha for a hand-kept package */
		output: z.string().regex(HEX64),
		publishedAt: z.string().regex(ISO_DATETIME_REGEX),
		/** the committed spec the release was generated from, readable again with `git show {commit}:{path}` */
		spec: z.object({
			commit: z.string().regex(/^[a-f0-9]{40}$/),
			path: z.string().min(1),
			sha: z.string().regex(HEX64),
		}),
		version: z.string().regex(SEMVER_REGEX),
	})
}

/** Parsed and validated release state. */
export type ReleaseState = z.infer<ReturnType<typeof releaseStateSchema>>
