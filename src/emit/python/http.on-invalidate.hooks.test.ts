/**
 * `on_invalidate`'s hooks as a Python call runs them (plan 2's cases 1.4-1.5, in Python's terms): detached on an
 * `AsyncSDK` stream's or socket's open (streams are its alone, G2), once per call however many attempts it took, in
 * order and before the write returns, from the safe mirror too, and never failing it; a hook's raise goes to on_log,
 * or nowhere without one, never to stderr. Consumer programs on the registry's `invalidate` package, over a mock
 * transport on both clients and over a recording server for the stream and the socket.
 */
import { describe, expect, it } from "vitest";

import { type Reply, served } from "../shared/__fixtures__/recording-server.ts";
import { consume, type Run } from "./__fixtures__/consumer.ts";
import { clean, invalidating, KINDS, noted, UPDATED } from "./__fixtures__/on-invalidate.ts";

/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 };

/**
 * One `AsyncSDK` whose hooks put each event on `seen` then hold until `release` is set (`held` once they waited out
 * 3 s), reading the feed's stream to its end, then dialing the room's socket; after each, what the hooks saw. Then a
 * stream on a client whose first hook raises: what on_log got, and the next hook's event.
 */
const OPENS = `release = asyncio.Event()
seen = asyncio.Queue()
held = [False]


async def tell(e):
    seen.put_nowait(shown(e))


async def hung(e):
    try:
        await asyncio.wait_for(release.wait(), 3)
    except TimeoutError:
        held[0] = True


async def following(queue):
    try:
        return await asyncio.wait_for(queue.get(), 2)
    except TimeoutError:
        return "none"


live = sdk.AsyncSDK(sdk.ClientConfig(base_url=BASE, on_invalidate=[tell, hung]))
section("sse")
async with await live.feed.live() as s:
    async for e in s:
        note(f"event {e.data}")
note(f"held {held[0]}")
note(f"invalidated {await following(seen)}")
section("ws")
socket = await live.rooms.live("r1")
note(f"held {held[0]}")
note(f"invalidated {await following(seen)}")
await socket.close()
release.set()
note(f"more {seen.qsize()}")
section("sse-raise")
logs = asyncio.Queue()


async def boomed(e):
    raise RuntimeError(BOOM)


def told(entry):
    if BOOM in (entry.error or ""):
        logs.put_nowait(f"{entry.level} {entry.event} {entry.error}")


raising = sdk.AsyncSDK(sdk.ClientConfig(base_url=BASE, on_invalidate=[boomed, tell], on_log=told))
async with await raising.feed.live() as s:
    async for e in s:
        note(f"event {e.data}")
note(f"log {await following(logs)}")
note(f"invalidated {await following(seen)}")
section("sse-unlogged")
quiet = sdk.AsyncSDK(sdk.ClientConfig(base_url=BASE, on_invalidate=[boomed, tell]))
async with await quiet.feed.live() as s:
    async for e in s:
        note(f"event {e.data}")
note(f"invalidated {await following(seen)}")
await asyncio.sleep(0.1)`;

/** Every call-side case's section on each client, `<kind> <case>`, each on its own recorded client. */
const CALLS = `import time

finished = [False]


def failing(e):
    raise RuntimeError(BOOM)


def finish(e):
    time.sleep(0.05)
    finished[0] = True


async def finish_async(e):
    await asyncio.sleep(0.05)
    finished[0] = True


for kind in ("async", "sync"):
    section(f"{kind} auth")
    authed = recorded(kind, gate=True, bearer_token="stale", on_auth_expired=lambda: "fresh")
    await done(authed.users.update("42", {}))
    section(f"{kind} order")
    first, second = (hooked(kind, lambda e, n=n: note(n)) for n in ("first", "second"))
    await done(recorded(kind, first, second).users.update("42", {}))
    section(f"{kind} waits")
    finished[0] = False
    await done(recorded(kind, finish if kind == "sync" else finish_async).users.update("42", {}))
    note(f"done {finished[0]}")
    section(f"{kind} safe")
    note(type(await done(recorded(kind).safe.users.update("42", {}))).__name__)
    REPLIES["PATCH /users/42"] = (200, '{"saved":true}')
    section(f"{kind} failing")
    note(f"data {await done(recorded(kind, hooked(kind, failing)).users.update('42', {}))}")
    if kind == "async":
        section("async plain")
        note(f"data {await done(recorded(kind, failing).users.update('42', {}))}")
    section(f"{kind} unlogged")
    note(f"data {await done(recorded(kind, hooked(kind, failing), on_log=None).users.update('42', {}))}")
    del REPLIES["PATCH /users/42"]`;

/** What a write with `{"saved": true}` returns once its failing hook was told to on_log and the next hook ran. */
const SAVED = ["log error error RuntimeError: boom", UPDATED, "data {'saved': True}"];

/** A 200 event stream of one event whose data is `data`, then closed. */
function stream(data: string): Reply {
  return { sse: { end: "close", steps: [`data: ${data}\n\n`] }, status: 200 };
}

let opened: Promise<Run> | undefined;

/** OPENS' run over a server answering the stream, the socket and the raising clients' two streams, once. */
function opens(): Promise<Run> {
  const replies = [stream("x"), { status: 101, ws: { steps: [] } }, stream("y"), stream("z")];
  opened ??= served(replies, (server) => consume("invalidate", "on_invalidate_opens", invalidating(OPENS, server.url)));

  return opened;
}

let memo: Promise<Run> | undefined;

/** CALLS' run, once. */
function calls(): Promise<Run> {
  memo ??= consume("invalidate", "on_invalidate_calls", invalidating(CALLS));

  return memo;
}

/** The notes of CALLS' `section`; the run must have ran to the end. */
async function section(name: string) {
  const run = await calls();
  expect(run.ran, run.stderr).toBe(true);

  return noted(run, name);
}

describe("on_invalidate: stream and socket opens call the hooks once, detached", SLOW, () => {
  it("calls them once as the SSE stream and the WS socket open, neither waiting on a held hook", async () => {
    const run = await opens();

    expect([noted(run, "sse"), noted(run, "ws")], run.stderr).toStrictEqual([
      clean(["event x", "held False", "invalidated feed.live | feed.get {}"]),
      clean(["held False", 'invalidated rooms.live | rooms.messages {"room": "r1"}', "more 0"]),
    ]);
  });

  it("tells on_log a raising hook's error on a stream's open, and still runs the next hook", async () => {
    const run = await opens();
    expect(noted(run, "sse-raise"), run.stderr).toStrictEqual(
      clean(["event y", "log error error RuntimeError: boom", "invalidated feed.live | feed.get {}"]),
    );
  });

  it("drops a raising hook's error on a stream's open without on_log: nothing on stderr", async () => {
    const run = await opens();
    expect([noted(run, "sse-unlogged"), run.stderr]).toStrictEqual([
      clean(["event z", "invalidated feed.live | feed.get {}"]),
      "",
    ]);
  });
});

describe("on_invalidate: once per call, in order, before the write returns", SLOW, () => {
  it.each(KINDS)("%s: calls them once for a 401 that on_auth_expired refreshes into a 2xx", async (kind) => {
    expect(await section(`${kind} auth`)).toStrictEqual(clean(["sent Bearer stale", "sent Bearer fresh", UPDATED]));
  });

  it.each(KINDS)("%s: runs them in their list's order", async (kind) => {
    expect(await section(`${kind} order`)).toStrictEqual(clean(["first", "second", UPDATED]));
  });

  it.each(KINDS)("%s: returns only after a slow hook returned", async (kind) => {
    expect(await section(`${kind} waits`)).toStrictEqual(clean([UPDATED, "done True"]));
  });

  it.each(KINDS)("%s: calls them from the safe mirror, whose call is Ok", async (kind) => {
    expect(await section(`${kind} safe`)).toStrictEqual(clean([UPDATED, "Ok"]));
  });
});

describe("on_invalidate: a hook's raise never fails the write", SLOW, () => {
  it.each(KINDS)("%s: returns the write's data, tells on_log and still runs the next hook", async (kind) => {
    expect(await section(`${kind} failing`)).toStrictEqual(clean(SAVED));
  });

  it("async: takes a plain function too, as on_response does, its raise told to on_log", async () => {
    expect(await section("async plain")).toStrictEqual(clean(SAVED));
  });

  it.each(KINDS)("%s: drops the error without on_log: the write returns its data, nothing on stderr", async (kind) => {
    const run = await calls();
    expect([await section(`${kind} unlogged`), run.stderr]).toStrictEqual([
      clean([UPDATED, "data {'saved': True}"]),
      "",
    ]);
  });
});
