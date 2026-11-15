/**
 * The docs' pages and code blocks (bit 20), read by core's docs tests and gen's examples-compile legs alike: every
 * markdown page under docs/, each fenced block with its info string and where it starts, the example programs under
 * docs/examples/, and the API they call: the Kitchen e2e app's committed document, which generate:check keeps current.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import realtimeKeyed from "../../../ir/__fixtures__/specs/streams/realtime-keyed.json" with { type: "json" }
import sseItemSchema from "../../../ir/__fixtures__/specs/streams/sse-item-schema.json" with { type: "json" }
import wsKeyed from "../../../ir/__fixtures__/specs/streams/ws-keyed.json" with { type: "json" }

export const REPO = /* @__PURE__ */ resolve(import.meta.dirname, "../../../..")
export const DOCS = /* @__PURE__ */ join(REPO, "docs")

/** A fenced block: its page and line, its info string (`ts`, `ts run`, `go`, …) and its code. */
export type Block = { readonly at: string; readonly code: string; readonly info: string }

/** Every markdown file under `dir`, repo-relative, sorted; none when `dir` is absent. */
export function pagesUnder(dir: string = DOCS): string[] {
	if (!existsSync(dir)) return []
	return readdirSync(dir)
		.flatMap((name) => {
			const path = join(dir, name)
			if (statSync(path).isDirectory()) return pagesUnder(path)
			return name.endsWith(".md") ? [relative(REPO, path)] : []
		})
		.sort()
}

/** The fenced blocks of `markdown` (page `page`), in order; a fence left open ends at the page's end. */
export function blocksOf(page: string, markdown: string): Block[] {
	const blocks: Block[] = []
	let open: { at: string; info: string; lines: string[] } | undefined
	for (const [index, line] of markdown.split("\n").entries()) {
		if (open === undefined) {
			const fence = /^```(.*)$/.exec(line)
			if (fence) open = { at: `${page}:${index + 1}`, info: (fence[1] ?? "").trim(), lines: [] }
			continue
		}
		if (line === "```") {
			blocks.push({ at: open.at, code: `${open.lines.join("\n")}\n`, info: open.info })
			open = undefined
		} else open.lines.push(line)
	}
	if (open) blocks.push({ at: open.at, code: `${open.lines.join("\n")}\n`, info: open.info })
	return blocks
}

/** The README, outside docs/ but compiled with it (bit 20 d). */
export const READMES = ["README.md"]

/** Every page's blocks: docs/ and the READMEs. */
export const allBlocks = (pages: readonly string[] = [...pagesUnder(), ...READMES]): Block[] =>
	pages.flatMap((page) => blocksOf(page, readFileSync(join(REPO, page), "utf8")))

/** The example program in `lang` (`docs/examples/<lang>/<file>`). */
export const exampleOf = (lang: string, file: string): string =>
	readFileSync(join(DOCS, "examples", lang, file), "utf8")

/**
 * The blocks with info `info` that `program` does not hold verbatim: a page shows an excerpt of a compiled example,
 * never code of its own, so every such block is a slice of the program the language's leg compiles.
 */
export const strayExcerpts = (blocks: readonly Block[], info: string, program: string): string[] =>
	blocks.filter((block) => block.info === info && !program.includes(block.code)).map((block) => block.at)

/** The API the docs' SDK examples call: the Kitchen e2e app's committed OpenAPI document. */
export const docsDocument = (): Record<string, unknown> =>
	JSON.parse(
		readFileSync(new URL("../../../../tests/__fixtures__/apps/kitchen.openapi.json", import.meta.url), "utf8"),
	) as Record<string, unknown>

type Spec = { readonly paths: object; readonly components?: { readonly schemas?: object } }

/**
 * The API the docs' typed stream examples call: the Kitchen document, and beside it the typed stream fixtures
 * TypeScript's recipe calls as `Streams` (named SSE events, a keyed WebSocket and a keyed realtime connection),
 * whose paths, operation ids and schemas the Kitchen document does not use.
 */
export function docsStreamsDocument(): Record<string, unknown> {
	const kitchen = docsDocument() as Spec & Record<string, unknown>
	const added: readonly Spec[] = [sseItemSchema, wsKeyed, realtimeKeyed]
	return {
		...kitchen,
		components: {
			...kitchen.components,
			schemas: Object.assign({}, kitchen.components?.schemas, ...added.map((spec) => spec.components?.schemas)),
		},
		paths: Object.assign({}, kitchen.paths, ...added.map((spec) => spec.paths)),
	}
}
