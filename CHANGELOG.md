# Changelog

All notable changes to [`@workerstack/clients`](https://www.npmjs.com/package/@workerstack/clients), formerly `@lovrozagar/honey-clients`, are documented in this file. Releases up to 1.0.0-rc.23 shipped from the backend repository; their notes are in [its changelog](https://github.com/workerstack/backend/blob/main/CHANGELOG.md).

## 1.0.0

### Breaking

- **Every honey name is gone (1.0.0-rc.27).** The bin is `clients` (was `honey-clients`), the env vars are `CLIENTS_*`, the source condition is `backend-source`, the wire names are `x-backend-*`, and the generated SDKs are named for the target: `HttpSdk`, `http_sdk`, `HttpException` and the rest. There are no aliases. Upgrade together with `@workerstack/backend` 1.0.0-rc.26, rerun `clients generate`, and use [the migration guide](docs/migrating-from-honey.md), which maps each old name to its new one.

### Added

- **installgen ships inside the package.** The `installgen` command (`init`, `build`, `check`) and the `@workerstack/clients/installers` subpath replace `@lovrozagar/installgen`. A generated CLI's `release.yml` now runs `npx --yes --package @workerstack/clients@<version> installgen check`, from the same release that wrote its installers.
- **Release tooling ships inside the package.** `honey-clients release bump|sync|bootstrap|codegen|toolchains --config <path>` and the `@workerstack/clients/release` subpath version, mirror and publish the packages a `release.config.ts` lists. `release codegen` runs the config's codegen as `bump` does, and `release toolchains` prints the `system.config.ts` names that codegen needs, from the config's new `toolchains` field.
- **Reusable release workflows.** `release-validate.yml`, `release-sync.yml` and `release-bump.yml` in this repository are callable as `workerstack/clients/.github/workflows/<name>.yml@workflows-v1`; they install the consumer's toolchains and run its codegen before they validate, mirror or open the release PR. [`references/release.md`](https://github.com/workerstack/clients/blob/main/references/release.md) is the release guide. They need this release or later in the consumer.

### Changed

- **Generated code imports the backend by surface.** `@workerstack/backend` 1.0.0-rc.26 has no root entry, so the generated `types.gen.d.ts`, route trees and the IR loader import `@workerstack/backend/http` and `/http/openapi`. Upgrade both packages together and rerun `honey-clients generate`; [the backend's migration guide](https://github.com/workerstack/backend/blob/main/docs/migrating-from-honey.md) maps every moved import.
- **The package has its own repository.** `@workerstack/clients` now ships from [github.com/workerstack/clients](https://github.com/workerstack/clients), with its full history. The move itself changed nothing in the package: 1.0.0-rc.24 has rc.23's `honey-clients` command, exports and generated code. It depends on `@workerstack/backend` only for its tests, and an app keeps both as before.

### Fixed

- **A GitHub release's live check has the job's token.** The rendered `release.yml` step that confirms a `github` registry's release ran `gh release view` without `GH_TOKEN`, so it failed in Actions after the release was created. It now gets `GH_TOKEN: ${{ github.token }}` like the publish step. The release guide also lists `administration: write` for the sync App, which sync needs to set a repo's description, homepage and topics.
