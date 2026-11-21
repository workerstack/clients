/**
 * The single-flight caller when things go wrong, and the reads it brings back: a write's own error, a batch that does
 * not decode, an abort, an expired token inside the batch, a refusal, a batch that fails, and the fresh reads the
 * hooks get before the write resolves. Driven on the emitted client over the emitted handler.
 */
import { describe, expect, it } from "vitest";

import {
  batchAt,
  conflict,
  everyRead,
  expiredUntilFresh,
  failed,
  flightOf,
  type Hook,
  missing,
  MUTATE,
  rejectionOf,
  type Route,
  type Routes,
  sent,
  type Target,
} from "./__fixtures__/single-flight-caller.ts";

const USER_42 = { params: { id: 42 } };

const TARGETS = [
  { operationId: "users.get", ...USER_42 },
  { operationId: "users.list", params: {} },
];

const EXPIRED: Routes = { "PATCH /users/42": expiredUntilFresh };

/** A custom send whose answer is no envelope. */
function noEnvelope(): Promise<object> {
  return Promise.resolve({ v: 1 });
}

/** A token refresh that hands back `fresh`. */
function freshToken(): Promise<string> {
  return Promise.resolve("fresh");
}

/** A token refresh that hands back a token the API still rejects. */
function staleToken(): Promise<string> {
  return Promise.resolve("stale");
}

/** An envelope whose write answered `status` with `headers`, bringing back no read. */
function envelope(status: number, headers: Readonly<Record<string, number | string>> = {}): Route {
  return () => Response.json({ reads: [], v: 1, write: { body: null, headers, status } });
}

describe("singleFlight: a write's own error is the error a direct call throws", () => {
  it("throws a 409 write as the same ConflictError, and runs no read and no hook", async () => {
    const routes: Routes = { "PATCH /users/42": conflict };
    const direct = await flightOf({ config: { singleFlight: undefined }, routes });
    const flown = await flightOf({ routes });
    const expected = await rejectionOf(direct.sdk.users.update({ json: {}, ...USER_42 }));
    const error = await rejectionOf(flown.sdk.users.update({ json: {}, ...USER_42 }));
    expect([error, expected?.name, sent(flown.api), flown.events]).toStrictEqual([
      expected,
      "ConflictError",
      ["PATCH /users/42"],
      [],
    ]);
  });
});

describe("singleFlight: a batch that does not decode still calls the hooks", () => {
  it.each([
    ["is not JSON", () => new Response("{not json", { headers: { "content-type": "application/json" } })],
    ["is no envelope", () => Response.json({ v: 2 })],
    ["has a write status out of range", envelope(99)],
    ["has a header that is no string", envelope(200, { a: 1 })],
  ] as const)("throws DecodeError for a batch answer that %s, the hooks called", async (_label, batch) => {
    const { events, sdk } = await flightOf({ batch });
    const error = await rejectionOf(sdk.users.update({ json: {}, ...USER_42 }));
    expect([error?.name, events]).toStrictEqual(["DecodeError", [{ by: "users.update", targets: TARGETS }]]);
  });

  it("throws DecodeError for a custom send that resolves no envelope", async () => {
    const { events, sdk } = await flightOf({ config: { singleFlight: { select: everyRead, send: noEnvelope } } });
    const error = await rejectionOf(sdk.users.update({ json: {}, ...USER_42 }));
    expect([error?.name, error?.status, events.length]).toStrictEqual(["DecodeError", 200, 1]);
  });
});

describe("singleFlight: an aborted signal acts as it does on a direct call", () => {
  it("rejects with the signal's reason and sends nothing", async () => {
    const reason = new Error("stop");
    const signal = AbortSignal.abort(reason);
    const direct = await flightOf({ config: { singleFlight: undefined } });
    const flown = await flightOf();

    await expect(flown.sdk.users.update({ json: {}, ...USER_42, signal })).rejects.toBe(reason);
    await expect(direct.sdk.users.update({ json: {}, ...USER_42, signal })).rejects.toBe(reason);
    expect(flown.app.length).toBe(0);
  });

  it("rejects a custom send with the signal's reason, aborted before or during the send", async () => {
    const reason = new Error("stop");
    const ctrl = new AbortController();

    function send(): Promise<object> {
      return new Promise<object>(() => setTimeout(() => ctrl.abort(reason), 0));
    }

    const { sdk } = await flightOf({ config: { singleFlight: { select: everyRead, send } } });
    const signal = AbortSignal.abort(reason);

    await expect(sdk.users.update({ json: {}, ...USER_42, signal })).rejects.toBe(reason);
    await expect(sdk.users.update({ json: {}, ...USER_42, signal: ctrl.signal })).rejects.toBe(reason);
  });
});

describe("singleFlight: a 401 inside the batch refreshes the token once", () => {
  it("calls onAuthExpired once and resends the batch with the fresh token", async () => {
    let refreshes = 0;

    function onAuthExpired(): Promise<string> {
      refreshes += 1;

      return Promise.resolve("fresh");
    }

    const { app, sdk } = await flightOf({ config: { onAuthExpired }, routes: EXPIRED });
    const data = await sdk.users.update({ json: {}, ...USER_42 });
    expect([data, refreshes, sent(app), app[1]?.headers.get("authorization")]).toStrictEqual([
      { ok: true },
      1,
      [`POST ${MUTATE}`, `POST ${MUTATE}`],
      "Bearer fresh",
    ]);
  });

  it("throws the write's UnauthorizedError when the resent batch's write is a 401 too", async () => {
    const { app, sdk } = await flightOf({ config: { onAuthExpired: staleToken }, routes: EXPIRED });
    const error = await rejectionOf(sdk.users.update({ json: {}, ...USER_42 }));
    expect([error?.name, error?.status, app.length]).toStrictEqual(["UnauthorizedError", 401, 2]);
  });

  it("throws the write's UnauthorizedError with no onAuthExpired, sending the batch once", async () => {
    const { app, sdk } = await flightOf({ routes: EXPIRED });
    const error = await rejectionOf(sdk.users.update({ json: {}, ...USER_42 }));
    expect([error?.name, app.length]).toStrictEqual(["UnauthorizedError", 1]);
  });
});

/** `first` for the first batch, then a refusal, as an app that changed its limits between them would answer. */
function refusedOnResend(first: Route): Route {
  let calls = 0;

  return (request) => {
    calls += 1;

    if (calls === 1) return first(request);

    return Response.json({ type: "urn:workerstack:single-flight:refused" }, { status: 400 });
  };
}

describe("singleFlight: a refusal resends the write direct", () => {
  it("sends the write as the normal request once the handler refuses the batch", async () => {
    const { app, events, sdk } = await flightOf({ handler: { maxReads: 1 } });
    const data = await sdk.users.update({ json: {}, ...USER_42 });
    expect([data, sent(app), events]).toStrictEqual([
      { got: "{}", path: "/users/42" },
      [`POST ${MUTATE}`, "PATCH /api/users/42"],
      [{ by: "users.update", targets: TARGETS }],
    ]);
  });

  it("resends an idempotent write with the key the batch carried", async () => {
    const { app, sdk } = await flightOf({ handler: { maxReads: 0 } });
    await sdk.users.create({ json: {} });
    const { input } = await batchAt(app);
    expect(app[1]?.headers.get("idempotency-key")).toBe(input.idempotencyKey);
  });

  it("resends the write direct when the batch sent again after a refresh is refused", async () => {
    const setup = { batch: refusedOnResend(envelope(401)), config: { onAuthExpired: freshToken } };
    const { app, sdk } = await flightOf(setup);
    await sdk.users.update({ json: {}, ...USER_42 });
    expect(sent(app)).toStrictEqual([`POST ${MUTATE}`, `POST ${MUTATE}`, "PATCH /api/users/42"]);
  });
});

describe("singleFlight: any other batch failure throws and never resends", () => {
  it.each([
    ["a write that got no answer (502)", { routes: { "PATCH /users/42": failed } }, "BadGatewayError"],
    ["a batch the app fails (500)", { batch: () => Response.json({}, { status: 500 }) }, "InternalServerError"],
    ["a 400 that is no refusal", { batch: () => Response.json({ type: "other" }, { status: 400 }) }, "BadRequestError"],
    ["a 400 with no body", { batch: () => new Response(null, { status: 400 }) }, "BadRequestError"],
  ] as const)("throws %s as a direct call would", async (_label, setup, name) => {
    const { app, events, sdk } = await flightOf(setup);
    const error = await rejectionOf(sdk.users.update({ json: {}, ...USER_42 }));
    expect([error?.name, app.length, events]).toStrictEqual([name, 1, []]);
  });
});

describe("singleFlight: the fresh reads reach the hooks before the write resolves", () => {
  it("hands each hook every read's data by its id, the write still pending", async () => {
    let isResolved = false;
    const seen: Array<[boolean, unknown]> = [];

    function hook(event: Parameters<Hook>[0]): void {
      seen.push([isResolved, event.fresh]);
    }

    const { sdk } = await flightOf({ hooks: [hook] });
    await sdk.users.update({ json: {}, ...USER_42 }).then(() => (isResolved = true));

    const data = new Map([
      ["r0", { n: 1, path: "/users/42" }],
      ["r1", { n: 1, path: "/users" }],
    ]);

    expect(seen).toStrictEqual([[false, { data, failed: new Set() }]]);
  });
});

describe("singleFlight: the hooks name what the batch could not bring back", () => {
  it("names a read that failed in `failed`, with no data", async () => {
    const { events, sdk } = await flightOf({ routes: { "GET /users/42": missing } });
    await sdk.users.update({ json: {}, ...USER_42 });
    expect(events.map((event) => [[...(event.fresh?.data.keys() ?? [])], event.fresh?.failed])).toStrictEqual([
      [["r1"], new Set(["r0"])],
    ]);
  });

  it("calls the hooks once, with the targets, and selects from those targets", async () => {
    const asked: Target[][] = [];

    function select(targets: Target[]) {
      asked.push(targets);

      return everyRead(targets);
    }

    const { events, sdk } = await flightOf({ config: { singleFlight: { select } } });
    await sdk.users.update({ json: {}, ...USER_42 });
    expect([asked, events.map(({ by, targets }) => ({ by, targets }))]).toStrictEqual([
      [TARGETS],
      [{ by: "users.update", targets: TARGETS }],
    ]);
  });
});
