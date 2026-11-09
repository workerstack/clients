/** An operating system the scripts install for, in Go's GOOS spelling. */
export type Os = "linux" | "darwin" | "windows"
/** A CPU architecture the scripts install for, in Go's GOARCH spelling. */
export type Arch = "amd64" | "arm64"
/** An `os/arch` pair, as `platforms` lists them (`"linux/amd64"`). */
export type Platform = `${Os}/${Arch}`

/* Mixed case, so toUpperCase and toLowerCase both change it and the build reports the call as mangled. */
export const VERSION_SENTINEL = "__InstallGen_Version__"
export const TAG_SENTINEL = "__InstallGen_Tag__"

declare const versionBrand: unique symbol
declare const tagBrand: unique symbol

/** The release version without the tag prefix (`1.2.3`). Interpolate it; the script fills it in at install time. */
export interface VersionToken {
	/** Yields a placeholder the build swaps for the script's version variable; a string method on it is refused. */
	readonly [Symbol.toPrimitive]: (hint: string) => string
	readonly [versionBrand]: true
}

/** The release tag, `tagPrefix` + version (`v1.2.3`). Interpolate it; the script fills it in at install time. */
export interface TagToken {
	/** Yields a placeholder the build swaps for the script's tag variable; a string method on it is refused. */
	readonly [Symbol.toPrimitive]: (hint: string) => string
	readonly [tagBrand]: true
}

/** What a path function gets: the tokens to interpolate, and the platform it is called for (once per platform). */
export interface PathContext {
	/** The version being installed, filled in at install time. */
	readonly version: VersionToken
	/** The tag being installed, filled in at install time. */
	readonly tag: TagToken
	/** The platform's operating system. */
	readonly os: Os
	/** The platform's architecture. */
	readonly arch: Arch
}

/** What `checksumsPath` gets: the path context plus the asset it lists. */
export interface ChecksumsContext extends PathContext {
	/** The asset path `assetPath` returned for this platform. */
	readonly asset: string
}

/** What `signature.bundlePath` gets: the checksums context plus the checksums file it signs. */
export interface BundleContext extends ChecksumsContext {
	/** The checksums path `checksumsPath` returned for this platform. */
	readonly checksums: string
}

/** A keyless sigstore signature on the checksums file, checked by `cosign verify-blob` when cosign is on PATH. */
export interface SignatureConfig {
	/**
	 * The certificate identity the bundle must carry, matched exactly: an https URL. Interpolate `tag` to bind it to the
	 * release, e.g. `https://github.com/o/r/.github/workflows/release.yml@refs/tags/${tag}`.
	 */
	identity: (ctx: PathContext) => string
	/** The OIDC issuer the certificate must carry. Default `"https://token.actions.githubusercontent.com"`. */
	issuer?: string
	/** The sigstore bundle of the checksums file, per platform. Default: the checksums path + `.sigstore.json`. */
	bundlePath?: (ctx: BundleContext) => string
}

/** Where the two scripts are served: https, or http on loopback. The scripts print these in their hints. */
export interface ScriptUrls {
	/** The URL users pipe to `sh`. */
	sh: string
	/** The URL users pipe to `iex`. */
	ps1: string
}

/** An `installgen.config.ts` default export: where a release's files live and how the scripts install them. */
export interface InstallgenConfig {
	/** The binary name, `^[A-Za-z0-9][A-Za-z0-9._-]*$`. */
	name: string
	/** Where the files live. https only; loopback http is allowed for tests. */
	baseUrl: string
	/** The asset path under `baseUrl`, per platform. Must contain `version` or `tag`. */
	assetPath: (ctx: PathContext) => string
	/** Default: all six. */
	platforms?: readonly Platform[]
	/** A shared `checksums.txt` or a per-asset `<asset>.sha256`, per platform. Unset: no verification. */
	checksumsPath?: (ctx: ChecksumsContext) => string
	/** Verify the checksums file's signature before its hashes. Needs `checksumsPath`. Unset: no signature check. */
	signature?: SignatureConfig
	/** The file holding the latest version. Default `"latest"`. */
	latestPath?: string
	/** The binary's path inside an archive. Default: search the extracted tree. */
	binaryInArchive?: (ctx: PathContext) => string
	/** Default `"v"`. */
	tagPrefix?: string
	/** Must start with `~/`. Default `"~/.<name>/bin"`. */
	installDir?: string
	/** Prefix of the end-user overrides. Default: `name` uppercased, non-alphanumerics → `_`. */
	envPrefix?: string
	/** Default `true`. */
	modifyPath?: boolean
	/** Printed after a successful install. */
	message?: string
	/** Where the scripts are served. Default `baseUrl/install.sh` and `baseUrl/install.ps1`. */
	scriptUrls?: ScriptUrls
	/** Default `"installers"`. */
	outDir?: string
}

/** Returns `config` unchanged; it is there so an untyped config file still gets the config's types. */
export function defineConfig(config: InstallgenConfig): InstallgenConfig {
	return config
}

const token = (sentinel: string) => Object.freeze({ [Symbol.toPrimitive]: () => sentinel })

export const versionToken = /* @__PURE__ */ token(VERSION_SENTINEL) as unknown as VersionToken
export const tagToken = /* @__PURE__ */ token(TAG_SENTINEL) as unknown as TagToken
