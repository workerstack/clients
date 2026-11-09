import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, expect } from "vitest"
import type { InstallgenConfig } from "../../../src/installers/config/define-config.ts"
import { fakeBinary, publish, startServer, type ReleaseOptions, type TestServer } from "./server.ts"
import { runners, shPipeline, type Runner, type RunResult } from "./shells.ts"

/* What install-sh.test.ts and its case modules share: one server per test file, sandboxes, and the install pipeline. */

export const SH_RUNNERS = runners().filter((r) => r.kind === "sh")
export const HOST = `${process.platform === "darwin" ? "darwin" : "linux"}/${process.arch === "arm64" ? "arm64" : "amd64"}`

export const CHECK = "✓"
export const ERASE = "\x1b[1A\x1b[2K"

export const config = {
	name: "my-cli",
	assetPath: ({ tag, version, os, arch }) =>
		`${tag}/my-cli_${version}_${os}_${arch}${os === "windows" ? ".zip" : ".tar.gz"}`,
	checksumsPath: ({ tag }) => `${tag}/checksums.txt`,
} satisfies Omit<InstallgenConfig, "baseUrl">
const { checksumsPath: _checksums, ...unchecked } = config
export const noChecksums = unchecked
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
	shims: string
}

export function sandbox(): Sandbox {
	const root = mkdtempSync(join(tmpdir(), "installgen-sh-"))
	roots.push(root)
	const home = join(root, "home")
	const shims = join(root, "shims")
	mkdirSync(home)
	mkdirSync(shims)
	return { root, home, shims }
}

export function shim(box: Sandbox, name: string, body: string): void {
	writeFileSync(join(box.shims, name), `#!/bin/sh\n${body}\n`)
	chmodSync(join(box.shims, name), 0o755)
}

export function release(options: Partial<Omit<ReleaseOptions, "prefix">> = {}) {
	return publish(server, { prefix: `/c${++cases}`, config, versions: ["1.2.0", "1.2.3"], ...options })
}

export interface InstallOptions {
	args?: string[]
	env?: Record<string, string>
	tty?: boolean
	/** Replace PATH with symlinks to just these tools. */
	only?: readonly string[]
}

export function install(runner: Runner, box: Sandbox, url: string, options: InstallOptions = {}): Promise<RunResult> {
	let command = shPipeline(runner, url, options.args)
	if (options.only) {
		const tools = options.only.join(" ")
		command =
			`R="$PWD/restricted"; mkdir -p "$R"; for t in ${tools}; do p=$(command -v "$t") && ln -sf "$p" "$R/$t"; done; ` +
			`PATH="$R"; export PATH; ${command}`
	}
	return runner.run({
		command,
		cwd: box.root,
		tty: options.tty,
		env: { HOME: box.home, PATH: `${box.shims}:${runner.systemPath}`, SHELL: "/bin/sh", ...options.env },
	})
}

export const prefixOf = (rel: { baseUrl: string }) => rel.baseUrl.slice(server.url.length)
export const assetRequested = (rel: { baseUrl: string; asset(p: string, v: string): string }) =>
	server.requested(prefixOf(rel)).includes(rel.asset(HOST, "1.2.3"))
export const target = (box: Sandbox) => join(box.home, ".my-cli/bin/my-cli")
export const output = (r: RunResult) => r.stdout + r.stderr
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g")
export const plain = (text: string) => text.replaceAll(ANSI, "").replaceAll("\r", "")

export function expectInstalled(
	box: Sandbox,
	version: string,
	os = HOST.split("/")[0] as "linux" | "darwin",
	path = target(box),
) {
	expect(readFileSync(path)).toEqual(fakeBinary("my-cli", version, os))
	expect(statSync(path).mode & 0o111).not.toBe(0)
}

/* Every tool the script and the pipeline use, for the restricted-PATH cases */
export const TOOLS = [
	"sh",
	"dash",
	"bash",
	"zsh",
	"curl",
	"wget",
	"uname",
	"mkdir",
	"mktemp",
	"rm",
	"mv",
	"cp",
	"chmod",
	"cat",
	"tr",
	"awk",
	"head",
	"basename",
	"dirname",
	"find",
	"grep",
	"sed",
	"printf",
	"gzip",
	"tar",
	"unzip",
	"sha256sum",
	"shasum",
	"openssl",
	"sysctl",
	"id",
	"sort",
	"wc",
	"ls",
	"sleep",
]
