#!/usr/bin/env bun
/**
 * The generated CLI's release path, end to end (roadmap 14 slice 3): a fixture spec through `clients generate
 * --target cli`, a goreleaser snapshot of the generated module (signed keyless by cosign when a GitHub OIDC token is
 * available), the release served from loopback, `installgen check` and `installgen build` from this package's packed
 * tarball against a fixture config whose base is that server and whose identity is this workflow run, then install.sh
 * installing the binary (verifying the signature when signed), the binary's `--version`, and install.sh refusing a
 * tampered checksums.txt. Every run works in fresh temporary directories.
 *
 *   bun scripts/e2e-snapshot.ts                            # local: the signature leg is skipped
 *   E2E_REQUIRE_SIGNATURE=1 bun scripts/e2e-snapshot.ts    # CI (id-token: write): signed and verified
 */
import { spawn, spawnSync, type SpawnOptions } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { shop } from "../src/emit/cli/__fixtures__/shop.ts"

const ROOT = resolve(import.meta.dirname, "..")
const TAG = "v1.2.3"
const BIN = "shop"
const REPO = "workerstack/clients"
const ISSUER = "https://token.actions.githubusercontent.com"
const ARCH = ({ arm64: "arm64", x64: "amd64" } as Record<string, string>)[process.arch]
const OS = ({ darwin: "darwin", linux: "linux" } as Record<string, string>)[process.platform]

const say = (line: string) => console.log(`e2e-snapshot: ${line}`)
const die = (line: string): never => {
	console.error(`e2e-snapshot: ${line}`)
	process.exit(1)
}

/** A command run to its end without blocking: the loopback server answers from this same event loop. */
function run(command: string, args: readonly string[], options: SpawnOptions = {}) {
	return new Promise<{ status: number; stdout: string; stderr: string }>((done) => {
		const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] })
		let stdout = ""
		let stderr = ""
		child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
		child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
		child.on("error", (error) => done({ status: 127, stderr: error.message, stdout }))
		child.on("close", (code) => done({ status: code ?? 1, stderr, stdout }))
	})
}

/** Runs one step's command; a non-zero exit ends the run with the step's name and the command's output. */
async function step(
	name: string,
	command: string,
	args: readonly string[],
	options: SpawnOptions = {},
): Promise<string> {
	const ran = await run(command, args, options)
	if (ran.status !== 0) die(`step "${name}" failed (exit ${ran.status}):\n${ran.stderr}${ran.stdout}`)
	return ran.stdout
}

const scratch = (name: string) => mkdtempSync(join(tmpdir(), `e2e-snapshot-${name}-`))

/** The goreleaser this run builds with: $GORELEASER, PATH's (CI installs the pinned one), or the pinned tools cache. */
function goreleaser(): string {
	if (process.env.GORELEASER) return process.env.GORELEASER
	const found = spawnSync("sh", ["-c", "command -v goreleaser"], { encoding: "utf8" })
	if (found.status === 0) return found.stdout.trim()
	const cached = join(homedir(), ".cache/backend-tmp/tools/goreleaser-2.18.3/goreleaser")
	return existsSync(cached) ? cached : die("goreleaser not found: install v2.18.3 or set GORELEASER")
}

/** A loopback server answering the release's paths, as GitHub serves a release; its base URL once listening. */
async function serve(files: Map<string, Buffer>): Promise<{ server: Server; base: string }> {
	const server = createServer((request, response) => {
		const body = files.get(request.url ?? "")
		response.writeHead(body === undefined ? 404 : 200)
		response.end(body)
	})
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
	const address = server.address()
	const port = typeof address === "object" && address !== null ? address.port : die("the server has no port")
	return { base: `http://127.0.0.1:${port}`, server }
}

/** The fixture config: the generated layout with the loopback base, signed by this workflow run when `identity`. */
function fixtureConfig(base: string, identity: string | undefined): string {
	const signature =
		identity === undefined
			? ""
			: `\tsignature: { identity: () => ${JSON.stringify(identity)}, issuer: ${JSON.stringify(ISSUER)} },\n`
	return `import type { InstallgenConfig } from "@workerstack/clients/installers"

export default {
	assetPath: ({ arch, os, tag }) => \`download/\${tag}/${BIN}_\${os}_\${arch}\${os === "windows" ? ".zip" : ".tar.gz"}\`,
	baseUrl: ${JSON.stringify(base)},
	checksumsPath: ({ tag }) => \`download/\${tag}/checksums.txt\`,
	envPrefix: "SHOP",
	installDir: "~/.local/bin",
	latestPath: "latest/download/version.txt",
	name: ${JSON.stringify(BIN)},
	scriptUrls: { ps1: ${JSON.stringify(`${base}/install.ps1`)}, sh: ${JSON.stringify(`${base}/install.sh`)} },
${signature}} satisfies InstallgenConfig
`
}

/** install.sh run with sh into a fresh install dir, cosign reachable only when the run verifies a signature. */
async function install(script: string, verify: boolean): Promise<{ status: number; out: string; dir: string }> {
	const home = scratch("home")
	const dir = join(home, "bin")
	const env: Record<string, string> = {
		HOME: home,
		PATH: process.env.PATH ?? "",
		SHOP_INSTALL_DIR: dir,
		SHOP_NO_MODIFY_PATH: "1",
		...(verify && { SHOP_INSTALL_VERIFY: "require" }),
	}
	const ran = await run("sh", [script], { env })
	return { dir, out: `${ran.stdout}${ran.stderr}`, status: ran.status }
}

async function main(): Promise<void> {
	if (OS === undefined || ARCH === undefined) die(`no release archive for ${process.platform}/${process.arch}`)
	const oidc = process.env.ACTIONS_ID_TOKEN_REQUEST_URL !== undefined && process.env.GITHUB_WORKFLOW_REF !== undefined
	if (process.env.E2E_REQUIRE_SIGNATURE === "1" && !oidc) {
		die(
			"E2E_REQUIRE_SIGNATURE=1 but no GitHub OIDC token (ACTIONS_ID_TOKEN_REQUEST_URL unset); run it in CI with id-token: write",
		)
	}

	/* the module, generated from the fixture spec */
	const work = scratch("cli")
	const spec = join(work, "spec.json")
	writeFileSync(spec, JSON.stringify(shop()))
	const out = join(work, "out")
	await step("generate", process.execPath, [
		join(ROOT, "bin/clients.js"),
		"generate",
		"--spec",
		spec,
		"--target",
		"cli",
		"--out",
		out,
		"--cli-repo",
		REPO,
		"--cli-binary-name",
		BIN,
		"--cli-module-path",
		"github.com/workerstack/clients-e2e/shop",
		"--cli-base-url",
		"https://shop.example.com",
	])
	const module = join(out, "cli")
	say(`generated cli into ${module}`)

	/* a tagged snapshot release of it */
	const git = (...args: string[]) =>
		step(`git ${args[0]}`, "git", ["-c", "user.name=e2e", "-c", "user.email=e2e@localhost", ...args], { cwd: module })
	await git("init", "-q")
	await git("add", "-A")
	await git("commit", "-qm", "e2e snapshot")
	await git("tag", TAG)
	/* without a remote goreleaser's git state fails, and a snapshot then falls back to v0.0.0 instead of the tag */
	await git("remote", "add", "origin", `https://github.com/${REPO}.git`)
	await step(
		"goreleaser snapshot",
		goreleaser(),
		["release", "--snapshot", "--clean", ...(oidc ? [] : ["--skip=sign"])],
		{
			cwd: module,
		},
	)
	say(
		`goreleaser snapshot (${oidc ? "checksums.txt signed keyless by this run" : "signature leg skipped: no GitHub OIDC token"})`,
	)

	/* served as GitHub serves a release: the archives under the tag, version.txt under latest */
	const dist = join(module, "dist")
	const files = new Map<string, Buffer>([["/latest/download/version.txt", readFileSync(join(module, "version.txt"))]])
	for (const name of readdirSync(dist)) {
		if (/\.(tar\.gz|zip|txt|json)$/.test(name)) files.set(`/download/${TAG}/${name}`, readFileSync(join(dist, name)))
	}
	if (oidc && !files.has(`/download/${TAG}/checksums.txt.sigstore.json`))
		die("the signed run wrote no checksums.txt.sigstore.json")
	const { base, server } = await serve(files)
	try {
		/* this package as npm ships it, packed the way release.yml publishes it */
		const packed = await step("pack", "bun", [join(ROOT, "scripts/pack.ts"), scratch("pack"), ROOT])
		const tarball = packed.trim().split("\n").at(-1) ?? die("scripts/pack.ts printed no tarball")
		const npx = (name: string, args: readonly string[], cwd: string) =>
			step(name, "npx", ["--yes", "--package", tarball, "installgen", ...args], { cwd })

		/* installgen from the tarball, on the fixture config */
		const configDir = scratch("config")
		const identity = oidc ? `https://github.com/${process.env.GITHUB_WORKFLOW_REF}` : undefined
		writeFileSync(join(configDir, "installgen.config.mts"), fixtureConfig(base, identity))
		await npx("installgen check", ["check", "--default-version", TAG], configDir)
		say(`installgen check passed against ${base}`)
		await npx("installgen build", ["build", "--out", "rendered"], configDir)
		const script = join(configDir, "rendered/install.sh")

		/* install.sh installs the release's binary, verified when signed */
		const installed = await install(script, oidc)
		if (installed.status !== 0) die(`step "install.sh" failed (exit ${installed.status}):\n${installed.out}`)
		if (oidc && !installed.out.includes("Signed"))
			die(`install.sh did not report the signature verified:\n${installed.out}`)
		const version = (await step("shop --version", join(installed.dir, BIN), ["--version"])).trim()
		if (version !== TAG) die(`the installed binary reports ${JSON.stringify(version)}, not ${TAG}`)
		say(
			`install.sh installed ${BIN}, --version ${version} (${oidc ? "signature verified, VERIFY=require" : "signature not verified"})`,
		)

		/* and refuses a release whose checksums.txt does not match the archive */
		const checksums = `/download/${TAG}/checksums.txt`
		const original = files.get(checksums) ?? die("no checksums.txt in the release")
		files.set(checksums, Buffer.from(original.toString().replace(/^([0-9a-f])/gm, (d) => (d === "0" ? "1" : "0"))))
		const tampered = await install(script, false)
		if (tampered.status === 0) die(`install.sh installed from a tampered checksums.txt:\n${tampered.out}`)
		say("install.sh refused a tampered checksums.txt")
	} finally {
		server.close()
	}
}

await main()
