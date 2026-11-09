import { existsSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import type { PathContext } from "../../../src/installers/config/define-config.ts"
import { cosignArgs, fakeCosign } from "./cosign.ts"
import { tarGz, type ChecksumStyle } from "./server.ts"
import {
	assetRequested,
	config,
	expectInstalled,
	HOST,
	IDENTITY,
	install,
	noChecksums,
	output,
	prefixOf,
	release,
	sandbox,
	server,
	signed,
	target,
} from "./sh-harness.ts"
import type { Runner } from "./shells.ts"

/* install.sh's cases from the download to the checks, registered by install-sh.test.ts under each runner's describe. */

/** Every archive format, wrapped or not, installs. */
export function formatCases(runner: Runner): void {
	test.each([
		["tar.gz", "tar.gz", {}],
		["zip", "zip", {}],
		["raw", "", {}],
		["wrapped-folder tar.gz, searched", "tar.gz", { wrap: true }],
		["wrapped-folder zip, searched", "zip", { wrap: true }],
		[
			"tar.gz with binaryInArchive",
			"tar.gz",
			{ binaryInArchive: ({ tag, os, arch }: PathContext) => `my-cli-${tag}-${os}-${arch}/bin/my-cli` },
		],
	])("%s installs", async (_name, ext, extra) => {
		const box = sandbox()
		const { wrap, ...rest } = extra as { wrap?: boolean }
		const rel = release({
			wrap: wrap ?? false,
			config: {
				...config,
				assetPath: ({ tag, version, os, arch }) => `${tag}/my-cli_${version}_${os}_${arch}${ext ? `.${ext}` : ""}`,
				...rest,
			},
		})
		const r = await install(runner, box, rel.shUrl)
		expect(r.status, output(r)).toBe(0)
		expectInstalled(box, "1.2.3")
		expect(r.stdout).toContain("Installed")
		expect(server.requested(rel.baseUrl.slice(server.url.length))).toContain(rel.asset(HOST, "1.2.3"))
	})
}

/** An archive with two binaries, or none, fails. */
export function archiveCases(runner: Runner): void {
	test("two files named like the binary fail, asking for binaryInArchive", async () => {
		const box = sandbox()
		const rel = release({
			wrap: true,
			extra: [{ name: "bin/" }, { name: "bin/my-cli", data: "#!/bin/sh\necho stray\n", mode: 0o755 }],
		})
		const r = await install(runner, box, rel.shUrl)
		expect(r.status).not.toBe(0)
		expect(r.stderr).toContain(
			`${rel.asset(HOST, "1.2.3").split("/").at(-1)} holds 2 files named my-cli; set binaryInArchive`,
		)
		expect(existsSync(join(box.home, ".my-cli"))).toBe(false)
	})

	test("an archive without the binary fails", async () => {
		const box = sandbox()
		const rel = release({ config: noChecksums })
		server.set(`${rel.baseUrl.slice(server.url.length)}/${rel.asset(HOST, "1.2.3")}`, tarGz([{ name: "README.md" }]))
		const r = await install(runner, box, rel.shUrl)
		expect(r.status).not.toBe(0)
		expect(r.stderr).toContain("my-cli not found in")
	})
}

/** Pinning, the baked default, and the latest file. */
export function versionCases(runner: Runner): void {
	test.each([
		["$1 without v", { args: ["1.2.0"] }, "1.2.0"],
		["$1 with v", { args: ["v1.2.0"] }, "1.2.0"],
		["env without v", { env: { MY_CLI_VERSION: "1.2.0" } }, "1.2.0"],
		["env with v", { env: { MY_CLI_VERSION: "v1.2.0" } }, "1.2.0"],
		["$1 latest", { args: ["latest"] }, "1.2.3"],
		["$1 over env", { args: ["1.2.0"], env: { MY_CLI_VERSION: "1.2.3" } }, "1.2.0"],
		["latest by default", {}, "1.2.3"],
	])("pinning: %s", async (_name, options, version) => {
		const box = sandbox()
		const rel = release()
		const r = await install(runner, box, rel.shUrl, options)
		expect(r.status, output(r)).toBe(0)
		expectInstalled(box, version)
		expect(r.stdout).toContain(version)
	})

	test("a baked default version", async () => {
		const box = sandbox()
		const rel = release({ defaultVersion: "v1.2.0" })
		const r = await install(runner, box, rel.shUrl)
		expect(r.status, output(r)).toBe(0)
		expectInstalled(box, "1.2.0")
	})

	test("a latest file with CRLF and spaces", async () => {
		const box = sandbox()
		const rel = release({ latest: "  v1.2.0\r\n" })
		const r = await install(runner, box, rel.shUrl)
		expect(r.status, output(r)).toBe(0)
		expectInstalled(box, "1.2.0")
	})

	test.each(["1.2.3; touch pwned", "$(id)", "", "1.2.3/../x"])("an invalid latest %j is rejected", async (latest) => {
		const box = sandbox()
		const rel = release({ latest })
		const r = await install(runner, box, rel.shUrl)
		expect(r.status).not.toBe(0)
		expect(r.stderr).toMatch(/invalid version|could not resolve the latest version/)
		expect(existsSync(target(box))).toBe(false)
		expect(existsSync(join(box.root, "pwned"))).toBe(false)
	})

	test("a version that does not exist fails on the download", async () => {
		const box = sandbox()
		const rel = release()
		const r = await install(runner, box, rel.shUrl, { args: ["9.9.9"] })
		expect(r.status).not.toBe(0)
		expect(r.stderr).toContain("download failed")
		expect(existsSync(target(box))).toBe(false)
	})
}

/** Every checksums format verifies, and a mismatch or a gap fails. */
export function checksumCases(runner: Runner): void {
	test.each<ChecksumStyle>(["plain", "star", "upper", "bsd"])("the %s checksums.txt format verifies", async (style) => {
		const box = sandbox()
		const rel = release({ checksums: style })
		const r = await install(runner, box, rel.shUrl)
		expect(r.status, output(r)).toBe(0)
		expect(r.stdout).toMatch(/Verified +sha256/)
		expectInstalled(box, "1.2.3")
	})

	test("a per-asset .sha256 file with a single bare hash verifies", async () => {
		const box = sandbox()
		const rel = release({ checksums: "bare", config: { ...config, checksumsPath: ({ asset }) => `${asset}.sha256` } })
		const r = await install(runner, box, rel.shUrl)
		expect(r.status, output(r)).toBe(0)
		expect(r.stdout).toMatch(/Verified +sha256/)
	})

	test("a mismatch fails and leaves nothing installed", async () => {
		const box = sandbox()
		const rel = release({ checksums: "wrong" })
		const r = await install(runner, box, rel.shUrl)
		expect(r.status).not.toBe(0)
		expect(r.stderr).toContain("checksum mismatch")
		expect(existsSync(join(box.home, ".my-cli"))).toBe(false)
	})

	test("an asset missing from checksums.txt fails", async () => {
		const box = sandbox()
		const rel = release()
		const prefix = rel.baseUrl.slice(server.url.length)
		server.set(`${prefix}/v1.2.3/checksums.txt`, "0000  some-other-file.tar.gz\n")
		const r = await install(runner, box, rel.shUrl)
		expect(r.status).not.toBe(0)
		expect(r.stderr).toContain("no checksum for")
	})

	test("no checksumsPath: a warn row, and the install goes on", async () => {
		const box = sandbox()
		const rel = release({ config: noChecksums })
		const r = await install(runner, box, rel.shUrl)
		expect(r.status, output(r)).toBe(0)
		expect(r.stdout).toMatch(/! Verified +skipped: no checksums published/)
		expectInstalled(box, "1.2.3")
	})
}

/** cosign checks the checksums' bundle, or a warn row says it could not. */
export function signatureCases(runner: Runner): void {
	test("cosign on PATH checks the bundle against the tag-bound identity, before the hashes", async () => {
		const box = sandbox()
		fakeCosign(box.shims, false)
		const rel = release({ config: signed })
		const r = await install(runner, box, rel.shUrl)
		expect(r.status, output(r)).toBe(0)
		expect(r.stdout).toMatch(/Signed +cosign[\s\S]*Verified +sha256/)
		expect(cosignArgs(box.shims)).toEqual([
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
		fakeCosign(box.shims, false)
		const rel = release({ config: signed, bundle: "forged" })
		const r = await install(runner, box, rel.shUrl)
		expect(r.status).not.toBe(0)
		expect(r.stderr).toContain(`checksums.txt: cosign could not verify it as signed by ${IDENTITY}v1.2.3`)
		expect(existsSync(join(box.home, ".my-cli"))).toBe(false)
	})

	test("a missing bundle fails, naming it", async () => {
		const box = sandbox()
		fakeCosign(box.shims, false)
		const rel = release({ config: signed })
		server.remove(`${prefixOf(rel)}/v1.2.3/checksums.txt.sigstore.json`)
		const r = await install(runner, box, rel.shUrl)
		expect(r.status).not.toBe(0)
		expect(r.stderr).toMatch(/download failed: .*\/v1\.2\.3\/checksums\.txt\.sigstore\.json/)
	})

	test("no cosign: a warn row, and the install goes on", async () => {
		const box = sandbox()
		const rel = release({ config: signed })
		const r = await install(runner, box, rel.shUrl)
		expect(r.status, output(r)).toBe(0)
		expect(r.stdout).toMatch(/! Signed +skipped: cosign not installed/)
		expect(r.stdout).toMatch(/Verified +sha256/)
		expectInstalled(box, "1.2.3")
	})
}

/** INSTALL_VERIFY=require refuses an install it cannot verify, before any download. */
export function requireCases(runner: Runner): void {
	test("INSTALL_VERIFY=require with cosign installs", async () => {
		const box = sandbox()
		fakeCosign(box.shims, false)
		const rel = release({ config: signed })
		const r = await install(runner, box, rel.shUrl, { env: { MY_CLI_INSTALL_VERIFY: "require" } })
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
		if (cosign) fakeCosign(box.shims, false)
		const rel = release({ config: cfg })
		const r = await install(runner, box, rel.shUrl, { env: { MY_CLI_INSTALL_VERIFY: "require" } })
		expect(r.status).not.toBe(0)
		expect(r.stderr).toContain(message)
		expect(assetRequested(rel)).toBe(false)
	})

	test("an unknown INSTALL_VERIFY value fails", async () => {
		const box = sandbox()
		const rel = release({ config: signed })
		const r = await install(runner, box, rel.shUrl, { env: { MY_CLI_INSTALL_VERIFY: "yes" } })
		expect(r.status).not.toBe(0)
		expect(r.stderr).toContain("MY_CLI_INSTALL_VERIFY yes: want require, or unset")
		expect(assetRequested(rel)).toBe(false)
	})
}
