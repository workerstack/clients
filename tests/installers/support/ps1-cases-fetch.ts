import { existsSync } from "node:fs"
import { expect, test } from "vitest"
import { cosignArgs } from "./cosign.ts"
import {
	ARCH,
	assetRequested,
	config,
	expectInstalled,
	IDENTITY,
	install,
	output,
	prefixOf,
	q,
	release,
	sandbox,
	server,
	signed,
	target,
	unwrapped,
	withCosign,
} from "./ps1-harness.ts"
import type { Runner } from "./shells.ts"

/* install.ps1's cases from the download to the checks, registered by install-ps1.test.ts under each runner's describe. */

/** Every archive format installs, and two binaries in one fail. */
export function formatCases(runner: Runner): void {
	test.each([
		["zip", "zip", false],
		["tar.gz", "tar.gz", false],
		["raw .exe", "exe", false],
		["wrapped-folder zip, searched", "zip", true],
	])("%s installs", async (_name, ext, wrap) => {
		const box = sandbox()
		const rel = release({
			wrap,
			config: {
				...config,
				assetPath: ({ tag, version, os, arch }) => `${tag}/my-cli_${version}_${os}_${arch}.${ext}`,
			},
		})
		const r = await install(runner, box, rel.ps1Url)
		expect(r.status, output(r)).toBe(0)
		expectInstalled(box, "1.2.3")
		expect(r.stdout).toContain("Installed")
		expect(r.stdout).toMatch(/Verified +sha256/)
		expect(server.requested(rel.baseUrl.slice(server.url.length))).toContain(rel.asset(`windows/${ARCH}`, "1.2.3"))
	})

	test("two files named like the binary fail, asking for binaryInArchive", async () => {
		const box = sandbox()
		const rel = release({ wrap: true, extra: [{ name: "bin/" }, { name: "bin/my-cli.exe", data: "MZ stray" }] })
		const r = await install(runner, box, rel.ps1Url)
		expect(r.status).not.toBe(0)
		expect(output(r)).toContain("holds 2 files named my-cli.exe; set binaryInArchive")
		expect(existsSync(target(box))).toBe(false)
	})
}

/** Pinning by -Version or env, and the latest file. */
export function versionCases(runner: Runner): void {
	test.each([
		["-Version without v", { version: "1.2.0" }, "1.2.0"],
		["-Version with v", { version: "v1.2.0" }, "1.2.0"],
		["env without v", { env: { MY_CLI_VERSION: "1.2.0" } }, "1.2.0"],
		["env with v", { env: { MY_CLI_VERSION: "v1.2.0" } }, "1.2.0"],
		["-Version over env", { version: "1.2.0", env: { MY_CLI_VERSION: "1.2.3" } }, "1.2.0"],
		["latest by default", {}, "1.2.3"],
	])("pinning: %s", async (_name, options, version) => {
		const box = sandbox()
		const rel = release()
		const r = await install(runner, box, rel.ps1Url, options)
		expect(r.status, output(r)).toBe(0)
		expectInstalled(box, version)
		expect(r.stdout).toContain(version)
	})

	test("a latest file with CRLF", async () => {
		const box = sandbox()
		const rel = release({ latest: "v1.2.0\r\n" })
		const r = await install(runner, box, rel.ps1Url)
		expect(r.status, output(r)).toBe(0)
		expectInstalled(box, "1.2.0")
	})

	test("an invalid latest is rejected", async () => {
		const box = sandbox()
		const rel = release({ latest: "1.2.3; Remove-Item x" })
		const r = await install(runner, box, rel.ps1Url)
		expect(r.status).not.toBe(0)
		expect(output(r)).toContain("invalid version")
		expect(existsSync(target(box))).toBe(false)
	})
}

/** cosign checks the checksums' bundle, or a warn row says it could not. */
export function signatureCases(runner: Runner): void {
	test("cosign on PATH checks the bundle against the tag-bound identity, before the hashes", async () => {
		const box = sandbox()
		const cosign = withCosign(runner, box)
		const rel = release({ config: signed })
		const r = await install(runner, box, rel.ps1Url, { env: cosign.env })
		expect(r.status, output(r)).toBe(0)
		expect(r.stdout).toMatch(/Signed +cosign[\s\S]*Verified +sha256/)
		expect(cosignArgs(cosign.shims)).toEqual([
			"verify-blob",
			"--bundle",
			expect.any(String),
			"--certificate-identity",
			`${IDENTITY}v1.2.3`,
			"--certificate-oidc-issuer",
			"https://token.actions.githubusercontent.com",
			expect.any(String),
		])
		expectInstalled(box, "1.2.3")
	})

	test("a bundle cosign rejects fails, and nothing is installed", async () => {
		const box = sandbox()
		const cosign = withCosign(runner, box)
		const rel = release({ config: signed, bundle: "forged" })
		const r = await install(runner, box, rel.ps1Url, { env: cosign.env })
		expect(r.status).not.toBe(0)
		expect(unwrapped(output(r))).toContain(
			unwrapped(`checksums.txt: cosign could not verify it as signed by ${IDENTITY}v1.2.3`),
		)
		expect(existsSync(target(box))).toBe(false)
	})

	test("a missing bundle fails, naming it", async () => {
		const box = sandbox()
		const cosign = withCosign(runner, box)
		const rel = release({ config: signed })
		server.remove(`${prefixOf(rel)}/v1.2.3/checksums.txt.sigstore.json`)
		const r = await install(runner, box, rel.ps1Url, { env: cosign.env })
		expect(r.status).not.toBe(0)
		expect(unwrapped(output(r))).toMatch(/downloadfailed:.*\/v1\.2\.3\/checksums\.txt\.sigstore\.json/)
	})

	test("no cosign: a warn row, and the install goes on", async () => {
		const box = sandbox()
		const rel = release({ config: signed })
		const r = await install(runner, box, rel.ps1Url)
		expect(r.status, output(r)).toBe(0)
		expect(r.stdout).toMatch(/! Signed +skipped: cosign not installed/)
		expectInstalled(box, "1.2.3")
	})
}

/** INSTALL_VERIFY=require refuses an install it cannot verify, before any download. */
export function requireCases(runner: Runner): void {
	test("INSTALL_VERIFY=require with cosign installs", async () => {
		const box = sandbox()
		const cosign = withCosign(runner, box)
		const rel = release({ config: signed })
		const r = await install(runner, box, rel.ps1Url, { env: { ...cosign.env, MY_CLI_INSTALL_VERIFY: "require" } })
		expect(r.status, output(r)).toBe(0)
		expect(r.stdout).toMatch(/Signed +cosign/)
	})

	test.each([
		[
			"no cosign",
			signed,
			false,
			"MY_CLI_INSTALL_VERIFY=require: cosign is not installed to verify the checksums' signature",
		],
		["an unsigned release", config, true, "MY_CLI_INSTALL_VERIFY=require: no signature is published for this release"],
	])("INSTALL_VERIFY=require refuses %s before any download", async (_case, cfg, cosign, message) => {
		const box = sandbox()
		const env = cosign ? withCosign(runner, box).env : {}
		const rel = release({ config: cfg })
		const r = await install(runner, box, rel.ps1Url, { env: { ...env, MY_CLI_INSTALL_VERIFY: "require" } })
		expect(r.status).not.toBe(0)
		expect(unwrapped(output(r))).toContain(unwrapped(message))
		expect(assetRequested(rel)).toBe(false)
	})

	test("an unknown INSTALL_VERIFY value fails", async () => {
		const box = sandbox()
		const rel = release({ config: signed })
		const r = await install(runner, box, rel.ps1Url, { env: { MY_CLI_INSTALL_VERIFY: "yes" } })
		expect(r.status).not.toBe(0)
		expect(unwrapped(output(r))).toContain(unwrapped("MY_CLI_INSTALL_VERIFY yes: want require, or unset"))
		expect(assetRequested(rel)).toBe(false)
	})
}

/** A failure throws into the caller's session instead of exiting it. */
export function sessionCases(runner: Runner): void {
	test("a checksum mismatch fails without closing the session; a later command still runs", async () => {
		const box = sandbox()
		const rel = release({ checksums: "wrong" })
		const r = await install(runner, box, rel.ps1Url, {
			after: "Write-Output 'still here'",
		})
		const caught = await runner.run({
			command: `try { irm ${q(rel.ps1Url)} | iex } catch { Write-Output "caught: $($_.Exception.Message)" }; Write-Output 'still here'`,
			cwd: box.root,
			env: { HOME: box.home, USERPROFILE: box.home, PATH: runner.systemPath },
		})
		expect(r.status).not.toBe(0)
		expect(output(r)).toContain("checksum mismatch")
		expect(caught.status, output(caught)).toBe(0)
		expect(caught.stdout).toMatch(/caught: .*checksum mismatch/)
		expect(caught.stdout).toContain("still here")
		expect(existsSync(target(box))).toBe(false)
	})

	test("the script never calls exit", () => {
		const rel = release()
		expect(rel.ps1).not.toMatch(/\bexit\b/i)
	})
}
