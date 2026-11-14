/**
 * A product `acme` in a real git repo for `release bump`: `openapi` is hand-kept, `sdk` is generated, the release
 * config at `<repo>/acme-release/release.config.ts`. The fixture codegen writes the sdk's `gen.txt` from the spec and
 * the version it is asked for (RELEASE_VERSIONS, else the released one), as clients bakes a version into rust and mcp
 * output, plus clients' manifest. It fails on a release run while `fail-codegen` exists. Prod is a loopback server
 * that serves the committed spec unless a test serves another. Bump runs in process, so coverage sees it.
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, expect } from "vitest"
import { release } from "../cli.ts"
import { releaseStateSchema, type ReleaseState } from "../release-state.ts"

/** The release config's dir, repo-relative. */
export const PUBLIC = "acme-release"
/** The generated package's dir, repo-relative. */
export const SDK = `${PUBLIC}/sdk`
/** The hand-kept package's dir, repo-relative. */
export const OPENAPI = `${PUBLIC}/openapi`

/** Each bump runs the fixture codegen twice and may compile oasdiff on first use. */
export const TIMEOUT_MS = 180_000

const CODEGEN = `import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
const sha = (text) => createHash("sha256").update(text).digest("hex")
const versions = process.env.RELEASE_VERSIONS ? JSON.parse(process.env.RELEASE_VERSIONS) : {}
if (process.env.RELEASE_VERSIONS && existsSync("fail-codegen")) process.exit(1)
const dir = "${SDK}"
const state = existsSync(dir + "/.release-state.json")
	? JSON.parse(readFileSync(dir + "/.release-state.json", "utf8")).version
	: "0.1.0"
const text = "version=" + (versions.sdk ?? state) + "\\nspec=" + sha(readFileSync("spec.json", "utf8")) + "\\n"
writeFileSync(dir + "/gen.txt", text)
writeFileSync(dir + "/.clients-generated.json", JSON.stringify({ files: { "gen.txt": sha(text) } }, null, "\\t") + "\\n")
`

/* a spec whose `paths` map each path and method to its operationId */
function specOf(ids: Record<string, Record<string, string>>): string {
	const paths = Object.fromEntries(
		Object.entries(ids).map(([route, methods]) => [
			route,
			Object.fromEntries(
				Object.entries(methods).map(([method, id]) => [
					method,
					{ operationId: id, responses: { "200": { description: "ok" } } },
				]),
			),
		]),
	)
	return `${JSON.stringify({ info: { title: "acme", version: "1" }, openapi: "3.1.0", paths }, null, "\t")}\n`
}
/** The spec the product starts from: one operation. */
export const BASE = /* @__PURE__ */ specOf({ "/v1/widgets": { get: "widget.list" } })
/** BASE with an operation added. */
export const ADDED = /* @__PURE__ */ specOf({ "/v1/widgets": { get: "widget.list", post: "widget.create" } })
/** BASE's operation removed, another added. */
export const REMOVED = /* @__PURE__ */ specOf({ "/v1/other": { get: "other.get" } })

/** A run that exited 0, showing its stderr when it did not. */
export const succeeded = (result: { status: number | null; stderr: string }) =>
	expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 })

/** The `bumped:` lines a run printed. */
export const bumped = (stdout: string) => stdout.match(/^bumped: .*$/gm) ?? []

/** The fixture product of one test: its files, its git, its prod, and its bump. */
export type BumpProject = {
	/** Writes `content` at the repo-relative `relative`. */
	write(relative: string, content: string): Promise<string>
	/** The text at the repo-relative `relative`. */
	read(relative: string): Promise<string>
	/** Deletes the repo-relative `relative`. */
	remove(relative: string): Promise<void>
	/** `git args` in the repo: its stdout. */
	git(...args: string[]): string
	/** Stages everything and commits it as `message`. */
	commit(message: string): void
	/** Runs `release bump --config <config> ...extra` in process. */
	bump(...extra: string[]): Promise<{ status: number | null; stdout: string; stderr: string }>
	/** The parsed `.release-state.json` of the repo-relative package dir `pkg`. */
	state(pkg: string): Promise<ReleaseState>
	/** A first release, bumped and committed. */
	released(): Promise<void>
	/** Makes prod serve `spec` instead of the committed one. */
	serve(spec: string): void
	/** The spec requests prod answered since the last `resetRequests`. */
	requests(): number
	/** Forgets the requests prod answered so far. */
	resetRequests(): void
}

/* `release bump --config <config> ...extra` in process, in `env`: its exit status and output */
async function bumpIn(
	config: string,
	extra: readonly string[],
	env: NodeJS.ProcessEnv,
): Promise<{ status: number; stdout: string; stderr: string }> {
	let [stdout, stderr] = ["", ""]
	const status = await release(
		["bump", "--config", config, ...extra],
		{ err: (text) => void (stderr += text), out: (text) => void (stdout += text) },
		{ env },
	)
	return { status, stderr, stdout }
}

/* the product's first commit: its release config pointing prod at `url`, its codegen, its spec, and two packages */
async function seed(project: BumpProject, url: string): Promise<void> {
	const packages = [
		{ commitMessage: "c", description: "openapi first cut", name: "openapi", repo: "acme/openapi", topics: ["acme"] },
		{
			commitMessage: "c",
			description: "sdk first cut",
			clients: { options: {}, target: "go" },
			name: "sdk",
			repo: "acme/sdk",
			topics: ["acme"],
		},
	]
	const config = {
		codegen: ["node", "codegen.mjs"],
		homepage: "https://example.com",
		packages,
		project: "acme",
		spec: { committedPath: "spec.json", deployedUrl: url },
	}
	await project.write(`${PUBLIC}/release.config.ts`, `export default ${JSON.stringify(config)}\n`)
	await project.write("codegen.mjs", CODEGEN)
	await project.write("spec.json", BASE)
	for (const pkg of [OPENAPI, SDK]) {
		await project.write(`${pkg}/README.md`, "# readme\n")
		await project.write(`${pkg}/package.json`, '{\n\t"name": "@acme/pkg",\n\t"version": "0.1.0"\n}\n')
	}
	project.git("init", "--quiet")
	project.git("config", "user.email", "test@example.com")
	project.git("config", "user.name", "test")
	project.commit("source")
}

/** Registers the fixture product's setup and teardown for each test of the calling file; `env` is what bump runs in. */
export function useBumpProject(env: () => NodeJS.ProcessEnv = () => process.env): BumpProject {
	let workdir = ""
	let server: Server
	let served: string | undefined
	let requests = 0

	const full = (relative: string) => path.join(workdir, relative)
	const project: BumpProject = {
		async write(relative, content) {
			await fs.mkdir(path.dirname(full(relative)), { recursive: true })
			await fs.writeFile(full(relative), content, "utf8")
			return full(relative)
		},
		read: (relative) => fs.readFile(full(relative), "utf8"),
		remove: (relative) => fs.rm(full(relative)),
		git: (...args) => execFileSync("git", args, { cwd: workdir, encoding: "utf8" }),
		commit(message) {
			project.git("add", "-A")
			project.git("commit", "--quiet", "--allow-empty", "-m", message)
		},
		bump: (...extra) => bumpIn(full(`${PUBLIC}/release.config.ts`), extra, env()),
		state: async (pkg) => releaseStateSchema().parse(JSON.parse(await project.read(`${pkg}/.release-state.json`))),
		async released() {
			succeeded(await project.bump())
			project.commit("release")
		},
		serve: (spec) => void (served = spec),
		requests: () => requests,
		resetRequests: () => void (requests = 0),
	}

	beforeEach(async () => {
		workdir = await fs.mkdtemp(path.join(os.tmpdir(), "oss-cli-"))
		served = undefined
		requests = 0
		server = createServer((_req, res) => {
			requests++
			void fs.readFile(full("spec.json"), "utf8").then((committed) => {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(served ?? committed)
			})
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		await seed(project, `http://127.0.0.1:${(server.address() as AddressInfo).port}/openapi/spec.json`)
	})

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()))
		await fs.rm(workdir, { force: true, recursive: true })
	})

	return project
}
