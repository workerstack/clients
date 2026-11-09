import { spawn } from "node:child_process"

interface GitResult {
	exitCode: number
	stderr: string
	stdout: string
}

/*
 * The variables git exports to a hook, which every child process inherits. A `cwd` does not
 * override them: with GIT_DIR set, `git init` in a sandbox re-initialises the enclosing repository
 * and a commit lands there. The pre-push hook runs this package's tests, so they have to be
 * cleared or a test's sandbox writes into the repository being pushed.
 */
const INHERITED_GIT_VARS = [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_NAMESPACE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_PREFIX",
	"GIT_WORK_TREE",
] as const

function envForCwd(): NodeJS.ProcessEnv {
	const env = { ...process.env }
	for (const key of INHERITED_GIT_VARS) delete env[key]
	return env
}

function runGit(args: string[], cwd: string): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		const proc = spawn("git", args, { cwd, env: envForCwd(), stdio: ["ignore", "pipe", "pipe"] })
		let stdout = ""
		let stderr = ""
		proc.stdout.on("data", (chunk) => (stdout += chunk))
		proc.stderr.on("data", (chunk) => (stderr += chunk))
		proc.on("error", reject)
		proc.on("close", (code) => resolve({ exitCode: code ?? 1, stderr, stdout }))
	})
}

/** `git args` in `cwd`: its trimmed stdout; throws with its stderr when it exits non-zero. */
export async function gitOutput(args: string[], cwd: string): Promise<string> {
	const result = await runGit(args, cwd)
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`)
	}
	return result.stdout.trim()
}

/** `git args` in `cwd`, for its effect; throws with its stderr when it exits non-zero. */
export async function gitRun(args: string[], cwd: string): Promise<void> {
	await gitOutput(args, cwd)
}

/** `git args` in `cwd`: its exit code, whatever it is. */
export async function gitExitCode(args: string[], cwd: string): Promise<number> {
	return (await runGit(args, cwd)).exitCode
}

/** The commit `branch` points at on the remote `mirrorUrl`; undefined when the remote or the branch is not there. */
export async function getRemoteTip(mirrorUrl: string, branch: string, cwd: string): Promise<string | undefined> {
	const result = await runGit(["ls-remote", mirrorUrl, `refs/heads/${branch}`], cwd)
	if (result.exitCode !== 0) return undefined
	const line = result.stdout.trim()
	if (!line) return undefined
	return line.split("\t")[0]
}

/** A GitHub SSH remote as the token-authenticated https URL every push uses; any other URL is left as it is. */
export function sshToHttps(sshUrl: string, token: string): string {
	return sshUrl.replace(/^git@github\.com:/, `https://x-access-token:${token}@github.com/`)
}
