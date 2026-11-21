/**
 * The emitted adapter compiles in a consumer's project (bit 22, leaf 5.2). An emitted file lands in the
 * consumer's own tree and inherits their compiler flags, so the flag set here is the one
 * `tests/e2e/strict-consumer/tsconfig.json` uses — every strictness flag we could plausibly meet.
 *
 * It writes under `.tmp/`, inside the repository and gitignored, NOT under
 * `~/.cache/backend-tmp` like the behavior fixture: `@tanstack/query-core` is a devDependency of this package,
 * so only a project inside the workspace resolves it, and a type-only import that silently failed to
 * resolve would make this leg prove nothing. The leg asserts it resolved.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts";
import type { OpenApiDocument } from "../../ir/build.ts";
import { generateSdk } from "./sdk.ts";

const GEN = resolve(import.meta.dirname, "../../..");

const STRICT = {
  compilerOptions: {
    exactOptionalPropertyTypes: true,
    module: "ESNext",
    moduleResolution: "bundler",
    noEmit: true,
    noFallthroughCasesInSwitch: true,
    noImplicitOverride: true,
    noImplicitReturns: true,
    noPropertyAccessFromIndexSignature: true,
    noUncheckedIndexedAccess: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    skipLibCheck: true,
    strict: true,
    target: "ESNext",
    types: [],
    verbatimModuleSyntax: true,
  },
  include: ["./**/*.ts"],
};

const json = () => ({ content: { "application/json": { schema: { type: "object" } } }, description: "" });
const param = (name: string) => ({ in: "path", name, required: true, schema: { type: "string" } });

const document = {
  info: { title: "Shop", version: "1" },
  openapi: "3.1.0",
  paths: {
    "/orgs": {
      get: { operationId: "org.list", responses: { 200: json() } },
      post: { operationId: "org.create", responses: { 201: json() }, "x-invalidate": ["GET /orgs"] },
    },
    "/orgs/{org_id}": {
      get: { operationId: "org.get", parameters: [param("org_id")], responses: { 200: json() } },
      patch: {
        operationId: "org.update",
        parameters: [param("org_id")],
        responses: { 200: json() },
        "x-invalidate": ["GET /orgs", "GET /orgs/{org_id}"],
      },
    },
    "/orgs/{org_id}/members": {
      get: {
        operationId: "org.member.list",
        parameters: [param("org_id"), { in: "query", name: "limit", schema: { type: "integer" } }],
        responses: { 200: json() },
      },
    },
  },
} as unknown as OpenApiDocument;

// a consumer's own module: the call shapes an app uses, each spread into query-core's own observer as solid-query's
// hooks spread it, so the options a spread infers are the options TanStack sees; the Equal lines pin what it infers
const consumer = `import {
	type InfiniteData,
	InfiniteQueryObserver,
	MutationObserver,
	QueryClient,
	QueryObserver,
} from "@tanstack/query-core"
import { Shop } from "./shop.client.gen"
import { createQueryHelpers, invalidateQueries } from "./shop.tanstack-query.gen"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Org = Awaited<ReturnType<Shop["org"]["get"]>>
type Members = Awaited<ReturnType<Shop["org"]["member"]["list"]>>
type Update = Parameters<Shop["org"]["update"]>[0]

const queryClient = new QueryClient()
const sdk = new Shop({ baseURL: "https://example.test", onInvalidate: [invalidateQueries(queryClient)] })
const { infiniteQuery, mutation, query, queryKey } = createQueryHelpers(() => sdk)

export const list = new QueryObserver(queryClient, query.org.list())
export const one = new QueryObserver(queryClient, { ...query.org.get({ params: { org_id: "o1" } }), staleTime: 0 })
export const oneData: Equal<ReturnType<typeof one.getCurrentResult>["data"], Org | undefined> = true
export const timed = query.org.get({ params: { org_id: "o1" } }, { timeout: 5_000 })
export const page = query.org.member.list({ params: { org_id: "o1" }, search: { limit: 20 } })
export const prefetched = queryClient.prefetchQuery(query.org.get({ params: { org_id: "o1" } }))
const cached = queryClient.getQueryData(queryKey.org.get({ params: { org_id: "o1" } }))
export const cachedData: Equal<typeof cached, Org | undefined> = true
export const pageKey = queryKey.org.member.list({ params: { org_id: "o1" }, search: { limit: 20 } })

export const update = new MutationObserver(queryClient, {
	...mutation.org.update(),
	onMutate: (variables) => {
		const exact: Equal<typeof variables, Update> = true
		return exact
	},
})
export const updated = update.mutate({ params: { org_id: "o1" } })
export const create = mutation.org.create()

export const members = new InfiniteQueryObserver(queryClient, {
	...infiniteQuery.org.member.list((limit: number | undefined) => ({ params: { org_id: "o1" }, search: { limit } })),
	getNextPageParam: (_last, _all, lastPageParam) => {
		const exact: Equal<typeof lastPageParam, number | undefined> = true
		return exact ? (lastPageParam ?? 0) + 20 : undefined
	},
	initialPageParam: undefined,
})
export const membersData: Equal<
	ReturnType<typeof members.getCurrentResult>["data"],
	InfiniteData<Members, number | undefined> | undefined
> = true
`;

/** The project written out, and what `tsc` says about it: `""` when it is clean. */
function checked(extra: string): { diagnostics: string; dir: string } {
  const dir = join(GEN, ".tmp/tanstack-query-typecheck");
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(dir, { recursive: true });

  const { files } = generateSdk(document, {
    name: "Shop",
    stem: "shop",
    tanstackQuery: true,
  });

  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, "consumer.ts"), `${consumer}${extra}`);
  writeFileSync(join(dir, "tsconfig.json"), `${JSON.stringify(STRICT, null, "\t")}\n`);
  const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");

  try {
    execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], { encoding: "utf8" });

    return { diagnostics: "", dir };
  } catch (error) {
    return { diagnostics: String((error as { stdout?: string }).stdout ?? error), dir };
  }
}

describe("the emitted adapter compiles in a consumer's project (bit 22, G-strict)", () => {
  it("type-checks under every strictness flag, with query-core resolved", { timeout: SPAWN_TIMEOUT }, () => {
    const { diagnostics, dir } = checked("");
    // the import must really resolve: a missing package would otherwise read as a clean run
    const resolved = createRequire(join(dir, "consumer.ts")).resolve("@tanstack/query-core/package.json");
    expect(resolved).toContain("@tanstack/query-core");
    expect(diagnostics).toBe("");
  });
});

/** What `tsc` says once the consumer also exports `statement`. */
function refused(statement: string): string {
  return checked(`\nexport const bad = ${statement}\n`).diagnostics;
}

const NESTED = 'query.org.get({ reqOptions: { req: { params: { org_id: "o1" } } } })';

const OFF_ANNOTATION =
  "new InfiniteQueryObserver(queryClient, { " +
  '...infiniteQuery.org.member.list((n: number) => ({ params: { org_id: "o1" }, search: { limit: n } })), ' +
  'getNextPageParam: () => 1, initialPageParam: "a" })';

describe("the emitted adapter's types refuse what the service map and the SDK do not take", () => {
  // a clean run proves nothing unless a wrong call is refused, so each mutant must red
  it(
    "is not a hollow check: the surfaces refuse what the service map says they are not",
    { timeout: SPAWN_TIMEOUT },
    () => {
      expect(refused("query.org.create()")).toContain("Property 'create' does not exist");
      expect(refused("mutation.org.list()")).toContain("Property 'list' does not exist");
      expect(refused("query.org.get()")).toContain("but got 0");
    },
  );

  it(
    "refuses the old nested input, a wrong mutate and a page param off its annotation",
    { timeout: SPAWN_TIMEOUT },
    () => {
      expect(refused(NESTED)).toContain("'reqOptions' does not exist in type");
      expect(refused("update.mutate({ params: {} })")).toContain("Property 'org_id' is missing");
      expect(refused(OFF_ANNOTATION)).toContain("Type 'string' is not assignable to type 'number'");
    },
  );
});
