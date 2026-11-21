/**
 * `<stem>.single-flight.gen.ts` as `generateSdk` writes it under `singleFlight`: only when asked, refused for an API
 * whose writes invalidate nothing, importing only the SDK's own files, and compiling in a consumer's project under
 * every strictness flag (the strict-consumer set). Its behavior: http.single-flight-handler*.test.ts.
 */
import { describe, expect, it } from "vitest";

import { withPinnedBun } from "../../gen/__fixtures__/pinned-bun.ts";
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts";
import { compareCodeUnits } from "../shared/lang.ts";
import { DOCUMENT } from "./__fixtures__/single-flight.ts";
import { browserBundle, strictDiagnostics } from "./__fixtures__/strict-compile.ts";
import { generateSdk } from "./sdk.ts";

const FILE = "test-sdk.single-flight.gen.ts";

// a server's module: the two calls it makes, typed by the SDK class
const SERVER = `import { TestSDK } from "./test-sdk.client.gen"
import { runSingleFlight, singleFlightHandler, type SingleFlightEnvelope } from "./test-sdk.single-flight.gen"

const sdk = (request: Request) =>
	new TestSDK({ baseURL: "https://api.test", headers: { authorization: request.headers.get("authorization") ?? "" } })
export const handle: (request: Request) => Promise<Response> = singleFlightHandler(sdk, { maxReads: 20 })
export const run: Promise<SingleFlightEnvelope> = runSingleFlight(sdk(new Request("https://app.test")), { v: 1 })
`;

/** What `tsc` says about the SDK, its single-flight file and `server`: `""` when it is clean. */
function diagnosticsOf(server: string): string {
  const { files } = generateSdk(DOCUMENT, { name: "TestSDK", singleFlight: true });

  return strictDiagnostics("single-flight-typecheck", { ...files, "server.ts": server });
}

describe("generateSdk: the single-flight file", () => {
  it("is written only under singleFlight", () => {
    const on = generateSdk(DOCUMENT, { name: "TestSDK", singleFlight: true }).files;
    const off = generateSdk(DOCUMENT, { name: "TestSDK" }).files;
    expect([Object.hasOwn(on, FILE), Object.hasOwn(off, FILE)]).toStrictEqual([true, false]);
  });

  it("imports only the SDK's own runtime, map and class", () => {
    const text = generateSdk(DOCUMENT, { name: "TestSDK", singleFlight: true }).files[FILE] ?? "";
    const specifiers = [...text.matchAll(/^import .* from "([^"]+)"$/gm)].map(([, specifier]) => specifier ?? "");
    expect(specifiers.toSorted(compareCodeUnits)).toStrictEqual([
      "./test-sdk.client.gen.js",
      "./test-sdk.map.gen.js",
      "./test-sdk.runtime.gen.js",
    ]);
  });

  it("refuses an API with no write whose x-invalidate names a read", () => {
    const document = {
      info: { title: "t", version: "1" },
      openapi: "3.1.0",
      paths: { "/ping": { post: { operationId: "ping", responses: { 204: { description: "ok" } } } } },
    };

    expect(() => generateSdk(document, { name: "TestSDK", singleFlight: true })).toThrow(
      "singleFlight needs a write whose x-invalidate names a read",
    );
  });
});

describe("the single-flight file compiles in a server's project (strict-consumer flags)", () => {
  it("type-checks", { timeout: SPAWN_TIMEOUT }, () => {
    expect(diagnosticsOf(SERVER)).toBe("");
  });

  it("is not a hollow check: a handler over another client is refused", { timeout: SPAWN_TIMEOUT }, () => {
    const wrong = `${SERVER}\nexport const bad = singleFlightHandler(() => new Date())\n`;
    expect(diagnosticsOf(wrong)).toMatch(/server\.ts\(\d+,\d+\): error TS2740: Type .Date. is missing/);
  });
});

describe("a browser bundle of the index carries no single-flight code (plan 4, Verify 4.4)", () => {
  it(
    "leaves the handler out of an index-only bundle, and keeps it when the file is imported",
    { timeout: SPAWN_TIMEOUT },
    () => {
      // the pinned Bun where it is installed, else the one on PATH: either bundles as a browser app would
      const bun = withPinnedBun() ?? "bun";

      const files = {
        ...generateSdk(DOCUMENT, { name: "TestSDK", singleFlight: true }).files,
        "flight.ts": 'export { singleFlightHandler } from "./test-sdk.single-flight.gen"\n',
        "index-only.ts": 'export { TestSDK } from "./test-sdk.index.gen"\n',
      };

      const indexed = browserBundle(bun, "single-flight-bundle", files, "index-only.ts");
      const flight = browserBundle(bun, "single-flight-bundle", files, "flight.ts");

      expect([
        indexed.includes("TestSDK"),
        indexed.includes("singleFlightHandler"),
        indexed.includes("single-flight"),
        flight.includes("singleFlightHandler"),
      ]).toStrictEqual([true, false, false, true]);
    },
  );
});
