import { spawnSync } from "node:child_process"
import * as z from "zod"
import { MAX_OUTPUT_BYTES, OASDIFF_LEVEL } from "./constants.ts"

/** The oasdiff module `go run` builds and caches: the breaking-change rules a bump's level comes from. */
export const OASDIFF = "github.com/oasdiff/oasdiff@v1.35.0"

/** One oasdiff changelog entry: level 1 INFO, 2 WARN, 3 ERR (breaking). */
function apiChangeSchema() {
	return z.object({
		id: z.string(),
		level: z.union([z.literal(OASDIFF_LEVEL.INFO), z.literal(OASDIFF_LEVEL.WARN), z.literal(OASDIFF_LEVEL.ERR)]),
		operation: z.string().optional(),
		operationId: z.string().optional(),
		path: z.string().optional(),
		text: z.string(),
	})
}

/** One change oasdiff reports between two specs. */
export type ApiChange = z.infer<ReturnType<typeof apiChangeSchema>>

/* the Go on the caller's PATH, in its environment: a test hands in go-env's, whose GOTOOLCHAIN pins it */
const GO_BINARY = "go"

/**
 * Every change oasdiff finds from `baseFile` to `revisionFile`, run through `go run` in `env` (the Go on its PATH, its
 * GOTOOLCHAIN honored); throws with oasdiff's stderr when it fails, and says so when Go cannot start.
 */
export function apiChanges(
	baseFile: string,
	revisionFile: string,
	env: NodeJS.ProcessEnv = process.env,
): readonly ApiChange[] {
	const result = spawnSync(GO_BINARY, ["run", OASDIFF, "changelog", baseFile, revisionFile, "--format", "json"], {
		encoding: "utf8",
		env,
		maxBuffer: MAX_OUTPUT_BYTES,
	})
	if (result.error) throw new Error(`oasdiff could not start (it runs through Go on PATH): ${result.error.message}`)
	if (result.status !== 0) {
		throw new Error(`oasdiff failed (${result.status}): ${result.stderr.trim()}`)
	}
	/* `[]` when the specs do not differ */
	return z.array(apiChangeSchema()).parse(JSON.parse(result.stdout))
}
