# The generated CLI

`clients generate --target cli` writes a Go command-line client: one command per operation, grouped
by its dotted `operationId`, with `--help`, `commands` and `schema` describing every call and an embedded `SKILL.md`
for agents. It reads its base URL and credentials from flags, the environment or a config file, and it ships with a
release workflow and install scripts; see the CLI release page.

## Example

```sh
clients generate --spec openapi.json --target cli --out ./cli --repo acme/shop-cli
```

## Reference

| Value                                                               | Default         | What it does                                                                       | Watch for                                                                |
| ------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| command per operation                                               | —               | one command per OpenAPI operation, grouped by the dotted operationId resource tree | verbs are consistent at the schema level (list/get/create/update/delete) |
| `--json`                                                            | off             | uniform machine-readable output on every command                                   | uniform shape so an agent parses one format                              |
| output formats (json/ndjson/yaml/table)                             | table           | human and machine formats                                                          | compact-for-agent output is the default under `--json`                   |
| `--api-key` / `--base-url` / `--config` / `--timeout` / `--verbose` | from config/env | auth, target, config file, deadline, logging                                       | precedence: flag > env > config file                                     |
| command discovery                                                   | on              | a machine-listable command index for agents                                        | agents enumerate capabilities without scraping help text                 |
| local/remote indicator                                              | —               | shows whether a command hits local or remote                                       | —                                                                        |
| shell completion                                                    | —               | bash/zsh/fish completion                                                           | —                                                                        |
| agent skills/docs bundle                                            | emitted         | a skills/docs bundle shipped with the CLI for agents                               | part of the token-budget surface                                         |
| binary response                                                     | —               | writes bytes to stdout or `--output <file>`                                        | pipe-safe; no mojibake on binary                                         |
| exit codes                                                          | usage/standard  | non-zero on usage error vs runtime error                                           | distinguishable for scripts                                              |

## Streams

A stream command prints one JSON line per event or message, a YAML document each under `--format yaml`, and
`--take N` ends it after N.

- **Server-sent events** print as `{"event", "id", "data"}`, the name and id left out when empty. An operation that
  names its events prints each `data` as that name's type re-encodes it, an unnamed event as `message`, and a name it
  does not declare as sent. An event whose data does not decode ends the stream with exit 1.
- **A WebSocket command** sends each stdin line as a text frame. Where the operation declares what the server
  receives, each line is checked first: it must be JSON that decodes as that type with its required fields, and for a
  union keyed on one field, the member its key names. A line that fails is not sent. Its refusal goes to stderr as
  any error does (`input line 2 not sent: …`), the conversation reads on, a blank line is skipped, and the run exits 4,
  `input lines not sent: N`, once it ends. A message prints as its type re-encodes it, a key value the operation does
  not declare as sent; a frame that does not decode sends a close 1007 and ends the run with exit 1.
- **A realtime feed** prints each message as its type, and writes its resume cursor to stderr when it ends.
