#!/usr/bin/env node
// The installgen bin. A repository checkout (marked by tsconfig.json, which is not published) runs the TypeScript
// source, natively on Bun and through jiti on Node, so a stale build never runs; an installed package runs the
// compiled JavaScript (the tarball ships it, not src/).
import { existsSync } from "node:fs"

const checkout = existsSync(new URL("../tsconfig.json", import.meta.url))

async function entry() {
	if (checkout) {
		if (typeof globalThis.Bun !== "undefined") return import("../src/installers/cli.ts")
		const { createJiti } = await import("jiti")
		return createJiti(import.meta.url).import("../src/installers/cli.ts")
	}
	return import("../dist/installers/cli.js")
}

const { start } = await entry()
await start()
