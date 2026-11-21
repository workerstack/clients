/**
 * `onInvalidate`'s hooks as the call runs them: detached on a stream's or socket's open, once per call however
 * many attempts it took, awaited by the write, and never failing it. Driven on the emitted SDK over a recording
 * fetch, with a scripted `WebSocket` for the socket op.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSocket } from "./__fixtures__/fake-socket.ts";
import {
  firstThenOk,
  type Hook,
  hung,
  type InvalidateEvent,
  sdkOf,
  tick,
  unauthorized,
  UPDATED,
} from "./__fixtures__/on-invalidate.ts";

/** An event stream of one event, closed. */
function stream(): Response {
  return new Response("data: x\n\n", { headers: { "content-type": "text/event-stream" } });
}

/** Every event of `iterable`. */
async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];

  for await (const item of iterable) out.push(item);

  return out;
}

beforeEach(() => {
  FakeSocket.sockets = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("onInvalidate: stream and socket writes call the hooks on open, detached", () => {
  it("calls them once an SSE op's stream opens, without the stream waiting on them", async () => {
    const seen: InvalidateEvent[] = [];
    const { sdk } = await sdkOf(stream, { onInvalidate: [(event) => void seen.push(event), hung] });
    const items = await collect(sdk.feed.live());
    expect([items.length, seen]).toStrictEqual([
      1,
      [{ by: "feed.live", targets: [{ operationId: "feed.get", params: {} }] }],
    ]);
  });

  it("calls them once a WS op's socket opens, without the socket waiting on them", async () => {
    const events: InvalidateEvent[] = [];
    const { sdk } = await sdkOf(undefined, { onInvalidate: [(event) => void events.push(event), hung] });
    const socket = sdk.rooms.live({ params: { room: "r1" } });
    let isOpened = false;
    socket.on("open", () => (isOpened = true));
    const before = events.length;
    (FakeSocket.sockets.at(-1) /* the call above opened one */ as FakeSocket).accept();
    await tick();
    expect([before, isOpened, events]).toStrictEqual([
      0,
      true,
      [{ by: "rooms.live", targets: [{ operationId: "rooms.messages", params: { room: "r1" } }] }],
    ]);
  });
});

describe("onInvalidate: once per call, not once per attempt", () => {
  it("calls them once for a 401 that onAuthExpired refreshes into a 2xx", async () => {
    const { calls, events, sdk } = await sdkOf(
      (request) => (request.headers.get("authorization") === "Bearer fresh" ? Response.json({}) : unauthorized()),
      { headers: { authorization: "Bearer stale" }, onAuthExpired: () => Promise.resolve("fresh") },
    );

    await sdk.users.update({ json: {}, params: { id: 42 } });
    expect([calls.length, events]).toStrictEqual([2, [UPDATED]]);
  });

  it("calls them once when an onResponse hook retries", async () => {
    const onResponse = [
      (ctx: { isRetry: boolean; response: Response; retry: () => Promise<Response> }) =>
        ctx.response.status === 401 && !ctx.isRetry ? ctx.retry() : undefined,
    ];

    const { calls, events, sdk } = await sdkOf(firstThenOk(unauthorized), { onResponse });

    await sdk.users.update({ json: {}, params: { id: 42 } });
    expect([calls.length, events]).toStrictEqual([2, [UPDATED]]);
  });
});

describe("onInvalidate: the write waits on the hooks", () => {
  it("resolves the write only after a deferred hook settles", async () => {
    let release: (() => void) | undefined;

    function deferred(): Promise<void> {
      return new Promise<void>((resolve) => (release = resolve));
    }

    const { sdk } = await sdkOf(undefined, {}, [deferred]);
    let isDone = false;
    const pending = sdk.users.update({ json: {}, params: { id: 42 } }).then(() => (isDone = true));
    await vi.waitFor(() => expect(release).toBeDefined());
    await tick();
    const wasDone = isDone;
    release?.();
    await pending;
    expect([wasDone, isDone]).toStrictEqual([false, true]);
  });

  it("calls them from the safe twin", async () => {
    const { events, sdk } = await sdkOf();
    const result = await sdk.safe.users.update({ json: {}, params: { id: 42 } });
    expect([result.ok, events]).toStrictEqual([true, [UPDATED]]);
  });
});

/** A hook that throws `error` as it is called. */
function throwing(error: Error): Hook {
  return () => {
    throw error;
  };
}

/** A hook whose promise rejects with `error`. */
function rejecting(error: Error): Hook {
  return () => Promise.reject(error);
}

describe("onInvalidate: a hook's error never fails the write", () => {
  it.each([
    ["sync", throwing],
    ["async", rejecting],
  ] as const)(
    "leaves the write resolved when a %s hook throws, calls the others and tells onLog",
    async (_label, hook) => {
      const error = new Error("boom");
      const { events, logs, sdk } = await sdkOf(() => Response.json({ saved: true }), {}, [hook(error)]);
      const data = await sdk.users.update({ json: {}, params: { id: 42 } });
      const errors = logs.filter((entry) => entry.event === "error");
      expect([data, events, errors]).toStrictEqual([
        { saved: true },
        [UPDATED],
        [expect.objectContaining({ error, level: "error" })],
      ]);
    },
  );
});
