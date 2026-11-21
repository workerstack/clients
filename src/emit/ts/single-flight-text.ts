/**
 * `<stem>.single-flight.gen.ts`, written under `--ts-single-flight`: `singleFlightHandler` and `runSingleFlight`
 * over the SDK's service map, a server's file of its own (as the webhook verifier is), never named by the index.
 */
import { invalidateReads } from "../../ir/invalidate-reads.ts";
import type { IR } from "../../ir/model.ts";
import { singleFlightSource } from "./http.ts";

// the runtime's declarations a consumer never imports: every one but the public SingleFlight* and Json types
const INTERNAL = /^export ((?:async )?function |type |const )(?!SingleFlight|Json\b|JsonObject\b)/gm;

/** The two calls a server imports, typed by the SDK class `name`. */
function wrappers(name: string): string {
  return `/**
 * A fetch handler that runs one write, then the reads it made stale, in one request: \`{ v: 1, op, input, reads }\`
 * in, \`{ v: 1, write, reads }\` out. Mount it before any proxy of the API, and make \`getSdk\`'s client per request,
 * forwarding only the auth it chooses. The write runs once: this handler adds no retry, the SDK's own hooks may.
 * Set-Cookie headers of the write are copied onto the answer; they only stick when the API shares this site.
 */
export function singleFlightHandler(
	getSdk: SingleFlightSdk<${name}>,
	options: SingleFlightOptions = {},
): (request: Request) => Promise<Response> {
	return handlerOf(serviceMap, getSdk, options)
}

/** The same batch run with no Request or Response: a refusal throws a TypeError, the write's cookies are dropped. */
export function runSingleFlight(sdk: ${name}, body: Json): Promise<SingleFlightEnvelope> {
	return runFlight(serviceMap, sdk, body)
}
`;
}

/** The single-flight file of the SDK `name` over `ir`; an API with no write that invalidates a read is refused. */
export function singleFlightText(ir: IR, name: string, stem: string): string {
  if (invalidateReads(ir).reads.size === 0)
    throw new Error("generateSdk: singleFlight needs a write whose x-invalidate names a read; this API declares none");

  return `import type { ${name} } from "./${stem}.client.gen.js"
import { serviceMap } from "./${stem}.map.gen.js"
${singleFlightSource(stem).replaceAll(INTERNAL, "$1")}
${wrappers(name)}`;
}
