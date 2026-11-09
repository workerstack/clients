/**
 * The x- keys gen reads off a document are kept by backend's sanitizer (`stripXExtensions: true` strips every other
 * extension). backend's src/schema/sanitize-spec.test.ts holds its sanitizer to this list, copied word for word: a
 * key gen starts reading fails here until both lists name it.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const GENERATORS_READ = [
	"x-deprecated",
	"x-honey-error",
	"x-honey-errors",
	"x-honey-route",
	"x-honey-webhook",
	"x-honey-wildcard",
	"x-idempotency-key",
	"x-invalidate",
	"x-mcp",
	/* built, as tests/structure/mcp-file-extension.test.ts holds the keyword to emit/mcp/files.ts alone */
	["x", "mcp", "file"].join("-"),
	"x-realtime",
	"x-websocket",
]

describe("the x- keys gen reads", () => {
	it("are the ones backend's sanitizer is held to keep", () => {
		const read = new Set<string>()
		for (const file of ["../../src/ir/slots.ts", "../../src/emit/mcp/files.ts"])
			for (const [, key] of readFileSync(new URL(file, import.meta.url), "utf8").matchAll(/"(x-[a-z-]+)"/g))
				read.add(key as string)
		expect([...read].sort()).toEqual(GENERATORS_READ)
	})
})
