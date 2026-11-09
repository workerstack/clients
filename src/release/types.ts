/**
 * The shapes a `release.config.ts` is written in and a loaded release is read in. `manifest.ts` holds the schemas
 * that parse a config into them, each checked against these at compile time.
 */
import type { Target } from "../gen/targets.ts"

/** The package metadata honey-clients writes into each generated package's manifest; every field is optional. */
export type PackageMetadata = {
	/** Authors, as `Name <email>`. */
	readonly authors?: readonly string[]
	/** The changelog's URL. */
	readonly changelog?: string
	/** The copyright line. */
	readonly copyright?: string
	/** A one-line description. */
	readonly description?: string
	/** The documentation's URL. */
	readonly documentation?: string
	/** The project's site. */
	readonly homepage?: string
	/** The package icon's path, relative to the repo root. */
	readonly icon?: string
	/** Registry search keywords. */
	readonly keywords?: readonly string[]
	/** The SPDX license expression. */
	readonly license?: string
	/** The license file's path, relative to the repo root. */
	readonly licenseFile?: string
	/** The README's path, relative to the repo root. */
	readonly readme?: string
	/** The source repository's URL. */
	readonly repository?: string
}

/** How honey-clients generates a package: its target, and that target's options by name. */
export type HoneyRun = {
	/** The target's options, as `--<target>-<option>` takes them; none by default. */
	readonly options?: Readonly<Record<string, string>>
	/** The honey-clients target the package is generated with. */
	readonly target: Target
}

/** A registry a package's public repo publishes it to; names come from the package's own files. */
export type Registry =
	| {
			/** The registry, which the package's own manifest names the package on. */
			readonly kind: "crates" | "go" | "jsr" | "maven" | "npm" | "nuget" | "pypi"
	  }
	| {
			/** The files of the package attached to the tag's release, at least one. */
			readonly assets: readonly string[]
			/** A GitHub Release of the tag. */
			readonly kind: "github"
	  }

/** One public package a config lists. */
export type ManifestPackageInput = {
	/** Globs bootstrap leaves out of the first push, so the next sync adds them as their own commit. */
	readonly bootstrapExclude?: readonly string[]
	/** The public repo's branch sync pushes to; `main` by default. */
	readonly branch?: string
	/** The message of each snapshot commit, unless the package's `.publicsync-message` names one. */
	readonly commitMessage: string
	/** The package's one description: its public repo's, every registry's, and its first CHANGELOG entry. */
	readonly description: string
	/** How honey-clients generates it; absent for a package honey does not generate (the spec itself). */
	readonly honey?: HoneyRun
	/** This package's metadata over the product's; its keywords add to the product's. */
	readonly metadata?: PackageMetadata
	/** The package's slug: its dir beside the config, and the key bump's `RELEASE_VERSIONS` uses. */
	readonly name: string
	/** The registries its release workflow publishes to; none for a package that ships its own workflow. */
	readonly registries?: readonly Registry[]
	/** The public repo, `owner/name` on github.com. */
	readonly repo: string
	/** The public repo's GitHub topics, 1 to 20 lowercase slugs. */
	readonly topics: readonly string[]
}

/** Where a product's public spec is served, and the committed spec its generated code is built from. */
export type SpecSource = {
	/** The committed spec: as a config gives it, relative to the repo root; once loaded, absolute. */
	readonly committedPath: string
	/** Where prod serves the spec: https, or http on a loopback host. */
	readonly deployedUrl: string
}

/** A git identity: the committer of every snapshot sync pushes. */
export type Committer = {
	/** The committer's email; a public repo tip with any other committer was pushed by hand. */
	readonly email: string
	/** The committer's name. */
	readonly name: string
}

/** What a product's `release.config.ts` default-exports. */
export type ReleaseManifestInput = {
	/** The command that regenerates every package of the product, run from the repo root; it honors `RELEASE_VERSIONS`. */
	readonly codegen: readonly string[]
	/** The identity sync commits as; `public-sync[bot]` by default, so another org's GitHub App can sync. */
	readonly committer?: Committer
	/** The product's site: every public repo's website and every registry's homepage. */
	readonly homepage: string
	/** The metadata every generated package of the product carries. */
	readonly metadata?: PackageMetadata
	/** The product's public packages, at least one; each name and repo once. */
	readonly packages: readonly ManifestPackageInput[]
	/** The product's slug: the `<project>/<name>` key of each package, and what its codegen filters on. */
	readonly project: string
	/** The product's spec. */
	readonly spec: SpecSource
}

/** A listed package with its defaults applied. */
export type ManifestPackage = ManifestPackageInput & {
	/** The public repo's branch. */
	readonly branch: string
	/** The package's metadata: the product's, then its own over it. */
	readonly metadata?: PackageMetadata
	/** The registries its release workflow publishes to, possibly none. */
	readonly registries: readonly Registry[]
}

/** A config package placed in the repo. */
export type PublicPackage = ManifestPackage & {
	/** The product's codegen command (argv, run from the repo root). */
	readonly codegen: readonly string[]
	/** The identity sync commits this package's snapshots as. */
	readonly committer: Committer
	/** The product's site. */
	readonly homepage: string
	/** The public repo's SSH remote, `git@github.com:<repo>.git`. */
	readonly mirror: string
	/** The package's source dir, relative to the repo root (the git toplevel). */
	readonly path: string
	/** The product's slug. */
	readonly project: string
	/** The product's spec; `committedPath` is absolute. */
	readonly spec: SpecSource
}

/** A loaded release config: the repo it lives in and the packages it places there. */
export type Release = {
	/** The product's codegen command (argv, run from the repo root); it honors `RELEASE_VERSIONS`. */
	readonly codegen: readonly string[]
	/** The product's packages, in the order the config lists them. */
	readonly packages: readonly PublicPackage[]
	/** The product's slug. */
	readonly project: string
	/** The git toplevel of the config's dir, which every package path and the committed spec are relative to. */
	readonly root: string
	/** The product's spec; `committedPath` is absolute. */
	readonly spec: SpecSource
}
