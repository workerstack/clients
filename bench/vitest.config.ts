import { defaultClientConditions, defaultServerConditions } from "vite"
import { defineConfig } from "vitest/config"

/* a side's honey is a core source tree, read as a checkout reads it (honey-source): its `#output-check` import
 * resolves to that tree's src/, never to a dist/ a checkout does not build */
export default defineConfig({
	resolve: { conditions: ["honey-source", ...defaultClientConditions] },
	ssr: { resolve: { conditions: ["honey-source", ...defaultServerConditions.filter((c) => c !== "module")] } },
})
