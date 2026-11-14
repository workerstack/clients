// Managed by ~/Development/standards (files/scripts/brand-names.ts). Edit it there, then run `bun sync.ts`.
// The brand names a rename removed, and where they may still stand: shared by the rename codemod, its inventory and
// each repo's no-<brand> structure test, so the three never disagree on what counts.
//
// A brand counts as a segment of a name, never inside an ordinary word: lowercase `honey` needs a non-lowercase
// letter on each side, `Honey` a non-uppercase letter before and a non-lowercase letter after, `HONEY` a non-letter
// on each side. So `honey-source`, `honey_sdk`, `isHoneyError` and `HONEY_X` count; `honeypot`, `Honeydew`,
// `honeycomb` and `HONEYCOMB` do not. ALLOW then drops whole tokens that pass that rule and are still not the brand.
//
// History is the record of the old names and keeps them: changelogs, migration docs, the maps a rename ran from,
// `blueprint/**`, each `no-<brand>` test, the exports a past release shipped, this module and the rename tools, and
// a README's dated upgrade sections. Two files are partly live: `blueprint/files.tsv`, whose path column check-tree
// reads, and each lesson, whose `paths:` and commands agents run; only its `evidence:` line is history.

export const ALLOW: Record<string, readonly string[]> = {
	comb: ["combobox", "Combobox", "combination", "combine"],
	honey: ["honeymoon", "Honeydew", "honeypot", "honeybadger", "HoneyBadger"],
}

const TOKEN_CHAR = /[A-Za-z0-9_$-]/

function segmentPattern(brand: string): RegExp {
	const lower = brand.toLowerCase()
	const cap = lower.charAt(0).toUpperCase() + lower.slice(1)
	const upper = lower.toUpperCase()
	return new RegExp(`(?<![a-z])${lower}(?![a-z])|(?<![A-Z])${cap}(?![a-z])|(?<![A-Za-z])${upper}(?![A-Za-z])`, "g")
}

/** Each whole token (a run of `[A-Za-z0-9_$-]`) that holds a brand segment, in text order, allow list removed. */
export function brandTokens(text: string, brand: string): string[] {
	const allowed = new Set(ALLOW[brand.toLowerCase()] ?? [])
	const out: string[] = []
	let end = 0
	for (const match of text.matchAll(segmentPattern(brand))) {
		if (match.index < end) continue
		let start = match.index
		let stop = match.index + match[0].length
		while (start > 0 && TOKEN_CHAR.test(text.charAt(start - 1))) start--
		while (stop < text.length && TOKEN_CHAR.test(text.charAt(stop))) stop++
		end = stop
		const token = text.slice(start, stop)
		if (!allowed.has(token)) out.push(token)
	}
	return out
}

export type Area = "history" | "files-tsv" | "lesson" | "live"

/** One run of a file's text: `live` when a rename rewrites it and a leftover there counts. */
export type Span = { live: boolean; text: string }

const HISTORY = [
	/(^|\/)CHANGELOG\.md$/,
	/(^|\/)docs\/(.*\/)?[^/]*migrat[^/]*\.md$/,
	/(^|\/)tests\/structure\/no-[a-z-]+\.test\.ts$/,
	/(^|\/)__snapshots__\/released-[^/]+$/,
	/(^|\/)brand-names(\.test)?\.ts$/,
	/(^|\/)rename-brand\//,
]

/** Where `path` stands: all history, partly live (`files-tsv`, `lesson`), or live, with `maps` the rename's maps. */
export function historyOf(path: string, maps: readonly string[] = []): Area {
	if (maps.includes(path) || HISTORY.some((re) => re.test(path))) return "history"
	if (path === "blueprint/files.tsv") return "files-tsv"
	if (path.startsWith("blueprint/")) return "history"
	if (/^\.rulesync\/lessons\/.*\.md$/.test(path)) return "lesson"
	return "live"
}

/** `text` split into lines, each keeping its newline, so the lines rejoin to it. */
const linesOf = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? []

/** Adjacent spans of one kind merged. */
function merged(spans: readonly Span[]): Span[] {
	const out: Span[] = []
	for (const span of spans) {
		const last = out.at(-1)
		if (last && last.live === span.live) last.text += span.text
		else if (span.text !== "") out.push({ ...span })
	}
	return out
}

function tsvSpans(text: string): Span[] {
	return linesOf(text).flatMap((line) => {
		const tab = line.indexOf("\t")
		if (line.startsWith("#") || tab < 0) return [{ live: false, text: line }]
		return [
			{ live: true, text: line.slice(0, tab) },
			{ live: false, text: line.slice(tab) },
		]
	})
}

const UPGRADE = /^## (Upgrading to |\d)/

function readmeSpans(text: string): Span[] {
	return text.split(/(?<=\n)(?=## )/).map((section) => ({ live: !UPGRADE.test(section), text: section }))
}

/** `text` of `path` as live and history spans, in order; their texts rejoin to `text`. */
export function spansOf(path: string, text: string, maps: readonly string[] = []): Span[] {
	const area = historyOf(path, maps)
	if (area === "history") return [{ live: false, text }]
	if (area === "files-tsv") return merged(tsvSpans(text))
	if (area === "lesson")
		return merged(linesOf(text).map((line) => ({ live: !line.startsWith("evidence:"), text: line })))
	if (/(^|\/)README\.md$/.test(path)) return merged(readmeSpans(text))
	return [{ live: true, text }]
}
