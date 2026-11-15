/**
 * `trusted` hands each run a CA file no other run writes: the Go, Rust and TS version legs run in parallel processes,
 * and a rewrite of one shared file empties it for a moment, so a child reading it then trusts no CA (x509: unknown
 * authority).
 */
import { readFileSync, statSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { trusted } from "./alpn-server.ts"

describe("trusted", () => {
	it("gives a run a CA file that a second, overlapping run leaves untouched, and removes it after", async () => {
		const seen = await trusted(async () => {
			const file = process.env.SSL_CERT_FILE as string
			const before = statSync(file, { bigint: true })
			const other = await trusted(async () => process.env.SSL_CERT_FILE as string)
			const after = statSync(file, { bigint: true })
			return { file, other, rewritten: after.mtimeNs !== before.mtimeNs, text: readFileSync(file, "utf8") }
		})
		expect({ ca: seen.text.startsWith("-----BEGIN CERTIFICATE-----"), distinct: seen.other !== seen.file }).toEqual({
			ca: true,
			distinct: true,
		})
		expect(seen.rewritten).toBe(false)
		expect(() => statSync(seen.file)).toThrow(/ENOENT/)
	})

	it("restores SSL_CERT_FILE after the run", async () => {
		const before = process.env.SSL_CERT_FILE
		await trusted(async () => undefined)
		expect(process.env.SSL_CERT_FILE).toBe(before)
	})
})
