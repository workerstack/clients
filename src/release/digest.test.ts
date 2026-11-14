import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SPAWN_TIMEOUT } from "../gen/__fixtures__/spawn-timeout.ts"
import { DEFAULT_COMMITTER } from "./constants.ts"
import type { PublicPackage } from "./types.ts"
import { handDigest, outputDigest } from "./digest.ts"

let root = ""
const PKG_DIR = "acme-release/sdk"

const pkg = (generated: boolean): PublicPackage => ({
	branch: "main",
	codegen: ["true"],
	commitMessage: "c",
	committer: DEFAULT_COMMITTER,
	description: "d",
	homepage: "https://example.com",
	...(generated ? { clients: { options: {}, target: "go" as const } } : {}),
	mirror: "git@github.com:acme/sdk.git",
	name: "sdk",
	path: PKG_DIR,
	project: "acme",
	registries: [],
	repo: "acme/sdk",
	spec: { committedPath: "/spec.json", deployedUrl: "https://api.example.com/spec.json" },
	topics: ["acme"],
})

function write(rel: string, text: string): void {
	const full = path.join(root, PKG_DIR, rel)
	mkdirSync(path.dirname(full), { recursive: true })
	writeFileSync(full, text)
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" })

function manifest(files: Record<string, string>): void {
	write(".clients-generated.json", `${JSON.stringify({ files }, null, "\t")}\n`)
}

beforeEach(() => {
	root = mkdtempSync(path.join(os.tmpdir(), "digest-test-"))
	git("init", "--quiet")
	write("README.md", "# sdk\n")
	write("package.json", '{\n\t"name": "@acme/sdk",\n\t"version": "1.0.0"\n}\n')
	write("CHANGELOG.md", "# Changelog\n")
	write(".release-state.json", "{}\n")
	write("client.go", "package sdk\n")
	manifest({ "client.go": "e".repeat(64) })
	git("add", "-A")
}, SPAWN_TIMEOUT)

afterEach(() => rmSync(root, { force: true, recursive: true }))

describe("handDigest", () => {
	it(
		"ignores the version, the CHANGELOG, the state, the manifest and generated files",
		{ timeout: SPAWN_TIMEOUT },
		() => {
			const before = handDigest(root, pkg(true))
			write("package.json", '{\n\t"name": "@acme/sdk",\n\t"version": "2.0.0"\n}\n')
			write("CHANGELOG.md", "# Changelog\n\n## 2.0.0\n")
			write(".release-state.json", '{"version":"2.0.0"}\n')
			write("client.go", "package sdk // changed\n")
			manifest({ "client.go": "f".repeat(64) })
			expect(handDigest(root, pkg(true))).toBe(before)
		},
	)

	it("changes when a hand file changes", { timeout: SPAWN_TIMEOUT }, () => {
		const before = handDigest(root, pkg(true))
		write("README.md", "# sdk, now documented\n")
		expect(handDigest(root, pkg(true))).not.toBe(before)
	})
})

describe("outputDigest", () => {
	it("follows the generated files' hashes in clients' manifest", () => {
		const before = outputDigest(root, pkg(true), "a".repeat(64))
		manifest({ "client.go": "f".repeat(64) })
		expect(outputDigest(root, pkg(true), "a".repeat(64))).not.toBe(before)
	})

	it("throws naming the dir when codegen wrote no manifest", () => {
		rmSync(path.join(root, PKG_DIR, ".clients-generated.json"))
		expect(() => outputDigest(root, pkg(true), "a".repeat(64))).toThrow(PKG_DIR)
	})

	it("is the spec's sha for a hand-kept package", () => {
		expect(outputDigest(root, pkg(false), "a".repeat(64))).toBe("a".repeat(64))
	})
})

describe("handDigest of a deleted file", () => {
	it("changes when a tracked hand file is deleted from the worktree", { timeout: SPAWN_TIMEOUT }, () => {
		const before = handDigest(root, pkg(true))
		rmSync(path.join(root, PKG_DIR, "README.md"))
		expect(handDigest(root, pkg(true))).not.toBe(before)
	})
})
