# Releasing a product's public packages

`@workerstack/clients` releases a product's public packages from the private repo that generates them. One
`release.config.ts` lists the packages. `honey-clients release bump` cuts each package's next version from what
changed. `honey-clients release sync` mirrors each package into its own public repo and pushes the `v<version>` tag.
Each public repo's `release.yml` then publishes on that tag through OIDC, with no registry token stored anywhere.
Three reusable workflows in `workerstack/clients` run these steps in CI, so a consumer repo only writes short callers.

## Contents

- [Consumer prerequisites](#consumer-prerequisites)
- [release.config.ts](#releaseconfigts)
- [New product checklist](#new-product-checklist)
- [The reusable workflows](#the-reusable-workflows)
- [CLI](#cli)
- [Versioning](#versioning)
- [Tags](#tags)
- [Deployed spec gate](#deployed-spec-gate)
- [Channels](#channels)
- [Secrets](#secrets)

## Consumer prerequisites

- `@workerstack/clients` in the repo's dependencies. The `workflows-v1` workflows need 1.0.0-rc.25 or later, the first
  version with `release codegen` and `release toolchains`. The workflows run the consumer's own installed copy and pin
  none.
- `@workerstack/system` in the repo's dependencies, and a `system.config.ts` at the repo root that declares every name
  the release config lists in `toolchains`, each at the version codegen needs:

  ```ts
  import { defineConfig } from "@workerstack/system"

  export default defineConfig({ deps: { go: "1.27.2", rust: "1.99.1", uv: "0.13.1", ruff: "0.17.1" } })
  ```

- `packageManager: "bun@<version>"` in the root `package.json` (the workflows read Bun's version from it) and a
  committed `bun.lock` (they run `bun install --frozen-lockfile`, with the repo's scripts on).

## release.config.ts

A product's config sits in its own directory. Each package's source dir is a sibling named after the package, and
every other non-hidden directory there is an error. A package's public repo is `github.com/<repo>`.

```ts
import { defineRelease } from "@workerstack/clients/release"

export default defineRelease({
	project: "<product>",
	/* regenerates every package from the repo root; bump runs it, and it must honor RELEASE_VERSIONS */
	codegen: ["bun", "scripts/codegen.ts"],
	/* the system.config.ts deps codegen needs, installed in this order before it runs */
	toolchains: ["go", "rust", "uv", "ruff"],
	homepage: "https://<domain>",
	metadata: { license: "MIT", authors: ["<Name> <oss@<domain>>"] },
	packages: [
		{
			name: "cli",
			repo: "<org>/cli",
			description: "<one line: the repo's, every registry's, and the first CHANGELOG entry>",
			topics: ["<product>", "cli"],
			commitMessage: "chore: generate from openapi spec",
			honey: { target: "cli", options: { binaryName: "<bin>", modulePath: "github.com/<org>/cli", repo: "<org>/cli" } },
		},
		{
			name: "sdk-typescript",
			repo: "<org>/sdk-typescript",
			description: "<one line>",
			topics: ["<product>", "sdk"],
			commitMessage: "chore: generate from openapi spec",
			honey: { target: "ts" },
			registries: [{ kind: "npm" }, { kind: "jsr" }],
		},
	],
	spec: {
		committedPath: "api/openapi.public.json",
		deployedUrl: "https://api.<domain>/openapi.json",
	},
})
```

| Field                         | Meaning                                                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project`                     | The product's slug: each package's `<project>/<name>` key, and what codegen filters on                                                             |
| `codegen`                     | The argv that regenerates every package, run from the repo root. Bump runs it again with `RELEASE_VERSIONS` (JSON, package name to version) set    |
| `toolchains`                  | Optional, none by default. The `system.config.ts` dep names codegen needs; the workflows install them in this order                                |
| `committer`                   | Optional. The identity sync commits as (`public-sync[bot]` by default); a GitHub App's bot address works                                           |
| `homepage`                    | https. Every public repo's website and every registry's homepage                                                                                   |
| `metadata`                    | Optional. Package metadata every generated package carries (authors, license, keywords and the rest); a package's own `metadata` wins over it      |
| `packages[].honey`            | How honey-clients generates the package: its target and that target's options. Absent for a hand-kept package (one that publishes the spec itself) |
| `packages[].registries`       | Where the public repo's rendered `release.yml` publishes: `npm`, `jsr`, `pypi`, `crates`, `go`, `nuget`, `maven`, or `github` with `assets`        |
| `packages[].branch`           | The public repo's branch sync pushes to, `main` by default                                                                                         |
| `packages[].bootstrapExclude` | Globs the first push leaves out, so the next sync adds them as their own commit                                                                    |
| `spec`                        | The committed spec codegen builds from (repo-relative), and the URL prod serves it at (the deployed spec gate)                                     |

## New product checklist

1. Create or pick the GitHub org for the public repos, and an empty public repo `<org>/<package>` for each package.
   Sync pushes their content; nobody commits there by hand.
2. Register the account-backed channels the packages need. Every registry that supports it publishes through a
   trusted publisher for repo `<org>/<package>`, workflow `release.yml`:
   - JSR: create `@<scope>` and link the package to its repo.
   - npm: npm adds a trusted publisher only to a package that exists, so publish it once by hand with a short-lived
     granular token, add the trusted publisher, then revoke the token.
   - PyPI: add a pending trusted publisher (it works before the first upload).
   - crates.io: publish once with `cargo publish` and a short-lived token, then add the trusted publisher.
   - NuGet: add a trusted-publishing policy for the repo and workflow, and set the repo variable `NUGET_USER` to the
     nuget.org user that owns it.
   - Maven Central has no OIDC: verify the namespace, generate a Portal user token, create a GPG key whose public half
     is on `keys.openpgp.org`, and add the four `MAVEN_*` secrets to the SDK's repo (see [Secrets](#secrets)).
   - Go: nothing to register; the workflow's `proxy.golang.org` fetch indexes the tag.
   - A CLI's channels are honey `cli` options, each optional: a Homebrew tap repo, a Scoop bucket repo, a
     `microsoft/winget-pkgs` fork, an AUR account with an SSH key. Each one's token goes in the CLI's repo.
3. Create a GitHub App with `contents: write` and `workflows: write` (sync pushes each repo's `release.yml`), install
   it on the org's public repos, and store its ID and private key as two Actions secrets in the private repo.
4. Write `release.config.ts` with a dir per package, add the prerequisites above, and check the config:
   `honey-clients release sync --config <path> --validate-only`. A CLI also needs a hand `README.md` and `LICENSE`;
   honey writes its `.goreleaser.yaml` and `.github/workflows/release.yml`.
5. Publishing needs no workflow edits: every public tree carries a `release.yml` (the CLI's from honey, the rest
   rendered from `registries`). Before the first real tag, run a repo's `release.yml` by hand with `workflow_dispatch`
   to see each registry accept it. A repo whose version is already live must get that tag pushed by hand before its
   first `release.yml` lands, or sync tags and republishes it.
6. First release: commit the spec (bump records the commit a release is cut from), run the bump caller (or
   `honey-clients release bump --config <path>` locally), and merge the release PR. Each package releases 1.0.0 with
   its `description` as the entry. The next sync tags each package.
7. Verify: each public repo's `release` run is green (`gh run list -R <org>/<package> -w release`), its GitHub release
   has its assets, each registry serves the new version, and a CLI's tap, bucket, winget PR and AUR package show it.

## The reusable workflows

A consumer calls each one from its own workflow, pinned to the `workflows-v1` tag. The caller owns the triggers,
the `concurrency` group and the permissions it grants. A reusable workflow's job never gets more than its caller
grants, and secrets pass only through the declared `secrets:`, never `secrets: inherit` across owners. Every job runs
the same set-up: checkout, Node 24 (the release config loads as TypeScript), Bun from `packageManager`,
`bun install --frozen-lockfile`, each `toolchains` name through `system install <name> --upgrade` at its
`system.config.ts` pin with those tools first on PATH, then `release codegen`.

Each workflow also takes `cli`, the command that runs honey-clients, split on spaces. It defaults to
`bun x --no-install honey-clients`, the bin a consumer's `@workerstack/clients` install links. A consumer leaves it
unset. This repo's own release fixture passes `node bin/honey-clients.js`, because bun never links a root package's
own bin.

```yaml
# .github/workflows/release-sync.yml
on:
  push:
    branches: [main]
    paths: ["<product>-release/**", "api/**"]
  schedule: [{ cron: "0 3 * * *" }]
  workflow_dispatch:
    inputs:
      dry-run: { type: boolean, default: false }
      only: { type: string, required: false }
concurrency: { group: release-sync, cancel-in-progress: false }
permissions: { contents: read }
jobs:
  sync:
    uses: workerstack/clients/.github/workflows/release-sync.yml@workflows-v1
    with:
      config: <product>-release/release.config.ts
      app-owner: <org>
      dry-run: ${{ inputs.dry-run == true }}
      only: ${{ inputs.only }}
    secrets:
      app-id: ${{ secrets.RELEASE_APP_ID }}
      app-private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}
```

| `release-sync.yml`          | Meaning                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `config`                    | Required. The release config, repo-relative                                                                                |
| `app-owner`                 | The App installation's owner (the public repos' org); blank means the caller repo's owner                                  |
| `dry-run`                   | Stage each tree and report what would be pushed and tagged, pushing nothing                                                |
| `only`                      | Comma-separated package names (`name` or `project/name`); blank means every package                                        |
| `app-id`, `app-private-key` | Secrets, optional. Without both, the token step is skipped and only a dry run works (sync says `GH_TOKEN env is required`) |

```yaml
# .github/workflows/release-bump.yml
on:
  workflow_dispatch:
    inputs:
      major: { type: boolean, default: false }
permissions: { contents: write, pull-requests: write }
jobs:
  bump:
    uses: workerstack/clients/.github/workflows/release-bump.yml@workflows-v1
    with:
      config: <product>-release/release.config.ts
      major: ${{ inputs.major == true }}
```

`release-bump.yml` takes `config` (required) and `major` (release every changed package as a major). It also installs
`go` when `toolchains` does not list it, because bump runs oasdiff through `go run`. When a package changed, it opens
or updates the release PR on branch `auto/release-bump` with exactly the paths bump printed as `wrote:`. That PR is
opened with the caller's `GITHUB_TOKEN`, so it starts no workflows of its own: run the validate caller by hand, or
review the PR's diff.

```yaml
# .github/workflows/release-validate.yml
on:
  pull_request:
    paths: ["<product>-release/**"]
permissions: { contents: read }
jobs:
  validate:
    uses: workerstack/clients/.github/workflows/release-validate.yml@workflows-v1
    with:
      config: <product>-release/release.config.ts
```

`release-validate.yml` takes `config` and runs the set-up, codegen, then `release sync --validate-only`.

A dry run proves the whole path short of the push: the toolchains install, codegen runs, every package's tree is
staged against its public repo's current tip, its `release.yml` is rendered, and the report says which packages would
be pushed and which `v<version>` tags would be created. It leaves out the push, the tag and the repo settings step.

## CLI

```
honey-clients release bump --config <path> [--major]
honey-clients release sync --config <path> [--only <names>] [--dry-run] [--validate-only]
honey-clients release bootstrap --config <path> (--all | --only <names>) [--force-bootstrap]
honey-clients release codegen --config <path>
honey-clients release toolchains --config <path>
```

- `bump` regenerates, decides each package's release, gates generated output on prod, writes versions, regenerates at
  them, and records the release. It prints one `bumped: <name> <version> <kind>` line per release and one
  `wrote: <path>` line per file it touched.
- `sync` mirrors each package and pushes its tag. It needs `GH_TOKEN` unless `--dry-run` or `--validate-only` is set.
- `bootstrap` makes the first push to an empty public repo, or over the stub a new repo starts with.
- `codegen` runs the config's codegen from the repo root, as bump runs it.
- `toolchains` prints the config's `toolchains`, one per line.

## Versioning

`bump` runs the product's codegen, then compares each package with what its `.release-state.json` recorded at the last
release. It compares the generated output (honey's `.honey-generated.json` map, or the spec itself for a hand-kept
package) and the tracked hand files (version lines normalized, the CHANGELOG and the state file left out). Nothing
moved means no release, even when the spec moved.

When the output changed on a moved spec, oasdiff compares the spec with the one the last release was cut from (read
back with `git show <commit>:<path>`). Any API change, breaking or not, is a minor. Output that changed with no API change,
and any hand-file change, is a patch. A package stays on its major line: a major comes only from `--major`, which makes each
package that releases a major.

A release writes the new version into every version file the package has (`package.json`, `jsr.json`,
`pyproject.toml`). It reruns codegen with `RELEASE_VERSIONS`, so version-baked output is regenerated at that version.
Only then does it record the digests, the spec's commit and the version in `.release-state.json`, so the merged release
PR finds nothing left to release. The spec must be committed first, because the state records HEAD. A refusal writes
nothing, so a rerun decides the same. Each public repo's `release.yml` checks the tag against its version files, so a
tag whose files disagree fails before anything publishes.

## Tags

Sync tags; the private repo never does. After sync pushes a package, or finds the bot's tip already equal to the
source, it pushes `v<version>` from the package's `.release-state.json` unless that tag exists. It never moves a tag,
so a rerun, or a run after one that stopped between its commit and its tag, converges. A merged release PR therefore
releases every bumped package on the next sync. Never delete or move a pushed tag.

## Deployed spec gate

Generated code may only describe operations prod serves. The gate fetches `spec.deployedUrl` and compares it with the
committed spec by canonical sha. Sync refuses a package whose changed paths include a file honey generated. Bump
refuses the whole run, hand-kept packages included, when a generated package whose output changed would release. On
drift both print both shas and the operations on either side. Deploy, then rerun the bump caller; sync reruns on its
schedule.

## Channels

| Package kind               | Channel                                                                                       | Published by                            |
| -------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------- |
| CLI                        | GitHub Release: archives, `checksums.txt` signed by cosign, build attestations, `version.txt` | honey's `release.yml` in the CLI's repo |
| CLI                        | Homebrew cask, Scoop manifest, winget PR, AUR `<bin>-bin`, deb/rpm/apk assets (each optional) | the same, with its channel's secret     |
| TypeScript SDK, MCP server | npm (provenance), JSR                                                                         | the rendered `release.yml`              |
| Go SDK                     | the Go proxy (`proxy.golang.org` fetch of the tag)                                            | the rendered `release.yml`              |
| Python SDK                 | PyPI (attestations)                                                                           | the rendered `release.yml`              |
| Rust SDK                   | crates.io                                                                                     | the rendered `release.yml`              |
| C# SDK                     | NuGet                                                                                         | the rendered `release.yml`              |
| Java SDK                   | Maven Central (GPG-signed bundle through the Central Portal)                                  | the rendered `release.yml`              |
| OpenAPI spec               | GitHub Release with `openapi.json`                                                            | the rendered `release.yml`              |

A rendered `release.yml` checks the tag against the version each registry publishes from, publishes, and retries until
the registry serves the version. A rejected or repeated upload fails the run; a rerun is `workflow_dispatch` with the
tag. Go modules at 2.0.0 and up carry `/v<major>` in their path, which codegen adds for the go and cli targets.

## Secrets

| Secret                                             | Where            | Read by                                                                           |
| -------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------- |
| the App's ID and private key                       | the private repo | the sync caller, passed as `app-id` and `app-private-key`                         |
| `HOMEBREW_TAP_TOKEN`                               | `<org>/cli`      | goreleaser's cask push to the tap                                                 |
| `SCOOP_BUCKET_TOKEN`                               | `<org>/cli`      | goreleaser's manifest push to the bucket                                          |
| `WINGET_TOKEN`                                     | `<org>/cli`      | goreleaser's push to the winget-pkgs fork and its PR to `microsoft/winget-pkgs`   |
| `AUR_SSH_KEY`                                      | `<org>/cli`      | goreleaser's push to `aur.archlinux.org/<bin>-bin.git`                            |
| none for npm, JSR, PyPI, crates.io, NuGet          |                  | trusted publishers; NuGet's login also reads the repo variable `NUGET_USER`       |
| `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD` | `<org>/sdk-java` | the Central Portal user token: uploads the bundle and polls until it is published |
| `MAVEN_GPG_PRIVATE_KEY`, `MAVEN_GPG_PASSPHRASE`    | `<org>/sdk-java` | signs every bundle file; the public key must be on a keyserver Central reads      |
