import { describe, expect, test } from "vitest"
import {
	archiveCases,
	checksumCases,
	formatCases,
	requireCases,
	signatureCases,
	versionCases,
} from "./support/sh-cases-fetch.ts"
import {
	outputCases,
	pathEnvCases,
	platformCases,
	preflightCases,
	profileCases,
	shadowCases,
} from "./support/sh-cases-system.ts"
import { serveSuite, SH_RUNNERS } from "./support/sh-harness.ts"

serveSuite()

/* the runners come from the environment; say so rather than report an empty file */
if (SH_RUNNERS.length === 0) {
	test.skipIf(SH_RUNNERS.length === 0)(
		"install.sh: no sh runner (INSTALLGEN_E2E_SHELLS=sh or INSTALLGEN_E2E_DOCKER=1)",
		() => {
			expect(SH_RUNNERS).toEqual([])
		},
	)
}

describe.each(SH_RUNNERS)("install.sh under $name", (runner) => {
	describe("formats", () => formatCases(runner))
	archiveCases(runner)
	describe("versions", () => versionCases(runner))
	describe("checksums", () => checksumCases(runner))
	describe("signature", () => {
		signatureCases(runner)
		requireCases(runner)
	})
	describe("preflight", () => preflightCases(runner))
	describe("platforms", () => platformCases(runner))
	describe("install and PATH", () => {
		profileCases(runner)
		pathEnvCases(runner)
		shadowCases(runner)
	})
	describe("output", () => outputCases(runner))
})
