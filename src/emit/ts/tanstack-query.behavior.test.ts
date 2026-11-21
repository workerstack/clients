/**
 * The vendored TanStack Query adapter's behavior (bit 22). Phase 2 drives the runtime module directly;
 * phase 3 adds the leg over the emitted `<stem>.tanstack-query.gen.ts`, which is what proves the vendored
 * text an SDK ships is this text. The invalidation cases come from the package this replaces,
 * `monorepo/packages/query-client/src/repo.query-client.invalidation.test.ts`, so a read-after-write that
 * worked there works here.
 */
import { hashKey, partialMatchKey, QueryClient, type QueryKey } from "@tanstack/query-core";
import { describe, expect, it } from "vitest";

import type { Surface } from "../../runtime/ts-tanstack-query/query.ts";
import { queryHelpers } from "../../runtime/ts-tanstack-query/query.ts";
import type { ServiceMap } from "../../runtime/ts/sdk.ts";
import { emittedTanstackQuery } from "./__fixtures__/emitted.ts";

const ORG = "org_1";
const SDK_NAME = "acme";

// the shape serviceMapOf emits: `{p}` kept in `path`, `params` naming the path slots, flags only when set
const serviceMap: ServiceMap = {
  extract: {
    stream: {
      id: "extract.stream",
      invalidate: ["GET /v1/projects/rows"],
      method: "POST",
      path: "/v1/projects/extract-stream",
      sse: true,
    },
    watch: { id: "extract.watch", method: "GET", path: "/v1/projects/watch", ws: true },
  },
  org: {
    create: { id: "org.create", invalidate: ["GET /v1/organizations"], method: "POST", path: "/v1/organizations" },
    get: { id: "org.get", method: "GET", params: ["organization_id"], path: "/v1/organizations/{organization_id}" },
    list: { id: "org.list", method: "GET", path: "/v1/organizations" },
    update: {
      id: "org.update",
      invalidate: ["GET /v1/organizations", "GET /v1/organizations/:organization_id"],
      method: "PATCH",
      params: ["organization_id"],
      path: "/v1/organizations/{organization_id}",
    },
  },
  other: {
    noop: { id: "other.noop", method: "POST", path: "/v1/other" },
    unknown: { id: "other.unknown", invalidate: ["GET /v1/nope"], method: "POST", path: "/v1/other/unknown" },
  },
};

const sdk = {
  extract: { stream: () => ({ events: true }), watch: () => ({ socket: true }) },
  org: {
    explode: (): Promise<{ ok: boolean }> => Promise.reject(new Error("boom")),
    get: (req?: { params: { organization_id: string } }) => Promise.resolve({ id: req?.params.organization_id ?? "" }),
    list: () => Promise.resolve([]),
    // params is optional here only so the missing-param case can reach the real mutationFn
    update: (req: { json?: { name: string }; params?: { organization_id: string } }) =>
      Promise.resolve({ id: req.params?.organization_id ?? "", name: req.json?.name ?? "" }),
  },
  other: { noop: () => Promise.resolve({}), unknown: () => Promise.resolve({}) },
};

/** A client that records what was invalidated instead of invalidating it. */
function trackingClient(): { client: QueryClient; keys: QueryKey[] } {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  const keys: QueryKey[] = [];
  client.invalidateQueries = async (filters) => {
    if (filters && "queryKey" in filters && filters.queryKey !== undefined) keys.push(filters.queryKey);
  };

  return { client, keys };
}

/** The surface at `path` under `surface`, or a throw naming the path: a test reaches only what its map declares. */
function leaf(surface: Surface, ...path: string[]): Surface {
  let node = surface;

  for (const name of path) {
    const next = node[name];

    if (next === undefined) throw new Error(`no surface at ${path.join(".")}`);
    node = next;
  }

  return node;
}

const helpersWith = (client?: QueryClient) =>
  queryHelpers(sdk, serviceMap, SDK_NAME, client === undefined ? {} : { getQueryClient: () => client });

describe("the adapter's surfaces follow the service map, not method names", () => {
  it("keys a read by its member path and request, and seeds nothing", async () => {
    const get = leaf(helpersWith().query, "org", "get");
    const options = get({ reqOptions: { req: { params: { organization_id: ORG } } } });
    expect(options.queryKey).toEqual([SDK_NAME, "org", "get", { params: { organization_id: ORG } }]);
    // solid-query reads `initialData?: Data | undefined` as the seeded overload, so it is present and undefined
    expect("initialData" in options).toBe(true);
    expect(options.initialData).toBeUndefined();
    await expect((options.queryFn as () => Promise<{ id: string }>)()).resolves.toEqual({ id: ORG });
  });

  it("splits by method, so a write is never a query and `list`/`retrieve` names decide nothing", () => {
    const helpers = helpersWith();
    expect(leaf(helpers.query, "org").list).toBeTypeOf("function");
    expect(leaf(helpers.query, "org").get).toBeTypeOf("function");
    expect(leaf(helpers.mutation, "org").update).toBeTypeOf("function");
    expect(leaf(helpers.mutation, "org").create).toBeTypeOf("function");
    // `update` is a PATCH: it is not a read, however it is named
    expect(leaf(helpers.query, "org").update).toBeUndefined();
    // `get` is a GET: it is not a write
    expect(leaf(helpers.mutation, "org").get).toBeUndefined();
  });

  it("leaves an event stream and a websocket out of both surfaces", () => {
    const helpers = helpersWith();
    expect(leaf(helpers.mutation, "extract").stream).toBeUndefined();
    expect(leaf(helpers.query, "extract").stream).toBeUndefined();
    expect(leaf(helpers.query, "extract").watch).toBeUndefined();
    expect(leaf(helpers.mutation, "extract").watch).toBeUndefined();
  });

  it("keys a mutation by its member path", () => {
    expect(leaf(helpersWith().mutationKey, "org", "update")({ params: { organization_id: ORG } })).toEqual([
      SDK_NAME,
      "org",
      "update",
      { params: { organization_id: ORG } },
    ]);
  });
});

// the queryFn sends req.search, so two searches are two cache entries; keying on params alone merged them
const searchMap: ServiceMap = {
  auth: {
    listSecurityEvents: { id: "auth.listSecurityEvents", method: "GET", path: "/v1/auth/events" },
    revokeSession: {
      id: "auth.revokeSession",
      invalidate: ["GET /v1/auth/events"],
      method: "POST",
      path: "/v1/auth/sessions/revoke",
    },
  },
  org: {
    get: { id: "org.get", method: "GET", params: ["organization_id"], path: "/v1/organizations/{organization_id}" },
    update: {
      id: "org.update",
      invalidate: ["GET /v1/organizations/:organization_id"],
      method: "PATCH",
      params: ["organization_id"],
      path: "/v1/organizations/{organization_id}",
    },
  },
};

const searchSdk = {
  auth: { listSecurityEvents: () => Promise.resolve({}), revokeSession: () => Promise.resolve({}) },
  org: { get: () => Promise.resolve({}), update: () => Promise.resolve({}) },
};

const withSearch = (client?: QueryClient) =>
  queryHelpers(searchSdk, searchMap, SDK_NAME, client === undefined ? {} : { getQueryClient: () => client });

describe("a read's key holds every input that changes its answer", () => {
  it("separates two pages of one route that differ only by search", () => {
    const events = leaf(withSearch().query, "auth", "listSecurityEvents");
    const first = events({ reqOptions: { req: { search: { limit: 20 } } } });
    const next = events({ reqOptions: { req: { search: { before: "c1", limit: 20 } } } });
    expect(first.queryKey).not.toEqual(next.queryKey);
    expect(hashKey(first.queryKey)).not.toBe(hashKey(next.queryKey));
  });

  it("holds the request itself, params and search together", () => {
    const get = leaf(withSearch().query, "org", "get");

    const options = get({
      reqOptions: { req: { params: { organization_id: ORG }, search: { expand: "members" } } },
    });

    expect(options.queryKey).toEqual([
      SDK_NAME,
      "org",
      "get",
      { params: { organization_id: ORG }, search: { expand: "members" } },
    ]);
  });

  it("keys a read with no request by its member path alone", () => {
    const events = leaf(withSearch().query, "auth", "listSecurityEvents");
    expect(events().queryKey).toEqual([SDK_NAME, "auth", "listSecurityEvents"]);
  });

  it("is stable under property order, so one search is one entry however it is written", () => {
    const events = leaf(withSearch().query, "auth", "listSecurityEvents");
    const a = events({ reqOptions: { req: { search: { before: "c1", limit: 20 } } } });
    const b = events({ reqOptions: { req: { search: { before: "c1", limit: 20 } } } });
    expect(hashKey(a.queryKey)).toBe(hashKey(b.queryKey));
  });

  it("gives queryKey.* exactly the key query.* writes for that request", () => {
    const h = withSearch();
    const req = { params: { organization_id: ORG }, search: { expand: "members" } };
    expect(leaf(h.queryKey, "org", "get")(req)).toEqual(leaf(h.query, "org", "get")({ reqOptions: { req } }).queryKey);
    const events = leaf(h.query, "auth", "listSecurityEvents");
    expect(leaf(h.queryKey, "auth", "listSecurityEvents")()).toEqual(events().queryKey);
  });
});

describe("a read's key and an invalidation filter meet without colliding", () => {
  it("keeps an infinite read off the plain read's entry, whose data shape differs", () => {
    const h = withSearch();
    const plain = leaf(h.query, "auth", "listSecurityEvents")({ reqOptions: { req: { search: { limit: 20 } } } });
    const infinite = leaf(h.infiniteQuery, "auth", "listSecurityEvents");

    const paged = infinite({
      buildReqOptions: (before: string | null) => ({ req: { search: { before, limit: 20 } } }),
      getNextPageParam: () => null,
      initialPageParam: null,
    });

    expect(paged.queryKey).not.toEqual(plain.queryKey);
    expect(hashKey(paged.queryKey)).not.toBe(hashKey(plain.queryKey));
  });

  it("still lets a write reach both entries by prefix, filled params and all", async () => {
    const { client, keys } = trackingClient();
    const h = withSearch(client);
    await leaf(h.mutation, "auth", "revokeSession")().mutationFn({});
    await leaf(h.mutation, "org", "update")().mutationFn({ params: { organization_id: ORG } });
    expect(keys).toEqual([
      [SDK_NAME, "auth", "listSecurityEvents"],
      [SDK_NAME, "org", "get", { params: { organization_id: ORG } }],
    ]);
    // what TanStack does with those filters: the prefix matches every search, and the params object
    // partially matches a key that also carries search, including the infinite read's longer key
    const events = leaf(h.query, "auth", "listSecurityEvents");
    const infinite = leaf(h.infiniteQuery, "auth", "listSecurityEvents");
    const get = leaf(h.query, "org", "get");
    const plain = events({ reqOptions: { req: { search: { limit: 20 } } } }).queryKey;

    const paged = infinite({
      buildReqOptions: () => ({ req: { search: { limit: 20 } } }),
      getNextPageParam: () => null,
      initialPageParam: null,
    }).queryKey;

    const one = get({
      reqOptions: { req: { params: { organization_id: ORG }, search: { expand: "members" } } },
    }).queryKey;

    expect(partialMatchKey(plain, keys[0] as QueryKey)).toBe(true);
    expect(partialMatchKey(paged, keys[0] as QueryKey)).toBe(true);
    expect(partialMatchKey(one, keys[1] as QueryKey)).toBe(true);
  });
});

describe("a write invalidates what its x-invalidate names", () => {
  it("invalidates the list and that one org, with the params filled in", async () => {
    const { client, keys } = trackingClient();
    const options = leaf(helpersWith(client).mutation, "org", "update")();
    await options.mutationFn({ json: { name: "Acme" }, params: { organization_id: ORG } });
    expect(keys).toEqual([
      [SDK_NAME, "org", "list"],
      [SDK_NAME, "org", "get", { params: { organization_id: ORG } }],
    ]);
  });

  it("reads a `{id}` path and a `:id` selector as one key", async () => {
    const braced: ServiceMap = {
      item: {
        get: { id: "item.get", method: "GET", params: ["id"], path: "/v1/items/{id}" },
        patch: {
          id: "item.patch",
          invalidate: ["GET /v1/items/:id"],
          method: "PATCH",
          params: ["id"],
          path: "/v1/items/{id}",
        },
      },
    };

    const { client, keys } = trackingClient();
    const sdkItem = { item: { get: () => Promise.resolve({}), patch: () => Promise.resolve({}) } };
    const helpers = queryHelpers(sdkItem, braced, SDK_NAME, { getQueryClient: () => client });
    await leaf(helpers.mutation, "item", "patch")().mutationFn({ params: { id: "i1" } });
    expect(keys).toEqual([[SDK_NAME, "item", "get", { params: { id: "i1" } }]]);
  });

  it("keeps the mutation's body off the read's key", async () => {
    const { client, keys } = trackingClient();
    await leaf(helpersWith(client).mutation, "org", "update")().mutationFn({
      json: { name: "Acme" },
      params: { organization_id: ORG },
    });
    expect(keys[1]).toEqual([SDK_NAME, "org", "get", { params: { organization_id: ORG } }]);
    expect(JSON.stringify(keys)).not.toContain("Acme");
  });

  it("falls back to the read's prefix when a param has no value", async () => {
    const { client, keys } = trackingClient();
    await leaf(helpersWith(client).mutation, "org", "update")().mutationFn({ json: { name: "x" } });
    expect(keys).toEqual([
      [SDK_NAME, "org", "list"],
      [SDK_NAME, "org", "get"],
    ]);
  });
});

const json = () => ({ content: { "application/json": { schema: { type: "object" } } }, description: "" });

describe("the emitted adapter is this adapter", () => {
  // the vendored text is only worth testing above if what an SDK ships is the same text, run end to end
  const document = {
    info: { title: "T", version: "1" },
    openapi: "3.1.0",
    paths: {
      "/orgs": {
        get: { operationId: "org.list", responses: { 200: json() } },
        post: { operationId: "org.create", responses: { 201: json() }, "x-invalidate": ["GET /orgs"] },
      },
    },
  };

  it("keys a read and invalidates a write through the file generateSdk wrote", async () => {
    const { client, keys } = trackingClient();

    const emitted = (await emittedTanstackQuery(document)) as unknown as {
      createQueryHelpers: (
        sdk: unknown,
        options: { getQueryClient: () => QueryClient },
      ) => {
        mutation: Surface;
        query: Surface;
      };
    };

    const helpers = emitted.createQueryHelpers(
      { org: { create: () => Promise.resolve({ id: "o1" }), list: () => Promise.resolve([]) } },
      { getQueryClient: () => client },
    );

    expect(leaf(helpers.query, "org", "list")().queryKey).toEqual(["TestSDK", "org", "list"]);
    await leaf(helpers.mutation, "org", "create")().mutationFn({});
    expect(keys).toEqual([["TestSDK", "org", "list"]]);
    // the stream guard travels too: `org.create` is a write here, and a read is not on the write surface
    expect(leaf(helpers.mutation, "org").list).toBeUndefined();
  });
});

describe("a write invalidates nothing when there is nothing to make stale", () => {
  it("invalidates nothing for an empty or unknown selector", async () => {
    const { client, keys } = trackingClient();
    const helpers = helpersWith(client);
    await leaf(helpers.mutation, "other", "noop")().mutationFn({});
    await leaf(helpers.mutation, "other", "unknown")().mutationFn({});
    expect(keys).toEqual([]);
  });

  it("invalidates nothing when the call throws", async () => {
    const { client, keys } = trackingClient();

    const rejecting = queryHelpers({ ...sdk, org: { ...sdk.org, update: sdk.org.explode } }, serviceMap, SDK_NAME, {
      getQueryClient: () => client,
    });

    await expect(
      leaf(rejecting.mutation, "org", "update")().mutationFn({ params: { organization_id: ORG } }),
    ).rejects.toThrow("boom");
    expect(keys).toEqual([]);
  });

  it("still answers the call when no query client was given", async () => {
    const options = leaf(helpersWith().mutation, "org", "update")();
    await expect(options.mutationFn({ json: { name: "Acme" }, params: { organization_id: ORG } })).resolves.toEqual({
      id: ORG,
      name: "Acme",
    });
  });
});
