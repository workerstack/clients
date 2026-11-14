import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { MANIFEST } from "../gen/write.ts"
import type { SpecSource } from "./types.ts"

/*
 * Generated code must only describe operations prod serves. Sync, bump and release compare the deployed public
 * spec with the committed one before they let changed generated output out.
 */

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const
const FETCH_TIMEOUT_MS = 30_000

export type SpecDrift = {
	readonly status: "drift"
	readonly deployedSha: string
	readonly committedSha: string
	/** `METHOD path` in the committed spec that prod does not serve. */
	readonly missing: readonly string[]
	/** `METHOD path` prod serves that the committed spec lacks. */
	readonly extra: readonly string[]
}

export type SpecGate = { readonly status: "match"; readonly sha: string } | SpecDrift

/** The value with every object's keys sorted, so equal specs serialize equally. */
export function canonicalize(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value
	if (Array.isArray(value)) return value.map(canonicalize)
	const sorted: Record<string, unknown> = {}
	for (const key of Object.keys(value).sort()) {
		sorted[key] = canonicalize((value as Record<string, unknown>)[key])
	}
	return sorted
}

/** sha256 of the spec's canonical JSON. */
export function canonicalSha(spec: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(spec)))
		.digest("hex")
}

function operations(spec: unknown): Set<string> {
	const paths = (spec as { paths?: Record<string, Record<string, unknown>> }).paths ?? {}
	const out = new Set<string>()
	for (const [path, item] of Object.entries(paths)) {
		for (const method of METHODS) if (item[method] !== undefined) out.add(`${method.toUpperCase()} ${path}`)
	}
	return out
}

const minus = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).sort()

/** Fetches the deployed spec and compares it with the committed one; throws naming the URL when prod does not answer. */
export async function checkDeployedSpec(source: SpecSource, fetchImpl: typeof fetch = fetch): Promise<SpecGate> {
	const committed: unknown = JSON.parse(readFileSync(source.committedPath, "utf8"))
	let res: Response
	try {
		res = await fetchImpl(source.deployedUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
	} catch (error) {
		const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : ""
		throw new Error(
			`could not fetch the deployed spec from ${source.deployedUrl}: ${error instanceof Error ? error.message : String(error)}${cause}`,
			{ cause: error },
		)
	}
	if (!res.ok) throw new Error(`the deployed spec at ${source.deployedUrl} answered ${res.status}`)
	const deployed: unknown = await res.json()

	const committedSha = canonicalSha(committed)
	const deployedSha = canonicalSha(deployed)
	if (committedSha === deployedSha) return { sha: committedSha, status: "match" }
	const ours = operations(committed)
	const theirs = operations(deployed)
	return {
		committedSha,
		deployedSha,
		extra: minus(theirs, ours),
		missing: minus(ours, theirs),
		status: "drift",
	}
}

/* each operation on a line of its own, or a line saying there is none */
const list = (ops: readonly string[]) => (ops.length === 0 ? "  (none)" : ops.map((o) => `  ${o}`).join("\n"))

/** Why `packageName` was refused, and what unblocks it. */
export function describeDrift(packageName: string, gate: SpecDrift): string {
	return [
		`${packageName}: its generated output changed, but prod does not serve the committed public spec.`,
		`  committed ${gate.committedSha}`,
		`  deployed  ${gate.deployedSha}`,
		"Operations prod does not serve yet:",
		list(gate.missing),
		"Operations prod serves that the committed spec lacks:",
		list(gate.extra),
		"Deploy the API so it serves the committed spec, then re-run the bump; the next sync picks it up.",
	].join("\n")
}

/** Backend's manifest in `dir`: each generated path, relative to `dir`, with its sha256; undefined when there is none. */
export function generatedFiles(dir: string): Readonly<Record<string, string>> | undefined {
	const file = join(dir, MANIFEST)
	if (!existsSync(file)) return undefined
	const { files } = JSON.parse(readFileSync(file, "utf8")) as { files?: Record<string, string> }
	return files ?? {}
}

/** The paths, relative to `dir`, that clients' manifest in `dir` lists as generated; empty when there is none. */
export function generatedPaths(dir: string): ReadonlySet<string> {
	return new Set(Object.keys(generatedFiles(dir) ?? {}))
}

/** `checkDeployedSpec`, fetched once per deployed URL for the life of the returned function: one run, one answer. */
export function memoizedSpecGate(fetchImpl: typeof fetch = fetch): (source: SpecSource) => Promise<SpecGate> {
	const answers = new Map<string, Promise<SpecGate>>()
	return (source) => {
		const key = `${source.deployedUrl}\0${source.committedPath}`
		let answer = answers.get(key)
		if (answer === undefined) {
			answer = checkDeployedSpec(source, fetchImpl)
			answers.set(key, answer)
		}
		return answer
	}
}
