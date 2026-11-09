/**
 * The argument rules `honey-clients generate` shares with backend's `honey` (bit 19 h1): each CLI parses its own flags
 * (gen never imports backend, H2), so each package holds its parser to the same table, a value flag standing as `<V>`
 * and a boolean as `--watch`. The table is copied word for word in @workerstack/backend's
 * tests/integration/cli-args-rules.test.ts; change both together.
 */
import { describe, expect, it } from "vitest"
import { parseGenerate } from "../../src/gen/args.ts"

const RULES: readonly (readonly [rule: string, argv: readonly string[], outcome: unknown])[] = [
	["a value after the flag", ["--<V>", "a.ts"], ["a.ts", false]],
	["a value inline, an = inside it kept", ["--<V>=a=b.ts"], ["a=b.ts", false]],
	["a value flag before another flag", ["--<V>", "--watch"], "--<V> requires a value"],
	["a value flag last", ["--watch", "--<V>"], "--<V> requires a value"],
	["an empty inline value", ["--<V>="], "--<V> requires a value"],
	["a bare boolean", ["--<V>", "a.ts", "--watch"], ["a.ts", true]],
	["a boolean set false", ["--<V>", "a.ts", "--watch=false"], ["a.ts", false]],
	["a boolean given another value", ["--<V>", "a.ts", "--watch=yes"], '--watch takes true or false, not "yes"'],
	["an unknown flag", ["--nope"], "unknown option --nope"],
	["a stray argument", ["a.ts"], 'unexpected argument "a.ts"'],
	["a bare --", ["--"], 'unexpected argument "--"'],
]

/** gen's required flags, so a run reaches the rule under test */
const GEN_REQUIRED = ["--out", "o", "--target", "ts"]

/** What a parse of `argv` (`<V>` as --spec) gave: its error's message with the flag as `<V>`, else the spec and watch. */
function outcome(argv: readonly string[]): unknown {
	try {
		const run = parseGenerate([...argv.map((arg) => arg.replace("<V>", "spec")), ...GEN_REQUIRED])
		return [run.spec, run.watch]
	} catch (err) {
		return (err as Error).message.replaceAll("--spec", "--<V>")
	}
}

describe("honey-clients reads its arguments by the rules backend's honey shares (bit 19 h1)", () => {
	it.each(RULES)("%s", (_rule, argv, expected) => {
		expect(outcome(argv)).toEqual(expected)
	})
})
