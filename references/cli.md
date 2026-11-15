---
description: The generated CLI
order: 80
---

# The command-line client

`--target cli` writes a Go command-line client for the API: one command per operation, grouped by its dotted
`operationId`, with `--help` everywhere, `commands` and `schema` for discovery, typed flags, table/JSON/NDJSON/YAML
output, streams, pagination, shell completion, and an embedded `SKILL.md` so an agent can drive it. It ships with a
release workflow, which can publish to Homebrew, Scoop, winget, AUR and deb/rpm/apk packages, and, with `--cli-repo`,
install scripts that verify what they install.

```sh
clients generate --spec openapi.json --target cli --out ./cli --cli-repo acme/shop-cli
shop orders list --status open --output json
```

| Value                                                               | Default         | What it does                                         |
| ------------------------------------------------------------------- | --------------- | ---------------------------------------------------- |
| a command per operation                                             | —               | grouped by the dotted operationId resource tree      |
| `--json`                                                            | off             | one machine-readable shape on every command          |
| `--output <json\|ndjson\|yaml\|table>`                              | table           | human and machine formats                            |
| `--api-key` / `--base-url` / `--config` / `--timeout` / `--verbose` | from config/env | auth, target, config file, deadline, logging         |
| `commands`, `schema`                                                | —               | a listable command index and per-call schemas        |
| `--output <file>`                                                   | stdout          | a binary response written as bytes, pipe-safe        |
| exit codes                                                          | usage/standard  | non-zero on usage error, distinct from a runtime one |

Its configuration has one precedence, everywhere: **flag, then environment, then config file.** The environment
variables are the `--cli-env-prefix` (or the API's name) upper-cased.

Full reference: [the generated CLI](https://github.com/workerstack/clients/blob/main/docs/cli.md) and
[releasing it](https://github.com/workerstack/clients/blob/main/docs/cli-release.md).
