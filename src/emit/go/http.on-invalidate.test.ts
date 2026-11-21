/**
 * `OnInvalidate` on the Go SDK (plan 2's cases 1.3-1.4, in Go's terms): a client's config hooks, called once per
 * successful write with the reads it made stale, as operationIds with the write's params as the call took them
 * (strings); which answers call them. One consumer program over the recording transport, one section per case
 * (http.on-invalidate.hooks.test.ts holds streams, sockets, the auth retry and the hooks' own errors).
 */
import { describe, expect, it } from "vitest";

import { consume, type Run } from "./__fixtures__/consumer.ts";
import { clean, CREATED, invalidating, noted, sent, UPDATED } from "./__fixtures__/on-invalidate.ts";
import { generateGoSdk } from "./sdk.ts";

/** A write naming a route no read answers and a non-GET route, beside the read it does make stale. */
const UNRESOLVED = {
  info: { title: "unresolved", version: "1" },
  openapi: "3.1.0",
  paths: {
    "/users": { get: { operationId: "users.list", responses: { 200: { description: "ok" } } } },
    "/users/{id}": {
      put: {
        operationId: "users.update",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "ok" } },
        "x-invalidate": ["GET /nowhere", "POST /users", "GET /users"],
      },
    },
  },
};

/** Every case's section, on one client without an invalidation config unless the section says otherwise. */
const BODY = `	body := map[string]interface{}{}
	c := recorded(sdk.Config{})
	section("renamed")
	must(c.Safe_.Save(ctx, "7", "a/b.txt", body, nil))
	section("partial")
	must(c.Orgs.Update(ctx, "acme", body, nil))
	section("string")
	must(c.Users.Update(ctx, "42", body, nil))
	failures := []struct {
		name   string
		answer reply
	}{
		{"4xx", reply{status: 404, body: \`{"error":"missing"}\`}},
		{"5xx", reply{status: 500, body: \`{"error":"fail"}\`}},
	}
	for _, failure := range failures {
		section(failure.name)
		replies["PATCH /users/42"] = failure.answer
		_, err := c.Users.Update(ctx, "42", body, nil)
		note("failed", err != nil)
		delete(replies, "PATCH /users/42")
		must(c.Users.Create(ctx, body, nil))
	}
	section("network")
	refused := recorded(sdk.Config{BaseURL: "http://127.0.0.1:1", HTTPClient: &http.Client{}})
	_, err := refused.Users.Update(ctx, "42", body, nil)
	note("failed", err != nil)
	must(c.Users.Create(ctx, body, nil))
	section("get")
	must(c.Users.List(ctx, nil))
	must(c.Users.Create(ctx, body, nil))
	section("get-invalidating")
	must(c.Feed.Refresh(ctx, nil))
	must(c.Users.Create(ctx, body, nil))
	section("undecodable")
	replies["PATCH /users/42"] = reply{status: 200, body: "{not json"}
	_, err = c.Users.Update(ctx, "42", body, nil)
	var decode *sdk.DecodeError
	note("decode", errors.As(err, &decode))
	delete(replies, "PATCH /users/42")
	section("empty")
	replies["PUT /users/42/avatar"] = reply{status: 204}
	note("avatar", c.Users.Avatar(ctx, "42", body, nil))
	section("invalidation")
	must(recorded(sdk.Config{Invalidation: &sdk.InvalidationConfig{StaleTime: 5000}}).Users.Update(ctx, "42", body, nil))`;

let memo: Promise<Run> | undefined;

/** BODY's run, once. */
function outcomes(): Promise<Run> {
  memo ??= consume(...invalidating(BODY));

  return memo;
}

/** The notes of `section`, less its request lines, with the run's build and vet. */
async function section(name: string) {
  const run = await outcomes();
  expect(run.built, run.stderr).toBe(true);

  return noted(run, name);
}

describe("OnInvalidate: a 2xx write calls the hooks once with the reads it made stale", () => {
  it("names the write by operationId, not its renamed member; fills `:id`, `*rest` and `:id?` targets", async () => {
    expect(await section("renamed")).toStrictEqual(
      clean([
        "invalidated safe.save | items.get map[id:7] | files.get map[rest:a/b.txt] | " +
          "docs.list map[] | docs.get map[id:7]",
      ]),
    );
  }, 600_000);

  it("omits a target param the write does not know", async () => {
    expect(await section("partial")).toStrictEqual(clean(["invalidated orgs.update | members.get map[org:acme]"]));
  }, 600_000);

  it("gives an integer param as the string the call took", async () => {
    expect(await section("string")).toStrictEqual(clean([UPDATED]));
  }, 600_000);
});

describe("OnInvalidate: a write that failed calls no hook", () => {
  it.each([["4xx"], ["5xx"], ["network"]] as const)(
    "calls nothing for a %s failure, then once for the next 2xx write",
    async (name) => {
      expect(await section(name)).toStrictEqual(clean(["failed true", CREATED]));
    },
    600_000,
  );

  it.each([["get"], ["get-invalidating"]] as const)(
    "calls nothing for a %s read",
    async (name) => {
      const run = await outcomes();
      expect([sent(run, name), await section(name)]).toStrictEqual([2, clean([CREATED])]);
    },
    600_000,
  );
});

describe("OnInvalidate: a 2xx write calls them whatever its body", () => {
  it("calls them for a 2xx whose body does not decode, the call's error a *DecodeError", async () => {
    expect(await section("undecodable")).toStrictEqual(clean([UPDATED, "decode true"]));
  }, 600_000);

  it("calls them for a 2xx with no body", async () => {
    expect(await section("empty")).toStrictEqual(
      clean(["invalidated users.avatar | users.get map[id:42]", "avatar <nil>"]),
    );
  }, 600_000);

  it.each([
    ["without", "string"],
    ["with", "invalidation"],
  ] as const)(
    "calls them %s an invalidation config",
    async (_label, name) => {
      expect(await section(name)).toStrictEqual(clean([UPDATED]));
    },
    600_000,
  );
});

describe("OnInvalidate: a selector that names no read", () => {
  it("is a go: notice of the generation, the selector skipped and the write's other reads kept", () => {
    const { files, notices } = generateGoSdk(UNRESOLVED);
    expect([notices, files["client.go"]?.includes('reads: []staleRead{{"users.list", []string{}}}')]).toStrictEqual([
      [
        'go: users.update: x-invalidate "GET /nowhere" matches no GET read; skipped',
        'go: users.update: x-invalidate "POST /users" names a POST route; only GET reads are cached; skipped',
      ],
      true,
    ]);
  });
});
