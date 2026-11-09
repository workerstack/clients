import module from "node:module"

export type RegisterHooks = typeof module.registerHooks

/**
 * Maps a config's import of `specifier` (`@workerstack/clients/installers`, `@workerstack/clients/release`) to the
 * running package's entry `selfUrl`, so a config in a project without a local install (zero-install `bunx`) still
 * resolves. `module.register` is deprecated on Node 26 (DEP0205).
 * Reached through the default export: Bun's `node:module` has no `registerHooks`, and a named import would fail to link.
 */
export function registerNodeHook(
	specifier: string,
	selfUrl: string,
	register: RegisterHooks = module.registerHooks,
): ReturnType<RegisterHooks> {
	return register({
		resolve(imported, context, nextResolve) {
			if (imported === specifier) return { url: selfUrl, shortCircuit: true }
			return nextResolve(imported, context)
		},
	})
}
