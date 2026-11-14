/**
 * A local TLS server offering h2 and http/1.1 by ALPN (bit 19 d2), recording each request's negotiated protocol, so a
 * leg can hold an SDK to HTTP/1.1 when a server would speak h2. A child process trusts the CA through SSL_CERT_FILE
 * (Go, Rust, OpenSSL) or NODE_EXTRA_CA_CERTS (Node, Bun), which `trusted` sets for the span of one run.
 *
 * TEST-ONLY, INSECURE KEY MATERIAL, PUBLISHED ON PURPOSE: the CA ("clients test CA (test only, insecure)"), the leaf
 * ("clients test leaf for 127.0.0.1 (test only, insecure)", valid to 2126) and the leaf's private key below exist only so
 * this fixture can speak TLS on loopback. The CA's own key was discarded when it signed the leaf. None of it protects
 * anything; never trust this CA or reuse this key outside a test.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { createSecureServer } from "node:http2"
import type { AddressInfo } from "node:net"
import type { TLSSocket } from "node:tls"
import { homedir } from "node:os"
import { join } from "node:path"

const CA = `-----BEGIN CERTIFICATE-----
MIIBxjCCAW2gAwIBAgIUezkG1vaeTXj8zc7AXi30uXUNOkYwCgYIKoZIzj0EAwIw
MDEuMCwGA1UEAwwlY2xpZW50cyB0ZXN0IENBICh0ZXN0IG9ubHksIGluc2VjdXJl
KTAgFw0yNjExMTQwOTA2MDZaGA8yMTI2MTAyMTA5MDYwNlowMDEuMCwGA1UEAwwl
Y2xpZW50cyB0ZXN0IENBICh0ZXN0IG9ubHksIGluc2VjdXJlKTBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABB5svDfkxvaPEMBahzVWIMBMGwSB+/lQJt+vTzn08f4b
GXUIsKcqMdvEfPN1EDpXfD4hxsXCia05mJVXA21NsjSjYzBhMB0GA1UdDgQWBBRH
o34IjkEmXGBpUFN0mcmm1xXZHzAfBgNVHSMEGDAWgBRHo34IjkEmXGBpUFN0mcmm
1xXZHzAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAKBggqhkjOPQQD
AgNHADBEAiB6D90pDeWBmkjox7vo2d3WIjR3DdQr4NVH3JFz+JCSMwIgJ2XAip2y
SaNftPa93vz646dUXjKFRL8BXL5KaxaCtj0=
-----END CERTIFICATE-----`

const CERT = `-----BEGIN CERTIFICATE-----
MIIB9jCCAZugAwIBAgIUdP2yLkDL7/VK/sdskhIJ6Yg7eqwwCgYIKoZIzj0EAwIw
MDEuMCwGA1UEAwwlY2xpZW50cyB0ZXN0IENBICh0ZXN0IG9ubHksIGluc2VjdXJl
KTAgFw0yNjExMTQwOTA2MDZaGA8yMTI2MTAyMTA5MDYwNlowQDE+MDwGA1UEAww1
Y2xpZW50cyB0ZXN0IGxlYWYgZm9yIDEyNy4wLjAuMSAodGVzdCBvbmx5LCBpbnNl
Y3VyZSkwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQmH1YVzUCKM+Ga9k5xqwQn
c8ZxnbH61QON3K97f1mB207av5j+4anYw/io7ej8xXs5PpRlj78xmbjNeoTyK1vs
o4GAMH4wDwYDVR0RBAgwBocEfwAAATAJBgNVHRMEAjAAMAsGA1UdDwQEAwIHgDAT
BgNVHSUEDDAKBggrBgEFBQcDATAdBgNVHQ4EFgQU2YsVOwmX6VvkAFZJxA9ODmtG
erYwHwYDVR0jBBgwFoAUR6N+CI5BJlxgaVBTdJnJptcV2R8wCgYIKoZIzj0EAwID
SQAwRgIhAJJ0qKyQKOUbArfsyYRBmeNy0aO6eHKFl6VroWR5Zd07AiEAuglYjpBi
k8S3T0e7YTda0Ze2axKxUFKVLu9A7P0qDjg=
-----END CERTIFICATE-----`

const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQghuikhxLnzLbxpglW
hg2WRte5KEi/k+yVdJD+Q8xwOguhRANCAAQmH1YVzUCKM+Ga9k5xqwQnc8ZxnbH6
1QON3K97f1mB207av5j+4anYw/io7ej8xXs5PpRlj78xmbjNeoTyK1vs
-----END PRIVATE KEY-----`

/** One request as the server saw it: the ALPN protocol its TLS session negotiated, and its HTTP version. */
export type Negotiated = { readonly alpn: string | false | null; readonly version: string }

export type AlpnServer = {
	readonly url: string
	/** each request's negotiated protocol, in arrival order */
	seen(): readonly Negotiated[]
	close(): Promise<void>
}

/** A TLS server on an OS-picked loopback port, answering every request `{}` as JSON. */
export async function alpnServer(): Promise<AlpnServer> {
	const seen: Negotiated[] = []
	const server = createSecureServer({ allowHTTP1: true, cert: CERT, key: KEY }, (req, res) => {
		seen.push({ alpn: (req.socket as TLSSocket).alpnProtocol ?? null, version: req.httpVersion })
		res.writeHead(200, { "content-type": "application/json" })
		res.end("{}")
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as AddressInfo
	return {
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
		seen: () => seen,
		url: `https://127.0.0.1:${port}`,
	}
}

/** `run` with SSL_CERT_FILE naming the test CA, so the child processes it spawns trust the server; restored after. */
export async function trusted<T>(run: () => Promise<T>): Promise<T> {
	const dir = join(process.env.HOME ?? homedir(), ".cache/backend-tmp/tls")
	mkdirSync(dir, { recursive: true })
	const file = join(dir, "test-ca.pem")
	writeFileSync(file, `${CA}\n`)
	const before = process.env.SSL_CERT_FILE
	process.env.SSL_CERT_FILE = file
	try {
		return await run()
	} finally {
		if (before === undefined) delete process.env.SSL_CERT_FILE
		else process.env.SSL_CERT_FILE = before
	}
}
