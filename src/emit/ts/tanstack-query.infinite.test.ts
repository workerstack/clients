/**
 * The adapter's paged reads (bit 22, plan 3): `infiniteQuery.x(build, init?)`, where `build` turns a page param into
 * the SDK's request. The key is the read key of `build(undefined)` plus the `"infinite"` marker, so it holds still as
 * pages load and stays off the plain read's entry, and the call gets TanStack's abort signal as a plain read does.
 */
import { hashKey, InfiniteQueryObserver, type QueryClient } from "@tanstack/query-core";
import { describe, expect, it } from "vitest";

import { queryHelpers } from "../../runtime/ts-tanstack-query/query.ts";
import {
  type Answer,
  type CallInput,
  ORG,
  pagedAt,
  readAt,
  recordingSdk,
  SDK_NAME,
  serviceMap,
  testClient,
} from "./__fixtures__/tanstack-query.ts";

const MARKER = "infinite";
const PAGES = 3;
const LIMIT = 2;
const EVENTS = ["auth", "listSecurityEvents"] as const;

/** Helpers over a fresh recording SDK, read through a thunk as an app passes it. */
function helpers() {
  const { calls, sdk } = recordingSdk();

  return { calls, h: queryHelpers(() => sdk, serviceMap, SDK_NAME) };
}

/** A cursor page's request. */
function byCursor(cursor: string | undefined): CallInput {
  return { search: { cursor, limit: LIMIT } };
}

/** An offset page's request. */
function byOffset(offset: number | undefined): CallInput {
  return { search: { limit: LIMIT, offset } };
}

/** The cursor after `pages`: `c<count>`. */
function nextCursor(_last: Answer, pages: readonly Answer[]): string {
  return `c${pages.length}`;
}

/** The offset after `pages`. */
function nextOffset(_last: Answer, pages: readonly Answer[]): number {
  return pages.length * LIMIT;
}

/** The helper set `helpers` builds. */
type Helpers = ReturnType<typeof helpers>["h"];

/** A builder that reads a field of its page param, so its `undefined` call throws. */
function readsCursor(page: { cursor: string }): CallInput {
  return byCursor(page.cursor);
}

/** PAGES cursor pages of the events read, fetched on `client`. */
async function cursorPages(client: QueryClient, h: Helpers): Promise<void> {
  const options = pagedAt(h.infiniteQuery, ...EVENTS)(byCursor);
  await client.fetchInfiniteQuery({
    ...options,
    getNextPageParam: nextCursor,
    initialPageParam: undefined,
    pages: PAGES,
  });
}

/** PAGES offset pages of the events read, fetched on `client`. */
async function offsetPages(client: QueryClient, h: Helpers): Promise<void> {
  const options = pagedAt(h.infiniteQuery, ...EVENTS)(byOffset);
  await client.fetchInfiniteQuery({ ...options, getNextPageParam: nextOffset, initialPageParam: 0, pages: PAGES });
}

/** The keys a fresh client holds once `run` fetched its pages on it, and the searches the calls sent. */
async function fetched(run: (client: QueryClient, h: Helpers) => Promise<void>) {
  const { calls, h } = helpers();
  const client = testClient();
  await run(client, h);
  const queries = client.getQueryCache().getAll();

  return { keys: queries.map((query) => query.queryKey), searches: calls.map((call) => call.input?.search) };
}

describe("a paged read is keyed by build(undefined), whatever its pages", () => {
  it("keeps one key for a cursor builder across pages", async () => {
    expect(await fetched(cursorPages)).toStrictEqual({
      keys: [[SDK_NAME, ...EVENTS, byCursor(undefined), MARKER]],
      searches: [undefined, "c1", "c2"].map((cursor) => byCursor(cursor).search),
    });
  });

  it("keeps one key for an offset builder across pages, its initial page param not in it", async () => {
    expect(await fetched(offsetPages)).toStrictEqual({
      keys: [[SDK_NAME, ...EVENTS, byOffset(undefined), MARKER]],
      searches: [0, LIMIT, LIMIT * 2].map((offset) => byOffset(offset).search),
    });
  });

  it("stays off the plain read's entry, whose data shape differs", () => {
    const { h } = helpers();
    const plain = readAt(h.query, ...EVENTS)(byCursor("c1")).queryKey;
    const paged = pagedAt(h.infiniteQuery, ...EVENTS)(() => byCursor("c1")).queryKey;
    const marked = [SDK_NAME, ...EVENTS, byCursor("c1"), MARKER];
    expect([hashKey(paged) === hashKey(plain), paged]).toStrictEqual([false, marked]);
  });
});

describe("build is called once with undefined for the key", () => {
  it("calls build with undefined before any page loads", () => {
    const seen: Array<number | undefined> = [];

    function build(page: number | undefined): CallInput {
      seen.push(page);

      return { params: { organization_id: ORG }, search: { page } };
    }

    pagedAt(helpers().h.infiniteQuery, "org", "get")(build);
    expect(seen).toStrictEqual([undefined]);
  });

  it("shows that call to a builder reading a field of its param", () => {
    const list = pagedAt(helpers().h.infiniteQuery, ...EVENTS);
    expect(() => list(readsCursor)).toThrow("reading 'cursor'");
  });
});

describe("a paged read aborts with TanStack's signal", () => {
  it("hands each page's call the query's signal, which cancelQueries aborts", async () => {
    const { calls, h } = helpers();
    const client = testClient();
    const options = pagedAt(h.infiniteQuery, "org", "slow")(() => undefined);

    const observer = new InfiniteQueryObserver(client, {
      ...options,
      getNextPageParam: nextOffset,
      initialPageParam: 0,
    });

    const unsubscribe = observer.subscribe(() => undefined);
    const signal = calls[0]?.input?.signal;
    const live = [signal instanceof AbortSignal, signal?.aborted];
    await client.cancelQueries({ queryKey: options.queryKey });
    expect([live, signal?.aborted]).toStrictEqual([[true, false], true]);
    unsubscribe();
  });
});
