import { describe, expect, it } from "vitest"
import plugin from "./no-module-side-effects.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"
import { SPAWN_TIMEOUT } from "../src/gen/__fixtures__/spawn-timeout.ts"

const rule = plugin.rules["no-module-side-effects"]
const MESSAGE = "module scope runs no code: mark a pure call /* @__PURE__ */ or move it into a function"

describe("clients/no-module-side-effects", () => {
	it("rejects top-level statements that run code", () => {
		const fixture = {
			"src/a.ts": "register()\n",
			"src/b.ts": "globalThis.backend = 1\n",
			"src/c.ts": "if (globalThis.x) {\n\tthrow new Error('x')\n}\n",
			"src/d.ts": "for (const k of []) {\n}\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "src/a.ts", message: MESSAGE },
			{ file: "src/b.ts", message: MESSAGE },
			{ file: "src/c.ts", message: MESSAGE },
			{ file: "src/d.ts", message: MESSAGE },
		])
	})

	it("rejects an initializer that runs code, however deep, unless it is marked pure", () => {
		const fixture = {
			"src/a.ts": "export const id = Symbol.for('backend.id')\n",
			"src/b.ts": "const table = { a: [build()] }\nexport default table\n",
			"src/c.ts": "export default setup()\n",
			"src/d.ts": "const t = tag`x`\nconst n = (globalThis.count = 1)\nexport { t, n }\n",
			"src/e.ts": "export const enc = /* @__PURE__ */ new TextEncoder()\n",
			"src/f.ts": "export const m = /* #__PURE__ */ Object.freeze({ a: 1 })\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "src/a.ts", message: MESSAGE },
			{ file: "src/b.ts", message: MESSAGE },
			{ file: "src/c.ts", message: MESSAGE },
			{ file: "src/d.ts", message: MESSAGE },
			{ file: "src/d.ts", message: MESSAGE },
		])
	})
})

describe("clients/no-module-side-effects: scope", () => {
	it("allows declarations, literals, functions and types", () => {
		const fixture = {
			"src/a.ts": [
				'"use strict"',
				'import { x } from "./x.ts"',
				'export { y } from "./y.ts"',
				"export type T = { a: number }",
				"interface I {\n\tb: string\n}",
				"export const LIMIT = 10",
				"export const NAMES = ['a', `b${LIMIT}`] as const",
				"export const pick = () => compute()",
				"export function run(i: I) {\n\treturn register(i)\n}",
				"export class Box {\n\tvalue = make()\n}",
				"export default { x }",
				"",
			].join("\n"),
			"src/a.test.ts": "register()\n",
			"bench/src/hotpath.ts": "await run()\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the clients plugin entry", { timeout: SPAWN_TIMEOUT }, () => {
		const fixture = {
			"src/a.ts": "register()\n",
			"src/b.ts": "export const id = /* @__PURE__ */ Symbol.for('x')\n",
		}
		expect(oxlintReports("no-module-side-effects", fixture)).toEqual([{ file: "src/a.ts", message: MESSAGE }])
	})
})
