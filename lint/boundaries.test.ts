import { describe, expect, it } from "vitest"
import plugin from "./boundaries.js"
import { oxlintReports, reportsOf } from "./rule-harness.ts"
import { SPAWN_TIMEOUT } from "../src/gen/__fixtures__/spawn-timeout.ts"

const rule = plugin.rules.boundaries
const ESCAPE = "an import stays inside its package's src (no repo path outside it, no sibling package)"
const TS_MORPH = "ts-morph is for honey-clients's extract/ only"
const INTERNAL = "honey-clients reads @workerstack/backend through public subpaths only"

describe("honey/boundaries: imports", () => {
	it("never leaves the package's src: no repo path outside it, no sibling package by path", () => {
		const fixture = {
			"src/emit/ts/sdk.ts": 'import { judge } from "../../../../bench/src/significance.ts"\n',
			"src/ir/model.ts": 'export * from "../../tests/fixtures/apps/kitchen.openapi.json"\n',
			"src/ir/build.ts": 'import { x } from "../../../core/src/routing/app.ts"\n',
			"src/ir/schema.ts": 'import { m } from "./model.ts"\nimport { e } from "../emit/ts/sdk.ts"\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "src/emit/ts/sdk.ts", message: ESCAPE },
			{ file: "src/ir/model.ts", message: ESCAPE },
			{ file: "src/ir/build.ts", message: ESCAPE },
		])
	})

	it("keeps ts-morph in extract/", () => {
		const fixture = {
			"src/extract/walk.ts": 'import type { Project } from "ts-morph"\n',
			"src/ir/load.ts": 'import { Project } from "ts-morph"\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([{ file: "src/ir/load.ts", message: TS_MORPH }])
	})

	it("keeps honey-clients on @workerstack/backend's public subpaths", () => {
		const fixture = {
			"src/ir/load.ts": [
				'import type { OpenApiSpec } from "@workerstack/backend/openapi"',
				'import { x } from "@workerstack/backend/src/routing/app.ts"',
				'import { z } from "@workerstack/backend/dist/index.js"',
				"",
			].join("\n"),
		}
		expect(reportsOf(rule, fixture)).toEqual([
			{ file: "src/ir/load.ts", message: INTERNAL },
			{ file: "src/ir/load.ts", message: INTERNAL },
		])
	})

	it("ignores tests and files outside src", () => {
		const fixture = {
			"src/ir/load.test.ts": 'import { x } from "../../../../bench/src/significance.ts"\n',
			"tests/integration/x.test.ts": 'import { x } from "../../../../bench/src/significance.ts"\n',
			"scripts/sdk-budget.ts": 'import { Project } from "ts-morph"\n',
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("fails oxlint through the honey plugin entry", { timeout: SPAWN_TIMEOUT }, () => {
		const fixture = {
			"src/ir/load.ts": 'import { Project } from "ts-morph"\n',
			"src/extract/walk.ts": 'import { Project } from "ts-morph"\n',
		}
		expect(oxlintReports("boundaries", fixture)).toEqual([{ file: "src/ir/load.ts", message: TS_MORPH }])
	})
})
