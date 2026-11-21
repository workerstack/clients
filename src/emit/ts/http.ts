/**
 * The vendored TS runtime, as the text an SDK ships (H9/F5): the modules under `runtime/ts`, read
 * here and nowhere else, joined into one module in dependency order with their imports of each
 * other dropped. An SDK ships only the transports its operations use: the event-stream modules for an
 * SSE or realtime API, the WebSocket ones for a WebSocket or realtime API, the realtime ones for a
 * realtime API, and only the app client ships its own `createClient`. The webhook verifier is no part of it: it ships
 * in its own file (`webhookSource`), so a receiver bundles nothing else. Both fronts emit it verbatim, so a test that runs the emitted client runs this text.
 * The single-flight handler ships in a file of its own too (`singleFlightSource`), so a browser bundles none of it.
 */
import { readFileSync } from "node:fs";

import type { IR } from "../../ir/model.ts";
import { sdkModel } from "../../ir/sdk-model.ts";
import { compareCodeUnits } from "../shared/lang.ts";

/** What a client needs from the runtime beyond plain HTTP; `app` is the app client's own `createClient`. */
export type TsRuntimeFeatures = {
  readonly app: boolean;
  readonly realtime: boolean;
  readonly sse: boolean;
  readonly ws: boolean;
};

/** The app client's runtime: `createClient` and every transport, since it cannot know its routes'. */
export const FULL_RUNTIME: TsRuntimeFeatures = { app: true, realtime: true, sse: true, ws: true };

/** The runtime modules under `runtime/ts`, each after the ones it imports. */
export const RUNTIME_MODULES: readonly string[] = [
  "media-type",
  "defaults",
  "redirect-policy",
  "error",
  "path",
  "request",
  "response",
  "config",
  "redirects",
  "hooks",
  "sse",
  "realtime",
  "realtime-connection",
  "http",
  "stream",
  "ws",
  "realtime-transports",
  "stale",
  "app-types",
  "app",
  "sdk-invalidate",
  "sdk-single-flight.constants",
  "sdk-single-flight",
  "sdk",
  "sdk-sse",
  "sdk-ws",
  "sdk-realtime",
];

// the modules each transport adds; realtime dials over an event stream and a WebSocket, so it ships both
const SSE: readonly string[] = ["sse", "stream", "sdk-sse"];
const WS: readonly string[] = ["ws", "sdk-ws"];
const REALTIME: readonly string[] = ["realtime", "realtime-connection", "realtime-transports", "sdk-realtime"];
const APP: readonly string[] = ["app-types", "app"];

/** The runtime modules an SDK with `features` ships, in `RUNTIME_MODULES` order. */
function runtimeModules(features: TsRuntimeFeatures): string[] {
  const left = new Set([
    ...(features.sse || features.realtime ? [] : SSE),
    ...(features.ws || features.realtime ? [] : WS),
    ...(features.realtime ? [] : REALTIME),
    ...(features.app ? [] : APP),
  ]);

  return RUNTIME_MODULES.filter((name) => !left.has(name));
}

/** What the SDK of `ir` needs from the runtime: its operations' transports, never the app client. */
export function runtimeFeatures(ir: IR): TsRuntimeFeatures {
  const streams = new Set(sdkModel(ir).ops.map((op) => op.stream));

  return { app: false, realtime: streams.has("realtime"), sse: streams.has("sse"), ws: streams.has("ws") };
}

// an import of a sibling runtime module, on one line or several
const SIBLING_IMPORT = /^import\s+(?:type\s+)?\{[^}]*\}\s+from\s+"\.\/[\w.-]+\.ts"\n/gm;

/** One runtime module's text, as written. */
function moduleText(name: string): string {
  return readFileSync(new URL(`../../runtime/ts/${name}.ts`, import.meta.url), "utf8");
}

/** One runtime module's source, without its imports of its siblings. */
function moduleSource(name: string): string {
  return moduleText(name).replaceAll(SIBLING_IMPORT, "").trim();
}

/** The Standard Webhooks verifier: it imports nothing, so the webhook file that carries it stands alone. */
export function webhookSource(): string {
  return moduleSource("webhook");
}

/** The single-flight handler's runtime modules, each after the ones it imports. */
export const SINGLE_FLIGHT_MODULES: readonly string[] = [
  "single-flight.constants",
  "single-flight-batch",
  "single-flight-body",
  "single-flight-run",
  "single-flight",
];

// an import of a sibling runtime module, its names and its module captured
const SIBLING_NAMES = /^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"\.\/([\w.-]+)\.ts"\n/gm;

// a type-only name of an import list
const TYPE_PREFIX = /^type /;

/** The names `text` imports from runtime modules outside `own`, each `type X` when only its type is imported. */
function runtimeImports(text: string, own: readonly string[]): string[] {
  return [...text.matchAll(SIBLING_NAMES)]
    .filter(([, , , module]) => !own.includes(String(module)))
    .flatMap(([, typeOnly, names]) =>
      String(names)
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "")
        .map((name) => (typeOnly === undefined ? name : `type ${name}`)),
    );
}

/** `name` without its `type ` mark. */
function bare(name: string): string {
  return name.replace(TYPE_PREFIX, "");
}

/**
 * The single-flight handler's runtime, for a file of its own beside the SDK (as the webhook verifier is): its
 * modules joined, their imports of the client's runtime gathered into one import of `<stem>.runtime.gen.js`, so no
 * browser bundle that leaves the file out carries any of it.
 */
export function singleFlightSource(stem: string): string {
  const imported = new Set(
    SINGLE_FLIGHT_MODULES.flatMap((name) => runtimeImports(moduleText(name), SINGLE_FLIGHT_MODULES)),
  );

  const sorted = [...imported].toSorted((a, b) => compareCodeUnits(bare(a), bare(b)));
  const modules = SINGLE_FLIGHT_MODULES.map(moduleSource).join("\n\n");

  return `import { ${sorted.join(", ")} } from "./${stem}.runtime.gen.js"\n\n${modules}\n`;
}

/** The runtime as one module, with `features`' transports: what `runtime.gen.ts` holds. */
export function runtimeSource(features: TsRuntimeFeatures): string {
  return `${runtimeModules(features).map(moduleSource).join("\n\n")}\n`;
}
