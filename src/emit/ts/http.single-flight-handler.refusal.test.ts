/**
 * The single-flight handler refuses a batch the service map does not allow, before anything runs: each case answers
 * the one 400 problem and the fake API sees no request. The HTTP checks are in http.single-flight-handler.http.test.ts.
 */
import { describe, expect, it } from "vitest";

import { post, problemOf, type Sent } from "./__fixtures__/single-flight-wire.ts";
import { batch, flightOf, read, REFUSAL, UPDATE } from "./__fixtures__/single-flight.ts";

const ONE = read("one", "users.get", { params: { id: 42 } });

/** The handler's answer to `body` and how many requests reached the fake API. */
async function refusedOf(body: Sent, maxReads?: number) {
  const { calls, handle } = await flightOf({}, maxReads === undefined ? {} : { maxReads });
  const problem = await problemOf(await handle(post(body)));

  return [problem, calls.length];
}

describe("singleFlightHandler: a batch that is no batch", () => {
  it.each([
    ["a body that is not JSON", "{not json"],
    ["a version other than 1", { ...batch(UPDATE.op, UPDATE.input), v: 2 }],
    ["a body with no version", { input: UPDATE.input, op: UPDATE.op, reads: [] }],
    ["reads that are not a list", { ...batch(UPDATE.op, UPDATE.input), reads: {} }],
  ])("refuses %s", async (_label, body) => {
    expect(await refusedOf(body)).toStrictEqual([REFUSAL, 0]);
  });
});

describe("singleFlightHandler: a write the map does not allow", () => {
  it.each([
    ["an unknown op", "users.delete", {}],
    ["an inherited key as op", "constructor", {}],
    ["a GET", "users.get", { params: { id: 42 } }],
    ["a GET that declares x-invalidate", "feed.refresh", {}],
    ["an event-stream write", "feed.publish", { json: {} }],
    ["a WebSocket", "rooms.live", { params: { room: "r" } }],
  ])("refuses %s", async (_label, op, input) => {
    expect(await refusedOf(batch(op, input, [ONE]))).toStrictEqual([REFUSAL, 0]);
  });
});

describe("singleFlightHandler: a read the map does not allow", () => {
  it.each([
    ["an unknown operationId", read("x", "users.find")],
    ["a write", read("x", "users.update", { params: { id: 42 } })],
    ["an event stream", read("x", "feed.live")],
    ["a non-JSON answer (accept)", read("x", "reports.get", { params: { id: 1 } })],
    ["an answer with no body (empty)", read("x", "ping")],
    ["a read with no id", { input: {}, operationId: "users.list" }],
  ])("refuses %s", async (_label, entry) => {
    expect(await refusedOf(batch(UPDATE.op, UPDATE.input, [ONE, entry]))).toStrictEqual([REFUSAL, 0]);
  });

  it("refuses more reads than maxReads", async () => {
    const reads = [read("a", "users.list"), read("b", "users.list"), read("c", "users.list")];
    expect(await refusedOf(batch(UPDATE.op, UPDATE.input, reads), 2)).toStrictEqual([REFUSAL, 0]);
  });

  it("takes exactly maxReads reads", async () => {
    const { calls, handle } = await flightOf({}, { maxReads: 2 });
    const response = await handle(post(batch(UPDATE.op, UPDATE.input, [read("a", "users.list"), ONE])));
    expect([response.status, calls.length]).toStrictEqual([200, 3]);
  });
});

describe("singleFlightHandler: an input the entry does not allow", () => {
  it.each([
    ["headers on the write", batch(UPDATE.op, { ...UPDATE.input, headers: { authorization: "x" } })],
    ["raw on the write", batch(UPDATE.op, { ...UPDATE.input, raw: true })],
    ["signal on the write", batch(UPDATE.op, { ...UPDATE.input, signal: {} })],
    ["headers on a read", batch(UPDATE.op, UPDATE.input, [read("x", "users.list", { headers: { cookie: "c" } })])],
    ["json on a read", batch(UPDATE.op, UPDATE.input, [read("x", "users.list", { json: {} })])],
    ["an idempotencyKey on a write that is not idempotent", batch(UPDATE.op, { ...UPDATE.input, idempotencyKey: "k" })],
    ["a param the write does not declare", batch(UPDATE.op, { ...UPDATE.input, params: { id: 42, org: "o" } })],
    [
      "a param a read does not declare",
      batch(UPDATE.op, UPDATE.input, [read("x", "users.list", { params: { id: 1 } })]),
    ],
    ["a boolean param", batch(UPDATE.op, { ...UPDATE.input, params: { id: true } })],
    ["an object param", batch(UPDATE.op, { ...UPDATE.input, params: { id: { toString: "42" } } })],
    ["a null param", batch(UPDATE.op, UPDATE.input, [read("x", "users.get", { params: { id: null } })])],
    ["an input that is not an object", batch(UPDATE.op, "json")],
  ])("refuses %s", async (_label, body) => {
    expect(await refusedOf(body)).toStrictEqual([REFUSAL, 0]);
  });

  it("takes params as strings or numbers, and search on a read", async () => {
    const { calls, handle } = await flightOf();
    const reads = [read("a", "users.get", { params: { id: "7" } }), read("b", "users.list", { search: { limit: 1 } })];
    const response = await handle(post(batch(UPDATE.op, UPDATE.input, reads)));
    expect([response.status, calls.length]).toStrictEqual([200, 3]);
  });
});
