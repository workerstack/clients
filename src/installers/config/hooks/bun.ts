export interface BunBuild {
	module(specifier: string, load: () => { exports: Record<string, unknown>; loader: "object" }): void
}

export interface BunPlugin {
	name: string
	setup(build: BunBuild): void | Promise<void>
}

/** The slice of the `Bun` global the loader uses. */
export interface BunLike {
	plugin(plugin: BunPlugin): void
}

type Importer = (url: string) => Promise<Record<string, unknown>>

/**
 * Bun's `onResolve` never sees the imports a runtime-loaded config makes; `build.module` does. The config's import of
 * `specifier` becomes a virtual module holding the exports of the running package's entry `selfUrl`.
 */
export async function registerBunHook(
	bun: BunLike,
	specifier: string,
	selfUrl: string,
	importModule: Importer = (url) => import(url) as Promise<Record<string, unknown>>,
): Promise<void> {
	const exports = await importModule(selfUrl)
	bun.plugin({
		name: `self:${specifier}`,
		setup(build) {
			build.module(specifier, () => ({ exports, loader: "object" }))
		},
	})
}
