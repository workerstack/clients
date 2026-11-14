/**
 * clients/no-console (bit 20 scope): every file under src/, tests/ and lint/, tests, fixtures and helpers included,
 * writes through the io a command is handed; only the scripts whose stdout is their protocol, each by exact path, may
 * touch console. A console call inside a string is no member expression.
 */
import { describe, expect, it } from "vitest"
import plugin, { PROTOCOL } from "./no-console.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"
import { SPAWN_TIMEOUT } from "../src/gen/__fixtures__/spawn-timeout.ts"

const rule = plugin.rules["no-console"]
const MESSAGE = "console is for no source or test here: write through the io a command is handed"
const LOG = 'console.log("x")\n'

describe("clients/no-console", () => {
	it("rejects console in source", () => {
		const fixture = {
			"src/routing/app.ts": LOG,
			"src/middleware/cors.ts": 'export const f = () => console["warn"]("x")\n',
			"src/cli.ts": "export const out = console.error\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "src/routing/app.ts", message: MESSAGE },
			{ file: "src/middleware/cors.ts", message: MESSAGE },
			{ file: "src/cli.ts", message: MESSAGE },
		])
	})

	it("rejects console in a test file, wherever it lives in scope", () => {
		const fixture = {
			"src/build/source.test.ts": LOG,
			"tests/integration/routing.test.ts": LOG,
			"lint/boundaries.test.ts": LOG,
			"src/cli.app.test.ts": LOG,
			"tests/integration/codegen-bin.test.ts": LOG,
		}
		expect(reportsOf(rule, fixture).map((report) => report.file)).toEqual(Object.keys(fixture))
	})

	it("rejects console in a fixture or a helper", () => {
		const fixture = {
			"src/build/__fixtures__/project.ts": LOG,
			"src/ir/__fixtures__/app-project.ts": LOG,
			"tests/e2e/apps/kitchen/tests/e2e/helpers.ts": LOG,
			"tests/integration/support/server.ts": LOG,
			"tests/integration/conformance/harness.ts": LOG,
		}
		expect(reportsOf(rule, fixture).map((report) => report.file)).toEqual(Object.keys(fixture))
	})
})

describe("clients/no-console: what stays allowed", () => {
	it("allows the same call inside a string a test spawns, and a property named console", () => {
		const fixture = {
			"src/build/cli.test.ts": 'export const child = "console.log(process.pid)"\n',
			"src/cli.app.test.ts": "export const child = `console.error(${1})`\n",
			"src/routing/match.ts": "const logger = { console: 1 }\nexport const n = logger.console\n",
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("allows each script whose stdout is its protocol, and code outside the scope", () => {
		const fixture = Object.fromEntries([
			...[...PROTOCOL.keys()].map((path) => [path, LOG]),
			["bench/src/hotpath.ts", 'console.table("x")\n'],
			["scripts/build.ts", LOG],
		])
		expect([PROTOCOL.size, reportsOf(rule, fixture)]).toEqual([1, []])
	})

	it("rejects an unlisted file with an exemption's code: beside it, or a copy of its path nested deeper", () => {
		const fixture = {
			"tests/integration/proxy-upstream/other.ts": LOG,
			"tests/e2e/run.ts": LOG,
			"tests/integration/conformance/gate.test.ts": LOG,
			"tests/fixtures/tests/e2e/run-build.ts": LOG,
		}
		expect(reportsOf(rule, fixture).map((report) => report.file)).toEqual(Object.keys(fixture))
	})

	it("fails oxlint through the clients plugin entry", { timeout: SPAWN_TIMEOUT }, () => {
		const fixture = {
			"src/routing/app.ts": LOG,
			"tests/integration/conformance/gate.ts": LOG,
			"tests/integration/conformance/helper.ts": LOG,
		}
		expect(oxlintReports("no-console", fixture)).toEqual([
			{ file: "src/routing/app.ts", message: MESSAGE },
			{ file: "tests/integration/conformance/helper.ts", message: MESSAGE },
		])
	})
})
