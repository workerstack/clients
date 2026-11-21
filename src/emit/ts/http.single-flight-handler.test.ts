/**
 * The single-flight handler `--ts-single-flight` emits alone: one known write, then the caller's reads, in one JSON
 * envelope. Driven on the emitted `<stem>.single-flight.gen.ts` over a fake API that records each request
 * (refusals: http.single-flight-handler.refusal.test.ts and .http.test.ts; reads' budgets: .reads.test.ts).
 */
import { describe, expect, it } from "vitest";

import { conflict, envelopeFrom, failed, post, problemOf } from "./__fixtures__/single-flight-wire.ts";
import { batch, DOCUMENT, flightOf, read, UPDATE } from "./__fixtures__/single-flight.ts";
import { generateSdk } from "./sdk.ts";

const USER = { id: 42, name: "b" };

/** The write answers `USER` with a declared and an undeclared header and two cookies. */
function updated(): Response {
  const headers = new Headers({ "content-type": "application/json", "x-request-id": "r1", "x-secret": "s" });
  headers.append("set-cookie", "a=1; Path=/");
  headers.append("set-cookie", "b=2; Path=/");

  return new Response(JSON.stringify(USER), { headers });
}

const ROUTES = { "PATCH /users/42": updated };

const ONE = read("one", "users.get", { params: { id: 42 } });

const READS = [ONE, read("all", "users.list", { search: { limit: 5 } })];

describe("singleFlightHandler: a write, then its reads, in one answer", () => {
  it("answers the write's status, declared headers and body, then each read's data in order", async () => {
    const { handle } = await flightOf(ROUTES);
    const response = await handle(post(batch(UPDATE.op, UPDATE.input, READS)));
    expect(await envelopeFrom(response)).toStrictEqual({
      reads: [
        { data: { path: "/users/42" }, id: "one" },
        { data: { path: "/users" }, id: "all" },
      ],
      v: 1,
      write: { body: USER, headers: { "content-type": "application/json", "x-request-id": "r1" }, status: 200 },
    });
  });

  it("sends the write first, then each read with its params and search", async () => {
    const { calls, handle } = await flightOf(ROUTES);
    await handle(post(batch(UPDATE.op, UPDATE.input, READS)));
    const sent = calls.map((call) => `${call.method} ${call.url}`);
    expect([sent[0], sent.slice(1).toSorted()]).toStrictEqual([
      "PATCH https://api.test/users/42",
      ["GET https://api.test/users/42", "GET https://api.test/users?limit=5"],
    ]);
  });
});

describe("singleFlightHandler: the answer's own headers", () => {
  it("answers 200 as JSON with Cache-Control: no-store", async () => {
    const { handle } = await flightOf(ROUTES);
    const response = await handle(post(batch(UPDATE.op, UPDATE.input, READS)));
    const headers = response.headers;
    expect([response.status, headers.get("content-type"), headers.get("cache-control")]).toStrictEqual([
      200,
      "application/json",
      "no-store",
    ]);
  });

  it("copies the write's Set-Cookie headers onto the answer apart, never joined", async () => {
    const { handle } = await flightOf(ROUTES);
    const response = await handle(post(batch(UPDATE.op, UPDATE.input)));
    expect(response.headers.getSetCookie()).toStrictEqual(["a=1; Path=/", "b=2; Path=/"]);
  });
});

describe("singleFlightHandler: the write runs once with the caller's Idempotency-Key", () => {
  it("sends the given key once on an idempotent write", async () => {
    const { calls, handle } = await flightOf();
    const input = { idempotencyKey: "k-1", json: { name: "c" } };
    const response = await handle(post(batch("users.create", input, [read("all", "users.list")])));
    const writes = calls.filter((call) => call.method === "POST");
    expect([response.status, writes.map((call) => call.headers.get("idempotency-key"))]).toStrictEqual([200, ["k-1"]]);
  });

  it("answers a 201 write's status and body", async () => {
    const { handle } = await flightOf();
    const response = await handle(post(batch("users.create", { idempotencyKey: "k-1", json: { name: "c" } })));
    const { write } = await envelopeFrom(response);
    expect([write.status, write.body]).toStrictEqual([201, { got: { name: "c" }, path: "/users" }]);
  });
});

describe("singleFlightHandler: a write that fails runs no reads", () => {
  it("answers a 409 write's status and body, and sends no read", async () => {
    const { calls, handle } = await flightOf({ "PATCH /users/42": conflict });
    const response = await handle(post(batch(UPDATE.op, UPDATE.input, READS)));
    expect([response.status, await envelopeFrom(response), calls.length]).toStrictEqual([
      200,
      {
        reads: [],
        v: 1,
        write: { body: { error: "taken" }, headers: { "content-type": "application/json" }, status: 409 },
      },
      1,
    ]);
  });
});

describe("singleFlightHandler: a write that got no answer", () => {
  it("answers the 502 problem, naming no upstream detail, and sends no read", async () => {
    const { calls, handle } = await flightOf({ "PATCH /users/42": failed });
    const response = await handle(post(batch(UPDATE.op, UPDATE.input, READS)));
    const text = await response.clone().text();
    expect([await problemOf(response), text.includes("secret-host"), calls.map((call) => call.method)]).toStrictEqual([
      { contentType: "application/problem+json", status: 502, type: "urn:workerstack:single-flight:unanswered" },
      false,
      ["PATCH"],
    ]);
  });
});

describe("runSingleFlight: the same run with no Request or Response", () => {
  it("returns the envelope the handler answers", async () => {
    const { calls, run } = await flightOf(ROUTES);
    const envelope = await run(batch(UPDATE.op, UPDATE.input, [ONE]));
    expect([envelope, calls.length]).toStrictEqual([
      {
        reads: [{ data: { path: "/users/42" }, id: "one" }],
        v: 1,
        write: { body: USER, headers: { "content-type": "application/json", "x-request-id": "r1" }, status: 200 },
      },
      2,
    ]);
  });

  it("is a file of its own: the index never re-exports it", () => {
    const { files } = generateSdk(DOCUMENT, { name: "TestSDK", singleFlight: true });
    expect([Object.hasOwn(files, "test-sdk.single-flight.gen.ts"), files["test-sdk.index.gen.ts"]]).toStrictEqual([
      true,
      expect.not.stringContaining("single-flight"),
    ]);
  });
});
