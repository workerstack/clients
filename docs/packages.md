# Package exports

Each feature is a subpath: import what an app uses, and a bundle carries nothing else. An app that never imports
`@workerstack/backend/ws` bundles no WebSocket code, and one that never imports `@workerstack/backend/openapi` no document
generator.

## @workerstack/backend

| Export                                 | What it holds                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@workerstack/backend`                 | `honey`, `HoneyError`, `defineErrors`, `createMiddleware`, `mergeTree`, and the type helpers below                                                  |
| `@workerstack/backend/node`            | `serve(app, options)` on Node's `node:http`                                                                                                         |
| `@workerstack/backend/bun`             | `serve(app, options)` on `Bun.serve`                                                                                                                |
| `@workerstack/backend/ws`              | `ws(app, path)`, a WebSocket route                                                                                                                  |
| `@workerstack/backend/ws/bun`          | `bunWebSocket`                                                                                                                                      |
| `@workerstack/backend/ws/node`         | `nodeWebSocket` (with the optional `ws` peer)                                                                                                       |
| `@workerstack/backend/webhook`         | `webhookContract`, `signWebhook`, `SignedWebhook`, `WebhookContract`, `WebhookEvents`, `WebhookSignOptions`, `SignWebhookOptions`, `WebhookHeaders` |
| `@workerstack/backend/cron`            | `defineCron`, `CronConfig`, `CronDefinition`, `CronHandler`, `CronJob`, `CronSchedule`                                                              |
| `@workerstack/backend/cron/serve`      | `serveCron`, `ServeCronOptions`, `CronHandle`, `CronFailure`                                                                                        |
| `@workerstack/backend/cron/workers`    | `workersCron`, `WorkersScheduledController`                                                                                                         |
| `@workerstack/backend/queue`           | `queueContract`, `queueMessage`, `defineConsumer`, `deadLetter`, `QueueBodyError`, `QueueDeadLetter`, and their types                               |
| `@workerstack/backend/queue/serve`     | `serveQueue`, `memoryQueueStore`, `QueueStore`, `ServeQueueOptions`, `QueueHandle`, `QueueFailure` and the store's types                            |
| `@workerstack/backend/queue/workers`   | `workersQueue`, `WorkersQueueOptions` and the binding's types                                                                                       |
| `@workerstack/backend/user-agent`      | `parseUserAgent`, `ParsedUserAgent`, `DeviceType`                                                                                                   |
| `@workerstack/backend/ws/workers`      | `workersWebSocket`                                                                                                                                  |
| `@workerstack/backend/ws/session`      | `createWsSession`: the session runtime a custom WebSocket adapter builds on                                                                         |
| `@workerstack/backend/realtime`        | `realtime(app, path, options)`: a resumable connection over WebSocket, SSE and long-poll                                                            |
| `@workerstack/backend/mcp`             | `mcp(app, path, handler, options?)`: the app's tools over MCP's Streamable HTTP, the handler `codegen.mcp` writes                                   |
| `@workerstack/backend/mcp/oauth`       | `oauth(options)`: `mcp()`'s opt-in OAuth 2.1 resource server (RFC 9728 metadata, Bearer challenges)                                                 |
| `@workerstack/backend/mcp/uploads`     | `uploads(options)`, `memoryUploadStore()`: `mcp()`'s opt-in out-of-band file uploads (the file-uploads extension's flow)                            |
| `@workerstack/backend/mcp/url-files`   | `urlFiles(options)`: `mcp()`'s opt-in file arguments as https URLs from listed hosts                                                                |
| `@workerstack/backend/openapi`         | `serveOpenApi`, `serveManifest`, `generateOpenApi`, `generateManifest`, `toYaml`                                                                    |
| `@workerstack/backend/openapi/auth`    | `basic`, `credentialsMatch`: HTTP Basic in front of a served document and its docs pages                                                            |
| `@workerstack/backend/openapi/scalar`  | `scalar`, the Scalar API reference page                                                                                                             |
| `@workerstack/backend/openapi/static`  | `serveStaticOpenApi`: a document built ahead of time or living elsewhere, served without the generator                                              |
| `@workerstack/backend/openapi/swagger` | `swagger`, the Swagger UI page                                                                                                                      |
| `@workerstack/backend/i18n`            | `createErrorTranslator`, `translateError`                                                                                                           |
| `@workerstack/backend/input`           | `streamed()`, a request body left unread for the handler                                                                                            |
| `@workerstack/backend/range`           | `rangeResponse`, a `Range` request answered from bytes                                                                                              |
| `@workerstack/backend/cache-control`   | `cacheControl`, `httpDate`                                                                                                                          |
| `@workerstack/backend/compress`        | `compress`                                                                                                                                          |
| `@workerstack/backend/etag`            | `etag`, `notModified`                                                                                                                               |
| `@workerstack/backend/rate-limit`      | `rateLimit`, `memoryRateLimitStore`                                                                                                                 |
| `@workerstack/backend/cors`            | `cors`                                                                                                                                              |
| `@workerstack/backend/csrf`            | `csrf`                                                                                                                                              |
| `@workerstack/backend/body-limit`      | `bodyLimit`                                                                                                                                         |
| `@workerstack/backend/timeout`         | `timeout`                                                                                                                                           |
| `@workerstack/backend/jwt`             | `signJwt`, `verifyJwt`, `remoteJwks`, `decodeJwtPayload`, `importPkcs8`, `isJwsAlgorithm`                                                           |
| `@workerstack/backend/ip-restrict`     | `ipRestrict`, `ipAllowed`, `isIpRule`                                                                                                               |
| `@workerstack/backend/request-id`      | `requestId`                                                                                                                                         |
| `@workerstack/backend/secure-headers`  | `secureHeaders`                                                                                                                                     |
| `@workerstack/backend/server-timing`   | `serverTiming`                                                                                                                                      |
| `@workerstack/backend/powered-by`      | `poweredBy`                                                                                                                                         |
| `@workerstack/backend/pretty-json`     | `prettyJson`                                                                                                                                        |
| `@workerstack/backend/logger`          | `createLogger`                                                                                                                                      |
| `@workerstack/backend/curl-logger`     | `curlLogger`, a request logged as a `curl` command                                                                                                  |
| `@workerstack/backend/telemetry/otel`  | `otelAdapter`                                                                                                                                       |
| `@workerstack/backend/static`          | `staticFiles`                                                                                                                                       |
| `@workerstack/backend/proxy`           | `proxy`, a route that forwards to an upstream                                                                                                       |
| `@workerstack/backend/accepts`         | `accepts`, content negotiation                                                                                                                      |
| `@workerstack/backend/cookie`          | `serializeCookie`, `parseCookieHeader`                                                                                                              |
| `@workerstack/backend/cookie-sign`     | `createCookieSigner`                                                                                                                                |
| `@workerstack/backend/crypto`          | `timingSafeEqual`                                                                                                                                   |
| `@workerstack/backend/request-to-curl` | `requestToCurl`                                                                                                                                     |
| `@workerstack/backend/testing`         | `testClient`, an app called in process or over a runtime's `serve`                                                                                  |
| `@workerstack/backend/tree`            | the route tree's types                                                                                                                              |
| `@workerstack/backend/plugin`          | `honeyPlugin()`, the Vite plugin that generates the app's artifacts                                                                                 |
| `@workerstack/backend/build`           | `createBuildPlugin`, a production bundle for a deploy target                                                                                        |

## @workerstack/clients

| Export                     | What it holds                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@workerstack/clients`     | `generated`, `writeTarget`, `TARGETS`, `targetOptionSchemas`, `METADATA_FIELDS`: a run as data, its files and packages; `generateRouteTree`, `generateTypes`, `extractTypes` for the build plugin |
| `@workerstack/clients/cli` | the `honey-clients` command's `main`                                                                                                                                                              |

The SDK, CLI and MCP generators run through `honey-clients generate` ([code generation](codegen.md)).

## Utilities

```ts
import { accepts } from "@workerstack/backend/accepts"
import { serializeCookie } from "@workerstack/backend/cookie"
import { createCookieSigner } from "@workerstack/backend/cookie-sign"
import { timingSafeEqual } from "@workerstack/backend/crypto"
import { requestToCurl } from "@workerstack/backend/request-to-curl"

declare const req: Request
declare const SECRET: string
declare const OLD_SECRET: string

/* the best match the request accepts, or null */
const type = accepts(req, ["application/json", "text/html"])

const cookie = serializeCookie("theme", { value: "dark", httpOnly: true, path: "/", sameSite: "lax" })

/* one signer per cookie, its name bound into each signature; every secret still accepted, newest first */
const sid = createCookieSigner({ name: "sid", secrets: [SECRET, OLD_SECRET] })
const value = await sid.verify(await sid.sign("abc"))

const same = await timingSafeEqual("token-a", "token-b")

/* the authorization header left out of the logged command */
const curl = await requestToCurl(req, { excludeHeader: (name) => name === "authorization" })
```

## Type helpers

Exported from `@workerstack/backend`, each over the app you built (`typeof app`):

| Type                                         | What it describes                                                |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `InferRoutes<typeof app>`                    | every path, its methods, and each one's input, output and errors |
| `InferRoutePaths<typeof app>`                | the paths, as a union                                            |
| `InferRouteMethods<typeof app, Path>`        | one path's methods                                               |
| `InferRouteInput<typeof app, Path, Method>`  | a route's validated input                                        |
| `InferRouteOutput<typeof app, Path, Method>` | a route's output map                                             |
| `InferRouteErrors<typeof app, Path, Method>` | a route's declared error keys                                    |
| `InferRouteMeta<typeof app, Path, Method>`   | a route's meta                                                   |
| `InferRouteCtx<typeof app, Path, Method>`    | a route's handler `ctx`                                          |
| `InferCtx<typeof app>`                       | the app's handler context                                        |
| `InferEnv<typeof app>`                       | `ctx.env`                                                        |
| `InferMeta<typeof app>`                      | the app-level meta                                               |
| `InferErrorFactory<typeof app>`              | the error factory                                                |
| `InferBasePath<typeof app>`                  | the base path, as a string                                       |
| `InferMethods<typeof app>`                   | the methods the app serves                                       |
