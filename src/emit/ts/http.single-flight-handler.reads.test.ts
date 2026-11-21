/**
 * The single-flight handler's reads: sent in parallel with `Cache-Control: no-cache`, each cut at `readBudgetMs`,
 * their streams counted against `maxReadBytes` before decoding; a cut or failed read is an error entry that never
 * carries an upstream message or URL.
 */
import { describe, expect, it } from "vitest";

import {
  bigJson,
  broken,
  entryAt,
  envelopeFrom,
  failed,
  meeting,
  missing,
  never,
  outcomes,
  post,
} from "./__fixtures__/single-flight-wire.ts";
import { batch, flightOf, read, type Routes, UPDATE } from "./__fixtures__/single-flight.ts";

const BUDGET_MS = 100;

/** The envelope the handler answers for UPDATE then `reads`, over `routes` with `options`. */
async function envelopeOf(routes: Routes, reads: object[], options = {}) {
  const flight = await flightOf(routes, options);
  const response = await flight.handle(post(batch(UPDATE.op, UPDATE.input, reads)));

  return { calls: flight.calls, envelope: await envelopeFrom(response) };
}

describe("singleFlightHandler: how reads are sent", () => {
  it("sends each read with Cache-Control: no-cache", async () => {
    const { calls } = await envelopeOf({}, [read("a", "users.list"), read("b", "users.get", { params: { id: 1 } })]);
    const reads = calls.filter((call) => call.method === "GET");
    expect(reads.map((call) => call.headers.get("cache-control"))).toStrictEqual(["no-cache", "no-cache"]);
  });

  it("sends the reads in parallel: each answers only once the other was sent", async () => {
    const reads = [read("a", "users.list"), read("b", "users.get", { params: { id: 1 } })];
    const { envelope } = await envelopeOf(meeting("GET /users", "GET /users/1"), reads, { readBudgetMs: 1000 });
    expect(envelope.reads).toStrictEqual([
      { data: { path: "/users" }, id: "a" },
      { data: { path: "/users/1" }, id: "b" },
    ]);
  });
});

describe("singleFlightHandler: a read's time budget", () => {
  it("cuts a slow read at readBudgetMs into an error entry, keeping the others", async () => {
    const started = performance.now();
    const reads = [read("slow", "users.list"), read("fast", "users.get", { params: { id: 1 } })];
    const { envelope } = await envelopeOf({ "GET /users": never }, reads, { readBudgetMs: BUDGET_MS });
    const fast = entryAt(envelope, 1);
    expect([outcomes(envelope), fast.data, performance.now() - started < 10 * BUDGET_MS]).toStrictEqual([
      ["slow: error(status)", "fast: data"],
      { path: "/users/1" },
      true,
    ]);
  });

  it("aborts the slow read's request", async () => {
    const { calls } = await envelopeOf({ "GET /users": never }, [read("slow", "users.list")], {
      readBudgetMs: BUDGET_MS,
    });

    expect(calls.find((call) => call.method === "GET")?.signal.aborted).toBe(true);
  });
});

describe("singleFlightHandler: the reads' byte budget", () => {
  it("cuts a read partway through its body into an error entry, having read no more than the budget", async () => {
    const pulled = { bytes: 0 };
    const routes = { "GET /users": () => bigJson(256 * 1024, pulled) };
    const { envelope } = await envelopeOf(routes, [read("big", "users.list")], { maxReadBytes: 4096 });
    const entry = entryAt(envelope, 0);
    expect([
      Object.hasOwn(entry, "data"),
      entry.id,
      JSON.stringify(entry).length <= 4096,
      pulled.bytes < 64 * 1024,
    ]).toStrictEqual([false, "big", true, true]);
  });

  it("counts every read against one total", async () => {
    const routes = {
      "GET /users": () => bigJson(3072, { bytes: 0 }),
      "GET /users/1": () => bigJson(3072, { bytes: 0 }),
    };

    const reads = [read("a", "users.list"), read("b", "users.get", { params: { id: 1 } })];
    const { envelope } = await envelopeOf(routes, reads, { maxReadBytes: 4096 });
    expect(envelope.reads.some((entry) => entry.error !== undefined)).toBe(true);
  });

  it("takes a read under the budget", async () => {
    const routes = { "GET /users": () => bigJson(2048, { bytes: 0 }) };
    const { envelope } = await envelopeOf(routes, [read("a", "users.list")], { maxReadBytes: 4096 });
    expect(envelope.reads).toStrictEqual([{ data: "x".repeat(2046), id: "a" }]);
  });
});

describe("singleFlightHandler: a failed read", () => {
  it("is an error entry with the upstream status and body", async () => {
    const { envelope } = await envelopeOf({ "GET /users": missing }, [read("a", "users.list")]);
    expect(envelope.reads).toStrictEqual([{ error: { body: { error: "missing" }, status: 404 }, id: "a" }]);
  });

  it("names no upstream URL or message when the network fails", async () => {
    const { envelope } = await envelopeOf({ "GET /users": failed }, [read("a", "users.list")]);
    const text = JSON.stringify(envelope);
    const leaks = ["api.test", "fetch failed", "secret"].filter((leak) => text.includes(leak));
    expect([outcomes(envelope), leaks]).toStrictEqual([["a: error(status)"], []]);
  });

  it("names no upstream URL when a read's answer does not decode", async () => {
    const { envelope } = await envelopeOf({ "GET /users": broken }, [read("a", "users.list")]);
    expect([Object.hasOwn(entryAt(envelope, 0), "data"), JSON.stringify(envelope).includes("api.test")]).toStrictEqual([
      false,
      false,
    ]);
  });
});
