/**
 * scripts/pack.ts packs the tarball release.yml publishes. Its manifest drops devDependencies, which no consumer
 * installs and whose vendored `file:` pin named a tarball no install could reach (rc.27 shipped one), and a `file:`,
 * `link:` or git spec in a field a consumer installs fails the pack before it builds.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { pack } from "./pack.ts"

/* npm pack spawns, so the leg takes an explicit bound rather than vitest's 5 s default */
const PACK_TIMEOUT = 120_000
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "clients-pack-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

/** A package at `<scratch>/<name>` whose manifest holds `fields`, with one shipped file. */
function fixture(name: string, fields: Record<string, unknown>): string {
	const dir = mkdtempSync(join(scratch, `${name}-`))
	const manifest = { files: ["index.js"], name: "@workerstack/clients", version: "1.0.0", ...fields }
	writeFileSync(join(dir, "package.json"), JSON.stringify(manifest))
	writeFileSync(join(dir, "index.js"), "export {}\n")
	return dir
}

/** What packing a package whose `field` holds `x: spec` ends in: "packed", or the refusal's message. */
function refusal(field: string, spec: string): string {
	try {
		pack(fixture("refused", { [field]: { x: spec } }), scratch)
		return "packed"
	} catch (error) {
		return (error as Error).message
	}
}

describe("scripts/pack.ts", () => {
	it(
		"publishes no devDependencies and keeps the registry ranges a consumer installs",
		{ timeout: PACK_TIMEOUT },
		() => {
			const dir = fixture("dev", {
				dependencies: { zod: "4.3.6" },
				devDependencies: { "@workerstack/backend": "file:vendor/workerstack-backend-1.0.0-rc.26.tgz" },
			})
			const tarball = pack(dir, scratch)
			const read = spawnSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" })
			const published = JSON.parse(read.stdout) as Record<string, unknown>
			expect([published.dependencies, published.devDependencies]).toEqual([{ zod: "4.3.6" }, undefined])
		},
	)

	it("refuses a file:, link: or git spec a consumer would install, naming the field and the spec", () => {
		expect([
			refusal("dependencies", "file:vendor/x.tgz"),
			refusal("peerDependencies", "link:../x"),
			refusal("optionalDependencies", "git+https://example.com/x.git"),
		]).toEqual([
			'pack: @workerstack/clients dependencies.x is "file:vendor/x.tgz"; a published manifest names only registry versions',
			'pack: @workerstack/clients peerDependencies.x is "link:../x"; a published manifest names only registry versions',
			'pack: @workerstack/clients optionalDependencies.x is "git+https://example.com/x.git"; a published manifest names only registry versions',
		])
	})
})
