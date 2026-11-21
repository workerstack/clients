/**
 * `onInvalidate`: a generated client's config hooks, called once per successful write with the reads it made
 * stale, as operationIds with the write's params; which answers call them. Driven on the emitted SDK over a
 * recording fetch (http.on-invalidate.hooks.test.ts holds streams, sockets, retries and the hooks' own errors).
 */
import { describe, expect, it } from "vitest";

import { CREATED, firstThenOk, sdkOf, UPDATED } from "./__fixtures__/on-invalidate.ts";

describe("onInvalidate: a 2xx write calls the hooks once with the reads it made stale", () => {
  it("names the write by operationId, not its renamed member; fills `:id`, `*rest` and `:id?` targets", async () => {
    const { events, sdk } = await sdkOf();
    // `state` is a client member, so the `state` group is the renamed `state_`
    await sdk["state_"].save({ json: {}, params: { id: "7", rest: "a/b.txt" } });
    expect(events).toStrictEqual([
      {
        by: "state.save",
        targets: [
          { operationId: "items.get", params: { id: "7" } },
          { operationId: "files.get", params: { rest: "a/b.txt" } },
          { operationId: "docs.list", params: {} },
          { operationId: "docs.get", params: { id: "7" } },
        ],
      },
    ]);
  });

  it("omits a target param the write does not know", async () => {
    const { events, sdk } = await sdkOf();
    await sdk.orgs.update({ json: {}, params: { org: "acme" } });
    expect(events).toStrictEqual([
      { by: "orgs.update", targets: [{ operationId: "members.get", params: { org: "acme" } }] },
    ]);
  });

  it("keeps an integer param a number", async () => {
    const { events, sdk } = await sdkOf();
    await sdk.users.update({ json: {}, params: { id: 42 } });
    expect(events).toStrictEqual([UPDATED]);
  });
});

/** A network error: fetch rejects before any answer. */
function networkError(): Response {
  throw new TypeError("fetch failed");
}

describe("onInvalidate: a write that failed calls no hook", () => {
  it.each([
    ["a 4xx", () => Response.json({ error: "missing" }, { status: 404 })],
    ["a 5xx", () => Response.json({ error: "fail" }, { status: 500 })],
    ["a network error", networkError],
  ] as const)("calls nothing for %s, then once for the next 2xx write", async (_label, failure) => {
    const { events, sdk } = await sdkOf(firstThenOk(failure));
    await expect(sdk.users.update({ json: {}, params: { id: 42 } })).rejects.toBeDefined();
    await sdk.users.create({ json: {} });
    expect(events).toStrictEqual([CREATED]);
  });

  it.each([
    ["a GET", "list"],
    ["a GET with x-invalidate", "refresh"],
  ] as const)("calls nothing for %s", async (_label, member) => {
    const { calls, events, sdk } = await sdkOf();
    await (member === "list" ? sdk.users.list() : sdk.feed.refresh());
    await sdk.users.create({ json: {} });
    expect([calls.length, events]).toStrictEqual([2, [CREATED]]);
  });
});

describe("onInvalidate: a 2xx write calls them whatever its body", () => {
  it("calls them for a 2xx whose body does not decode", async () => {
    const { events, sdk } = await sdkOf(
      () => new Response("{not json", { headers: { "content-type": "application/json" } }),
    );

    await expect(sdk.users.update({ json: {}, params: { id: 42 } })).rejects.toMatchObject({ name: "DecodeError" });
    expect(events).toStrictEqual([UPDATED]);
  });

  it("calls them for a 2xx with no body", async () => {
    const { events, sdk } = await sdkOf(() => new Response(null, { status: 204 }));
    await sdk.users.avatar({ json: {}, params: { id: 42 } });
    expect(events).toStrictEqual([{ by: "users.avatar", targets: [{ operationId: "users.get", params: { id: 42 } }] }]);
  });

  it.each([
    ["without", {}],
    ["with", { invalidation: { staleTime: 5_000 } }],
  ] as const)("calls them %s an invalidation config", async (_label, config) => {
    const { events, sdk } = await sdkOf(undefined, config);
    await sdk.users.update({ json: {}, params: { id: 42 } });
    expect(events).toStrictEqual([UPDATED]);
  });
});
