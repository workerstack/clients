/**
 * The vendored TanStack Query adapter's surfaces and reads (bit 22, plan 3), driven on the runtime module over a fake
 * SDK: what each surface offers, what a read is keyed by and calls the SDK with, and that TanStack's abort signal
 * reaches the call. Paged reads are tanstack-query.infinite.test.ts; invalidation, over the emitted file too, is
 * tanstack-query.invalidate.test.ts.
 */
import { hashKey, QueryObserver } from "@tanstack/query-core";
import { describe, expect, it } from "vitest";

import { queryHelpers } from "../../runtime/ts-tanstack-query/query.ts";
import {
  type CallInput,
  type Recorded,
  keyAt,
  offered,
  ORG,
  readAt,
  recordingSdk,
  SDK_NAME,
  serviceMap,
  testClient,
  writeAt,
} from "./__fixtures__/tanstack-query.ts";

const REQ = { params: { organization_id: ORG } };
const SEARCHED = { ...REQ, search: { expand: "members" } };
const METHODS = ["create", "get", "list", "update"];
const STREAMS = ["stream", "watch"];
const TIMEOUT = 5000;

/** Helpers over a fresh recording SDK, read through a thunk as an app passes it. */
function helpers() {
  const { calls, sdk } = recordingSdk();

  return { calls, h: queryHelpers(() => sdk, serviceMap, SDK_NAME) };
}

describe("the adapter's surfaces follow the service map, not method names", () => {
  it("splits by method, so a write is never a query and `list`/`get` names decide nothing", () => {
    const { h } = helpers();
    expect([offered(h.query, "org", METHODS), offered(h.mutation, "org", METHODS)]).toStrictEqual([
      [false, true, true, false],
      [true, false, false, true],
    ]);
  });

  it("leaves an event stream and a websocket out of every surface", () => {
    const { h } = helpers();
    const surfaces = [h.query, h.mutation, h.infiniteQuery];
    expect(surfaces.flatMap((surface) => offered(surface, "extract", STREAMS))).toStrictEqual(
      Array.from({ length: surfaces.length * STREAMS.length }, () => false),
    );
  });

  it("keys a mutation by its member path", () => {
    expect(keyAt(helpers().h.mutationKey, "org", "update")()).toStrictEqual([SDK_NAME, "org", "update"]);
  });
});

/** A call as the fake SDK saw it, its signal shown as whether it is one: a signal does not compare. */
function shown(call: Recorded) {
  return { input: { ...call.input, signal: call.input?.signal instanceof AbortSignal }, member: call.member };
}

describe("a read takes the SDK's own input and nothing of TanStack's", () => {
  it("keys a read by its member path and request, calls the method with that request, and seeds nothing", async () => {
    const { calls, h } = helpers();
    const options = readAt(h.query, "org", "get")(REQ);
    expect([Object.keys(options).toSorted(), options.queryKey]).toStrictEqual([
      ["queryFn", "queryKey"],
      [SDK_NAME, "org", "get", REQ],
    ]);
    await expect(testClient().fetchQuery(options)).resolves.toStrictEqual({ member: "org.get" });
    expect(calls.map(shown)).toStrictEqual([{ input: { ...REQ, signal: true }, member: "org.get" }]);
  });

  it("sends the SDK's own init in the one input, never in the key", async () => {
    const { calls, h } = helpers();
    const options = readAt(h.query, "org", "get")(REQ, { timeout: TIMEOUT });
    await testClient().fetchQuery(options);
    expect([options.queryKey, calls.map((call) => shown(call).input)]).toStrictEqual([
      [SDK_NAME, "org", "get", REQ],
      [{ ...REQ, signal: true, timeout: TIMEOUT }],
    ]);
  });
});

describe("a write takes the SDK's own input as mutate's variables", () => {
  it("gives a write's options only its call and key, and calls the method with the variables alone", async () => {
    const { calls, h } = helpers();
    const options = writeAt(h.mutation, "org", "update")();
    const variables = { json: { name: "Acme" }, ...REQ };
    await expect(options.mutationFn(variables)).resolves.toStrictEqual({ member: "org.update" });
    expect([Object.keys(options).toSorted(), calls]).toStrictEqual([
      ["mutationFn", "mutationKey"],
      [{ input: variables, member: "org.update" }],
    ]);
  });
});

/** The hash of `listSecurityEvents`'s key for `req`. */
function eventsHash(req: CallInput): string {
  return hashKey(readAt(helpers().h.query, "auth", "listSecurityEvents")(req).queryKey);
}

describe("a read's key holds every input that changes its answer", () => {
  it("separates two pages of one route that differ only by search", () => {
    expect(eventsHash({ search: { limit: 20 } }) === eventsHash({ search: { before: "c1", limit: 20 } })).toBe(false);
  });

  it("holds the request itself, params and search together", () => {
    expect(readAt(helpers().h.query, "org", "get")(SEARCHED).queryKey).toStrictEqual([
      SDK_NAME,
      "org",
      "get",
      SEARCHED,
    ]);
  });
});

describe("a read's key is one entry per request", () => {
  it("keys a read with no request by its member path alone", () => {
    expect(readAt(helpers().h.query, "org", "list")().queryKey).toStrictEqual([SDK_NAME, "org", "list"]);
  });

  it("is stable under property order, so one search is one entry however it is written", () => {
    const entries: Array<[string, number | string]> = [
      ["limit", 20],
      ["before", "c1"],
    ];

    const reversed = Object.fromEntries(entries);

    expect(eventsHash({ search: reversed })).toBe(eventsHash({ search: { before: "c1", limit: 20 } }));
  });

  it("gives queryKey.* exactly the key query.* writes for that request", () => {
    const { h } = helpers();
    const keys = [keyAt(h.queryKey, "org", "get")(SEARCHED), keyAt(h.queryKey, "org", "list")()];
    const reads = [readAt(h.query, "org", "get")(SEARCHED), readAt(h.query, "org", "list")()];
    expect(keys).toStrictEqual(reads.map((options) => options.queryKey));
  });
});

/** The `slow` read observed on a fresh client, its fetch in flight, and the signal its call received. */
function observed(init?: CallInput) {
  const { calls, h } = helpers();
  const client = testClient();
  const options = readAt(h.query, "org", "slow")(undefined, init);
  const unsubscribe = new QueryObserver(client, options).subscribe(() => undefined);

  return { client, options, signal: calls[0]?.input?.signal, unsubscribe };
}

describe("a read aborts with TanStack's signal", () => {
  it("hands the call a live signal", () => {
    const { signal, unsubscribe } = observed();
    expect([signal instanceof AbortSignal, signal?.aborted]).toStrictEqual([true, false]);
    unsubscribe();
  });

  it("aborts the call on cancelQueries", async () => {
    const { client, options, signal, unsubscribe } = observed();
    await client.cancelQueries({ queryKey: options.queryKey });
    expect(signal?.aborted).toBe(true);
    unsubscribe();
  });

  it("aborts the call when its last observer goes, as an unmount or a key change does", () => {
    const { signal, unsubscribe } = observed();
    unsubscribe();
    expect(signal?.aborted).toBe(true);
  });

  it("still aborts the call on the init's own signal", () => {
    const controller = new AbortController();
    const { signal, unsubscribe } = observed({ signal: controller.signal });
    controller.abort();
    expect(signal?.aborted).toBe(true);
    unsubscribe();
  });
});
