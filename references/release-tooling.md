---
description: Release tooling overview
order: 100
---

# Release tooling

`clients release` cuts versions for a product's public packages and mirrors each one to its own GitHub repo.
A product describes its packages once, in a `release.config.ts` typed by the `@workerstack/clients/release`
library; each package's dir sits beside the config, and the repo root is the config's git toplevel:

```ts
import { defineRelease } from "@workerstack/clients/release"

export default defineRelease({
	project: "acme",
	codegen: ["bun", "run", "codegen"],
	homepage: "https://example.com",
	spec: { committedPath: "openapi.json", deployedUrl: "https://api.example.com/openapi.json" },
	packages: [
		{ name: "sdk", repo: "acme/sdk", description: "Acme SDK", commitMessage: "chore: sync", topics: ["acme"] },
	],
})
```

```sh
clients release bump --config acme-release/release.config.ts [--major]
clients release sync --config acme-release/release.config.ts [--only sdk] [--dry-run] [--validate-only]
clients release bootstrap --config acme-release/release.config.ts (--all | --only sdk) [--force-bootstrap]
```

`bump` writes each changed package's version files, `CHANGELOG.md` and `.release-state.json` (an API change is a
minor, measured by oasdiff through Go on PATH); `sync` and `bootstrap` push with `GH_TOKEN`, committing as
`committer` (default `public-sync[bot]`).
