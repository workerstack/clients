import { spawnSync } from "node:child_process"
import { describe, expect, test } from "vitest"
import { SPAWN_TIMEOUT } from "../../src/gen/__fixtures__/spawn-timeout.ts"
import { resolveConfig } from "../../src/installers/config/resolve.ts"
import { render } from "../../src/installers/render/render.ts"
import { formatCases, requireCases, sessionCases, signatureCases, versionCases } from "./support/ps1-cases-fetch.ts"
import {
	outputCases,
	pathCases,
	profileCases,
	registryCases,
	ttyCases,
	updateCases,
} from "./support/ps1-cases-system.ts"
import { config, PS_RUNNERS, serveSuite, WIN } from "./support/ps1-harness.ts"
import { pwshCommand } from "./support/shells.ts"

serveSuite()

/*
 * .NET Framework (Windows PowerShell 5.1) follows an https to http redirect; the script must refuse one, or a
 * man in the middle could swap the binary and its same-host checksum. The guard runs here in real pwsh, cut
 * from a rendered script; the Windows CI legs run it under 5.1.
 */
const PWSH = pwshCommand()
test.runIf(PWSH)(
	"Assert-HttpsKept refuses https to http and allows the rest",
	() => {
		const ps1 = render(resolveConfig({ ...config, baseUrl: "https://dl.example.com" }), {}).ps1 as string
		const begin = ps1.indexOf("# installgen:begin Assert-HttpsKept")
		const end = ps1.indexOf("# installgen:end Assert-HttpsKept")
		expect(begin).toBeGreaterThan(-1)
		const fn = ps1.slice(begin, end)
		const redirects = [
			["https://dl.example.com/a", "https://cdn.example.com/a"],
			["https://dl.example.com/a", "http://cdn.example.com/a"],
			["HTTPS://dl.example.com/a", "http://cdn.example.com/a"],
			["http://127.0.0.1:8080/a", "http://127.0.0.1:8080/b"],
		]
		const script = [
			fn,
			...redirects.map(
				([requested, final]) =>
					`try { Assert-HttpsKept -Requested '${requested}' -Final ([Uri]'${final}'); Write-Output 'ok' } catch { Write-Output "threw: $($_.Exception.Message)" }`,
			),
		].join("\n")
		const [bin, ...args] = PWSH as [string, ...string[]]
		const r = spawnSync(bin, [...args, Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8" })
		expect(r.status, r.stderr).toBe(0)
		expect(r.stdout.trim().split(/\r?\n/)).toEqual([
			"ok",
			"threw: refusing https://dl.example.com/a: redirected from https to http://cdn.example.com/a",
			"threw: refusing HTTPS://dl.example.com/a: redirected from https to http://cdn.example.com/a",
			"ok",
		])
	},
	SPAWN_TIMEOUT,
)

/*
 * Windows PowerShell 5.1 defines these in script modules. powershell.exe started from pwsh inherits a
 * PSModulePath with the PowerShell 7 module dirs first, and then 5.1 cannot find them.
 */
const SCRIPT_MODULE_COMMANDS = [
	"Get-FileHash",
	"New-TemporaryFile",
	"New-Guid",
	"Format-Hex",
	"Import-PowerShellDataFile",
	"ConvertFrom-SddlString",
	"Expand-Archive",
	"Compress-Archive",
]
test("install.ps1 calls no script-module command, outside the non-Windows zip seam", () => {
	const ps1 = render(resolveConfig({ ...config, baseUrl: "https://dl.example.com" }), {}).ps1 as string
	const code = ps1
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n")
	const windowsBranch = code.indexOf("if ($onWindows) {")
	const seam = code.indexOf("} elseif ($format -eq 'zip') {", windowsBranch)
	expect(windowsBranch).toBeGreaterThan(-1)
	expect(seam).toBeGreaterThan(windowsBranch)
	const seamEnd = code.indexOf("} else {", seam)
	const calls = SCRIPT_MODULE_COMMANDS.flatMap((name) =>
		[...code.matchAll(new RegExp(`\\b${name}\\b`, "gi"))].map((m) => ({ name, at: m.index })),
	)
	expect(calls.filter((c) => !(c.name === "Expand-Archive" && c.at > seam && c.at < seamEnd))).toEqual([])
	expect(calls.filter((c) => c.name === "Expand-Archive")).toHaveLength(1)
})

/* the runners come from the environment; say so rather than report an empty file */
if (PS_RUNNERS.length === 0) {
	test.skipIf(PS_RUNNERS.length === 0)(
		"install.ps1: no PowerShell runner (INSTALLGEN_E2E_SHELLS=pwsh or INSTALLGEN_E2E_DOCKER=1)",
		() => {
			expect(PS_RUNNERS).toEqual([])
		},
	)
}

describe.each(PS_RUNNERS)("install.ps1 under $name", (runner) => {
	describe("formats", () => formatCases(runner))
	describe("versions", () => versionCases(runner))
	describe("signature", () => {
		signatureCases(runner)
		requireCases(runner)
	})
	describe("failures keep the session", () => sessionCases(runner))
	describe("install", () => {
		updateCases(runner)
		pathCases(runner)
	})
	describe("output", () => outputCases(runner))
	ttyCases(runner)
	describe.runIf(WIN)("Windows only", () => {
		registryCases(runner)
		profileCases(runner)
	})
})
