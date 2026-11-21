/**
 * `onInvalidate`'s event as a consumer of the emitted config sees it: `by` narrowed to the writes that invalidate a
 * read, each target's `operationId` to the reads some write invalidates, and the runtime's wide event still a hook.
 */
import * as morph from "ts-morph";
import { describe, expect, it } from "vitest";

import { consumerChecker, doc, json, param, STRING } from "./__fixtures__/consumer-types.ts";

const check = consumerChecker(morph);

const OK = json(STRING);

const API = doc({
  "/health": { get: { operationId: "health.check", responses: { 200: OK } } },
  "/users": {
    get: { operationId: "users.list", responses: { 200: OK } },
    post: { operationId: "users.create", responses: { 200: OK } },
  },
  "/users/{id}": {
    get: { operationId: "users.get", parameters: [param("id")], responses: { 200: OK } },
    patch: {
      operationId: "users.update",
      parameters: [param("id")],
      responses: { 200: OK },
      "x-invalidate": ["GET /users/:id", "GET /users"],
    },
  },
});

/** The event a TestSDK's `onInvalidate` hook takes. */
const EVENT = `type Hook = NonNullable<ConstructorParameters<typeof TestSDK>[0]["onInvalidate"]>[number]
type Event = Parameters<Hook>[0]
`;

describe("onInvalidate's emitted event", () => {
  it("narrows by to the invalidating writes and a target's operationId to the invalidated reads", () => {
    const consumer = `${EVENT}expectType<Equal<Event["by"], "users.update">>()
expectType<Equal<Event["targets"][0]["operationId"], "users.get" | "users.list">>()
expectType<Equal<Event["targets"][0]["params"], Record<string, string | number | boolean>>>()
new TestSDK({ baseURL: "https://api.example.com", onInvalidate: [(event) => void event.by] })`;

    expect(check(API, consumer, "all")).toStrictEqual([]);
  });

  it("takes the runtime's wide InvalidateEvent hook and refuses a hook that names an id the API never sends", () => {
    const consumer = `import type { InvalidateEvent, InvalidateTarget } from "./test-sdk.index.gen.ts"
const wide = (event: InvalidateEvent): void => void event.targets.map((t: InvalidateTarget) => t.operationId)
new TestSDK({ baseURL: "https://api.example.com", onInvalidate: [wide] })
// @ts-expect-error health.check is no write that invalidates
new TestSDK({ baseURL: "https://api.example.com", onInvalidate: [(event: InvalidateEvent<"health.check">) => void event] })`;

    expect(check(API, consumer)).toStrictEqual([]);
  });
});
