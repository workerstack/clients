# Release fixture package

The one package of the release fixture (`../release.config.ts`), which `.github/workflows/release-fixture.yml` runs
the reusable release workflows against. Nothing publishes it.

What each job proves on every change to the workflows, this fixture or the release code:

- `validate`: the toolchains in `toolchains` install at their `system.config.ts` pins and win on PATH (the codegen
  checks each exact version), codegen runs, and the config validates.
- `sync-dry-run`: the same set-up, then a token-less sync that stages this package for branch
  `release-fixture-mirror` of `workerstack/clients`, which does not exist, and pushes nothing.
- `bump`: the same set-up, then a bump that finds no change since the release recorded here, so no PR opens.

Change a file here only together with a local bump run whose output is committed in the same commit:

```console
RELEASE_FIXTURE_ANY_VERSION=1 node packages/gen/bin/honey-clients.js release bump --config .github/release-fixture/release.config.ts
```

Otherwise the next `bump` job on `main` finds a change and opens a real release PR in `workerstack/clients`.
