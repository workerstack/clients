/**
 * honeyPlugin()'s options, as typed: `outputValidation: true` keeps the answer check in a Vite production build.
 * Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import { honeyPlugin, type HoneyVitePluginConfig } from "../../src/build/plugin.ts"

describe("honeyPlugin({ outputValidation })", () => {
	it("takes a boolean, and no mode string", () => {
		expectTypeOf<HoneyVitePluginConfig["outputValidation"]>().toEqualTypeOf<boolean | undefined>()
		honeyPlugin({ app: "src/app.ts", outputValidation: true })
		// @ts-expect-error: the plugin keeps or drops the check; the app's old "always" | "dev" | "off" modes are gone
		honeyPlugin({ app: "src/app.ts", outputValidation: "always" })
	})
})
