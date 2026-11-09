#!/usr/bin/env bun
// `bun scripts/pack.ts <out dir> <package dir>...`: each package's tarball as npm publishes it, its path printed per
// line. Each package is packed from a staged copy: prepack builds dist/ in the copy, so the checkout never gets one.
// The build reads the checkout's `honey-source` condition, but the tarball ships no src/, so the manifest npm packs
// drops every `honey-source` key: a process that sets the condition would otherwise resolve an install to a missing
// file. release.yml's pack job packs here (bit 19 i).
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

type Manifest = { name: string; version: string; exports?: unknown; imports?: unknown }

const UNSTAGED = new Set(["coverage", "dist", "node_modules", "tests"])

const read = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest

/** The manifest npm publishes: the package's own, which pins exact versions (no catalog, no workspace). */
function published(dir: string): Manifest {
	return read(dir)
}

/** `entry` (an `exports` or `imports` value) without its `honey-source` conditions, at any depth. */
function withoutSource(entry: unknown): unknown {
	if (entry === null || typeof entry !== "object") return entry
	if (Array.isArray(entry)) return entry.map(withoutSource)
	return Object.fromEntries(
		Object.entries(entry).flatMap(([key, value]) => (key === "honey-source" ? [] : [[key, withoutSource(value)]])),
	)
}

/** The tarball of the package at `dir`, packed into `out` from a copy staged inside the package. */
function pack(dir: string, out: string): string {
	const manifest = published(dir)
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
		const shipped = { ...manifest, exports: withoutSource(manifest.exports), imports: withoutSource(manifest.imports) }
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
