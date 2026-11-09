import { readFileSync } from "node:fs"

/**
 * This package's own version, read from its manifest (`../package.json` from `src/` in a checkout and from the
 * compiled output in an install). Generated files pin it, so the tools they run come from the release that wrote them.
 */
export function clientsVersion(): string {
	return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version
}
