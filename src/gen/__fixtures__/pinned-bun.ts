/**
 * The Bun that package.json's packageManager pins (bit 17 phase i): the bin's legs run under it, never PATH's newest,
 * since a newer Bun parses what the pinned one panics on (1.3.11 on a statement starting with a local named
 * `declare`). Found by CLIENTS_PINNED_BUN, then `mise where bun@<version>`, then ~/.bun/bin/bun, each only at the pinned
 * version; under CLIENTS_REQUIRE_TOOLCHAINS (CI) a missing one is a failure naming the version, elsewhere a skip.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** The repository root's package.json. */
const rootManifest = () => resolve(import.meta.dirname, "../../../package.json")

/** The Bun version package.json's packageManager pins. */
export function pinnedBunVersion(manifest = rootManifest()): string {
	const pin = (JSON.parse(readFileSync(manifest, "utf8")) as { packageManager?: string }).packageManager ?? ""
	const version = /^bun@(\d+\.\d+\.\d+)$/.exec(pin)?.[1]
	if (version === undefined) throw new Error(`package.json's packageManager pins no Bun: ${JSON.stringify(pin)}`)
	return version
}

/** The version `bun --version` prints, or "" when it does not run. */
const versionOf = (bun: string) => spawnSync(bun, ["--version"], { encoding: "utf8" }).stdout?.trim() ?? ""

/** mise's install of Bun `version`, if mise has one. */
function miseBun(version: string, env: NodeJS.ProcessEnv): string | undefined {
	const where = spawnSync("mise", ["where", `bun@${version}`], { encoding: "utf8", env })
	return where.status === 0 ? join(where.stdout.trim(), "bin", "bun") : undefined
}

/**
 * The pinned Bun's path: CLIENTS_PINNED_BUN (refused when it is another version), else mise's, else ~/.bun's, each
 * taken only when it runs and prints `version`; undefined when none does.
 */
export function findPinnedBun(env: NodeJS.ProcessEnv = process.env, version = pinnedBunVersion()): string | undefined {
	const named = env.CLIENTS_PINNED_BUN
	if (named !== undefined && named !== "") {
		const found = versionOf(named)
		if (found !== version)
			throw new Error(`CLIENTS_PINNED_BUN ${named} is Bun ${found || "(not runnable)"}, not the pinned ${version}`)
		return named
	}
	const candidates = [miseBun(version, env), join(env.HOME ?? homedir(), ".bun", "bin", "bun")]
	return candidates.find((bun) => bun !== undefined && existsSync(bun) && versionOf(bun) === version)
}

/** The pinned Bun for a leg: its path, or undefined to skip; a failure instead under CLIENTS_REQUIRE_TOOLCHAINS. */
export function withPinnedBun(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const bun = findPinnedBun(env)
	if (bun === undefined && env.CLIENTS_REQUIRE_TOOLCHAINS === "1") {
		const version = pinnedBunVersion()
		throw new Error(
			`Bun ${version} (package.json's packageManager) is required here and is not found: set CLIENTS_PINNED_BUN, or run mise install bun@${version}`,
		)
	}
	return bun
}
