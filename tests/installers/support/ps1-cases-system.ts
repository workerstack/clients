import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { fakeBinary } from "./server.ts"
import {
	ARCH,
	config,
	expectInstalled,
	install,
	keepingUserPath,
	output,
	q,
	release,
	sandbox,
	server,
	target,
	userPath,
} from "./ps1-harness.ts"
import type { Runner } from "./shells.ts"

/* install.ps1's cases on the host: the install dir, PATH, output and Windows itself, registered per runner. */

/** A re-run updates in place; the install dir and the checksums row. */
export function updateCases(runner: Runner): void {
	test("a re-run says Updated", async () => {
		const box = sandbox()
		const rel = release()
		const first = await install(runner, box, rel.ps1Url, { version: "1.2.0" })
		expect(first.status, output(first)).toBe(0)
		expect(first.stdout).toContain("Installed")
		const second = await install(runner, box, rel.ps1Url)
		expect(second.status, output(second)).toBe(0)
		expect(second.stdout).toContain("Updated")
		expectInstalled(box, "1.2.3")
		expect(readdirSync(join(box.home, ".my-cli", "bin"))).toEqual(["my-cli.exe"])
	})

	test("MY_CLI_INSTALL_DIR overrides the install dir", async () => {
		const box = sandbox()
		const rel = release()
		const dir = join(box.root, "custom bin")
		const r = await install(runner, box, rel.ps1Url, { env: { MY_CLI_INSTALL_DIR: dir } })
		expect(r.status, output(r)).toBe(0)
		expect(readFileSync(join(dir, "my-cli.exe"))).toEqual(fakeBinary("my-cli", "1.2.3", "windows"))
	})

	test("no checksumsPath: a warn row, and the install goes on", async () => {
		const box = sandbox()
		const { checksumsPath: _checksums, ...noChecksums } = config
		const rel = release({ config: noChecksums })
		const r = await install(runner, box, rel.ps1Url)
		expect(r.status, output(r)).toBe(0)
		expect(r.stdout).toMatch(/! Verified +skipped: no checksums published/)
		expectInstalled(box, "1.2.3")
	})
}

/** The closing message, and what the script does to PATH. */
export function pathCases(runner: Runner): void {
	test("the message and the uninstall hint close the run", async () => {
		const box = sandbox()
		const rel = release({ config: { ...config, message: "Run 'my-cli --help' to start." } })
		const r = await install(runner, box, rel.ps1Url)
		expect(r.status, output(r)).toBe(0)
		expect(r.stdout).toContain("Run 'my-cli --help' to start.")
		expect(r.stdout).toMatch(/To uninstall: Remove-Item .*my-cli\.exe/)
	})

	test("$GITHUB_PATH gets the install dir appended", async () => {
		await keepingUserPath(runner, async () => {
			const box = sandbox()
			const rel = release()
			const ghPath = join(box.root, "github_path")
			writeFileSync(ghPath, "")
			const r = await install(runner, box, rel.ps1Url, { modify: true, env: { GITHUB_PATH: ghPath } })
			expect(r.status, output(r)).toBe(0)
			expect(readFileSync(ghPath, "utf8").trim()).toBe(join(box.home, ".my-cli", "bin"))
		})
	})

	test("NO_MODIFY_PATH is honored", async () => {
		const box = sandbox()
		const rel = release()
		const ghPath = join(box.root, "github_path")
		writeFileSync(ghPath, "")
		const r = await install(runner, box, rel.ps1Url, { env: { GITHUB_PATH: ghPath, MY_CLI_NO_MODIFY_PATH: "1" } })
		expect(r.status, output(r)).toBe(0)
		expect(r.stdout).toMatch(/PATH +not changed/)
		expect(readFileSync(ghPath, "utf8")).toBe("")
	})
}

/** Plain rows off a TTY. */
export function outputCases(runner: Runner): void {
	test("non-TTY output is plain", async () => {
		const box = sandbox()
		const rel = release()
		const r = await install(runner, box, rel.ps1Url)
		expect(r.status, output(r)).toBe(0)
		expect(output(r)).not.toContain("\x1b")
		expect(output(r)).not.toContain("\u2713")
		for (const row of ["Detected", "Version", "Download", "Verified", "Installed", "PATH"]) {
			expect(r.stdout).toMatch(new RegExp(`^[+!] ${row} `, "m"))
		}
	})
}

/** The bar and colored rows on a TTY. */
export function ttyCases(runner: Runner): void {
	test.runIf(runner.tty)("a TTY run draws the progress bar and colored rows", async () => {
		const box = sandbox()
		const rel = release()
		const r = await runner.run({
			command: `irm ${q(rel.ps1Url)} | iex`,
			cwd: box.root,
			tty: true,
			env: { HOME: box.home, USERPROFILE: box.home, PATH: runner.systemPath, TERM_PROGRAM: "test" },
		})
		expect(r.status, output(r)).toBe(0)
		expect(r.stdout).toMatch(/\[#+ *\] +\d+%/)
		expect(r.stdout).toContain("\u2713")
		expect(r.stdout).toContain("\x1b[")
		expectInstalled(box, "1.2.3")
	})
}

/** The registry user PATH, and the x64 fallback on ARM64. */
export function registryCases(runner: Runner): void {
	test("the user PATH in the registry gets the install dir once, and the session PATH too", async () => {
		await keepingUserPath(runner, async () => {
			const box = sandbox()
			const rel = release()
			const dir = join(box.home, ".my-cli", "bin")
			const r = await install(runner, box, rel.ps1Url, { modify: true, after: 'Write-Output "session: $env:PATH"' })
			expect(r.status, output(r)).toBe(0)
			expect(r.stdout).toContain(`session: ${dir}`)
			await install(runner, box, rel.ps1Url, { modify: true })
			const entries = (await userPath(runner)).split(";")
			expect(entries.filter((e) => e.toLowerCase() === dir.toLowerCase())).toHaveLength(1)
		})
	})

	test.runIf(process.arch === "arm64")("ARM64 without a native build installs the x64 build", async () => {
		const box = sandbox()
		const rel = release({ config: { ...config, platforms: ["windows/amd64", "linux/amd64"] } })
		const r = await install(runner, box, rel.ps1Url, { env: { MY_CLI_NO_MODIFY_PATH: "1" } })
		expect(r.status, output(r)).toBe(0)
		expect(output(r)).toContain("emulation")
		expect(server.requested(rel.baseUrl.slice(server.url.length))).toContain(rel.asset("windows/amd64", "1.2.3"))
	})
}

/** The default install dir, and replacing a running exe. */
export function profileCases(runner: Runner): void {
	test("the default install dir is under the user profile", async () => {
		const box = sandbox()
		const rel = release()
		const probe = await runner.run({
			command: "[Environment]::GetFolderPath('UserProfile')",
			cwd: box.root,
			env: { PATH: runner.systemPath },
		})
		const dir = join(probe.stdout.trim(), ".my-cli")
		try {
			const r = await runner.run({
				command: `irm ${q(rel.ps1Url)} | iex`,
				cwd: box.root,
				env: { PATH: runner.systemPath, TEMP: box.root, TMP: box.root, MY_CLI_NO_MODIFY_PATH: "1" },
			})
			expect(r.status, output(r)).toBe(0)
			expect(readFileSync(join(dir, "bin", "my-cli.exe"))).toEqual(fakeBinary("my-cli", "1.2.3", "windows"))
			expect(r.stdout).toContain("~\\.my-cli\\bin\\my-cli.exe")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test("a running exe is renamed aside and replaced", async () => {
		const box = sandbox()
		/* a real executable that stays running: ping, served as the raw asset */
		const ping = readFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "PING.EXE"))
		const { checksumsPath: _checksums, ...raw } = config
		const rel = release({
			config: { ...raw, assetPath: ({ tag, version, os, arch }) => `${tag}/my-cli_${version}_${os}_${arch}.exe` },
		})
		const prefix = rel.baseUrl.slice(server.url.length)
		for (const v of ["1.2.0", "1.2.3"]) server.set(`${prefix}/${rel.asset(`windows/${ARCH}`, v)}`, ping)
		const first = await install(runner, box, rel.ps1Url, { version: "1.2.0" })
		expect(first.status, output(first)).toBe(0)
		const r = await runner.run({
			command:
				`$p = Start-Process -PassThru -WindowStyle Hidden -FilePath ${q(target(box))} -ArgumentList '-n','30','127.0.0.1'; ` +
				`Start-Sleep -Milliseconds 500; irm ${q(rel.ps1Url)} | iex; $p | Stop-Process -Force`,
			cwd: box.root,
			env: {
				HOME: box.home,
				USERPROFILE: box.home,
				PATH: runner.systemPath,
				MY_CLI_NO_MODIFY_PATH: "1",
				MY_CLI_INSTALL_DIR: join(box.home, ".my-cli", "bin"),
			},
		})
		expect(r.status, output(r)).toBe(0)
		expect(r.stdout).toContain("Updated")
		expect(readFileSync(target(box))).toEqual(ping)
	})
}
