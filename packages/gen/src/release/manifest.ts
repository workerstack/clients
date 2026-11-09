/**
 * A product lists its public packages in one `release.config.ts`. A package's dir is `<config dir>/<name>` and its
 * public repo is `github.com/<repo>`; both are derived here, so the config never repeats them. The schemas are built
 * on use, each checked against the shapes `types.ts` publishes.
 */
import { existsSync, readdirSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import * as z from "zod"
import type { MetadataField } from "../emit/shared/metadata.ts"
import { TARGETS } from "../gen/targets.ts"
import { DEFAULT_COMMITTER, DESCRIPTION_MAX, HTTP_PROTOCOL, HTTPS_PROTOCOL, TOPICS_MAX } from "./constants.ts"
import type {
	ManifestPackage,
	PackageMetadata,
	PublicPackage,
	Registry,
	Release,
	ReleaseManifestInput,
	SpecSource,
	Committer,
} from "./types.ts"

const SLUG = /^[a-z][a-z0-9-]*$/

/* a topic is GitHub's lowercase slug of up to 50 characters */
const TOPIC = /^[a-z0-9][a-z0-9-]{0,49}$/

/* https, or http on loopback for tests */
const LOOPBACK: readonly string[] = ["127.0.0.1", "localhost", "[::1]"]

/** The one shape of a public repo's remote that sync pushes to: an SSH URL on github.com. */
export const MIRROR_ALLOWLIST = /^git@github\.com:[a-z0-9-]+\/[a-z0-9-]+\.git$/

/** Env var bump sets for codegen: JSON `{ [packageName]: version }`, the version each package generates at. */
export const RELEASE_VERSIONS_ENV = "RELEASE_VERSIONS"

/* one entry per METADATA_FIELDS name */
function packageMetadata(): z.ZodType<PackageMetadata, PackageMetadata> {
	const text = z.string().min(1).optional()
	const list = z.array(z.string().min(1)).optional()
	return z.strictObject({
		authors: list,
		changelog: text,
		copyright: text,
		description: text,
		documentation: text,
		homepage: text,
		icon: text,
		keywords: list,
		license: text,
		licenseFile: text,
		readme: text,
		repository: text,
	} satisfies Record<MetadataField, z.ZodType>)
}

/* names come from the package's own files, so a registry carries only what those files cannot say */
function registry(): z.ZodType<Registry, Registry> {
	return z.discriminatedUnion("kind", [
		z.object({ kind: z.enum(["crates", "go", "jsr", "maven", "npm", "nuget", "pypi"]) }),
		z.object({ assets: z.array(z.string().min(1)).min(1), kind: z.literal("github") }),
	])
}

function manifestPackage(): z.ZodType<ManifestPackage, ReleaseManifestInput["packages"][number]> {
	return z.object({
		bootstrapExclude: z.array(z.string()).optional(),
		branch: z.string().default("main"),
		commitMessage: z.string().min(1),
		description: z.string().min(1).max(DESCRIPTION_MAX),
		honey: z.object({ options: z.record(z.string(), z.string()).default({}), target: z.enum(TARGETS) }).optional(),
		metadata: packageMetadata().optional(),
		name: z.string().regex(SLUG),
		registries: z.array(registry()).default([]),
		repo: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/, "repo must be owner/name on github.com"),
		topics: z.array(z.string().regex(TOPIC, "a topic is a lowercase slug")).min(1).max(TOPICS_MAX),
	})
}

function specSource(): z.ZodType<SpecSource, SpecSource> {
	return z.object({
		committedPath: z.string().min(1),
		deployedUrl: z.url().refine((value) => {
			const url = new URL(value)
			return url.protocol === HTTPS_PROTOCOL || (url.protocol === HTTP_PROTOCOL && LOOPBACK.includes(url.hostname))
		}, "deployedUrl must be https (http only on a loopback host)"),
	})
}

/* a parsed config: every default applied */
type ReleaseManifest = Omit<ReleaseManifestInput, "committer" | "packages" | "toolchains"> & {
	readonly committer: Committer
	readonly packages: readonly ManifestPackage[]
	readonly toolchains: readonly string[]
}

function releaseManifest(): z.ZodType<ReleaseManifest, ReleaseManifestInput> {
	return z
		.object({
			codegen: z.array(z.string().min(1)).min(1),
			/* git takes any address; a GitHub App's bot address (`123+app[bot]@users.noreply.github.com`) is no RFC email */
			committer: z
				.strictObject({ email: z.string().regex(/^[^\s@]+@[^\s@]+$/, "an email address"), name: z.string().min(1) })
				.default(DEFAULT_COMMITTER),
			homepage: z.url({ protocol: /^https$/ }),
			metadata: packageMetadata().optional(),
			packages: z.array(manifestPackage()).min(1),
			project: z.string().regex(SLUG),
			spec: specSource(),
			toolchains: z
				.array(z.string().regex(SLUG, "a toolchain is a system.config.ts dep name (a lowercase slug)"))
				.default([]),
		})
		.superRefine((manifest, ctx) => {
			for (const key of ["name", "repo"] as const) {
				const seen = new Set<string>()
				for (const pkg of manifest.packages) {
					if (seen.has(pkg[key])) ctx.addIssue({ code: "custom", message: `duplicate ${key}: ${pkg[key]}` })
					seen.add(pkg[key])
				}
			}
		})
}

/** Types a product's `release.config.ts`; `loadRelease` parses it. */
export function defineRelease(manifest: ReleaseManifestInput): ReleaseManifestInput {
	return manifest
}

/** A package's `<project>/<name>`, unique across products; `--only` takes it as well as the bare name. */
export function packageKey(pkg: PublicPackage): string {
	return `${pkg.project}/${pkg.name}`
}

/** A package's metadata: the product's, then its own over it, its keywords added to the product's. */
function metadataOf(product: PackageMetadata | undefined, own: PackageMetadata | undefined): PackageMetadata {
	const keywords = [...(product?.keywords ?? []), ...(own?.keywords ?? [])]
	return { ...product, ...own, ...(keywords.length === 0 ? {} : { keywords }) }
}

/* the slug the config names, read before the rest: every package's key and the codegen's filter depend on it */
function projectOf(file: string, raw: unknown): string {
	const project = typeof raw === "object" && raw !== null ? (raw as { project?: unknown }).project : undefined
	if (typeof project === "string" && SLUG.test(project)) return project
	throw new Error(`${file}: project: expected a slug, got ${JSON.stringify(project) ?? "undefined"}`)
}

/* the dirs beside the config that are neither a listed package nor hidden: a package the config forgot */
function unlistedDirs(configDir: string, listed: ReadonlySet<string>): string[] {
	return readdirSync(configDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !listed.has(entry.name))
		.map((entry) => join(configDir, entry.name))
}

/* the config's schema-checked contents; throws listing every issue, naming the config */
function parsed(file: string, raw: unknown): ReleaseManifest {
	const result = releaseManifest().safeParse(raw)
	if (result.success) return result.data
	const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ")
	throw new Error(`${file} is invalid:\n  ${issues}`)
}

/**
 * The packages `raw`, a release config's default export, places in the repo whose git toplevel is `root`; the config
 * lives at the absolute `configPath`, and each package's dir sits beside it. Throws naming the config on a config
 * that is invalid, a committed spec or a package dir that is not there, or a dir beside the config it does not list.
 */
export function placeRelease(raw: unknown, root: string, configPath: string): Release {
	const file = relative(root, configPath)
	const project = projectOf(file, raw)
	const data = parsed(file, raw)

	const committedPath = join(root, data.spec.committedPath)
	if (!existsSync(committedPath)) {
		throw new Error(`${file}: spec.committedPath ${data.spec.committedPath} does not exist`)
	}
	const spec = { committedPath, deployedUrl: data.spec.deployedUrl }
	const configDir = dirname(configPath)

	const packages: PublicPackage[] = data.packages.map((pkg) => ({
		...pkg,
		codegen: data.codegen,
		committer: data.committer,
		homepage: data.homepage,
		metadata: metadataOf(data.metadata, pkg.metadata),
		mirror: `git@github.com:${pkg.repo}.git`,
		path: relative(root, join(configDir, pkg.name)),
		project,
		spec,
	}))

	const missing = packages.filter((pkg) => !existsSync(join(root, pkg.path))).map((pkg) => pkg.path)
	if (missing.length > 0) throw new Error(`${file} lists packages with no dir: ${missing.join(", ")}`)

	const unlisted = unlistedDirs(configDir, new Set(packages.map((pkg) => pkg.name)))
	if (unlisted.length > 0)
		throw new Error(`${file} does not list: ${unlisted.map((dir) => relative(root, dir)).join(", ")}`)

	return { codegen: data.codegen, packages, project, root, spec, toolchains: data.toolchains }
}
