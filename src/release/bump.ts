import type { ApiChange } from "./oasdiff.ts"
import type { ReleaseState } from "./release-state.ts"
import { ENDPOINT_ADDED, ISO_DATE_LENGTH, OASDIFF_LEVEL, SPEC_SHA_LENGTH } from "./constants.ts"

/** What a package is cut from now: the digests `digest.ts` takes and the committed spec. */
export type Observed = { hand: string; output: string; spec: ReleaseState["spec"] }

export type ReleaseKind = "initial" | "major" | "minor" | "patch"

export type Decision = { kind: "none" } | { entry: string; kind: ReleaseKind; nextVersion: string }

export interface DecideInput {
	/** oasdiff from the released spec to the observed one; called only when the output changed and the spec moved */
	changes: (released: ReleaseState["spec"]) => readonly ApiChange[]
	/** the first release's CHANGELOG text */
	initialMessage: string
	/** the operator's call: a package that releases (after its first) takes a major, whatever changed */
	major?: boolean
	now: Date
	observed: Observed
	previous?: ReleaseState
}

function nextVersion(version: string, kind: Exclude<ReleaseKind, "initial">): string {
	const [major = 0, minor = 0, patch = 0] = version.split(/[.-]/).map(Number)
	if (kind === "major") return `${major + 1}.0.0`
	if (kind === "minor") return `${major}.${minor + 1}.0`
	return `${major}.${minor}.${patch + 1}`
}

/* Every package stays on its major line: any API change, breaking or not, is a minor; a major is only ever asked for. */
function levelOf(changes: readonly ApiChange[]): Exclude<ReleaseKind, "initial"> {
	return changes.length > 0 ? "minor" : "patch"
}

/* Each operation once, under the first section it belongs to: breaking, then added, then changed. */
function sections(changes: readonly ApiChange[]): string[] {
	const byOperation = new Map<string, { label: string; added: boolean; breaking: boolean }>()
	for (const change of changes) {
		if (change.operation === undefined || change.path === undefined) continue
		const key = `${change.operation} ${change.path}`
		const id = change.operationId === undefined ? "" : ` (${change.operationId})`
		const seen = byOperation.get(key) ?? {
			added: false,
			breaking: false,
			label: `- \`${key}\`${id}`,
		}
		seen.added ||= change.id === ENDPOINT_ADDED
		seen.breaking ||= change.level === OASDIFF_LEVEL.ERR
		byOperation.set(key, seen)
	}
	const all = [...byOperation.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, op]) => op)
	const section = (title: string, ops: typeof all) =>
		ops.length === 0 ? [] : ["", `### ${title}`, ...ops.map((op) => op.label)]
	return [
		...section(
			"Breaking",
			all.filter((op) => op.breaking),
		),
		...section(
			"Added",
			all.filter((op) => !op.breaking && op.added),
		),
		...section(
			"Changed",
			all.filter((op) => !op.breaking && !op.added),
		),
	]
}

/**
 * Whether a package releases and at what level. Nothing releases while its output and hand files match the last
 * release, even when the spec moved (a package may expose only part of it). A changed output on a moved spec with
 * any oasdiff entry is a minor; every other change is a patch; `major` makes any release a major.
 */
export function decide(input: DecideInput): Decision {
	const date = input.now.toISOString().slice(0, ISO_DATE_LENGTH)
	const generatedFrom = `Generated from openapi@${input.observed.spec.sha.slice(0, SPEC_SHA_LENGTH)}.`
	const { previous, observed } = input

	if (previous === undefined) {
		const entry = [`## 1.0.0 — ${date}`, "", input.initialMessage, "", generatedFrom, ""]
		return { entry: entry.join("\n"), kind: "initial", nextVersion: "1.0.0" }
	}

	const outputChanged = observed.output !== previous.output
	const handChanged = observed.hand !== previous.hand
	if (!outputChanged && !handChanged) return { kind: "none" }

	const changes = outputChanged && observed.spec.sha !== previous.spec.sha ? input.changes(previous.spec) : []
	const kind = input.major === true ? "major" : levelOf(changes)
	const version = nextVersion(previous.version, kind)
	const listed = sections(changes)
	const entry = [
		`## ${version} — ${date}`,
		"",
		generatedFrom,
		...listed,
		...(outputChanged && listed.length === 0
			? ["", "### Generated code", "- Regenerated with no change to the API."]
			: []),
		...(handChanged ? ["", "### Package", "- Package files changed."] : []),
		"",
	]
	return { entry: entry.join("\n"), kind, nextVersion: version }
}
