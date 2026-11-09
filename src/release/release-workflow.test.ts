import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { load } from "js-yaml"
import { afterEach, describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../gen/__fixtures__/spawn-timeout.ts"

import type { Registry } from "./types.ts"
import { ACTIONS } from "./registries.ts"
import { releaseWorkflow } from "./release-workflow.ts"

type Step = {
	name?: string
	uses?: string
	run?: string
	env?: Record<string, string>
	with?: Record<string, string>
}
type Workflow = {
	on: { push: { tags: string[] }; workflow_dispatch: { inputs: { tag: { required: boolean } } } }
	jobs: { publish: { permissions: Record<string, string>; steps: Step[] } }
}

const parsed = (registries: Registry[]) => load(releaseWorkflow(registries)) as Workflow
const steps = (registries: Registry[]) => parsed(registries).jobs.publish.steps
const runs = (registries: Registry[]) =>
	steps(registries)
		.map((step) => step.run ?? "")
		.join("\n")

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

/** Runs the workflow's version check in a dir holding `files`, as the runner would for tag `tag`. */
function versionCheck(registries: Registry[], tag: string, files: Record<string, string>) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "release-workflow-"))
	dirs.push(dir)
	for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content)
	const check = steps(registries).find((step) => step.name === "the tag is the version the package publishes")
	const env = { ...process.env, GITHUB_ENV: path.join(dir, "github-env"), TAG: tag }
	return spawnSync("bash", ["-e", "-c", check?.run ?? "exit 99"], {
		cwd: dir,
		encoding: "utf8",
		env,
	})
}

/** Runs the step named `name` of `registries`' workflow with `env`, a `curl` on `PATH` that answers `curlBody`. */
function runStep(registries: Registry[], name: string, env: Record<string, string>, curlBody = "") {
	const dir = mkdtempSync(path.join(os.tmpdir(), "release-workflow-"))
	dirs.push(dir)
	const bin = path.join(dir, "bin")
	mkdirSync(bin)
	writeFileSync(path.join(bin, "curl"), `#!/bin/sh\nprintf '%s' '${curlBody}'\n`)
	chmodSync(path.join(bin, "curl"), 0o755)
	const step = steps(registries).find((s) => s.name === name)
	return spawnSync("bash", ["-e", "-c", step?.run ?? "exit 99"], {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env, ...step?.env, ...env, PATH: `${bin}:${process.env.PATH}` },
	})
}

/** honey's record of the package: its name and version on each registry, as `.honey-generated.json` keeps it. */
const record = (...packages: { name: string; registry: string; version?: string }[]) => ({
	".honey-generated.json": JSON.stringify({ files: {}, packages }),
})

describe("releaseWorkflow triggers and publish steps", () => {
	it("runs on a v* tag, and again by hand for a named tag", () => {
		const { on } = parsed([{ kind: "npm" }])
		expect(on.push.tags).toEqual(["v*"])
		expect(on.workflow_dispatch.inputs.tag.required).toBe(true)
	})

	it("publishes npm with provenance over OIDC and never reads a token", () => {
		const text = releaseWorkflow([{ kind: "npm" }, { kind: "jsr" }])
		expect(parsed([{ kind: "npm" }, { kind: "jsr" }]).jobs.publish.permissions).toEqual({
			contents: "read",
			"id-token": "write",
		})
		expect(runs([{ kind: "npm" }])).toMatch(/npm publish --provenance --access public/)
		expect(runs([{ kind: "jsr" }])).toMatch(/npx --yes jsr@[\d.]+ publish/)
		expect(text).not.toMatch(/NODE_AUTH_TOKEN|secrets\./)
	})

	it("builds and uploads to PyPI through the pinned trusted-publishing action", () => {
		const uses = steps([{ kind: "pypi" }]).map((step) => step.uses)
		expect(uses).toContain(ACTIONS.pypiPublish.split(" ")[0])
		expect(runs([{ kind: "pypi" }])).toMatch(/python -m build/)
	})

	it("publishes the crate with the token crates.io's OIDC exchange hands back", () => {
		const publish = steps([{ kind: "crates" }]).find((step) => step.run === "cargo publish")
		expect(publish?.env?.CARGO_REGISTRY_TOKEN).toBe("${{ steps.crates-auth.outputs.token }}")
		expect(releaseWorkflow([{ kind: "crates" }])).not.toMatch(/secrets\./)
	})

	it("asks the Go proxy for the tag, with no OIDC and no publish step", () => {
		expect(parsed([{ kind: "go" }]).jobs.publish.permissions).toEqual({ contents: "read" })
		expect(runs([{ kind: "go" }])).toMatch(/proxy\.golang\.org\/\$NAME\/@v\/\$TAG\.info/)
	})

	it("cuts a GitHub release of the listed assets, the only kind that may write contents", () => {
		const registries: Registry[] = [{ assets: ["openapi.json"], kind: "github" }]
		expect(parsed(registries).jobs.publish.permissions).toEqual({ contents: "write" })
		expect(runs(registries)).toMatch(/gh release create "\$TAG" "openapi\.json" --verify-tag/)
	})

	it("refuses a package with no registry", () => {
		expect(() => releaseWorkflow([])).toThrow(/at least one registry/)
	})
})

describe("releaseWorkflow waits on the registries", () => {
	it("waits for every registry to serve the version, and fails naming the one that does not", () => {
		const live = steps([{ kind: "npm" }, { kind: "jsr" }]).filter((step) => step.name?.endsWith("serves the version"))
		expect(live.map((step) => step.name)).toEqual(["npm serves the version", "jsr serves the version"])
		expect(live[0]?.run).toMatch(/::error::npm does not serve/)
	})

	it(
		"passes when honey's record holds the tag's version for every registry",
		() => {
			const result = versionCheck(
				[{ kind: "npm" }, { kind: "jsr" }],
				"v2.0.0",
				record(
					{ name: "@a/sdk", registry: "npm", version: "2.0.0" },
					{ name: "@a/sdk", registry: "jsr", version: "2.0.0" },
				),
			)
			expect(result.status).toBe(0)
		},
		SPAWN_TIMEOUT,
	)
})

describe("releaseWorkflow's checks run on bash and jq", () => {
	it.each(["bash", "jq"])(
		"finds %s, which the version and Portal checks shell out to: missing, it fails here, never skips",
		(tool) => {
			expect(spawnSync(tool, ["--version"]).status, `${tool} is required by the release-workflow tests`).toBe(0)
		},
		SPAWN_TIMEOUT,
	)
})

describe("releaseWorkflow checks the recorded version", () => {
	it(
		"fails before any publish when the record holds another version, naming the record",
		() => {
			const result = versionCheck(
				[{ kind: "npm" }, { kind: "jsr" }],
				"v2.0.0",
				record(
					{ name: "@a/sdk", registry: "npm", version: "2.0.0" },
					{ name: "@a/sdk", registry: "jsr", version: "1.0.0" },
				),
			)
			expect(result.status).not.toBe(0)
			expect(result.stdout).toMatch(/tag v2\.0\.0, but \.honey-generated\.json holds version 1\.0\.0/)
		},
		SPAWN_TIMEOUT,
	)

	it(
		"reads each registry's version from the record, and fails on a registry it does not name",
		() => {
			const check = (kind: Registry, registry: string, version: string) =>
				versionCheck([kind], "v2.0.0", record({ name: "acme", registry, version })).status
			expect([
				check({ kind: "pypi" }, "pypi", "2.0.0"),
				check({ kind: "go" }, "go", "2.0.0"),
				check({ kind: "nuget" }, "nuget", "2.0.0"),
				check({ kind: "maven" }, "maven-central", "2.0.0"),
			]).toEqual([0, 0, 0, 0])
			expect(check({ kind: "crates" }, "crates.io", "2.0.1")).not.toBe(0)
			expect(versionCheck([{ kind: "crates" }], "v2.0.0", record()).status).not.toBe(0)
		},
		SPAWN_TIMEOUT,
	)
})

describe("releaseWorkflow on NuGet", () => {
	it("publishes to NuGet with the short-lived key NuGet's OIDC login hands back", () => {
		const nuget: Registry[] = [{ kind: "nuget" }]
		expect(parsed(nuget).jobs.publish.permissions).toEqual({
			contents: "read",
			"id-token": "write",
		})
		const login = steps(nuget).find((step) => step.uses === ACTIONS.nugetLogin.split(" ")[0])
		expect(login?.with?.user).toBe("${{ vars.NUGET_USER }}")
		const push = steps(nuget).find((step) => step.run?.includes("dotnet nuget push"))
		expect(push?.env?.NUGET_API_KEY).toBe("${{ steps.nuget-login.outputs.NUGET_API_KEY }}")
		expect(push?.run).not.toMatch(/--skip-duplicate/)
		expect(releaseWorkflow(nuget)).not.toMatch(/secrets\./)
	})

	it(
		"refuses to publish to NuGet before login when the repo names no NuGet user",
		() => {
			const guard = "NuGet names the user that owns the trusted-publishing policy"
			expect(runStep([{ kind: "nuget" }], guard, { NUGET_USER: "" }).status).not.toBe(0)
			expect(runStep([{ kind: "nuget" }], guard, { NUGET_USER: "acme" }).status).toBe(0)
		},
		SPAWN_TIMEOUT,
	)
})

describe("releaseWorkflow on Maven Central", () => {
	it("signs and uploads a Maven Central bundle with the Portal and GPG secrets, and waits on repo1", () => {
		const maven: Registry[] = [{ kind: "maven" }]
		const text = releaseWorkflow(maven)
		for (const secret of [
			"MAVEN_CENTRAL_USERNAME",
			"MAVEN_CENTRAL_PASSWORD",
			"MAVEN_GPG_PRIVATE_KEY",
			"MAVEN_GPG_PASSPHRASE",
		])
			expect(text).toContain(`\${{ secrets.${secret} }}`)
		expect(runs(maven)).toMatch(/gpg --batch .*--detach-sign/)
		expect(runs(maven)).toMatch(/api\/v1\/publisher\/upload\?publishingType=AUTOMATIC/)
		expect(runs(maven)).toMatch(/repo1\.maven\.org\/maven2/)
		expect(parsed(maven).jobs.publish.permissions).toEqual({ contents: "read" })
	})

	it(
		"passes once the Portal reports the deployment PUBLISHED, and fails on FAILED, an unknown state or a timeout",
		() => {
			const status = "Maven Central publishes the deployment"
			const env = { DEPLOYMENT_ID: "abc", PORTAL_TRIES: "2", PORTAL_WAIT: "0" }
			const said = (state: string) => JSON.stringify({ deploymentState: state, errors: {} })
			expect(runStep([{ kind: "maven" }], status, env, said("PUBLISHED")).status).toBe(0)
			expect(runStep([{ kind: "maven" }], status, env, said("FAILED")).status).not.toBe(0)
			expect(runStep([{ kind: "maven" }], status, env, said("LOST")).status).not.toBe(0)
			expect(runStep([{ kind: "maven" }], status, env, said("VALIDATING")).status).not.toBe(0)
		},
		SPAWN_TIMEOUT,
	)
})
