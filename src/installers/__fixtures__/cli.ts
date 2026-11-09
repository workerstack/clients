/**
 * The installgen CLI's test doubles: an Io that records what the CLI writes, a process whose stdout fails the way a
 * closed pipe does, and the config cli.test.ts builds, checks and publishes, both as source and as an object.
 */
import { PassThrough } from "node:stream"
import type { Io, Proc } from "../cli.ts"
import type { InstallgenConfig } from "../config/define-config.ts"

/** An Io and what was written to its stdout and stderr so far. */
export interface Captured {
	io: Io
	out: () => string
	err: () => string
}

/** An Io over `cwd` on Node that records stdout and stderr; a TTY and the environment only when asked for. */
export function capture(cwd: string, options: { isTTY?: boolean; env?: Record<string, string> } = {}): Captured {
	const out: string[] = []
	const err: string[] = []
	return {
		io: {
			cwd,
			env: options.env ?? {},
			stdout: (t) => void out.push(t),
			stderr: (t) => void err.push(t),
			isTTY: options.isTTY ?? false,
			runtime: { runtime: "node", nodeVersion: "26.0.0" },
		},
		out: () => out.join(""),
		err: () => err.join(""),
	}
}

/** A plain .mjs config: it needs no package import, so it loads in-process (tests/bin.test.ts covers the hook). */
export const configSource = (baseUrl: string, extra = ""): string => `export default {
	name: "my-cli",
	baseUrl: ${JSON.stringify(baseUrl)},
	assetPath: ({ tag, version, os, arch }) => \`\${tag}/my-cli_\${version}_\${os}_\${arch}\${os === "windows" ? ".zip" : ".tar.gz"}\`,
	checksumsPath: ({ tag }) => \`\${tag}/checksums.txt\`,
	${extra}
}
`

/** The same config as an object, for publish() and expected renders. */
export const config = {
	name: "my-cli",
	assetPath: ({ tag, version, os, arch }) =>
		`${tag}/my-cli_${version}_${os}_${arch}${os === "windows" ? ".zip" : ".tar.gz"}`,
	checksumsPath: ({ tag }) => `${tag}/checksums.txt`,
} satisfies Omit<InstallgenConfig, "baseUrl">

/** A write error carrying the errno `code` a stream reports. */
export const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`write ${code}`), { code })

/** A process whose stdout fails on its first write with `error` the way a closed pipe does, and what it recorded. */
export function fakeProc(
	cwd: string,
	error: NodeJS.ErrnoException | undefined,
): { proc: Proc; written: string[]; exits: number[]; errs: string[] } {
	const written: string[] = []
	const exits: number[] = []
	const stdout = new PassThrough()
	stdout.write = ((chunk: string) => {
		written.push(String(chunk))
		if (error) stdout.emit("error", error)
		return true
	}) as typeof stdout.write
	const stderr = new PassThrough()
	const errs: string[] = []
	stderr.write = ((chunk: string) => (errs.push(String(chunk)), true)) as typeof stderr.write
	const proc: Proc = {
		stdout,
		stderr,
		cwd: () => cwd,
		env: {},
		exitCode: undefined,
		exit: (code) => void exits.push(code ?? 0),
	}
	return { proc, written, exits, errs }
}
