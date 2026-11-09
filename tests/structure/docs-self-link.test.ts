import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "../..")
const OWN = "https://github.com/workerstack/clients/blob/main/"

function pages(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) return pages(path)
		return entry.name.endsWith(".md") ? [path] : []
	})
}

// A page that links to its own URL meant another page: a reader who follows it lands where they started.
function selfLinks(path: string, text: string): string[] {
	return [...text.matchAll(/\]\((https:[^)\s#]+)/g)].map((match) => match[1] ?? "").filter((url) => url === OWN + path)
}

describe("docs pages", () => {
	it("flags a page that links to its own URL", () => {
		expect(selfLinks("docs/a.md", `see [b](${OWN}docs/a.md) and [c](${OWN}docs/c.md)`)).toEqual([`${OWN}docs/a.md`])
	})

	it("never link to themselves", () => {
		const hits = pages(join(ROOT, "docs")).flatMap((file) => {
			const path = relative(ROOT, file)
			return selfLinks(path, readFileSync(file, "utf8")).map((url) => `${path} links to itself: ${url}`)
		})
		expect(hits).toEqual([])
	})
})
