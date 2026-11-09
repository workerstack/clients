/**
 * `#output-check` under the `honey-no-output-check` condition: no route checks what it answers. A Vite production
 * build through `honeyPlugin()` resolves this module, and so does a node or bun run started with
 * `--conditions=honey-no-output-check`. The check every `.output()` route runs on a `forward()`ed answer is no part
 * of it and stays.
 */
import type { OutputCheck } from "./validate-output.ts"

/** No check for any route: each answer goes out as its handler built it. */
export function outputCheck(): OutputCheck | null {
	return null
}
