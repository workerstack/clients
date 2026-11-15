---
description: Install the package
order: 20
---

# Install

backend moved to the workerstack org in 1.0.0-rc.23, and [the migration note](https://github.com/workerstack/backend/blob/main/docs/migrating-from-honey.md)
maps each old package name to its new one. 1.0 is out as a release candidate, published under npm's `next` tag, so
an install without a tag gets a deprecated placeholder.
Add `@next` until the final release:

```sh
npm install --save-dev @workerstack/clients@next
```

Node 22.12 or later, or Bun 1.3 or later.

Each target formats what it writes with that language's own formatter, when it can find it:

| target      | formatter | found by                                                                    |
| ----------- | --------- | --------------------------------------------------------------------------- |
| `go`, `cli` | gofmt     | `$GOFMT`, `$GOROOT/bin/gofmt`, `gofmt` on `PATH`, beside the `go` on `PATH` |
| `python`    | ruff      | `$RUFF`, then `ruff` on `PATH`                                              |
| `rust`      | rustfmt   | `$RUSTFMT`, the active toolchain's own binary beside `rustc`, `PATH`        |
| `ts`        | oxfmt     | the `oxfmt` optional peer, installed beside clients                         |

A formatter it cannot find is named on standard error and skipped: the files go out as the emitter wrote them,
which is valid source either way, so generating a Python SDK never requires you to install ruff. Set
`CLIENTS_REQUIRE_FORMATTERS=1` to make a missing formatter fail the run instead, for a pipeline that would
rather stop than ship unformatted code. An override that points at nothing is refused by name.

oxfmt is the exception and says nothing when absent: it is clients' own choice of TypeScript formatter and a
declared optional peer, so not having it is the documented normal rather than news. `CLIENTS_REQUIRE_FORMATTERS`
still stops for it.

The `csharp` and `java` targets are not formatted today: `dotnet format` and google-java-format work over a
project rather than a stream, which clients' post-pass does not yet do.
