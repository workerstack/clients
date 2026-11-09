import type { ResolvedConfig, ResolvedPlatform, Segment } from "../config/types.ts"
import { InstallgenError } from "../errors.ts"
import type { Ui } from "../ui.ts"
import { loadResolved, warnUnverified, type ConfigOptions } from "./build.ts"

export interface CheckOptions extends ConfigOptions {
	defaultVersion: string | undefined
	list: boolean
	fetch?: typeof fetch
}

/* the same rules the scripts apply at install time */
const VERSION = /^[A-Za-z0-9._+-]+$/
const TIMEOUT_MS = 15_000

function expand(segments: readonly Segment[], version: string, tag: string): string {
	return segments.map((s) => (s.kind === "literal" ? s.value : s.kind === "version" ? version : tag)).join("")
}

/** `hash  file`, `hash *file`, BSD `SHA256 (file) = hash`, or a file holding one bare hash. */
export function findChecksum(text: string, file: string): string | undefined {
	const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "")
	for (const line of lines) {
		const fields = line.trim().split(/\s+/)
		if (fields[0] === "SHA256" && fields[1] === `(${file})` && fields[2] === "=") return fields[3]
		if (fields.length >= 2 && fields[1]?.replace(/^\*/, "") === file) return fields[0]
	}
	const only = lines.length === 1 ? lines[0]?.trim().split(/\s+/) : undefined
	return only?.length === 1 ? only[0] : undefined
}

type Probe = { ok: true; body: string } | { ok: false; reason: string }

/* fetch rejects with a TypeError whose cause says why (ECONNREFUSED, a timeout) */
function failure(error: unknown): string {
	const e = error as Error
	return e.cause instanceof Error ? `${e.message}: ${e.cause.message}` : e.message
}

/** Strip whitespace and the tag prefix, then validate, as the scripts do. */
function normalize(raw: string, tagPrefix: string, what: string): string {
	let version = raw.replaceAll(/\s/g, "")
	if (version.startsWith(tagPrefix)) version = version.slice(tagPrefix.length)
	if (!VERSION.test(version)) throw new InstallgenError(`invalid ${what} version ${JSON.stringify(version)}`)
	return version
}

type Get = (url: string, init?: RequestInit) => Promise<Response>

interface Probes {
	/** undefined when the file is there, else the row that says why not. */
	exists(url: string): Promise<string | undefined>
	/** One fetch per checksums URL, shared by every platform that lists it. */
	checksums(url: string): Promise<Probe>
}

function probesFor(get: Get): Probes {
	const sums = new Map<string, Promise<Probe>>()
	return {
		/* HEAD first; hosts that refuse it get a one-byte ranged GET */
		async exists(url) {
			try {
				const head = await get(url, { method: "HEAD" })
				if (head.ok) return undefined
				const ranged = await get(url, { headers: { range: "bytes=0-0" } })
				await ranged.arrayBuffer()
				return ranged.ok ? undefined : `missing ${url} (${ranged.status})`
			} catch (error) {
				return `unreachable ${url}: ${failure(error)}`
			}
		},
		checksums(url) {
			let probe = sums.get(url)
			if (probe === undefined) {
				probe = get(url).then(
					async (res): Promise<Probe> =>
						res.ok ? { ok: true, body: await res.text() } : { ok: false, reason: `missing ${url} (${res.status})` },
					(error: unknown): Probe => ({ ok: false, reason: `unreachable ${url}: ${failure(error)}` }),
				)
				sums.set(url, probe)
			}
			return probe
		},
	}
}

interface Release {
	resolved: ResolvedConfig
	version: string
	tag: string
	probes: Probes
	ui: Ui
}

/** The checksum row of one platform: what it found, or undefined after reporting the problem. */
async function checksumRow(
	platform: ResolvedPlatform["platform"],
	checksums: readonly Segment[],
	asset: string,
	run: Release,
): Promise<string | undefined> {
	const { resolved, version, tag, probes, ui } = run
	const sumsUrl = `${resolved.baseUrl}/${expand(checksums, version, tag)}`
	const file = asset.slice(asset.lastIndexOf("/") + 1)
	const probe = await probes.checksums(sumsUrl)
	if (!probe.ok) ui.bad(platform, probe.reason)
	else if (findChecksum(probe.body, file) === undefined) ui.bad(platform, `no checksum for ${file} in ${sumsUrl}`)
	else return "sha256 listed"
	return undefined
}

/** Checks one platform's files, reports each problem as a row, and returns how many there were. */
async function checkPlatform(p: ResolvedPlatform, run: Release): Promise<number> {
	const { resolved, version, tag, probes, ui } = run
	const asset = expand(p.asset, version, tag)
	const assetUrl = `${resolved.baseUrl}/${asset}`
	const found: string[] = []
	let problems = 0
	const missing = await probes.exists(assetUrl)
	if (missing === undefined) found.push(assetUrl)
	else {
		problems++
		ui.bad(p.platform, missing)
	}
	if (p.checksums !== undefined) {
		const row = await checksumRow(p.platform, p.checksums, asset, run)
		if (row === undefined) problems++
		else found.push(row)
	}
	if (p.signature !== undefined) {
		const missingBundle = await probes.exists(`${resolved.baseUrl}/${expand(p.signature.bundle, version, tag)}`)
		if (missingBundle === undefined) found.push("signature bundle")
		else {
			problems++
			ui.bad(p.platform, missingBundle)
		}
	}
	const expected = 1 + (p.checksums === undefined ? 0 : 1) + (p.signature === undefined ? 0 : 1)
	if (found.length === expected) ui.ok(p.platform, found.join(", "))
	return problems
}

export async function check(options: CheckOptions, ui: Ui): Promise<number> {
	const resolved = await loadResolved(options)
	const doFetch = options.fetch ?? fetch
	const get: Get = (url, init = {}) =>
		doFetch(url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS), ...init })

	if (options.list) {
		list(resolved, options.defaultVersion, ui)
		return 0
	}
	warnUnverified(resolved, ui)

	const version = await resolveVersion(resolved, options.defaultVersion, get, ui)
	const run: Release = { resolved, version, tag: resolved.tagPrefix + version, probes: probesFor(get), ui }

	let problems = 0
	for (const p of resolved.platforms) problems += await checkPlatform(p, run)
	if (problems === 0) ui.info(`all ${resolved.platforms.length} platforms ok for ${version}`)
	else ui.info(`${problems} problem${problems === 1 ? "" : "s"}`)
	return problems
}

async function resolveVersion(
	resolved: ResolvedConfig,
	defaultVersion: string | undefined,
	get: (url: string) => Promise<Response>,
	ui: Ui,
): Promise<string> {
	if (defaultVersion !== undefined) return normalize(defaultVersion, resolved.tagPrefix, "default")
	const latestUrl = `${resolved.baseUrl}/${resolved.latestPath}`
	let res: Response
	try {
		res = await get(latestUrl)
	} catch (error) {
		throw new InstallgenError(`could not read the latest version from ${latestUrl}: ${failure(error)}`)
	}
	if (!res.ok) throw new InstallgenError(`could not read the latest version from ${latestUrl} (${res.status})`)
	const version = normalize(await res.text(), resolved.tagPrefix, "latest")
	ui.ok("latest", `${version} (${latestUrl})`)
	return version
}

function list(resolved: ResolvedConfig, defaultVersion: string | undefined, ui: Ui): void {
	const version = defaultVersion === undefined ? "{version}" : normalize(defaultVersion, resolved.tagPrefix, "default")
	const tag = defaultVersion === undefined ? "{tag}" : resolved.tagPrefix + version
	ui.info(`latest ${resolved.baseUrl}/${resolved.latestPath}`)
	for (const p of resolved.platforms) {
		ui.info(`${p.platform} ${resolved.baseUrl}/${expand(p.asset, version, tag)}`)
		if (p.checksums !== undefined) ui.info(`${p.platform} ${resolved.baseUrl}/${expand(p.checksums, version, tag)}`)
		if (p.signature !== undefined) {
			ui.info(`${p.platform} ${resolved.baseUrl}/${expand(p.signature.bundle, version, tag)}`)
		}
	}
}
