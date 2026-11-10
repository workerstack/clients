/**
 * How each registry kind names the package, reads its version, publishes, and shows it is live: the steps the
 * rendered `release.yml` runs for it.
 */
import type { Registry } from "./types.ts"

/* Actions the workflow runs, pinned to a commit. */
export const ACTIONS = {
	checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
	cratesAuth: "rust-lang/crates-io-auth-action@3268eb413133e2960fa4ae0e963ca76380c54cd9 # v1.0.6",
	nugetLogin: "NuGet/login@8d196754b4036150537f80ac539e15c2f1028841 # v1.2.0",
	pypiPublish: "pypa/gh-action-pypi-publish@7245906fb61fa33a13554f9d5fb856fe61758086 # v1.14.3",
	rustToolchain: "dtolnay/rust-toolchain@683b588c487a69d01f6c6ddf40f036ff682cc2c8",
	setupDotnet: "actions/setup-dotnet@a98b56852c35b8e3190ac28c8c2271da59106c68 # v6.0.0",
	setupGradle: "gradle/actions/setup-gradle@3f5f9adaf7d9fecd50b5935e54106014257a94e6 # v6.4.0",
	setupJava: "actions/setup-java@b843ebf9b913146b38da2eaa7aeddf76074ae1ad # v6.1.0",
	setupNode: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0",
	setupPython: "actions/setup-python@6d4fd22b20465ccc0f7354476588e8df7c9ca0e0 # v7.1.0",
} as const

/* npm publishes over OIDC from 11.5.1 on. */
export const TOOLS = {
	build: "1.6.1",
	dotnet: "10.0.403",
	gradle: "9.8.2",
	java: "21",
	jsr: "0.14.3",
	node: "24",
	npm: "12.2.1",
	python: "3.12",
	rust: "1.99.0",
} as const

/* The record honey keeps in every package it generates: the package's name and version on each registry. */
const IDENTITY = ".honey-generated.json"
/* `field` of the package honey recorded for `registry`, or a failed step when it recorded none. */
const identity = (registry: string, field: "name" | "version") =>
	`jq -er '.packages[] | select(.registry == "${registry}") | .${field}' ${IDENTITY}`

/** How one registry kind names the package, reads its version, publishes, and shows it is live. */
export type Kind = {
	/** The package's own file the registry publishes the version of. */
	file: string
	/** Shell that prints that version. */
	version: string
	/** Shell that prints the name the registry knows the package by. */
	name: string
	/** Publish steps (YAML list items, indented for `steps:`). */
	publish: string
	/** A shell condition, true once the registry serves `$NAME` at `$VERSION`. */
	live: string
	/** Environment the live check needs (YAML `env:` lines, indented for a step). */
	liveEnv?: string
	oidc: boolean
	/** How many 10 s waits the live check allows (60 unless the registry lags longer). */
	tries?: number
}

/* A `key = '…'` line of a Gradle build script. */
const gradleField = (key: string, file: string) => `sed -n "s/^${key} = '\\(.*\\)'$/\\1/p" ${file}`

/* Maven Central's Portal, which takes a signed bundle and reports the deployment's state. */
const CENTRAL_PORTAL = "https://central.sonatype.com"
/* repo1 serves a deployment up to 30 minutes after the Portal reports it PUBLISHED. */
const MAVEN_LIVE_TRIES = 180
const PORTAL_AUTH = `TOKEN="$(printf '%s:%s' "$MAVEN_CENTRAL_USERNAME" "$MAVEN_CENTRAL_PASSWORD" | base64 -w0)"`
const PORTAL_SECRETS = `          MAVEN_CENTRAL_USERNAME: \${{ secrets.MAVEN_CENTRAL_USERNAME }}
          MAVEN_CENTRAL_PASSWORD: \${{ secrets.MAVEN_CENTRAL_PASSWORD }}
          CENTRAL_PORTAL_URL: ${CENTRAL_PORTAL}
`

const NODE_SETUP = `      - uses: ${ACTIONS.setupNode}
        with:
          node-version: "${TOOLS.node}"
          registry-url: https://registry.npmjs.org
`

function npm(): Kind {
	return {
		file: IDENTITY,
		live: `[ "$(npm view "$NAME@$VERSION" version 2>/dev/null)" = "$VERSION" ]`,
		name: identity("npm", "name"),
		oidc: true,
		publish: `${NODE_SETUP}      - name: npm publish
        run: |
          npm install --global npm@${TOOLS.npm}
          npm publish --provenance --access public
`,
		version: identity("npm", "version"),
	}
}

function jsr(): Kind {
	return {
		file: IDENTITY,
		live: `curl -fsS -o /dev/null "https://jsr.io/$NAME/\${VERSION}_meta.json"`,
		name: identity("jsr", "name"),
		oidc: true,
		publish: `${NODE_SETUP}      - name: jsr publish
        run: npx --yes jsr@${TOOLS.jsr} publish
`,
		version: identity("jsr", "version"),
	}
}

function pypi(): Kind {
	return {
		file: IDENTITY,
		live: `curl -fsS -o /dev/null "https://pypi.org/pypi/$NAME/$VERSION/json"`,
		name: identity("pypi", "name"),
		oidc: true,
		publish: `      - uses: ${ACTIONS.setupPython}
        with:
          python-version: "${TOOLS.python}"
      - name: build
        run: |
          python -m pip install build==${TOOLS.build}
          python -m build
      - uses: ${ACTIONS.pypiPublish}
`,
		version: identity("pypi", "version"),
	}
}

function crates(): Kind {
	return {
		file: IDENTITY,
		live: `curl -fsS -o /dev/null -A "release.yml (github.com/$GITHUB_REPOSITORY)" "https://crates.io/api/v1/crates/$NAME/$VERSION"`,
		name: identity("crates.io", "name"),
		oidc: true,
		publish: `      - uses: ${ACTIONS.rustToolchain}
        with:
          toolchain: "${TOOLS.rust}"
      - uses: ${ACTIONS.cratesAuth}
        id: crates-auth
      - name: cargo publish
        env:
          CARGO_REGISTRY_TOKEN: \${{ steps.crates-auth.outputs.token }}
        run: cargo publish
`,
		version: identity("crates.io", "version"),
	}
}

/* NuGet's trusted publishing trades the job's OIDC token for a short-lived key; the policy belongs to a
 * nuget.org user, which the repository variable NUGET_USER names */
function nuget(): Kind {
	return {
		file: IDENTITY,
		live: `curl -fsS -o /dev/null "https://api.nuget.org/v3-flatcontainer/$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]')/$VERSION/$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]').nuspec"`,
		name: identity("nuget", "name"),
		oidc: true,
		publish: `      - name: NuGet names the user that owns the trusted-publishing policy
        env:
          NUGET_USER: \${{ vars.NUGET_USER }}
        run: |
          [ -n "$NUGET_USER" ] || { echo "::error::set the repository variable NUGET_USER to the nuget.org user that owns the trusted-publishing policy"; exit 1; }
      - uses: ${ACTIONS.setupDotnet}
        with:
          dotnet-version: "${TOOLS.dotnet}"
      - uses: ${ACTIONS.nugetLogin}
        id: nuget-login
        with:
          user: \${{ vars.NUGET_USER }}
      - name: dotnet nuget push
        env:
          NUGET_API_KEY: \${{ steps.nuget-login.outputs.NUGET_API_KEY }}
        run: |
          dotnet pack --configuration Release --output "$RUNNER_TEMP/nupkg"
          dotnet nuget push "$RUNNER_TEMP/nupkg/*.nupkg" --api-key "$NUGET_API_KEY" --source https://api.nuget.org/v3/index.json
`,
		version: identity("nuget", "version"),
	}
}

/* the signed bundle: the Maven layout of every file with its GPG signature, md5 and sha1 */
function mavenBundle(): string {
	return `      - uses: ${ACTIONS.setupJava}
        with:
          distribution: temurin
          java-version: "${TOOLS.java}"
      - uses: ${ACTIONS.setupGradle}
        with:
          gradle-version: "${TOOLS.gradle}"
      - name: Maven Central bundle
        env:
          MAVEN_GPG_PRIVATE_KEY: \${{ secrets.MAVEN_GPG_PRIVATE_KEY }}
          MAVEN_GPG_PASSPHRASE: \${{ secrets.MAVEN_GPG_PASSPHRASE }}
        run: |
          set -euo pipefail
          STAGE="$RUNNER_TEMP/m2"
          gradle --no-daemon publishToMavenLocal -Dmaven.repo.local="$STAGE"
          printf '%s' "$MAVEN_GPG_PRIVATE_KEY" | gpg --batch --import
          GROUP="$(${gradleField("group", "build.gradle")})"
          ARTIFACT="$(${gradleField("rootProject.name", "settings.gradle")})"
          REL="$(printf '%s' "$GROUP" | tr . /)/$ARTIFACT/$VERSION"
          cd "$STAGE/$REL"
          rm -f _remote.repositories maven-metadata*
          for FILE in *; do
            gpg --batch --yes --pinentry-mode loopback --passphrase "$MAVEN_GPG_PASSPHRASE" --armor --detach-sign "$FILE"
            md5sum "$FILE" | cut -d " " -f 1 > "$FILE.md5"
            sha1sum "$FILE" | cut -d " " -f 1 > "$FILE.sha1"
          done
          cd "$STAGE"
          zip -qr "$RUNNER_TEMP/bundle.zip" "$REL"
`
}

/* the bundle uploaded to the Portal, then waited on until the Portal publishes it */
function mavenPortal(): string {
	return `      - name: Maven Central upload
        env:
${PORTAL_SECRETS}        run: |
          set -euo pipefail
          ${PORTAL_AUTH}
          ID="$(curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -F "bundle=@$RUNNER_TEMP/bundle.zip" "$CENTRAL_PORTAL_URL/api/v1/publisher/upload?publishingType=AUTOMATIC")"
          echo "DEPLOYMENT_ID=$ID" >> "$GITHUB_ENV"
      - name: Maven Central publishes the deployment
        env:
${PORTAL_SECRETS}        run: |
          set -euo pipefail
          ${PORTAL_AUTH}
          for _ in $(seq "\${PORTAL_TRIES:-60}"); do
            BODY="$(curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$CENTRAL_PORTAL_URL/api/v1/publisher/status?id=$DEPLOYMENT_ID")"
            STATE="$(printf '%s' "$BODY" | jq -r .deploymentState)"
            case "$STATE" in
              PUBLISHED) echo "Maven Central published deployment $DEPLOYMENT_ID"; exit 0 ;;
              PENDING | VALIDATING | VALIDATED | PUBLISHING) sleep "\${PORTAL_WAIT:-10}" ;;
              FAILED) echo "::error::Maven Central refused deployment $DEPLOYMENT_ID: $(printf '%s' "$BODY" | jq -c .errors)"; exit 1 ;;
              *) echo "::error::Maven Central reports deployment $DEPLOYMENT_ID as $STATE"; exit 1 ;;
            esac
          done
          echo "::error::Maven Central did not publish deployment $DEPLOYMENT_ID in time"
          exit 1
`
}

/* Maven Central takes no OIDC: a Portal token uploads a bundle, the Maven layout of every file with its
 * GPG signature, md5 and sha1, and the Portal validates and publishes it */
function maven(): Kind {
	return {
		file: IDENTITY,
		live: `curl -fsS -o /dev/null "https://repo1.maven.org/maven2/$(printf '%s' "\${NAME%%:*}" | tr . /)/\${NAME#*:}/$VERSION/\${NAME#*:}-$VERSION.pom"`,
		name: identity("maven-central", "name"),
		oidc: false,
		publish: `${mavenBundle()}${mavenPortal()}`,
		tries: MAVEN_LIVE_TRIES,
		version: identity("maven-central", "version"),
	}
}

/* the proxy fetches a module version the first time it is asked for it, so the live check publishes it */
function goProxy(): Kind {
	return {
		file: IDENTITY,
		live: `curl -fsS -o /dev/null "https://proxy.golang.org/$NAME/@v/$TAG.info"`,
		name: identity("go", "name"),
		oidc: false,
		publish: "",
		version: identity("go", "version"),
	}
}

/* gh in Actions runs only with a token in GH_TOKEN */
const GH_TOKEN_ENV = `        env:
          GH_TOKEN: \${{ github.token }}
`

function githubRelease(registry: Extract<Registry, { kind: "github" }>): Kind {
	const assets = registry.assets.map((asset) => JSON.stringify(asset)).join(" ")
	return {
		file: ".release-state.json",
		live: `gh release view "$TAG" > /dev/null`,
		liveEnv: GH_TOKEN_ENV,
		name: 'echo "$GITHUB_REPOSITORY"',
		oidc: false,
		publish: `      - name: GitHub release
${GH_TOKEN_ENV}        run: gh release create "$TAG" ${assets} --verify-tag --title "$TAG" --notes "Release $TAG."
`,
		version: "jq -r .version .release-state.json",
	}
}

/* every kind but a GitHub release, which reads its assets from the registry entry */
const KINDS = { crates, go: goProxy, jsr, maven, npm, nuget, pypi } as const

/** The steps the release workflow runs for `registry`. */
export function kind(registry: Registry): Kind {
	return registry.kind === "github" ? githubRelease(registry) : KINDS[registry.kind]()
}
