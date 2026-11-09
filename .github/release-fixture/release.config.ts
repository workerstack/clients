/**
 * The release fixture: a product with one hand-kept package, which release-fixture.yml runs the reusable release
 * workflows against on every change to them. Its codegen checks the toolchains below are installed at their
 * system.config.ts pins and writes nothing; its package mirrors to a branch that does not exist, so a sync dry run
 * stages a first push and pushes nothing.
 */
import { defineRelease } from "@workerstack/clients/release"

export default defineRelease({
	codegen: ["bun", ".github/release-fixture/codegen.mjs"],
	homepage: "https://github.com/workerstack/clients",
	packages: [
		{
			branch: "release-fixture-mirror",
			commitMessage: "chore: release fixture sync",
			description: "The release workflows' fixture package",
			name: "fixture",
			registries: [{ kind: "go" }],
			repo: "workerstack/clients",
			topics: ["release-fixture"],
		},
	],
	project: "acme",
	spec: {
		committedPath: ".github/release-fixture/openapi.json",
		deployedUrl: "https://example.invalid/openapi.json",
	},
	toolchains: ["go", "rust", "uv", "ruff"],
})
