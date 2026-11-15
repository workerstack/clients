/**
 * `generateTypes`: an app's document, route tree and extracted types → `types.gen.d.ts`, checked
 * as a service consumes it (the `Routes` map, the extractors, the `HttpCodegen` `operationId`
 * slot, route meta). Errors live in type-gen.errors.test.ts, ctx in type-gen.ctx.test.ts.
 */
import * as tsMorph from "ts-morph";
import { describe, expect, it } from "vitest";

import type { ExtractedTypes } from "../../extract/extract.ts";
import { extracted, type HttpApp, type HttpRoute, httpDoc, object } from "./__fixtures__/http-doc.ts";
import { typechecker } from "./__fixtures__/typecheck.ts";
import { generateTypes } from "./type-gen.ts";

const typecheck = typechecker(tsMorph);

type Json = Record<string, unknown>;

const STRING = { type: "string" };
const NUMBER = { type: "number" };
const NULLABLE_STRING = { type: ["string", "null"] };
const arrayOf = (items: Json) => ({ items, type: "array" });
const json = (statuses: Record<string, Json>) => ({ "application/json": statuses });

/** generateTypes over `app`, what it reported, and each diagnostic of `consumer` beside its output. */
function check(app: HttpApp, consumer: string, types: ExtractedTypes | null = null) {
  const reports: string[] = [];
  const text = generateTypes({ ...app, extracted: types, report: (m) => reports.push(m) });

  return { diagnostics: typecheck(text, consumer), reports, text };
}

const route = (method: string, pattern: string, rest: Partial<HttpRoute> = {}): HttpRoute => ({
  method,
  pattern,
  ...rest,
});

/** The types of `routes` with nothing extracted. */
const generate = (routes: HttpRoute[]) => generateTypes({ ...httpDoc(routes), extracted: null, report: () => {} });

/** A closed object schema, as Effect's JSON Schema writes a Struct. */
const struct = (properties: Json) => ({ ...object(properties), additionalProperties: false });

const USER = object({ email: STRING, id: STRING, name: STRING });

// a real-world app: mixed inputs, optional and nullable fields, params, errors, outputs
const REAL_WORLD = httpDoc([
  route("GET", "/health"),
  route("POST", "/v1/auth/register", {
    errors: { email_taken: { status: 409 } },
    input: {
      json: object({ email: STRING, first_name: NULLABLE_STRING, last_name: NULLABLE_STRING, password: STRING }, [
        "email",
        "password",
      ]),
    },
    output: json({ created: object({ id: STRING }) }),
  }),
  route("POST", "/v1/auth/login", {
    errors: { not_authorized: { status: 401 } },
    input: { json: object({ email: STRING, password: STRING }) },
    output: json({ ok: object({ token: STRING }) }),
  }),
  route("GET", "/v1/users", {
    input: { search: object({ limit: NUMBER, page: NUMBER }, ["page"]) },
    output: json({ ok: object({ items: arrayOf(USER), total: NUMBER }) }),
  }),
  route("GET", "/v1/users/:id", { errors: { not_found: { status: 404 } }, output: json({ ok: USER }) }),
  route("PUT", "/v1/users/:id", {
    errors: { not_found: { status: 404 } },
    input: { json: object({ avatar: NULLABLE_STRING, bio: NULLABLE_STRING, name: STRING }, ["name"]) },
  }),
  route("DELETE", "/v1/users/:id", { errors: { not_authorized: { status: 401 }, not_found: { status: 404 } } }),
  route("GET", "/v1/projects", {
    input: { search: object({ limit: NUMBER, offset: NUMBER }) },
    output: json({ ok: object({ items: arrayOf(object({ id: STRING, name: STRING })), total: NUMBER }) }),
  }),
  route("POST", "/v1/projects", {
    input: { json: object({ description: STRING, name: STRING }, ["name"]) },
    output: json({ created: object({ id: STRING }) }),
  }),
]);

describe("the module skeleton", () => {
  // v0: 6770071363
  it("types every documented route under its pattern, with BaseCtx from the extracted env and HttpError factories", () => {
    const app = httpDoc([
      route("GET", "/items/:id", { errors: { not_found: { status: 404 } }, meta: { auth: true } }),
      route("POST", "/items"),
    ]);

    const consumer = `expectType<Equal<keyof Routes, "/items" | "/items/:id">>()
expectType<Equal<keyof Routes["/items/:id"], "get">>()
expectType<Equal<keyof Routes["/items"], "post">>()
expectType<Same<BaseCtx["env"], { DB: string }>>()
expectType<Equal<ReturnType<Routes["/items/:id"]["get"]["ctx"]["errors"]["not_found"]>, HttpError>>()`;

    const { diagnostics } = check(app, consumer, extracted({ env: "{ DB: string }" }));
    expect(diagnostics).toEqual([]);
  });

  // v0: 81bd6fd06a
  it("types an app with no routes as an empty Routes map", () => {
    expect(check(httpDoc([]), "expectType<Equal<keyof Routes, never>>()").diagnostics).toEqual([]);
  });

  // v0: a31c4df124
  it("emits all six Route* extractors even with no routes", () => {
    const consumer = `type Probe<P extends keyof Routes, M extends keyof Routes[P] & string> = [RouteInput<P, M>, RouteOutput<P, M>, RouteErrors<P, M>, RouteErrorShapes<P, M>, RouteErrorsByStatus<P, M>, RouteMeta<P, M>]
expectType<Equal<Probe<never, never>["length"], 6>>()`;

    expect(check(httpDoc([]), consumer).diagnostics).toEqual([]);
  });

  // v0: b3ed47c6ec
  it("resolves each Route* extractor to that route's entry", () => {
    const app = httpDoc([
      route("GET", "/health", {
        errors: { down: { status: 503 } },
        input: { search: object({ deep: { type: "boolean" } }) },
        meta: { summary: "Health" },
        output: json({ ok: object({ status: STRING }) }),
      }),
    ]);

    const consumer = `type E = Routes["/health"]["get"]
expectType<Equal<RouteInput<"/health", "get">, E["input"]>>()
expectType<Equal<RouteOutput<"/health", "get">, E["output"]>>()
expectType<Equal<RouteErrors<"/health", "get">, "down">>()
expectType<Equal<RouteErrorShapes<"/health", "get">, E["errorShapes"]>>()
expectType<Equal<RouteErrorsByStatus<"/health", "get">, E["errorsByStatus"]>>()
expectType<Equal<RouteMeta<"/health", "get">, { summary: "Health" }>>()
expectType<Same<RouteInput<"/health", "get">, { search: { deep: boolean } }>>()`;

    expect(check(app, consumer).diagnostics).toEqual([]);
  });
});

describe("the Routes map", () => {
  // v0: 8e405a63a7
  it("builds a GET route's ctx on BaseCtx", () => {
    const consumer = `type C = Routes["/health"]["get"]["ctx"]
expectType<Equal<C["env"], BaseCtx["env"]>>()
expectType<Equal<C["req"], Request>>()
expectType<Equal<C["routePattern"], "/health">>()`;

    expect(check(httpDoc([route("GET", "/health")]), consumer).diagnostics).toEqual([]);
  });

  // v0: 5a5fd49d0e
  it("keys GET and POST on one path under the same Routes entry", () => {
    const app = httpDoc([
      route("GET", "/users"),
      route("POST", "/users", { input: { json: object({ name: STRING }) } }),
    ]);

    const consumer = `expectType<Equal<keyof Routes["/users"], "get" | "post">>()
expectType<Same<RouteInput<"/users", "post">["json"], { name: string }>>()`;

    expect(check(app, consumer).diagnostics).toEqual([]);
  });

  it("types an all() route once, under the method all", () => {
    const consumer = `expectType<Equal<keyof Routes["/echo"], "all">>()`;
    expect(check(httpDoc([route("ALL", "/echo")]), consumer).diagnostics).toEqual([]);
  });

  // v0: 494723e73f
  it("types every route of a multi-route app with its concrete input and output", () => {
    const app = httpDoc([
      route("GET", "/health"),
      route("GET", "/users", {
        input: { search: object({ page: NUMBER }) },
        output: json({ ok: object({ items: arrayOf(STRING) }) }),
      }),
      route("POST", "/users", { input: { json: object({ email: STRING, name: STRING }) } }),
    ]);

    const consumer = `expectType<Equal<keyof Routes, "/health" | "/users">>()
expectType<Same<RouteInput<"/users", "get">, { search: { page: number } }>>()
expectType<Same<RouteInput<"/users", "post">, { json: { email: string; name: string } }>>()
expectType<Same<RouteOutput<"/users", "get">, { "application/json": { ok: { items: string[] } } }>>()`;

    expect(check(app, consumer).diagnostics).toEqual([]);
  });
});

describe("path params", () => {
  // v0: d48578b92d
  it("types the pattern's params as ctx.params, each a string", () => {
    const consumer = `type P = Routes["/users/:userId/posts/:postId"]["get"]["ctx"]["params"]
expectType<Same<P, { postId: string; userId: string }>>()
expectType<Equal<P["userId"] | P["postId"], string>>()`;

    expect(check(httpDoc([route("GET", "/users/:userId/posts/:postId")]), consumer).diagnostics).toEqual([]);
  });

  // v0: 4a3f99f9b3
  it("types path params beside the route's body and output", () => {
    const app = httpDoc([
      route("PUT", "/users/:userId/posts/:postId", {
        input: { json: object({ body: STRING, title: STRING }) },
        output: json({ ok: object({ id: STRING, updated: { type: "boolean" } }) }),
      }),
    ]);

    const consumer = `type C = Routes["/users/:userId/posts/:postId"]["put"]["ctx"]
expectType<Same<C["params"], { postId: string; userId: string }>>()
expectType<Same<RouteInput<"/users/:userId/posts/:postId", "put">, { json: { body: string; title: string } }>>()
expectType<Same<RouteOutput<"/users/:userId/posts/:postId", "put">, { "application/json": { ok: { id: string; updated: boolean } } }>>()`;

    expect(check(app, consumer).diagnostics).toEqual([]);
  });
});

describe("Routes entries", () => {
  // v0: 1b35afa162
  it("types a route with no input as input {}", () => {
    const consumer = `expectType<Equal<RouteInput<"/health", "get">, {}>>()`;
    expect(check(httpDoc([route("GET", "/health")]), consumer).diagnostics).toEqual([]);
  });

  // v0: 555da9d12f
  it("types a route with no output as output {}, core's placeholder 200 contributing nothing", () => {
    const consumer = `expectType<Equal<RouteOutput<"/health", "get">, {}>>()`;
    expect(check(httpDoc([route("GET", "/health")]), consumer).diagnostics).toEqual([]);
  });

  // v0: 03a0e807c7
  it("types a real-world app: every path, optional markers, params, declared errors and outputs", () => {
    const consumer = `expectType<Equal<keyof Routes, "/health" | "/v1/auth/login" | "/v1/auth/register" | "/v1/projects" | "/v1/users" | "/v1/users/:id">>()
expectType<Equal<keyof Routes["/v1/users/:id"], "delete" | "get" | "put">>()
expectType<Same<RouteInput<"/v1/auth/register", "post">["json"], { email: string; first_name?: string | null; last_name?: string | null; password: string }>>()
expectType<Same<RouteInput<"/v1/users", "get">["search"], { limit?: number; page: number }>>()
expectType<Same<RouteInput<"/v1/users/:id", "put">["json"], { avatar?: string | null; bio?: string | null; name: string }>>()
expectType<Same<RouteInput<"/v1/projects", "post">["json"], { description?: string; name: string }>>()
expectType<Same<Routes["/v1/users/:id"]["get"]["ctx"]["params"], { id: string }>>()
expectType<Equal<RouteErrors<"/v1/auth/register", "post">, "email_taken">>()
expectType<Equal<RouteErrors<"/v1/users/:id", "delete">, "not_authorized" | "not_found">>()
expectType<Equal<RouteErrors<"/v1/projects", "get">, never>>()
expectType<Same<RouteOutput<"/v1/auth/login", "post">, { "application/json": { ok: { token: string } } }>>()
expectType<Same<RouteOutput<"/v1/projects", "get">["application/json"]["ok"], { items: { id: string; name: string }[]; total: number }>>()`;

    expect(check(REAL_WORLD, consumer).diagnostics).toEqual([]);
  });

  it("leaves websocket operations out of Routes", () => {
    const consumer = `expectType<Equal<keyof Routes, "/health">>()`;
    expect(check(httpDoc([route("GET", "/health"), route("WS", "/chat")]), consumer).diagnostics).toEqual([]);
  });

  it("leaves out and reports, once, an operation without x-backend-route", () => {
    const app = httpDoc([route("GET", "/health"), route("GET", "/legacy")]);
    const paths = app.document.paths as Record<string, Record<string, Json>>;
    delete paths["/legacy"]?.get?.["x-backend-route"];
    const { diagnostics, reports } = check(app, `expectType<Equal<keyof Routes, "/health">>()`);
    expect({ diagnostics, reports }).toEqual({
      diagnostics: [],
      reports: ["GET /legacy: no x-backend-route; left out of Routes"],
    });
  });

  it("emits the same bytes whatever order the document lists its routes in", () => {
    const routes = [
      route("POST", "/b", { errors: { a_key: { status: 400 }, z_key: { status: 409 } } }),
      route("GET", "/B"),
      route("GET", "/a/:id"),
      route("DELETE", "/a/:id"),
    ];

    expect(generate(routes)).toBe(generate(routes.toReversed()));
  });
});

describe("input and output types", () => {
  // v0: b10d6edfc9
  it("types a search schema as input.search", () => {
    const app = httpDoc([route("GET", "/search", { input: { search: object({ limit: NUMBER, q: STRING }) } })]);
    const consumer = `expectType<Same<RouteInput<"/search", "get">, { search: { limit: number; q: string } }>>()`;
    expect(check(app, consumer).diagnostics).toEqual([]);
  });

  // v0: 3c06c03f2d
  it("keys a declared output by media type, then status key", () => {
    const app = httpDoc([route("GET", "/users", { output: json({ ok: object({ id: STRING, name: STRING }) }) })]);
    const consumer = `expectType<Same<RouteOutput<"/users", "get">, { "application/json": { ok: { id: string; name: string } } }>>()`;
    expect(check(app, consumer).diagnostics).toEqual([]);
  });

  // v0: 4a8c25fde6
  it("gives each output status key its own schema type", () => {
    const output = json({ created: object({ id: STRING }), ok: object({ message: STRING }) });

    const consumer = `type O = RouteOutput<"/multi-status", "post">["application/json"]
expectType<Equal<keyof O, "created" | "ok">>()
expectType<Same<O["created"], { id: string }>>()
expectType<Same<O["ok"], { message: string }>>()`;

    expect(check(httpDoc([route("POST", "/multi-status", { output })]), consumer).diagnostics).toEqual([]);
  });
});

describe("vendor and recursive schemas", () => {
  // v0: 7b85e5f7e5
  it("types a search input and a JSON output concretely, never unknown", () => {
    const app = httpDoc([
      route("GET", "/users", {
        input: { search: object({ limit: NUMBER, q: STRING }) },
        output: json({ ok: object({ id: STRING, name: STRING }) }),
      }),
    ]);

    const consumer = `expectType<Same<RouteInput<"/users", "get">["search"], { limit: number; q: string }>>()
expectType<Same<RouteOutput<"/users", "get">["application/json"]["ok"], { id: string; name: string }>>()
expectType<Equal<unknown extends RouteInput<"/users", "get">["search"]["q"] ? true : false, false>>()`;

    expect(check(app, consumer).diagnostics).toEqual([]);
  });

  // v0: 2803d8f745
  it("types an input and an output from different vendors' JSON Schema alike", () => {
    const app = httpDoc([
      route("POST", "/items", {
        input: { json: { $schema: "https://json-schema.org/draft/2020-12/schema", ...object({ name: STRING }) } },
        output: json({ ok: { ...object({ id: STRING }), additionalProperties: false } }),
      }),
    ]);

    const consumer = `expectType<Same<RouteInput<"/items", "post">, { json: { name: string } }>>()
expectType<Same<RouteOutput<"/items", "post">, { "application/json": { ok: { id: string } } }>>()`;

    expect(check(app, consumer).diagnostics).toEqual([]);
  });

  // v0: 9a75eedce5
  it("places an Effect schema's JSON Schema as the json input and the status-keyed output", () => {
    const app = httpDoc([
      route("POST", "/items", {
        input: { json: struct({ name: STRING }) },
        output: json({ ok: struct({ id: STRING }) }),
      }),
    ]);

    const consumer = `expectType<Same<RouteInput<"/items", "post">["json"], { name: string }>>()
expectType<Same<RouteOutput<"/items", "post">["application/json"]["ok"], { id: string }>>()`;

    expect(check(app, consumer).diagnostics).toEqual([]);
  });

  it("types a recursive component recursively, never unknown at depth", () => {
    const ref = { $ref: "#/components/schemas/FilterNode" };

    const FilterNode = object({
      conditions: arrayOf(object({ field: STRING, operator: STRING, value: {} })),
      logic: { enum: ["and", "or"], type: "string" },
      subgroups: arrayOf(ref),
    });

    const app = httpDoc([route("POST", "/items", { input: { json: object({ filter: ref }) } })], { FilterNode });

    const consumer = `type F = RouteInput<"/items", "post">["json"]["filter"]
expectType<Equal<F["logic"], "and" | "or">>()
expectType<Equal<F["subgroups"][number]["subgroups"][number]["logic"], "and" | "or">>()
expectType<Same<F["conditions"][number]["field"], string>>()`;

    expect(check(app, consumer).diagnostics).toEqual([]);
  });
});

/** A route declaring `operationId`, as `.meta({ operationId })` does. */
const named = (method: string, pattern: string, operationId: string, rest: Partial<HttpRoute> = {}): HttpRoute =>
  route(method, pattern, { ...rest, meta: { ...rest.meta, operationId } });

/** The `operationId` slot's entries as emitted: `[id, entry]` in the order the text lists them. */
const slotOf = (text: string) => [...text.matchAll(/^\t\t\t("[^"]+"): (\{ kind: .+ \})$/gm)].map((m) => [m[1], m[2]]);

describe("the operationId slot: HTTP ids", () => {
  it("emits no HttpCodegen augmentation for an app with no operations: core's plain string ids apply", () => {
    const consumer = `import type { OperationCtx, OperationId } from "@workerstack/backend/http"
expectType<Equal<OperationId, string>>()
expectType<Equal<OperationCtx<"anything">, HttpContext>>()`;

    const { diagnostics, text } = check(httpDoc([]), consumer);
    expect({ augmented: text.includes("HttpCodegen"), diagnostics }).toEqual({ augmented: false, diagnostics: [] });
  });

  it("maps each HTTP id, in code-unit order, to its Routes entry's ctx", () => {
    const app = httpDoc([
      named("POST", "/v1/users", "users.create"),
      named("GET", "/v1/users/:id", "users.get", { errors: { not_found: { status: 404 } } }),
      named("GET", "/v1/users", "users.list"),
    ]);

    const consumer = `import type { HttpOperationId, OperationCtx, OperationId } from "@workerstack/backend/http"
expectType<Equal<OperationId, "users.create" | "users.get" | "users.list">>()
expectType<Equal<HttpOperationId, OperationId>>()
expectType<Equal<OperationCtx<"users.get">, Routes["/v1/users/:id"]["get"]["ctx"]>>()
expectType<Same<OperationCtx<"users.get">["params"], { id: string }>>()
expectType<Equal<ReturnType<OperationCtx<"users.get">["errors"]["not_found"]>, HttpError>>()`;

    const { diagnostics, text } = check(app, consumer);
    expect({ diagnostics, slot: slotOf(text) }).toEqual({
      diagnostics: [],
      slot: [
        ['"users.create"', '{ kind: "http"; ctx: Routes["/v1/users"]["post"]["ctx"] }'],
        ['"users.get"', '{ kind: "http"; ctx: Routes["/v1/users/:id"]["get"]["ctx"] }'],
        ['"users.list"', '{ kind: "http"; ctx: Routes["/v1/users"]["get"]["ctx"] }'],
      ],
    });
  });

  it("lists a renamed all() operation once, under its declared id", () => {
    // core writes `echo_get`, `echo_post`, … each declaring `echo`; the fixture gives each method its own name
    const app = httpDoc([route("ALL", "/api/echo", { declaredId: "echo", meta: { operationId: "echo_any" } })]);

    const consumer = `import type { OperationCtx, OperationId } from "@workerstack/backend/http"
expectType<Equal<OperationId, "echo">>()
expectType<Equal<OperationCtx<"echo">["routePattern"], "/api/echo">>()`;

    const { diagnostics, text } = check(app, consumer);
    expect({ diagnostics, slot: slotOf(text) }).toEqual({
      diagnostics: [],
      slot: [['"echo"', '{ kind: "http"; ctx: Routes["/api/echo"]["all"]["ctx"] }']],
    });
  });

  it("types an .on([GET, POST]) id by its first route in code-unit order, GET", () => {
    const app = httpDoc([
      route("POST", "/multi", { declaredId: "multi", meta: { operationId: "multi_post" } }),
      route("GET", "/multi", { declaredId: "multi", meta: { operationId: "multi_get" } }),
    ]);

    const consumer = `import type { OperationCtx, OperationId } from "@workerstack/backend/http"
expectType<Equal<OperationId, "multi">>()
expectType<Equal<OperationCtx<"multi">, Routes["/multi"]["get"]["ctx"]>>()`;

    const { diagnostics, text } = check(app, consumer);
    expect({ diagnostics, slot: slotOf(text) }).toEqual({
      diagnostics: [],
      slot: [['"multi"', '{ kind: "http"; ctx: Routes["/multi"]["get"]["ctx"] }']],
    });
  });
});

describe("the operationId slot: WebSocket ids", () => {
  it("types a WebSocket id as kind ws: BaseCtx with its params, and the upgrade's search, headers and cookies", () => {
    const app = httpDoc([
      named("WS", "/feed/:room", "feed"),
      named("WS", "/rooms/:room/live", "rooms.live", {
        input: {
          cookies: object({ session: STRING }),
          headers: object({ "x-tenant": STRING }),
          search: object({ token: STRING }, []),
        },
      }),
      named("WS", "/ping", "ping"),
    ]);

    const consumer = `import type { HttpOperationId, OperationCtx, OperationId } from "@workerstack/backend/http"
expectType<Equal<OperationId, "feed" | "ping" | "rooms.live">>()
expectType<Equal<HttpOperationId, never>>()
expectType<Same<OperationCtx<"feed">["params"], { room: string }>>()
expectType<Same<OperationCtx<"rooms.live">["input"], { search: { token?: string }; headers: { "x-tenant": string }; cookies: { session: string } }>>()
expectType<Equal<OperationCtx<"ping">, BaseCtx>>()
expectType<Equal<"input" extends keyof OperationCtx<"feed"> ? true : false, false>>()`;

    const { diagnostics, text } = check(app, consumer);
    expect({ diagnostics, slot: slotOf(text) }).toEqual({
      diagnostics: [],
      slot: [
        ['"feed"', '{ kind: "ws"; ctx: BaseCtx & { readonly params: { room: string } } }'],
        ['"ping"', '{ kind: "ws"; ctx: BaseCtx }'],
        [
          '"rooms.live"',
          '{ kind: "ws"; ctx: BaseCtx & { readonly input: { search: { token?: string }; headers: { "x-tenant": string }; cookies: { session: string } }; readonly params: { room: string } } }',
        ],
      ],
    });
  });
});

describe("the operationId slot: the id it keys by and what it leaves out", () => {
  it("keys an operation with no x-backend-declared-id by its operationId", () => {
    const app = httpDoc([named("GET", "/health", "health")]);

    const consumer = `import type { OperationId } from "@workerstack/backend/http"
expectType<Equal<OperationId, "health">>()`;

    const { diagnostics, text } = check(app, consumer);
    expect({ diagnostics, slot: slotOf(text) }).toEqual({
      diagnostics: [],
      slot: [['"health"', '{ kind: "http"; ctx: Routes["/health"]["get"]["ctx"] }']],
    });
  });

  it("leaves an HTTP or WebSocket operation with no x-backend-route out of the slot, reporting each", () => {
    const app = httpDoc([named("GET", "/health", "health"), named("GET", "/x", "x"), named("WS", "/y", "y")]);
    const paths = app.document.paths as Record<string, Record<string, Record<string, unknown>>>;
    delete paths["/x"]?.get?.["x-backend-route"];
    delete paths["/y"]?.get?.["x-backend-route"];

    const consumer = `import type { OperationId } from "@workerstack/backend/http"
expectType<Equal<OperationId, "health">>()`;

    const { diagnostics, reports, text } = check(app, consumer);
    expect({ diagnostics, reports, slot: slotOf(text).map(([id]) => id) }).toEqual({
      diagnostics: [],
      reports: [
        "GET /x: no x-backend-route; left out of Routes",
        "GET /y: no x-backend-route; left out of the operationId slot",
      ],
      slot: ['"health"'],
    });
  });

  it("leaves an internal route out of Routes and the slot", () => {
    const app = httpDoc([
      named("GET", "/v1/users", "users.list"),
      named("GET", "/v1/internal", "internal", { meta: { internal: true } }),
    ]);

    const consumer = `import type { OperationId } from "@workerstack/backend/http"
expectType<Equal<OperationId, "users.list">>()
expectType<Equal<keyof Routes, "/v1/users">>()`;

    expect(check(app, consumer).diagnostics).toEqual([]);
  });

  it("emits no RouteCtx, RouteSelector or TapMap", () => {
    const { text } = check(REAL_WORLD, "", extracted({ middleware: { user: "string" } }));
    expect(/RouteCtx|RouteSelector|TapMap|routeSelector/.test(text)).toBe(false);
  });
});

// the meta of each route as the tree carries it: chain, middleware and route meta resolved (O1)
const META_APP = httpDoc([
  route("GET", "/health", { meta: { summary: "Health check" } }),
  route("GET", "/orgs", {
    input: { search: object({ limit: NUMBER }) },
    meta: {
      auth: "required",
      operationId: "listOrgs",
      rateLimit: "strict",
      summary: "List orgs",
      tags: ["Organization"],
    },
  }),
  route("POST", "/orgs", {
    input: { json: object({ name: STRING }) },
    meta: { auth: "required", deprecated: true, security: [{ bearerAuth: [] }], summary: "Create org" },
  }),
]);

describe("route meta", () => {
  // v0: 1bd65834a7
  it("types each route's full meta, custom keys and OpenAPI keys alike, as literals", () => {
    const consumer = `expectType<Equal<RouteMeta<"/health", "get">, { summary: "Health check" }>>()
expectType<Equal<RouteMeta<"/orgs", "get">, { auth: "required"; operationId: "listOrgs"; rateLimit: "strict"; summary: "List orgs"; tags: ["Organization"] }>>()
expectType<Equal<RouteMeta<"/orgs", "post">, { auth: "required"; deprecated: true; security: [{ bearerAuth: [] }]; summary: "Create org" }>>()`;

    expect(check(META_APP, consumer).diagnostics).toEqual([]);
  });
});
