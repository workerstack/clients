---
description: The generated MCP server
order: 110
---

# The MCP server

`--target mcp` writes a standalone Model Context Protocol server: one tool per operation marked for MCP, its
`inputSchema` from the operation's parameters and body, an `outputSchema` from its success response, and
`structuredContent` an agent reads as data beside a text rendering. A failure comes back as a tool error with its
status and key, never as a successful result. Read-only operations are annotated as such. It speaks stdio by
default, and Streamable HTTP with `--http`.

```sh
clients generate --spec openapi.json --target mcp --out ./mcp --mcp-name acme
```

Its package publishes to npm as written. `--mcp-package-name @acme/shop-mcp` names it (its bin keeps the server's
name), the metadata block fills its description, license, repository and the rest as it does the TS SDK's, and
`--mcp-mcp-name io.github.acme/shop` writes the `mcpName` the MCP registry checks the npm package by. With it the
server also gets the `server.json` that `mcp-publisher publish` reads from the package's root, on the registry's
2025-12-11 schema: that name, the description (100 characters at most, else refused), the version npm publishes, the
npm package over stdio with every environment variable the server reads, the home page as `websiteUrl`, and a GitHub
or GitLab repository. Where a hosted server runs is yours, so it lists no `remotes`.

```json
{
	"name": "orders_get",
	"inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] },
	"outputSchema": { "type": "object", "properties": { "id": { "type": "string" }, "status": { "type": "string" } } }
}
```

An event stream is one bounded collect: `max_events` (1 to 100, 20 by default) and `last_event_id` in, and
`{ events, last_event_id, ended }` out. When the stream names its events, each event's `event` is required and the
declared names are its `examples`. Each JSON event's `data` is typed by its name in an `anyOf` member, and any other
event, declared or not, has its `data` as a string. A stream of `tick` JSON events and `heartbeat` text events lists
its events as:

```json
{
	"type": "object",
	"properties": { "event": { "type": "string", "examples": ["tick", "heartbeat"] }, "id": { "type": "string" } },
	"required": ["data", "event"],
	"anyOf": [
		{
			"properties": {
				"event": { "const": "tick" },
				"data": { "type": "object", "properties": { "n": { "type": "number" } } }
			}
		},
		{ "properties": { "data": { "type": "string" } } }
	]
}
```

The server reads its configuration from the environment, under the `--mcp-env-prefix` (or the document's title,
upper-cased):

| Variable                     | Default                     | What it does                                                                                      |
| ---------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `$<PREFIX>_BASE_URL`         | the document's first server | the API every call goes to                                                                        |
| `$<PREFIX>_API_KEY`          | none                        | the credential, sent as the document's scheme says; scrubbed from every result                    |
| `$<PREFIX>_HEADERS`          | none                        | a JSON object of headers sent on every call, each scrubbed from results                           |
| `$<PREFIX>_REDIRECT`         | `same-origin`               | `same-origin`, or `follow` to follow a redirect off the API's origin with its credentials dropped |
| `$<PREFIX>_TIMEOUT_MS`       | `30000`                     | each call's bound, an event stream's collect included                                             |
| `$<PREFIX>_FILE_ROOT`        | the client's working dir    | the only directory a `{ path }` file argument is read from                                        |
| `$<PREFIX>_MAX_FILE_BYTES`   | `52428800`                  | the largest file a path may name                                                                  |
| `$<PREFIX>_MAX_INLINE_BYTES` | `1048576`                   | all inline files of one call together, decoded                                                    |
| `$<PREFIX>_MCP_TOKEN`        | none                        | the bearer token `--http` requires; it never reaches the API                                      |

**The standalone server needs Node**: it holds a listening socket and reads local files, so it belongs on a machine
or a container, never on serverless or Workers. To serve the same tools remotely, mount them in the app instead with
`mcp()` from `@workerstack/backend/mcp`, which runs wherever the app runs and is guarded by the app's own auth.

Full reference: [the generated MCP server](https://github.com/workerstack/backend/blob/main/docs/mcp.md).
