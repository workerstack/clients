# Range requests

`rangeResponse(request, body)` from `@workerstack/backend/range` answers a `Range`
request with `206 Partial Content` and the slice it asked for, and every other request with the whole body and
`Accept-Ranges: bytes`. An unsatisfiable range answers 416, and an absurd one (a huge number, thousands of ranges)
falls back to the whole body at once. `staticFiles` uses it for every sized file.

## Example

```ts
import { honey } from "@workerstack/backend"
import { rangeResponse } from "@workerstack/backend/range"

const video = new Blob([new Uint8Array(1024)], { type: "video/mp4" })

const app = honey()

app.get("/video").handler((ctx) => ctx.res.raw(rangeResponse(ctx.req, video)))
```

A route that declares its output forwards the answer instead. Its 200 and 206 are declared in `.output()` as `ok` and
`partial_content`, and its 416 with `.errors()`, under a key the factory maps to `range_not_satisfiable`; the 416 then
goes out as `rangeResponse` built it. A 206 on a route that declares no `partial_content` is refused.

```ts
import { defineErrors, honey } from "@workerstack/backend"
import { rangeResponse } from "@workerstack/backend/range"

const video = new Blob([new Uint8Array(1024)], { type: "video/mp4" })
const errors = defineErrors({ range_unsatisfiable: "range_not_satisfiable" })

const app = honey()

app
	.get("/video")
	.output({ "video/mp4": { ok: true, partial_content: true } })
	.errors(errors, "range_unsatisfiable")
	.handler((ctx) => ctx.res.forward(rangeResponse(ctx.req, video)))
```

Tested by: `response/range.test.ts`
