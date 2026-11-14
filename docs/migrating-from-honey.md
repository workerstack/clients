# clients — Migrating from honey

[← back to the overview](../README.md)

`@workerstack/clients` 1.0.0-rc.26 and earlier kept honey's names; rc.27 drops every one of them. The generators, the
manifest and the generated code work the same; every name changed. This page lists each one, old to new, for the
clients side. The names of `@workerstack/backend` that clients reads or writes are at the end of this page, and
[backend's own page](https://github.com/workerstack/backend/blob/main/docs/migrating-from-honey.md) lists the rest of
them. Nothing reads the old names, so change all of them at once, and regenerate every SDK, CLI and MCP client:
generated code carries the new names only.

A rename tool reads these tables: each row's two cells are one name each, and the tool rewrites a whole repo from
them, so a consumer's repo takes the same rows.

## Install and run

| honey-clients rc.26     | clients rc.27             |
| ----------------------- | ------------------------- |
| `bin/honey-clients.js`  | `bin/clients.js`          |
| `honey-clients`         | `clients`                 |
| `.honey-generated.json` | `.clients-generated.json` |
| `.honey-generated`      | `.clients-generated`      |
| `packages[].honey`      | `packages[].clients`      |

The `installgen` bin is unchanged. A one-off run outside a project that has the package installed names the package:
`bunx --package @workerstack/clients clients generate`.

`honey-source` is two conditions that shared one name. Which package's source it selects decides its new name:

- `@workerstack/clients`' own export condition, in its `package.json` `exports`, its lint rules, its pack script and
  its `tsconfig.json`, becomes `clients-source`.
- `@workerstack/backend`'s condition, which selects backend's `src/` when clients loads an app, becomes
  `backend-source`. The bin's Bun hand-off sets it, so an `--app` module's checkout backend resolves to its source.

The second one has a row, in the table of backend's names below, because a consumer's own tooling passes it. The first
has no row, because no consumer spells it. The release manifest's `packages[].honey` entry, which says how clients
generates a package, is `packages[].clients`.

## Environment

An environment variable is named for the package that reads it.

| honey-clients rc.26 | clients rc.27 |
| ------------------- | ------------- |
| `HONEY_*`           | `CLIENTS_*`   |

`CLIENTS_REQUIRE_TOOLCHAINS`, `CLIENTS_REQUIRE_PYTHON`, `CLIENTS_REQUIRE_GO`, `CLIENTS_REQUIRE_RUST`,
`CLIENTS_REQUIRE_JAVA`, `CLIENTS_REQUIRE_DOTNET`, `CLIENTS_REQUIRE_FORMATTERS`, `CLIENTS_NO_BUN_HANDOFF`,
`CLIENTS_BUN_HANDOFF`, `CLIENTS_PINNED_BUN`, `CLIENTS_CODEGEN_CHILD`, `CLIENTS_CONFORMANCE_RECORD`,
`CLIENTS_CONFORMANCE_MCP`, `CLIENTS_MUTANT`, `CLIENTS_FUZZ_RUNS` and `CLIENTS_FUZZ_SEED` are the ones the package
and its tests read. Backend reads its own `BACKEND_*` set; a variable both used to read, such as
`HONEY_REQUIRE_TOOLCHAINS`, is now two.

## Generated SDK names

The SDKs clients generates name each type for the surface it calls, so the HTTP SDK's names lead with `Http`.

| honey-clients rc.26   | clients rc.27        |
| --------------------- | -------------------- |
| `HoneySdkJsonContext` | `HttpSdkJsonContext` |
| `SafeHoneySdkClient`  | `SafeHttpSdkClient`  |
| `HoneySdkClient`      | `HttpSdkClient`      |
| `HoneyException`      | `HttpException`      |
| `HoneySDKConfig`      | `HttpSDKConfig`      |
| `HoneyClient`         | `HttpClient`         |
| `HoneyError`          | `HttpError`          |
| `HoneyStream`         | `HttpStream`         |
| `HoneyArgs`           | `HttpArgs`           |
| `HoneyCall`           | `HttpCall`           |
| `HoneySafe`           | `HttpSafe`           |
| `HoneySdk`            | `HttpSdk`            |
| `honey_sdk`           | `http_sdk`           |
| `honey-sdk`           | `http-sdk`           |
| `HoneySdk.csproj`     | `HttpSdk.csproj`     |
| `HoneyRun`            | `ReleaseRun`         |

The server throws `HttpError` and the generated client catches `HttpError` with the same `error_key`. Transport and
decode failures keep their own classes. `HoneySdkClient` is the one name that does not follow the rule word for
word: the C# client is named `<namespace>Client`, so it becomes `HttpSdkClient`, and a plain `HttpClient` would
shadow `System.Net.Http.HttpClient` in every file that imports it. The TypeScript app client, which has no such
clash, becomes `HttpClient`. `HoneyRun` (the `packages[].honey` entry's type in `@workerstack/clients/release`)
takes its subpath, `Release`; the entry itself is `packages[].clients`.

## Generated runtimes

C#, Java and Python vendor a small runtime into each SDK. Each takes `Http` as the SDK's names do, after a check
of its language's own names: Python's standard library has an `http` package, and `http_sdk` and `_http` do not
collide with it; Java's JDK has `java.net.http`, a different fully qualified package from `http.runtime`; C# has
`System.Net.Http`, and a namespace `Http.Runtime` beside it is told apart by its full name.

| honey-clients rc.26   | clients rc.27        |
| --------------------- | -------------------- |
| `HoneyParseSSEStream` | `HttpParseSSEStream` |
| `HoneyRaiseForStatus` | `HttpRaiseForStatus` |
| `HoneyExpandPath`     | `HttpExpandPath`     |
| `HoneyBuildURL`       | `HttpBuildURL`       |
| `Honey.Runtime`       | `Http.Runtime`       |
| `Honey.Driver`        | `Http.Driver`        |
| `honey.runtime`       | `http.runtime`       |
| `_honey`              | `_http`              |
| `honey.refreshAuth`   | `http.refreshAuth`   |
| `honey.envPrefix`     | `cli.envPrefix`      |
| `honey.server`        | `cli.server`         |
| `honey.config`        | `http.config`        |
| `honey.cross`         | `http.cross`         |
| `honey.send`          | `http.send`          |
| `honey://`            | `mcp://`             |
| `honey/status`        | `backend/status`     |
| `honey-driver`        | `clients-driver`     |
| `honey-tmp`           | `backend-tmp`        |

`honey/status` is the MCP result's `_meta` key backend's server writes and the generated MCP client reads, so it
takes backend's name. `honey-tmp` is `~/.cache/honey-tmp`, which becomes `~/.cache/backend-tmp`: the machine's shared
cache folder, the same name in both repos.

## Names clients spells from backend

Each of these is backend's name. Backend's page maps all of them; the ones clients spells in its fixtures, its emitted
imports and its readers are:

| honey rc.25    | backend rc.26    |
| -------------- | ---------------- |
| `{ honey }`    | `{ httpApp }`    |
| `{ honey,`     | `{ httpApp,`     |
| `, honey }`    | `, httpApp }`    |
| `typeof honey` | `typeof httpApp` |
| `honey<`       | `httpApp<`       |
| `honey(`       | `httpApp(`       |
| `honeyPlugin`  | `backendPlugin`  |
| `HoneyContext` | `HttpContext`    |
| `HoneyCodegen` | `HttpCodegen`    |
| `HoneyMeta`    | `HttpMeta`       |
| `HoneyRes`     | `HttpRes`        |
| `Honey<`       | `HttpApp<`       |
| `type Honey,`  | `type HttpApp,`  |
| `type Honey }` | `type HttpApp }` |
| `Honey`        | `Backend`        |
| `x-honey-*`    | `x-backend-*`    |
| `honey-source` | `backend-source` |
| `honey`        | `backend`        |

`x-honey-route`, `x-honey-error`, `x-honey-errors`, `x-honey-webhook`, `x-honey-wildcard` and `x-honey-signature`
are the OpenAPI extensions backend writes and clients reads. Backend's bin `honey` is `backend`, its
`honey-source` condition is `backend-source`, the app type `Honey` is `HttpApp` where it is written as a type, and a
prose `honey` or `Honey` that meant backend is `backend` or `Backend`.

## Hosts and fixtures

| honey-clients rc.26 | clients rc.27  |
| ------------------- | -------------- |
| `honey.test`        | `backend.test` |
| `honey.dev`         | `backend.dev`  |
| `honey-`            | `clients-`     |

The example hosts in fixtures and docs, and the `honey-` prefix of a temporary folder, a multipart boundary, a test
client id or a fixture package.

## Internal names (contributors)

Names only this repository spells: its fixtures, its lint plugin, private helpers and prose that means clients. They
matter only to a checkout of clients, and the codemod applies them after the tables above.

### Paths

| Before                                  | After                                  |
| --------------------------------------- | -------------------------------------- |
| `src/emit/ts/__fixtures__/honey-doc.ts` | `src/emit/ts/__fixtures__/http-doc.ts` |
| `src/runtime/java/HoneyException.java`  | `src/runtime/java/HttpException.java`  |

### Names

| Before                             | After                                |
| ---------------------------------- | ------------------------------------ |
| `["Honey", "declares HoneySafe"]`  | `["Http", "declares HttpSafe"]`      |
| `import type { Honey } from`       | `import type { HttpApp } from`       |
| `Honey(?:Call`                     | `Http(?:Call`                        |
| `Honey\.Runtime`                   | `Http\.Runtime`                      |
| `honey\.runtime`                   | `http\.runtime`                      |
| `honey-doc`                        | `http-doc`                           |
| `honeyDoc`                         | `httpDoc`                            |
| `HoneyApp`                         | `HttpApp`                            |
| `HoneyRoute`                       | `HttpRoute`                          |
| `HONEY`                            | `HTTP_APP`                           |
| `honey-mcp-clients`                | `mcp-clients`                        |
| `honey/spawn-timeout`              | `clients/spawn-timeout`              |
| `honey/public-jsdoc`               | `clients/public-jsdoc`               |
| `honey/no-console`                 | `clients/no-console`                 |
| `honey/boundaries`                 | `clients/boundaries`                 |
| `honey/unversioned-public`         | `clients/unversioned-public`         |
| `honey/no-module-state`            | `clients/no-module-state`            |
| `honey/no-module-side-effects`     | `clients/no-module-side-effects`     |
| `honey/no-v8-ignore`               | `clients/no-v8-ignore`               |
| `honey/content-type-exact-essence` | `clients/content-type-exact-essence` |
| `"honey"`                          | `"clients"`                          |
| `"honey: `                         | `"httpsdk: `                         |
| `honey: {`                         | `clients: {`                         |
| `honey?:`                          | `clients?:`                          |
| `pkg.honey`                        | `pkg.clients`                        |
| `p.honey`                          | `p.clients`                          |
| `generated by honey.`              | `generated by clients.`              |

### Env with a shell sigil

| Before                   | After                      |
| ------------------------ | -------------------------- |
| `$HONEY_NO_BUN_HANDOFF`  | `$CLIENTS_NO_BUN_HANDOFF`  |
| `$HONEY_CONFORMANCE_MCP` | `$CLIENTS_CONFORMANCE_MCP` |

### Prose that means clients

The bare word `honey` in prose means backend by default (`backend`), as backend's page maps it. These phrases name
what clients itself does, so they take `clients`.

| Before                       | After                          |
| ---------------------------- | ------------------------------ |
| `honey's own choice`         | `clients' own choice`          |
| `honey's own manifest`       | `clients' own manifest`        |
| `honey's own record`         | `clients' own record`          |
| `honey's own style`          | `clients' own style`           |
| `honey's own override`       | `clients' own override`        |
| `honey's own runtime`        | `clients' own runtime`         |
| `honey's post-pass`          | `clients' post-pass`           |
| `honey's manifest`           | `clients' manifest`            |
| `honey's record`             | `clients' record`              |
| `honey's discovery`          | `clients' discovery`           |
| `honey's runtime`            | `clients' runtime`             |
| `its honey imports`          | `its runtime imports`          |
| `honey simply never called`  | `clients simply never called`  |
| `honey takes everywhere`     | `clients takes everywhere`     |
| `honey had emitted`          | `clients had emitted`          |
| `honey ever calls`           | `clients ever calls`           |
| `honey recorded`             | `clients recorded`             |
| `honey generated`            | `clients generated`            |
| `honey bakes`                | `clients bakes`                |
| `honey keeps`                | `clients keeps`                |
| `honey writes`               | `clients writes`               |
| `honey wrote`                | `clients wrote`                |
| `honey tests`                | `clients tests`                |
| `honey runs`                 | `clients runs`                 |
| `program honey reads`        | `program clients reads`        |
| `the CLI's from honey`       | `the CLI's from clients`       |
| `honey plugin entry`         | `clients plugin entry`         |
| `every honey rule`           | `every clients rule`           |
| `every honey Python command` | `every clients Python command` |
| `honey code under test`      | `clients code under test`      |
| `honey cache`                | `backend-tmp cache`            |
| `user.name=honey`            | `user.name=clients`            |
| `honey@example.com`          | `clients@example.com`          |
