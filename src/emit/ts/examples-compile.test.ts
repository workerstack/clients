/**
 * The docs' TypeScript SDK code compiles against an SDK generated from the docs' API (bit 20): every `ts sdk` block
 * on a docs page and docs/examples/ts/example.ts, each importing the client from `./kitchen`, type-checked by tsc
 * beside the generated files. A realtime block imports from `./live`, an SDK whose document has an `x-realtime`
 * operation, since an SDK ships the realtime helpers only then (plan 32). A webhook receiver block imports from
 * `./shop.webhook.gen` of the Shop SDK, whose document declares the Standard Webhooks event the webhooks page sends (plan 36).
 * A typed stream block imports from `./streams`, an SDK of named SSE events and keyed WebSocket and realtime messages.
 * A `sdk ts tanstack` block also imports `./kitchen.tanstack-query.gen`, the adapter `--ts-tanstack-query`
 * writes beside the Kitchen SDK, and `@tanstack/query-core` from the workspace (plan 3).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts";
import { allBlocks, type Block, docsDocument, exampleOf, REPO } from "../shared/__fixtures__/docs-blocks.ts";
import { generateSdk } from "./sdk.ts";

const GEN = REPO;
const TSC = join(REPO, "node_modules/typescript/bin/tsc");

const OPTIONS = {
  lib: ["ESNext", "DOM"],
  module: "ESNext",
  moduleResolution: "bundler",
  noEmit: true,
  skipLibCheck: true,
  strict: true,
  target: "ESNext",
  types: ["node"],
};

// inside gen, so @types/node resolves from the workspace
mkdirSync(join(GEN, ".tmp"), { recursive: true });

const scratch = mkdtempSync(join(GEN, ".tmp/docs-sdk-"));

afterAll(() => rmSync(scratch, { force: true, recursive: true }));

/** The API the realtime blocks call: one `x-realtime` operation. */
const LIVE = {
  info: { title: "Live", version: "1" },
  openapi: "3.1.0",
  paths: { "/feed": { get: { operationId: "feed", responses: {}, "x-realtime": true } } },
};

/** The API the webhook receiver blocks verify: the `order.shipped` event of docs/capabilities/webhooks.md. */
const SHOP = {
  info: { title: "Shop", version: "1" },
  openapi: "3.1.0",
  paths: {},
  webhooks: {
    "order.shipped": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                properties: {
                  data: {
                    properties: { orderId: { type: "string" }, shippedAt: { type: "string" } },
                    required: ["orderId", "shippedAt"],
                    type: "object",
                  },
                  timestamp: { format: "date-time", type: "string" },
                  type: { const: "order.shipped" },
                },
                required: ["type", "timestamp", "data"],
                type: "object",
              },
            },
          },
          required: true,
        },
        responses: { "2XX": { description: "Received" } },
        "x-backend-webhook": "standard-webhooks",
      },
    },
  },
};

/** The API the typed stream blocks call: the IR's stream fixtures of named SSE events and keyed messages, as one. */
const STREAMS = ["sse-item-schema", "ws-keyed", "realtime-keyed"]
  .map((name) => join(import.meta.dirname, `../../ir/__fixtures__/specs/streams/${name}.json`))
  .map((path) => JSON.parse(readFileSync(path, "utf8")) as { components: { schemas: object }; paths: object })
  .reduce((all, { components, paths }) => ({
    ...all,
    components: { schemas: { ...all.components.schemas, ...components.schemas } },
    paths: { ...all.paths, ...paths },
  }));

/** tsc's errors for `sources` (name → code, each a module beside the generated SDK), by source and line. */
export function sdkTypeErrors(sources: Readonly<Record<string, string>>, dir: string): string[] {
  for (const [path, text] of Object.entries(
    generateSdk(docsDocument(), { name: "Kitchen", tanstackQuery: true }).files,
  ))
    writeFileSync(join(dir, path), text);
  writeFileSync(join(dir, "kitchen.ts"), 'export * from "./kitchen.index.gen"\n');

  for (const [path, text] of Object.entries(generateSdk(LIVE, { name: "Live" }).files))
    writeFileSync(join(dir, path), text);
  writeFileSync(join(dir, "live.ts"), 'export * from "./live.index.gen"\n');

  for (const [path, text] of Object.entries(generateSdk(SHOP, { name: "Shop" }).files))
    writeFileSync(join(dir, path), text);

  for (const [path, text] of Object.entries(generateSdk(STREAMS, { name: "Streams" }).files))
    writeFileSync(join(dir, path), text);
  writeFileSync(join(dir, "streams.ts"), 'export * from "./streams.index.gen"\n');

  for (const [name, code] of Object.entries(sources)) writeFileSync(join(dir, name), `${code}export {}\n`);
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: OPTIONS, files: Object.keys(sources) }));
  const out = spawnSync("node", [TSC, "-p", "tsconfig.json"], { cwd: dir, encoding: "utf8" }).stdout;

  return out.split("\n").filter((line) => / error TS\d+/.test(line));
}

/**
 * Each `ts sdk` block as a source named after its page and line; a reference page spells it `sdk ts`, because
 * `repo docs` type-checks every block whose first word is `ts` on its own, and these import a generated SDK.
 */
const SDK_INFOS: ReadonlySet<string> = new Set(["ts sdk", "sdk ts"]);

/** A TanStack Query block: `repo docs` skips it as it skips `sdk ts`, and this compiles it beside the adapter. */
const TANSTACK_INFOS: ReadonlySet<string> = new Set(["sdk ts tanstack"]);

const sourcesOf = (blocks: readonly Block[], infos: ReadonlySet<string> = SDK_INFOS) =>
  Object.fromEntries(
    blocks
      .filter((block) => infos.has(block.info))
      .map((block) => [`${block.at.replaceAll(/[/:.]/g, "_")}.ts`, block.code]),
  );

describe("the docs' TypeScript SDK code", () => {
  it("type-checks every ts sdk block and the TypeScript example against the generated SDK", () => {
    const sources = { ...sourcesOf(allBlocks()), "example.ts": exampleOf("ts", "example.ts") };
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    expect(sdkTypeErrors(sources, mkdtempSync(join(scratch, "docs-")))).toEqual([]);
  }, 120_000);

  it(
    "type-checks every sdk ts tanstack block against the Kitchen SDK's TanStack Query adapter",
    { timeout: SPAWN_TIMEOUT },
    () => {
      const sources = sourcesOf(allBlocks(), TANSTACK_INFOS);
      // the setup, the call shapes, the route preload and the single-flight client of references/sdks.md
      expect(Object.keys(sources)).toHaveLength(4);
      expect(sdkTypeErrors(sources, mkdtempSync(join(scratch, "tanstack-")))).toStrictEqual([]);
    },
  );

  it("reports a block that calls an operation the SDK does not have", () => {
    const code = 'import { Kitchen } from "./kitchen"\nnew Kitchen({ baseURL: "https://x.test" }).getNothing()\n';
    const found = sdkTypeErrors({ "bogus.ts": code }, mkdtempSync(join(scratch, "fixture-")));
    expect(found.map((line) => line.split("(")[0])).toEqual(["bogus.ts"]);
  }, 120_000);
});
