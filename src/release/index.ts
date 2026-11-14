/**
 * `@workerstack/clients/release`: what a product's `release.config.ts` imports, and the loader the release commands
 * read it with.
 */
export { defineRelease, RELEASE_VERSIONS_ENV } from "./manifest.ts"
export { loadRelease } from "./load.ts"
export type {
	Committer,
	ReleaseRun,
	ManifestPackage,
	ManifestPackageInput,
	PackageMetadata,
	PublicPackage,
	Registry,
	Release,
	ReleaseManifestInput,
	SpecSource,
} from "./types.ts"
