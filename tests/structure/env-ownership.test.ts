/**
 * Who owns an environment variable (bit 22). `CLIENTS_REQUIRE_TOOLCHAINS` and its per-language siblings belong
 * to the TEST harness: they mean "this leg's toolchain must be here, do not skip", and `.github/workflows/ci.yml`
 * sets them on six jobs. Product code must not read them, because then CI's choice about tests silently becomes
 * a change in what a generated run does.
 *
 * This exists because it happened: `missingFormatter` read `CLIENTS_REQUIRE_TOOLCHAINS`, which turned every
 * generation in CI without oxfmt into a hard failure and killed 1.0.0-rc.10's release run. `bun run verify`
 * was green locally, where nothing sets that variable. A product switch gets its own name
 * (`CLIENTS_REQUIRE_FORMATTERS`), and this leg is what notices the next time one is borrowed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const GEN = join(import.meta.dirname, "../..")

/** The harness's own variables: a test may read these, product source may not. */
const HARNESS_ONLY = [
	"CLIENTS_REQUIRE_TOOLCHAINS",
	"CLIENTS_REQUIRE_GO",
	"CLIENTS_REQUIRE_PYTHON",
	"CLIENTS_REQUIRE_RUST",
]

/** Every `.ts` under `dir`, with the test files and fixtures left out: what ships is what this checks. */
function productSources(dir: string, found: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const at = join(dir, entry)
		if (statSync(at).isDirectory()) {
			if (entry === "__fixtures__" || entry === "node_modules" || entry === "_tokenizer") continue
			productSources(at, found)
			continue
		}
		if (!entry.endsWith(".ts") || entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) continue
		found.push(at)
	}
	return found
}

/**
 * Whether `text` READS `name` off an environment, which is the thing that is banned. Naming it in a comment
 * is not: the comment on `missingFormatter` says which variable it deliberately does not read, and that
 * sentence is worth keeping.
 */
export function readsEnv(text: string, name: string): boolean {
	return new RegExp(`env\\s*(?:\\.\\s*${name}\\b|\\[\\s*["'\`]${name}["'\`]\\s*\\])`).test(text)
}

describe("the test harness's environment variables stay the harness's (bit 22)", () => {
	it("is read by no product source", () => {
		const sources = productSources(join(GEN, "src"))
		const borrowed = sources
			.map((path) => {
				const text = readFileSync(path, "utf8")
				return { names: HARNESS_ONLY.filter((name) => readsEnv(text, name)), path }
			})
			.filter(({ names }) => names.length > 0)
			.map(({ names, path }) => `${relative(GEN, path)}: ${names.join(", ")}`)
		expect(borrowed).toEqual([])
	})

	it("reads a real tree, and tells a read from a mention", () => {
		const sources = productSources(join(GEN, "src"))
		expect(sources.length).toBeGreaterThan(100)
		/* the product's own switch is read, which is what a read looks like */
		const own = sources.filter((path) => readsEnv(readFileSync(path, "utf8"), "CLIENTS_REQUIRE_FORMATTERS"))
		expect(own.length).toBeGreaterThan(0)
		expect([
			readsEnv('if (env.CLIENTS_REQUIRE_TOOLCHAINS === "1") throw', "CLIENTS_REQUIRE_TOOLCHAINS"),
			readsEnv('env["CLIENTS_REQUIRE_TOOLCHAINS"]', "CLIENTS_REQUIRE_TOOLCHAINS"),
			readsEnv("/* deliberately not CLIENTS_REQUIRE_TOOLCHAINS, the harness's own */", "CLIENTS_REQUIRE_TOOLCHAINS"),
		]).toEqual([true, true, false])
	})
})
