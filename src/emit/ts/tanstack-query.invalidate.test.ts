/**
 * Invalidation through the SDK's own `onInvalidate` (bit 22, plan 3): `invalidateQueries(queryClient)` is a hook the
 * SDK config takes, so a raw `sdk.x.y()` write refreshes the cache as a helper mutation does, and `mutationFn`
 * invalidates nothing itself. The runtime leg maps an event's targets to keys; the emitted leg runs the SDK and its
 * adapter as `generateSdk` writes them, over a recording fetch.
 */
import { MutationObserver, type QueryClient, type QueryKey, QueryObserver } from "@tanstack/query-core";
import { describe, expect, it } from "vitest";

import { invalidationHook } from "../../runtime/ts-tanstack-query/invalidate.ts";
import type { InvalidateTarget } from "../../runtime/ts/config.ts";
import { countingAnswer, emittedPair } from "./__fixtures__/tanstack-query.emitted.ts";
import { keyAt, readAt, SDK_NAME, testClient, writeAt } from "./__fixtures__/tanstack-query.ts";

/** Each read's operationId and its member path; `state` is a client member, so its group is `state_`. */
const MEMBERS: ReadonlyMap<string, readonly string[]> = new Map([
  ["state.get", ["state_", "get"]],
  ["users.get", ["users", "get"]],
  ["users.list", ["users", "list"]],
]);

const USER_42 = { params: { id: 42 } };
const STATE_7 = { params: { id: 7 } };
const EMITTED = "TestSDK";

/** One target of an onInvalidate event. */
type Target = InvalidateTarget;

/** The runtime's hook for `client`, bound to SDK_NAME and MEMBERS as the emitted file binds its own. */
function hookFor(client: QueryClient) {
  return invalidationHook(client, SDK_NAME, MEMBERS);
}

/** Whether each of `keys`, seeded on a fresh client, is invalidated once the runtime's hook gets `targets`. */
async function invalidatedBy(
  keys: readonly QueryKey[],
  targets: readonly Target[],
): Promise<Array<boolean | undefined>> {
  const client = testClient();

  for (const key of keys) client.setQueryData(key, {});
  await hookFor(client)({ by: "users.update", targets: [...targets] });

  return keys.map((key) => client.getQueryState(key)?.isInvalidated);
}

describe("invalidateQueries(queryClient) invalidates a target's own key", () => {
  it("invalidates the target's exact key and its searches, an integer param kept a number", async () => {
    const keys = [
      [SDK_NAME, "users", "get", USER_42],
      [SDK_NAME, "users", "get", { ...USER_42, search: { expand: "teams" } }],
      [SDK_NAME, "users", "get", { params: { id: "42" } }],
      [SDK_NAME, "users", "get", { params: { id: 43 } }],
    ];

    expect(await invalidatedBy(keys, [{ operationId: "users.get", ...USER_42 }])).toStrictEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("invalidates the bare prefix for `params: {}`: every search and the paged read", async () => {
    const keys = [
      [SDK_NAME, "users", "list"],
      [SDK_NAME, "users", "list", { search: { page: 2 } }],
      [SDK_NAME, "users", "list", "infinite"],
      [SDK_NAME, "users", "get", USER_42],
    ];

    expect(await invalidatedBy(keys, [{ operationId: "users.list", params: {} }])).toStrictEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});

describe("invalidateQueries(queryClient) reads members from its table and lets a refetch be cancelled", () => {
  it("finds a renamed member through the table and skips an operationId it does not hold", async () => {
    const keys = [
      [SDK_NAME, "state_", "get", STATE_7],
      [SDK_NAME, "state", "get", STATE_7],
    ];

    const targets = [
      { operationId: "nope.get", params: {} },
      { operationId: "state.get", ...STATE_7 },
    ];

    expect(await invalidatedBy(keys, targets)).toStrictEqual([true, false]);
  });

  it("asks TanStack to cancel a refetch in flight, once per target", async () => {
    const client = testClient();
    const seen: unknown[] = [];
    client.invalidateQueries = (filters, options) => {
      seen.push([filters, options]);

      return Promise.resolve();
    };

    await hookFor(client)({ by: "users.update", targets: [{ operationId: "users.get", ...USER_42 }] });
    expect(seen).toStrictEqual([[{ queryKey: [SDK_NAME, "users", "get", USER_42] }, { cancelRefetch: true }]]);
  });
});

/**
 * The emitted pair wired to a fresh client, with `users.get` for id 42 fetched and observed, and the key of every
 * invalidateQueries call recorded in `invalidated`.
 */
async function observing(failAfter?: number) {
  const client = testClient();
  const pair = await emittedPair(countingAnswer(failAfter), client);
  const { mutation, query } = pair.adapter.createQueryHelpers(() => pair.sdk);
  const read = readAt(query, "users", "get")(USER_42);
  await client.prefetchQuery(read);
  const unsubscribe = new QueryObserver(client, { ...read, staleTime: Infinity }).subscribe(() => undefined);
  const invalidated: QueryKey[] = [];
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = (filters, options) => {
    if (filters?.queryKey !== undefined) invalidated.push(filters.queryKey);

    return invalidate(filters, options);
  };

  return { ...pair, client, invalidated, mutation, read, unsubscribe };
}

/** Each write the fetch saw, as its URL and body. */
function writesOf(calls: readonly Request[]): Promise<string[][]> {
  return Promise.all(calls.filter((call) => call.method !== "GET").map(async (call) => [call.url, await call.text()]));
}

describe("the emitted SDK's write refreshes the cache before it resolves", () => {
  it("refetches an observed read before a raw sdk write resolves", async () => {
    const { client, read, sdk, unsubscribe } = await observing();
    await sdk.users.update({ json: {}, ...USER_42 });
    expect(client.getQueryData(read.queryKey)).toStrictEqual({ n: 2 });
    unsubscribe();
  });

  it("resolves the write with its answer when the refetch fails", async () => {
    const { client, read, sdk, unsubscribe } = await observing(1);
    await expect(sdk.users.update({ json: {}, ...USER_42 })).resolves.toStrictEqual({ wrote: "/users/42" });
    expect(client.getQueryState(read.queryKey)?.status).toBe("error");
    unsubscribe();
  });
});

describe("a helper mutation leaves invalidation to the SDK's hook", () => {
  it("calls the method with mutate's variables; the only invalidations are the hook's", async () => {
    const { calls, client, invalidated, mutation, read, unsubscribe } = await observing();
    const ping = new MutationObserver(client, writeAt(mutation, "users", "ping")());
    const update = new MutationObserver(client, writeAt(mutation, "users", "update")());
    await ping.mutate({ json: { at: 1 }, ...USER_42 });
    await update.mutate({ json: { name: "Ada" }, ...USER_42 });
    expect([await writesOf(calls), invalidated, client.getQueryData(read.queryKey)]).toStrictEqual([
      [
        ["https://api.test/users/42/ping", '{"at":1}'],
        ["https://api.test/users/42", '{"name":"Ada"}'],
      ],
      [
        [EMITTED, "users", "get", USER_42],
        [EMITTED, "users", "list"],
      ],
      { n: 2 },
    ]);
    unsubscribe();
  });
});

describe("the emitted adapter is this adapter", () => {
  it("keys the emitted surfaces by the SDK's name and member path", async () => {
    const { adapter, sdk } = await emittedPair(countingAnswer());
    const { query, queryKey } = adapter.createQueryHelpers(() => sdk);
    const keys = [readAt(query, "users", "list")().queryKey, keyAt(queryKey, "state_", "get")(STATE_7)];
    expect(keys).toStrictEqual([
      [EMITTED, "users", "list"],
      [EMITTED, "state_", "get", STATE_7],
    ]);
  });
});
