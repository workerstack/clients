import { describe, expect, it } from "vitest"
import plugin from "./no-v8-ignore.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"
import { SPAWN_TIMEOUT } from "../src/gen/__fixtures__/spawn-timeout.ts"

const rule = plugin.rules["no-v8-ignore"]
const MESSAGE = "coverage ignore hints are forbidden; delete the code or give it a case"

describe("honey/no-v8-ignore", () => {
	it("rejects every coverage-ignore hint the v8 provider honors", () => {
		const fixture = {
			"src/a.ts": "/* v8 ignore next */\nexport const a = 1\n",
			"src/b.ts": "// c8 ignore start\nexport const b = 1\n// c8 ignore stop\n",
			"src/c.ts": "export const c = 1 /* istanbul ignore next */\n",
			"src/d.ts": "/*   V8   IGNORE   else */\nexport const d = 1\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "src/a.ts", message: MESSAGE },
			{ file: "src/b.ts", message: MESSAGE },
			{ file: "src/b.ts", message: MESSAGE },
			{ file: "src/c.ts", message: MESSAGE },
			{ file: "src/d.ts", message: MESSAGE },
		])
	})

	it("leaves ordinary comments that only mention coverage alone", () => {
		const fixture = {
			"src/a.ts": "/* coverage is 100% here; nothing is ignored */\nexport const a = 1\n",
			"src/b.ts": "// we never ignore v8 output\nexport const b = 1\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the honey plugin entry", { timeout: SPAWN_TIMEOUT }, () => {
		const fixture = {
			"src/a.ts": "/* v8 ignore next */\nexport const a = 1\n",
			"src/b.ts": "export const b = 1\n",
		}
		expect(oxlintReports("no-v8-ignore", fixture)).toEqual([{ file: "src/a.ts", message: MESSAGE }])
	})
})
