import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterAll, beforeAll, expect } from "vitest"
import type { InstallgenConfig } from "../../../src/installers/config/define-config.ts"
import { fakeCosign } from "./cosign.ts"
import { fakeBinary, publish, startServer, type ReleaseOptions, type TestServer } from "./server.ts"
import { runners, type Runner, type RunResult } from "./shells.ts"

/* What install-ps1.test.ts and its case modules share: one server per test file, sandboxes, and the iex pipeline. */

export const PS_RUNNERS = runners().filter((r) => r.kind === "ps1")
export const WIN = process.platform === "win32"
/* Windows reads the arch from the registry; other hosts are the pwsh test seam and install the Windows build too */
export const ARCH = process.arch === "arm64" ? "arm64" : "amd64"

export const config = {
	name: "my-cli",
	assetPath: ({ tag, version, os, arch }) =>
		`${tag}/my-cli_${version}_${os}_${arch}${os === "windows" ? ".zip" : ".tar.gz"}`,
	checksumsPath: ({ tag }) => `${tag}/checksums.txt`,
} satisfies Omit<InstallgenConfig, "baseUrl">
export const IDENTITY = "https://github.com/acme/my-cli/.github/workflows/release.yml@refs/tags/"
export const signed = {
	...config,
	signature: { identity: ({ tag }) => `${IDENTITY}${tag}` },
} satisfies Omit<InstallgenConfig, "baseUrl">

/** The file's release server: a live binding, set by serveSuite's beforeAll. */
export let server: TestServer
let cases = 0
const roots: string[] = []

/** Starts the server before the file's tests and removes it and every sandbox after them. */
export function serveSuite(): void {
	beforeAll(async () => {
		server = await startServer()
	})
	afterAll(async () => {
		await server.close()
	})
	afterAll(() => {
		for (const r of roots) rmSync(r, { recursive: true, force: true })
	})
}

export interface Sandbox {
	root: string
	home: string
}

export function sandbox(): Sandbox {
	const root = mkdtempSync(join(tmpdir(), "installgen-ps1-"))
	roots.push(root)
	const home = join(root, "home")
	mkdirSync(home)
	return { root, home }
}

export function release(options: Partial<Omit<ReleaseOptions, "prefix">> = {}) {
	return publish(server, { prefix: `/p${++cases}`, config, versions: ["1.2.0", "1.2.3"], ...options })
}

export const q = (s: string) => `'${s.replaceAll("'", "''")}'`

export interface InstallOptions {
	/** `-Version` through `iex "& {$(irm …)} -Version X"`. */
	version?: string
	env?: Record<string, string>
	/** PowerShell run after the install, in the same session. */
	after?: string
	/** Let the script edit PATH. On Windows that is the registry, so it is off unless a test asks (and restores it). */
	modify?: boolean
}

export function install(runner: Runner, box: Sandbox, url: string, options: InstallOptions = {}): Promise<RunResult> {
	const run =
		options.version === undefined ? `irm ${q(url)} | iex` : `iex "& {$(irm ${q(url)})} -Version ${options.version}"`
	const command = options.after === undefined ? run : `${run}; ${options.after}`
	/* USERPROFILE is what GetFolderPath('UserProfile') reads on Windows; HOME on the other hosts */
	return runner.run({
		command,
		cwd: box.root,
		env: {
			HOME: box.home,
			USERPROFILE: box.home,
			PATH: runner.systemPath,
			...(WIN ? { TEMP: box.root, TMP: box.root } : {}),
			...(WIN && !options.modify ? { MY_CLI_NO_MODIFY_PATH: "1" } : {}),
			/* GetFolderPath('UserProfile') reads the real profile on Windows, not USERPROFILE: point the install into the sandbox */
			...(WIN ? { MY_CLI_INSTALL_DIR: join(box.home, ".my-cli", "bin") } : {}),
			...options.env,
		},
	})
}

export const userPath = async (r: Runner) =>
	(
		await r.run({
			command:
				"[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
			cwd: tmpdir(),
			env: { PATH: r.systemPath, SystemRoot: process.env.SystemRoot ?? "C:\\Windows" },
		})
	).stdout.trim()

/** Runs `fn` and puts the registry user PATH back afterwards (Windows); elsewhere just runs it. */
export async function keepingUserPath(runner: Runner, fn: () => Promise<void>): Promise<void> {
	if (!WIN) return fn()
	const env = { PATH: runner.systemPath, SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }
	const read =
		"[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')"
	const before = (await runner.run({ command: read, cwd: tmpdir(), env })).stdout.trim()
	try {
		await fn()
	} finally {
		await runner.run({
			command: `[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true).SetValue('Path', ${q(before)}, 'ExpandString')`,
			cwd: tmpdir(),
			env,
		})
	}
}

/** A fake cosign in its own dir ahead of PATH: a .cmd on Windows, a sh script under Docker pwsh. */
export function withCosign(runner: Runner, box: Sandbox): { shims: string; env: Record<string, string> } {
	const shims = join(box.root, "shims")
	mkdirSync(shims, { recursive: true })
	fakeCosign(shims, WIN)
	return { shims, env: { PATH: `${shims}${delimiter}${runner.systemPath}` } }
}
/* PowerShell's error view wraps a long message at the console width, anywhere in it */
export const unwrapped = (text: string) => text.replaceAll(/\s+/g, "")
export const prefixOf = (rel: { baseUrl: string }) => rel.baseUrl.slice(server.url.length)
export const assetRequested = (rel: { baseUrl: string; asset(p: string, v: string): string }) =>
	server.requested(prefixOf(rel)).includes(rel.asset(`windows/${ARCH}`, "1.2.3"))
export const target = (box: Sandbox) => join(box.home, ".my-cli", "bin", "my-cli.exe")
export const output = (r: RunResult) => r.stdout + r.stderr

export function expectInstalled(box: Sandbox, version: string) {
	expect(readFileSync(target(box))).toEqual(fakeBinary("my-cli", version, "windows"))
}
