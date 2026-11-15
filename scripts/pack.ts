#!/usr/bin/env bun
// `bun scripts/pack.ts <out dir> <package dir>...`: each package's tarball as npm publishes it, its path printed per
// line. Each package is packed from a staged copy: prepack builds dist/ in the copy, so the checkout never gets one.
// The build reads the checkout's `clients-source` condition, but the tarball ships no src/, so the manifest npm packs
// drops every `clients-source` key: a process that sets the condition would otherwise resolve an install to a missing
// file. It drops devDependencies too, which no consumer installs and whose vendored `file:` pins name a tarball no
// install can reach, and refuses a `file:`, `link:` or git spec in a field a consumer does install. release.yml's
// pack job packs here (bit 19 i).
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

/** The fields an install of the package reads; a spec in one must name a registry version. */
const INSTALLED = ["dependencies", "optionalDependencies", "peerDependencies"] as const
const NON_REGISTRY = /^(?:file|link|git(?:\+[a-z]+)?|github):/

type Manifest = { name: string; version: string; exports?: unknown; imports?: unknown } & Partial<
	Record<(typeof INSTALLED)[number] | "devDependencies", Record<string, string>>
>

const UNSTAGED = new Set(["coverage", "dist", "node_modules", "tests"])

const read = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest

/** The manifest npm publishes: the package's own, which pins exact versions (no catalog, no workspace). */
function published(dir: string): Manifest {
	return read(dir)
}

/** `manifest` as npm publishes it: no devDependencies, and every installed spec a registry version, or it throws. */
function shippedManifest(manifest: Manifest): Manifest {
	const { devDependencies: _dev, ...shipped } = manifest
	for (const field of INSTALLED)
		for (const [name, spec] of Object.entries(manifest[field] ?? {}))
			if (NON_REGISTRY.test(spec))
				throw new Error(
					`pack: ${manifest.name} ${field}.${name} is "${spec}"; a published manifest names only registry versions`,
				)
	return { ...shipped, exports: withoutSource(manifest.exports), imports: withoutSource(manifest.imports) }
}

/** `entry` (an `exports` or `imports` value) without its `clients-source` conditions, at any depth. */
function withoutSource(entry: unknown): unknown {
	if (entry === null || typeof entry !== "object") return entry
	if (Array.isArray(entry)) return entry.map(withoutSource)
	return Object.fromEntries(
		Object.entries(entry).flatMap(([key, value]) => (key === "clients-source" ? [] : [[key, withoutSource(value)]])),
	)
}

/** The tarball of the package at `dir`, packed into `out` from a copy staged inside the package. */
export function pack(dir: string, out: string): string {
	const manifest = published(dir)
	/* checked before the build, so a refused spec fails in a second, not after prepack */
	const shipped = shippedManifest(manifest)
	const stage = mkdtempSync(join(dir, ".tmp-pack-"))
	try {
		for (const entry of readdirSync(dir)) {
			if (UNSTAGED.has(entry) || entry.startsWith(".tmp")) continue
			cpSync(join(dir, entry), join(stage, entry), { recursive: true })
		}
		writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`)
		/* prepack's log and npm's tarball name go to stderr, so stdout carries only the path */
		const built = spawnSync("npm", ["run", "prepack", "--if-present"], { cwd: stage, stdio: ["ignore", 2, 2] })
		if (built.status !== 0) throw new Error(`pack: prepack of ${manifest.name} failed (${built.status})`)
		writeFileSync(join(stage, "package.json"), `${JSON.stringify(shipped, null, "\t")}\n`)
		const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", out], {
			cwd: stage,
			stdio: ["ignore", 2, 2],
		})
		if (packed.status !== 0) throw new Error(`pack: npm pack ${manifest.name} failed (${packed.status})`)
	} finally {
		rmSync(stage, { force: true, recursive: true })
	}
	const tarball = join(out, `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`)
	if (!existsSync(tarball)) throw new Error(`pack: npm pack wrote no ${tarball}`)
	return tarball
}

if (import.meta.main) {
	const [out, ...dirs] = process.argv.slice(2)
	if (out === undefined || dirs.length === 0) {
		console.error("usage: bun scripts/pack.ts <out dir> <package dir>...")
		process.exit(2)
	}
	mkdirSync(resolve(out), { recursive: true })
	for (const dir of dirs) console.log(pack(resolve(dir), resolve(out)))
}
