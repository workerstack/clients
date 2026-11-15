---
description: What a run writes
order: 130
---

# What a run writes

**Stale files are deleted, edited ones kept.** Each `<out>/<target>` keeps `.clients-generated.json`: every file the
run wrote, with its sha256. A file is rewritten only when its bytes change, through a temp file renamed over it. A
regeneration deletes a file the last run wrote and this one does not (a `cli` target's old `<name>_cmds.go`, say),
unless it was edited since: that one is kept and named on stderr. A file the manifest never listed is never deleted,
nothing outside `<out>/<target>` is touched, and no symlink is followed. Without a manifest, nothing is deleted.

Every target is held to the same conformance grid: one shared scenario suite runs against a live reference server
for all eight targets, and each decoded answer and each request on the wire must match one expected table. A feature
that works in one SDK and breaks in another fails the grid.

To lay the files out yourself, `generated(run, document, ctx)` from `@workerstack/clients` returns each
target's `files` unwritten, each as its text but for the C# package's icon, which is its bytes, and its `packages`:
the package on each registry it publishes to, as `{ registry, name, version }` (`npm` and `jsr` for a scoped TS SDK,
`npm` and `mcp-registry` for an MCP server with an `mcpName`, `pypi`, `crates.io`, `nuget`, `maven-central` as
`group:artifact`, and `go` by the module path, its `/vN` included and no version when none is given).
`writeTarget(dir, files, packages)` writes one target's into a directory you pick under the same rules, keeping
`MANIFEST` (`.clients-generated.json`) there with the packages recorded beside the files, so a release reads each name
and version from it. A file the last call wrote that you leave out of `files` is stale: deleted if unedited, kept and
named in the result's `kept` if you changed it, and dropped from the manifest either way, so a file you take over by
editing is never touched again.

A run kept as data (a release manifest, say) is checked with the same tables the command parses. `TARGETS` lists
every target, and `targetOptionSchemas[target]` is a Standard Schema for that target's options: its option names only,
each a non-empty string, a switch `"true"` or `"false"`. `generated` checks each target's options with it before
anything generates, and `GenerateRun` types them by target, so a misspelled option is a type error, then a refusal.
`GenerateRun`'s `metadata` is the `--metadata-<field>` block as a `Metadata` object, `authors` and `keywords` as
arrays, checked with the same rules.

```ts
import { TARGETS, targetOptionSchemas } from "@workerstack/clients"

const result = targetOptionSchemas.go["~standard"].validate({ modulePath: "github.com/acme/shop-go" })
export const ok = result.issues === undefined && TARGETS.includes("go")
```

This package also exports the app-side generators the backend CLI and Vite plugin use: `generateRouteTree`,
`generateTypes` and `extractTypes` from `@workerstack/clients`, and the command's own entry at
`@workerstack/clients/cli`.
