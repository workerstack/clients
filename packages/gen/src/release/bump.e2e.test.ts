/*
 * The bumps that move the spec after a release, so bump runs oasdiff through Go: they run in the `go` project, Go
 * pinned by go-env.
 */
import { describe, expect, it } from "vitest"

import { goEnv } from "../emit/go/__fixtures__/go-env.ts"
import {
	ADDED,
	bumped,
	OPENAPI,
	REMOVED,
	SDK,
	succeeded,
	TIMEOUT_MS,
	useBumpProject,
} from "./__fixtures__/bump-project.ts"

describe("bump --config across an added and a removed operation", () => {
	const acme = useBumpProject(() => ({ ...process.env, ...goEnv() }))

	it(
		"makes an added operation and a removed one each a minor",
		async () => {
			await acme.released()
			await acme.write("spec.json", ADDED)
			acme.commit("add an operation")

			const minor = await acme.bump()

			succeeded(minor)
			expect(bumped(minor.stdout)).toEqual(["bumped: openapi 1.1.0 minor", "bumped: sdk 1.1.0 minor"])
			expect(await acme.read(`${SDK}/CHANGELOG.md`)).toMatch(/### Added\n- `POST \/v1\/widgets`/)
			acme.commit("release")
			await acme.write("spec.json", REMOVED)
			acme.commit("remove an operation")

			const removed = await acme.bump()

			succeeded(removed)
			expect(bumped(removed.stdout)).toEqual(["bumped: openapi 1.2.0 minor", "bumped: sdk 1.2.0 minor"])
			expect(await acme.read(`${SDK}/CHANGELOG.md`)).toMatch(/### Breaking\n[\s\S]*`GET \/v1\/widgets`/)
		},
		TIMEOUT_MS,
	)
})

describe("bump --config across a failed codegen", () => {
	const acme = useBumpProject(() => ({ ...process.env, ...goEnv() }))

	it(
		"leaves every state alone when the release codegen fails, so a rerun releases the same",
		async () => {
			await acme.released()
			await acme.write("spec.json", ADDED)
			acme.commit("add an operation")
			await acme.write("fail-codegen", "")

			const crashed = await acme.bump()

			expect(crashed.status).not.toBe(0)
			expect((await acme.state(SDK)).version).toBe("1.0.0")
			expect((await acme.state(OPENAPI)).version).toBe("1.0.0")
			await acme.remove("fail-codegen")

			const rerun = await acme.bump()

			succeeded(rerun)
			expect(bumped(rerun.stdout)).toEqual(["bumped: openapi 1.1.0 minor", "bumped: sdk 1.1.0 minor"])
		},
		TIMEOUT_MS,
	)
})
