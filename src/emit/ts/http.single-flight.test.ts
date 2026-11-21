/**
 * The single-flight caller: with `singleFlight` set, an eligible write goes to the handler with the reads its `select`
 * picks, in one request, and every other call goes direct. Driven on the emitted client over an app whose
 * `/api/_mutate` is the emitted handler (failures, auth and fresh reads: http.single-flight.failures.test.ts).
 */
import { describe, expect, it } from "vitest";

import {
  type Batch,
  batchAt,
  type CallInput,
  type Data,
  everyRead,
  flightOf,
  MUTATE,
  type Sdk,
  sent,
  type SingleFlight,
  stream,
} from "./__fixtures__/single-flight-caller.ts";

const USER_42 = { params: { id: 42 } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("singleFlight: an eligible write goes to the handler once, with its reads", () => {
  it("posts one batch of the write and the selected reads, and resolves with the write's answer", async () => {
    const { api, app, sdk } = await flightOf();
    const data = await sdk.users.update({ json: { name: "Ada" }, ...USER_42 });
    expect([data, sent(app), sent(api).slice(0, 1), sent(api).slice(1).toSorted()]).toStrictEqual([
      { got: '{"name":"Ada"}', path: "/users/42" },
      [`POST ${MUTATE}`],
      ["PATCH /users/42"],
      ["GET /users", "GET /users/42"],
    ]);
    expect(await batchAt(app)).toStrictEqual({
      input: { json: { name: "Ada" }, ...USER_42 },
      op: "users.update",
      reads: [
        { id: "r0", input: USER_42, operationId: "users.get" },
        { id: "r1", input: { params: {} }, operationId: "users.list" },
      ],
      v: 1,
    });
  });
});

describe("singleFlight: the batch's reads and path follow the config", () => {
  it("brings back no more than maxReads", async () => {
    const { app, sdk } = await flightOf({ config: { singleFlight: { maxReads: 1, select: everyRead } } });
    await sdk.users.update({ json: {}, ...USER_42 });
    const { reads } = await batchAt(app);
    expect(reads.length).toBe(1);
  });

  it("posts to its own path under the base URL", async () => {
    const { app, sdk } = await flightOf({ config: { singleFlight: { path: "flight", select: everyRead } } });
    await sdk.users.update({ json: {}, ...USER_42 }).catch(() => undefined);
    expect(sent(app)[0]).toBe("POST /api/flight");
  });
});

describe("singleFlight: an idempotent write's key is made before the batch", () => {
  it("makes the key itself, in the batch, and the API gets that key", async () => {
    const { api, app, sdk } = await flightOf();
    await sdk.users.create({ json: {} });
    const { input } = await batchAt(app);
    expect([UUID.test(input.idempotencyKey ?? ""), api[0]?.headers.get("idempotency-key")]).toStrictEqual([
      true,
      input.idempotencyKey,
    ]);
  });

  it("sends the caller's own idempotencyKey in the batch", async () => {
    const { app, sdk } = await flightOf();
    await sdk.users.create({ idempotencyKey: "k1", json: {} });
    const { input } = await batchAt(app);
    expect(input).toStrictEqual({ idempotencyKey: "k1", json: {} });
  });

  it("leaves a key out of a write that is not idempotent", async () => {
    const { app, sdk } = await flightOf();
    await sdk.users.update({ idempotencyKey: "k1", json: {}, ...USER_42 });
    const { input } = await batchAt(app);
    expect(input).toStrictEqual({ json: {}, ...USER_42 });
  });
});

describe("singleFlight: the batch is a request of the client's", () => {
  it("runs the client's request and response hooks on the batch", async () => {
    const seen: string[] = [];
    const onRequest = [(ctx: { method: string; path: string }) => void seen.push(`${ctx.method} ${ctx.path}`)];
    const onResponse = [(ctx: { response: Response }) => void seen.push(String(ctx.response.status))];
    const { sdk } = await flightOf({ config: { onRequest, onResponse } });
    await sdk.users.update({ json: {}, ...USER_42 });
    expect(seen).toStrictEqual(["POST _mutate", "200"]);
  });

  it("hands a custom send the batch and reads the envelope it resolves, posting nothing", async () => {
    const batches: Batch[] = [];
    const flight = await flightOf();

    function send(batch: Batch): Promise<object> {
      batches.push(batch);

      return flight.run(batch);
    }

    const { app, events, sdk } = await flightOf({ config: { singleFlight: { select: everyRead, send } } });
    const data = await sdk.users.update({ json: {}, ...USER_42 });
    expect([data, app.length, batches.length, events[0]?.fresh?.data.size]).toStrictEqual([
      { got: "{}", path: "/users/42" },
      0,
      1,
      2,
    ]);
  });
});

/** A call that goes direct: what it is, how the case makes it, and the single-flight config it is made under. */
type Direct = { call: (sdk: Sdk) => Promise<Data>; label: string; singleFlight?: SingleFlight };

/** `users.update` 42 called with `input` over its JSON body. */
function update(input: CallInput = {}): (sdk: Sdk) => Promise<Data> {
  return (sdk: Sdk) => sdk.users.update({ json: {}, ...USER_42, ...input });
}

const DIRECT: readonly Direct[] = [
  {
    call: update(),
    label: "a write whose operationId is excluded",
    singleFlight: { exclude: ["users.update"], select: everyRead },
  },
  { call: update({ singleFlight: false }), label: "a call with singleFlight: false" },
  { call: update({ headers: { "x-a": "1" } }), label: "a call with headers" },
  { call: update({ cookies: { a: "1" } }), label: "a call with cookies" },
  { call: update({ raw: true }), label: "a raw call" },
  { call: update({ baseURL: "https://app.test/api" }), label: "a call with its own baseURL" },
  { call: (sdk) => sdk.users.update({ body: new Uint8Array([1]), ...USER_42 }), label: "a call with a raw body" },
  { call: (sdk) => sdk.users.update({ form: { a: "1" }, ...USER_42 }), label: "a call with a form" },
  { call: (sdk) => sdk.exports.create({ json: {} }), label: "a write with a declared non-JSON answer" },
  { call: (sdk) => sdk.users.avatar({ json: {}, ...USER_42 }), label: "a write that declares no body" },
  { call: (sdk) => sdk.feed.refresh(), label: "a GET that invalidates" },
  { call: (sdk) => sdk.users.ping({ json: {}, ...USER_42 }), label: "a write that invalidates nothing" },
  { call: update(), label: "a write select picks no read for", singleFlight: { select: () => [] } },
  { call: update(), label: "a write with maxReads 0", singleFlight: { maxReads: 0, select: everyRead } },
];

describe("singleFlight: every other call goes direct", () => {
  it.each(DIRECT)("sends $label as the normal request", async ({ call, singleFlight }) => {
    const { app, sdk } = await flightOf(singleFlight === undefined ? {} : { config: { singleFlight } });
    await call(sdk);
    expect(sent(app).map((line) => line.endsWith(MUTATE))).toStrictEqual([false]);
  });

  it("sends a write direct with no singleFlight config", async () => {
    const { app, sdk } = await flightOf({ config: { singleFlight: undefined } });
    await sdk.users.update({ json: {}, ...USER_42 });
    expect(sent(app)).toStrictEqual(["PATCH /api/users/42"]);
  });

  it("opens an event-stream write direct", async () => {
    const { app, sdk } = await flightOf({ routes: { "POST /feed/publish": stream } });
    const events = sdk.feed.publish({ json: {} })[Symbol.asyncIterator]();
    await events.next();
    await events.return?.();
    expect(sent(app)).toStrictEqual(["POST /api/feed/publish"]);
  });
});
