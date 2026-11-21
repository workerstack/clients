/**
 * The TanStack adapter's side of single flight (plan 5): `activeReads(queryClient)` picks the reads a write brings
 * back, and `invalidateQueries(queryClient)` seeds them before it invalidates the rest. The runtime leg drives the
 * adapter's functions on a QueryClient; the emitted leg runs the client, its handler and its adapter as one app.
 */
import {
  hashKey,
  MutationObserver,
  type QueryClient,
  type QueryFunction,
  type QueryKey,
  QueryObserver,
} from "@tanstack/query-core";
import { describe, expect, it, vi } from "vitest";

import { activeReadsOf, invalidationHook } from "../../runtime/ts-tanstack-query/invalidate.ts";
import { emittedModules, flightOf, MUTATE, sent, type Target } from "./__fixtures__/single-flight-caller.ts";
import { readAt, SDK_NAME, testClient, writeAt } from "./__fixtures__/tanstack-query.ts";

const MEMBERS: ReadonlyMap<string, readonly string[]> = new Map([
  ["users.get", ["users", "get"]],
  ["users.list", ["users", "list"]],
]);

const USER_42 = { params: { id: 42 } };
const GET_42: QueryKey = [SDK_NAME, "users", "get", USER_42];
const LIST: QueryKey = [SDK_NAME, "users", "list"];

const TARGETS: Target[] = [
  { operationId: "users.get", ...USER_42 },
  { operationId: "users.list", params: {} },
];

/** What a case sets on an observer over the defaults. */
type ObserverOptions = { enabled?: boolean; meta?: { singleFlight: boolean }; queryFn?: QueryFunction };

/** Observe `queryKey` on `client`, its answer `{}`, with `options` over that; the unsubscribe. */
function observe(client: QueryClient, queryKey: QueryKey, options: ObserverOptions = {}): () => void {
  const observer = new QueryObserver(client, { queryFn: () => ({}), queryKey, staleTime: Infinity, ...options });

  return observer.subscribe(() => undefined);
}

describe("activeReads(queryClient) picks the active reads a write's targets name", () => {
  it("picks active plain reads by hash, skipping inactive, disabled, infinite and opted-out ones", () => {
    const client = testClient();

    const stops = [
      observe(client, GET_42),
      observe(client, LIST),
      observe(client, [...LIST, "infinite"]),
      observe(client, [...LIST, { search: { page: 2 } }], { meta: { singleFlight: false } }),
      observe(client, [...LIST, { search: { page: 3 } }], { enabled: false }),
      observe(client, [...LIST, { extra: 1 }]),
    ];

    client.setQueryData([...GET_42.slice(0, 3), { ...USER_42, search: { a: 1 } }], {});
    const picked = activeReadsOf(client, SDK_NAME, MEMBERS)([...TARGETS, { operationId: "nope.get", params: {} }]);
    expect(picked).toStrictEqual([
      { id: hashKey(GET_42), input: USER_42, operationId: "users.get" },
      { id: hashKey(LIST), input: {}, operationId: "users.list" },
    ]);

    for (const stop of stops) stop();
  });

  it("picks a read two targets name once", () => {
    const client = testClient();
    const stop = observe(client, GET_42);

    const targets: Target[] = [
      { operationId: "users.get", ...USER_42 },
      { operationId: "users.get", params: {} },
    ];

    expect(activeReadsOf(client, SDK_NAME, MEMBERS)(targets).map((read) => read.id)).toStrictEqual([hashKey(GET_42)]);
    stop();
  });
});

/** The fresh reads of an event: each hash's data, and the hashes that failed. */
function fresh(data: Array<[QueryKey, unknown]>, failed: QueryKey[] = []) {
  return { data: new Map(data.map(([key, value]) => [hashKey(key), value])), failed: new Set(failed.map(hashKey)) };
}

describe("invalidateQueries(queryClient) seeds the fresh reads, then invalidates the rest", () => {
  it("sets each fresh read's data, and invalidates a failed read and one mounted mid-flight", async () => {
    const client = testClient();
    const searched = [...LIST, { search: { page: 2 } }];

    for (const key of [GET_42, LIST, searched]) client.setQueryData(key, { old: true });
    const event = { by: "users.update", fresh: fresh([[GET_42, { n: 2 }]], [LIST]), targets: TARGETS };
    await invalidationHook(client, SDK_NAME, MEMBERS)(event);
    expect(
      [GET_42, LIST, searched].map((key) => [client.getQueryData(key), client.getQueryState(key)?.isInvalidated]),
    ).toStrictEqual([
      [{ n: 2 }, false],
      [{ old: true }, true],
      [{ old: true }, true],
    ]);
  });
});

describe("invalidateQueries(queryClient) cancels a refetch that would overwrite a fresh read", () => {
  it("cancels a refetch in flight before it seeds, so the refetch cannot overwrite the fresh data", async () => {
    const client = testClient();
    const late = Promise.withResolvers<object>();
    let calls = 0;

    function queryFn(): object {
      calls += 1;

      return calls === 1 ? { v: "old" } : late.promise;
    }

    const stop = observe(client, GET_42, { queryFn });

    await vi.waitFor(() => expect(client.getQueryData(GET_42)).toStrictEqual({ v: "old" }));
    void client.refetchQueries({ queryKey: GET_42 });
    const event = { by: "users.update", fresh: fresh([[GET_42, { v: "fresh" }]]), targets: TARGETS.slice(0, 1) };
    await invalidationHook(client, SDK_NAME, MEMBERS)(event);
    late.resolve({ v: "stale" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([client.getQueryData(GET_42), client.getQueryState(GET_42)?.fetchStatus]).toStrictEqual([
      { v: "fresh" },
      "idle",
    ]);
    stop();
  });
});

describe("invalidateQueries(queryClient) leaves a fresh read alone when its query is gone", () => {
  it("skips a fresh read whose query is gone", async () => {
    const client = testClient();
    const event = { by: "users.update", fresh: fresh([[GET_42, { n: 2 }]]), targets: TARGETS.slice(0, 1) };
    await invalidationHook(client, SDK_NAME, MEMBERS)(event);
    expect(client.getQueryData(GET_42)).toBeUndefined();
  });
});

/** The emitted app, its client's single flight and invalidation wired to `client`, with `users.get` 42 observed. */
async function wired(client: QueryClient) {
  const { adapter } = await emittedModules();
  const singleFlight = { select: adapter.activeReads(client) };
  const app = await flightOf({ config: { singleFlight }, hooks: [adapter.invalidateQueries(client)] });
  const { mutation, query } = adapter.createQueryHelpers(() => app.sdk);
  const read = readAt(query, "users", "get")(USER_42);

  await client.prefetchQuery(read);
  const stop = observe(client, read.queryKey, read);

  return { ...app, mutation, read, stop };
}

describe("the emitted adapter brings a write's reads back in its batch", () => {
  it("lands the fresh read in the cache before the write resolves, with no refetch of its own", async () => {
    const client = testClient();
    const { api, app, read, sdk, stop } = await wired(client);
    await sdk.users.update({ json: {}, ...USER_42 });
    expect([client.getQueryData(read.queryKey), sent(app), sent(api)]).toStrictEqual([
      { n: 2, path: "/users/42" },
      ["GET /api/users/42", `POST ${MUTATE}`],
      ["GET /users/42", "PATCH /users/42", "GET /users/42"],
    ]);
    stop();
  });

  it("sends a mutation whose meta says singleFlight: false direct", async () => {
    const client = testClient();
    const { app, mutation, stop } = await wired(client);
    const options = writeAt(mutation, "users", "update")();
    await new MutationObserver(client, { ...options, meta: { singleFlight: false } }).mutate({ json: {}, ...USER_42 });
    await new MutationObserver(client, options).mutate({ json: {}, ...USER_42 });
    expect(sent(app).filter((line) => !line.startsWith("GET"))).toStrictEqual([
      "PATCH /api/users/42",
      `POST ${MUTATE}`,
    ]);
    stop();
  });
});
