import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import {
	CHECK,
	config,
	ERASE,
	expectInstalled,
	HOST,
	install,
	output,
	plain,
	release,
	sandbox,
	server,
	shim,
	target,
	TOOLS,
} from "./sh-harness.ts"
import type { Runner } from "./shells.ts"

/* install.sh's cases on the host: tools, platforms, PATH and output, registered by install-sh.test.ts per runner. */

/** A missing tool fails, naming it, before the download. */
export function preflightCases(runner: Runner): void {
	const shell = runner.shell.split(" ")[0] as string
	test("a missing tar fails with the tool named, before downloading", async () => {
		const box = sandbox()
		const rel = release()
		const r = await install(runner, box, rel.shUrl, { only: [...TOOLS.filter((t) => t !== "tar"), shell, "busybox"] })
		expect(r.status).not.toBe(0)
		expect(r.stderr).toContain("tar is required")
		expect(server.requested(rel.baseUrl.slice(server.url.length))).not.toContain(rel.asset(HOST, "1.2.3"))
	})

	test("no hashing tool fails when checksums are configured", async () => {
		const box = sandbox()
		const rel = release()
		const hashers = ["sha256sum", "shasum", "openssl"]
		const r = await install(runner, box, rel.shUrl, { only: [...TOOLS.filter((t) => !hashers.includes(t)), shell] })
		expect(r.status).not.toBe(0)
		expect(r.stderr).toContain("sha256sum, shasum or openssl is required")
	})

	test("no unzip, busybox or bsdtar fails for a zip", async () => {
		const box = sandbox()
		const rel = release({
			config: { ...config, assetPath: ({ tag, version, os, arch }) => `${tag}/my-cli_${version}_${os}_${arch}.zip` },
		})
		const r = await install(runner, box, rel.shUrl, { only: [...TOOLS.filter((t) => t !== "unzip"), shell] })
		expect(r.status).not.toBe(0)
		expect(r.stderr).toContain("unzip is required")
	})
}

/** Unsupported, missing, Windows-shell and Rosetta platforms. */
export function platformCases(runner: Runner): void {
	test("an unsupported platform fails", async () => {
		const box = sandbox()
		shim(box, "uname", 'case "$1" in -m) echo riscv64 ;; *) echo Linux ;; esac')
		const rel = release()
		const r = await install(runner, box, rel.shUrl)
		expect(r.status).not.toBe(0)
		expect(r.stderr).toContain("unsupported architecture: riscv64")
	})

	test("a platform the release does not ship fails", async () => {
		const box = sandbox()
		shim(box, "uname", 'case "$1" in -m) echo aarch64 ;; *) echo Linux ;; esac')
		const rel = release({ config: { ...config, platforms: ["linux/amd64", "windows/amd64"] } })
		const r = await install(runner, box, rel.shUrl)
		expect(r.status).not.toBe(0)
		expect(r.stderr).toContain("no my-cli build for linux/arm64")
	})

	test.each(["MINGW64_NT-10.0-19045", "MSYS_NT-10.0", "CYGWIN_NT-10.0"])(
		"%s prints the ps1 one-liner",
		async (uname) => {
			const box = sandbox()
			shim(box, "uname", `case "$1" in -m) echo x86_64 ;; *) echo ${uname} ;; esac`)
			const rel = release()
			const r = await install(runner, box, rel.shUrl)
			expect(r.status).not.toBe(0)
			expect(output(r)).toContain(`powershell -c "irm ${rel.ps1Url} | iex"`)
			expect(existsSync(join(box.home, ".my-cli"))).toBe(false)
		},
	)

	test("darwin arm64 without a native build falls back to amd64 with a Rosetta warning", async () => {
		const box = sandbox()
		shim(box, "uname", 'case "$1" in -m) echo arm64 ;; *) echo Darwin ;; esac')
		shim(box, "sysctl", "echo 0")
		shim(box, "xattr", `printf '%s\\n' "$*" >> "${box.root}/xattr.log"`)
		const rel = release({ config: { ...config, platforms: ["darwin/amd64", "linux/amd64"] } })
		const r = await install(runner, box, rel.shUrl, { env: { SHELL: "/bin/bash" } })
		expect(r.status, output(r)).toBe(0)
		expect(output(r)).toContain("Rosetta 2")
		expectInstalled(box, "1.2.3", "darwin")
		expect(server.requested(rel.baseUrl.slice(server.url.length))).toContain(rel.asset("darwin/amd64", "1.2.3"))
		expect(readFileSync(join(box.root, "xattr.log"), "utf8")).toContain(`-d com.apple.quarantine ${target(box)}`)
		expect(readFileSync(join(box.home, ".bash_profile"), "utf8")).toContain('export PATH="$HOME/.my-cli/bin:$PATH"')
	})

	test("an x86_64 shell under Rosetta installs the native arm64 build", async () => {
		const box = sandbox()
		shim(box, "uname", 'case "$1" in -m) echo x86_64 ;; *) echo Darwin ;; esac')
		shim(box, "sysctl", '[ "$2" = sysctl.proc_translated ] && echo 1')
		shim(box, "xattr", "true")
		const rel = release()
		const r = await install(runner, box, rel.shUrl)
		expect(r.status, output(r)).toBe(0)
		expect(server.requested(rel.baseUrl.slice(server.url.length))).toContain(rel.asset("darwin/arm64", "1.2.3"))
		expect(r.stdout).toContain("darwin/arm64")
	})
}

/** A re-run updates in place, and each shell's profile gets its PATH line. */
export function profileCases(runner: Runner): void {
	test("a re-run says Updated and leaves one profile line", async () => {
		const box = sandbox()
		const rel = release()
		const env = { SHELL: "/bin/bash" }
		const first = await install(runner, box, rel.shUrl, { env, args: ["1.2.0"] })
		expect(first.status, output(first)).toBe(0)
		expect(first.stdout).toContain("Installed")
		const second = await install(runner, box, rel.shUrl, { env })
		expect(second.status, output(second)).toBe(0)
		expect(second.stdout).toContain("Updated")
		expectInstalled(box, "1.2.3")
		const profile = HOST.startsWith("darwin") ? ".bash_profile" : ".bashrc"
		const lines = readFileSync(join(box.home, profile), "utf8").split("\n")
		expect(lines.filter((l) => l === 'export PATH="$HOME/.my-cli/bin:$PATH"')).toHaveLength(1)
		expect(second.stdout).toContain("rm ~/.my-cli/bin/my-cli")
	})

	test.each([
		["/bin/zsh", {}, ".zshrc", 'export PATH="$HOME/.my-cli/bin:$PATH"'],
		["/usr/bin/zsh", { ZDOTDIR: "ZDOT" }, "ZDOT/.zshrc", 'export PATH="$HOME/.my-cli/bin:$PATH"'],
		["/bin/sh", {}, ".profile", 'export PATH="$HOME/.my-cli/bin:$PATH"'],
		["/usr/bin/fish", {}, ".config/fish/conf.d/my-cli.fish", 'fish_add_path "$HOME/.my-cli/bin"'],
		["/usr/bin/fish", { XDG_CONFIG_HOME: "XDG" }, "XDG/fish/conf.d/my-cli.fish", 'fish_add_path "$HOME/.my-cli/bin"'],
	])("SHELL=%s %j writes %s", async (shellPath, extra, profile, line) => {
		const box = sandbox()
		const rel = release()
		const env: Record<string, string> = { SHELL: shellPath }
		for (const [k, v] of Object.entries(extra)) env[k] = join(box.home, v)
		const r = await install(runner, box, rel.shUrl, { env })
		expect(r.status, output(r)).toBe(0)
		expect(readFileSync(join(box.home, profile), "utf8")).toContain(line)
	})
}

/** The environment and config that change the install dir and PATH. */
export function pathEnvCases(runner: Runner): void {
	test("NO_MODIFY_PATH is honored", async () => {
		const box = sandbox()
		const rel = release()
		const r = await install(runner, box, rel.shUrl, { env: { MY_CLI_NO_MODIFY_PATH: "1", SHELL: "/bin/bash" } })
		expect(r.status, output(r)).toBe(0)
		expect(existsSync(join(box.home, ".bashrc"))).toBe(false)
		expect(existsSync(join(box.home, ".bash_profile"))).toBe(false)
		expect(r.stdout).toMatch(/PATH +not changed/)
	})

	test("modifyPath: false is honored", async () => {
		const box = sandbox()
		const rel = release({ config: { ...config, modifyPath: false } })
		const r = await install(runner, box, rel.shUrl)
		expect(r.status, output(r)).toBe(0)
		expect(existsSync(join(box.home, ".profile"))).toBe(false)
	})

	test("an install dir already on PATH is left alone", async () => {
		const box = sandbox()
		const rel = release()
		const dir = join(box.home, ".my-cli/bin")
		const r = await install(runner, box, rel.shUrl, { env: { PATH: `${dir}:${box.shims}:${runner.systemPath}` } })
		expect(r.status, output(r)).toBe(0)
		expect(existsSync(join(box.home, ".profile"))).toBe(false)
		expect(r.stdout).toMatch(/PATH +already set/)
	})

	test("MY_CLI_INSTALL_DIR overrides the install dir", async () => {
		const box = sandbox()
		const rel = release()
		const dir = join(box.root, "custom bin")
		const r = await install(runner, box, rel.shUrl, { env: { MY_CLI_INSTALL_DIR: dir } })
		expect(r.status, output(r)).toBe(0)
		expectInstalled(box, "1.2.3", undefined, join(dir, "my-cli"))
		expect(readFileSync(join(box.home, ".profile"), "utf8")).toContain(`export PATH="${dir}:$PATH"`)
	})

	test("$GITHUB_PATH gets the install dir appended", async () => {
		const box = sandbox()
		const rel = release()
		const ghPath = join(box.root, "github_path")
		writeFileSync(ghPath, "/existing\n")
		const r = await install(runner, box, rel.shUrl, { env: { GITHUB_PATH: ghPath } })
		expect(r.status, output(r)).toBe(0)
		expect(readFileSync(ghPath, "utf8")).toBe(`/existing\n${join(box.home, ".my-cli/bin")}\n`)
	})
}

/** Another copy on PATH, and the closing message. */
export function shadowCases(runner: Runner): void {
	test("another copy ahead of the install dir on PATH gets a shadowing warning", async () => {
		const box = sandbox()
		shim(box, "my-cli", "echo old")
		const rel = release()
		const dir = join(box.home, ".my-cli/bin")
		const r = await install(runner, box, rel.shUrl, { env: { PATH: `${box.shims}:${dir}:${runner.systemPath}` } })
		expect(r.status, output(r)).toBe(0)
		expect(output(r)).toContain(`${join(box.shims, "my-cli")} comes first on PATH`)
	})

	test("another copy on PATH with NO_MODIFY_PATH gets a shadowing warning", async () => {
		const box = sandbox()
		shim(box, "my-cli", "echo old")
		const rel = release()
		const r = await install(runner, box, rel.shUrl, { env: { MY_CLI_NO_MODIFY_PATH: "1" } })
		expect(r.status, output(r)).toBe(0)
		expect(output(r)).toContain(`${join(box.shims, "my-cli")} comes first on PATH`)
	})

	test("another copy on PATH is not a shadow when the profile prepends the install dir", async () => {
		const box = sandbox()
		shim(box, "my-cli", "echo old")
		const rel = release()
		const r = await install(runner, box, rel.shUrl)
		expect(r.status, output(r)).toBe(0)
		expect(readFileSync(join(box.home, ".profile"), "utf8")).toContain('export PATH="$HOME/.my-cli/bin:$PATH"')
		expect(output(r)).not.toContain("comes first on PATH")
	})

	test("the install dir ahead of another copy: no warning", async () => {
		const box = sandbox()
		shim(box, "my-cli", "echo old")
		const rel = release()
		const dir = join(box.home, ".my-cli/bin")
		const r = await install(runner, box, rel.shUrl, { env: { PATH: `${dir}:${box.shims}:${runner.systemPath}` } })
		expect(r.status, output(r)).toBe(0)
		expect(output(r)).not.toContain("comes first on PATH")
	})

	test("the message and the uninstall hint close the run", async () => {
		const box = sandbox()
		const rel = release({ config: { ...config, message: "Run 'my-cli --help' to start." } })
		const r = await install(runner, box, rel.shUrl)
		expect(r.status, output(r)).toBe(0)
		expect(r.stdout).toContain("Run 'my-cli --help' to start.")
		expect(r.stdout).toContain("To uninstall: rm ~/.my-cli/bin/my-cli")
		expect(r.stdout).toContain(`export PATH="$HOME/.my-cli/bin:$PATH"`)
	})
}

/** Plain output off a TTY; glyphs, color and the bar on one. */
export function outputCases(runner: Runner): void {
	test("non-TTY output has no ESC bytes and no progress bar", async () => {
		const box = sandbox()
		const rel = release()
		const r = await install(runner, box, rel.shUrl, { env: { LANG: "C.UTF-8" } })
		expect(r.status, output(r)).toBe(0)
		expect(output(r)).not.toContain("\x1b")
		expect(r.stderr).not.toContain("#")
		for (const row of ["Detected", "Version", "Download", "Verified", "Installed", "PATH"]) {
			expect(r.stdout).toMatch(new RegExp(`^${CHECK} ${row} `, "m"))
		}
	})

	test.runIf(runner.tty)("a UTF-8 TTY gets check rows, color, and curl's bar erased (wget stays silent)", async () => {
		const box = sandbox()
		const rel = release()
		const r = await install(runner, box, rel.shUrl, { tty: true, env: { LANG: "C.UTF-8" } })
		expect(r.status, output(r)).toBe(0)
		expect(r.stdout).toContain(`${CHECK}`)
		expect(r.stdout).toContain("\x1b[32m")
		/* curl draws its bar and erases it; wget prints no bar, so no '#' and nothing to erase */
		const bar = runner.fetch === "curl"
		expect(r.stdout).toMatch(bar ? /#+ +100\.0%/ : /^[^#]*$/)
		expect(r.stdout.includes(ERASE), "the bar's erase sequence").toBe(bar)
	})

	test.runIf(runner.tty)("a C locale TTY uses ASCII glyphs", async () => {
		const box = sandbox()
		const rel = release()
		const r = await install(runner, box, rel.shUrl, { tty: true, env: { LANG: "C", LC_ALL: "C" } })
		expect(r.status, output(r)).toBe(0)
		expect(r.stdout).not.toContain(CHECK)
		expect(plain(r.stdout)).toMatch(/^\+ Detected +/m)
	})

	test.runIf(runner.tty)("NO_COLOR on a TTY: no color, no bar", async () => {
		const box = sandbox()
		const rel = release()
		const r = await install(runner, box, rel.shUrl, { tty: true, env: { LANG: "C.UTF-8", NO_COLOR: "1" } })
		expect(r.status, output(r)).toBe(0)
		expect(r.stdout).not.toContain("\x1b[")
		expect(r.stdout).toContain(CHECK)
	})
}
