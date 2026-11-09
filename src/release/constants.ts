/** Characters of a commit sha sync and bootstrap show in their messages. */
export const SHORT_SHA_LENGTH = 8

/** Characters of the spec sha a CHANGELOG entry names (`Generated from openapi@<sha>.`). */
export const SPEC_SHA_LENGTH = 7

/** The committer of every snapshot commit sync writes to a public repo, unless the release config names its own. */
export const DEFAULT_COMMITTER = {
	email: "public-sync[bot]@users.noreply.github.com",
	name: "public-sync[bot]",
} as const

/** The deployed spec is fetched over https: the protocol it must use. */
export const HTTPS_PROTOCOL = "https:"

/** The protocol a deployed spec may use on a loopback host only, for tests. */
export const HTTP_PROTOCOL = "http:"

/** GitHub's REST API, which sync writes each public repo's description, website and topics through. */
export const GITHUB_API = "https://api.github.com"

/** Characters GitHub keeps of a repo description; every registry takes at least as many. */
export const DESCRIPTION_MAX = 350

/** Topics GitHub takes on one repo. */
export const TOPICS_MAX = 20

/** `NodeJS.ErrnoException.code` of a path that does not exist. */
export const ENOENT = "ENOENT"

/** Length of an ISO 8601 calendar date, `YYYY-MM-DD`. */
export const ISO_DATE_LENGTH = 10

/** oasdiff's entry levels: INFO and WARN add to the API, ERR breaks its callers. */
export const OASDIFF_LEVEL = { ERR: 3, INFO: 1, WARN: 2 } as const

/** oasdiff's id for an operation the revision adds. */
export const ENDPOINT_ADDED = "endpoint-added"

/** Room for a child's stdout: oasdiff on a large spec prints megabytes, `git show` a whole spec. */
export const MAX_OUTPUT_BYTES = 256 * 1024 * 1024

/** `git status --porcelain=v1` puts two status letters and a space before each path. */
export const PORCELAIN_PREFIX_LENGTH = 3

/** The record a package's last release keeps: what it was cut from (`release-state.ts`). */
export const RELEASE_STATE = ".release-state.json"

/** The changelog bump prepends each release's entry to. */
export const CHANGELOG_FILE = "CHANGELOG.md"
