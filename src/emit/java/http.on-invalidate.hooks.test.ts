/**
 * `onInvalidate`'s hooks as a Java call runs them (plan 9; plan 2's cases 1.4-1.5 in Java's terms): detached on a
 * stream's or socket's open, once per call however many attempts it took, run before the write returns, and never
 * failing it; a hook's exception (checked or unchecked) goes to onLog, or nowhere without one. Probes against the
 * recording server (shared/__fixtures__/on-invalidate-cases.ts).
 */
import { describe, expect, it } from "vitest";

import {
  CALL_REPLIES,
  callCases,
  type Case,
  OPEN_REPLIES,
  openCases,
  PAST_FAILED,
  type Printed,
  ran,
} from "../shared/__fixtures__/on-invalidate-cases.ts";
import { served } from "../shared/__fixtures__/recording-server.ts";
import { compiledJavaSdk, type JavaRun } from "./__fixtures__/compiled.ts";
import { failureOf, MAIN, notesOf, probe, sdkFiles } from "./__fixtures__/on-invalidate.ts";

/** A boolean as Java prints it. */
const SHOWN: Printed = { no: "false", yes: "true" };

/**
 * One client whose hooks put each event in `seen`, then hold until `release` opens (`held` once they waited out 3 s),
 * reading the feed's stream to its end, then dialing the room's socket; after each, what the hooks saw. Then a client
 * whose first hook throws, on the feed's stream again.
 */
const OPENS = `CountDownLatch release = new CountDownLatch(1);
BlockingQueue<String> seen = new LinkedBlockingQueue<>();
AtomicBoolean held = new AtomicBoolean();
InvalidateHook tell = e -> seen.add(shown(e));
InvalidateHook hung = e -> held.set(!release.await(3, TimeUnit.SECONDS));
ExampleClient live = base().onInvalidate(tell).onInvalidate(hung).build();
section("sse");
try (EventStream<SseEvent<String>> events = live.feed().live(FeedLiveParams.builder().build())) {
  for (SseEvent<String> ev : events) {
    note("event " + ev.data());
  }
}
note("held " + held.get());
note("invalidated " + next(seen));
section("ws");
TypedWebSocket<WsMessage, tools.jackson.databind.JsonNode> socket =
    live.rooms().live(RoomsLiveParams.builder().room("r1").build());
note("dial done");
note("held " + held.get());
note("invalidated " + next(seen));
socket.close();
release.countDown();
note("more " + seen.size());
section("sse-throw");
BlockingQueue<String> logged = new LinkedBlockingQueue<>();
ExampleClient throwing = base()
    .onInvalidate(e -> { throw new IllegalStateException("boom"); })
    .onInvalidate(tell)
    .onLog(entry -> {
      if (entry.error() != null && entry.error().contains("boom")) {
        logged.add(entry.level() + " " + entry.event());
      }
    })
    .build();
try (EventStream<SseEvent<String>> events = throwing.feed().live(FeedLiveParams.builder().build())) {
  for (SseEvent<String> ev : events) {
    note("event " + ev.data());
  }
}
note("log " + next(logged));
note("invalidated " + next(seen));`;

/** Every call-side case's section, each on its own recorded client. */
const CALLS = `UsersUpdateParams update = UsersUpdateParams.builder().id("42").build();
section("auth");
ExampleClient.Builder sent = base()
    .bearerToken("stale")
    .onAuthExpired(() -> "fresh")
    .onRequest(r -> note("sent retry=" + r.isRetry()));
recorded(sent).users().update(update);
section("waits");
AtomicBoolean done = new AtomicBoolean();
recorded(base(), e -> {
  Thread.sleep(50);
  done.set(true);
}).users().update(update);
note("done " + done.get());
section("safe");
note("ok " + recorded(base()).safe().users().update(update).isOk());
section("unchecked");
note("data " + recorded(base(), e -> { throw new IllegalStateException("boom"); }).users().update(update).size());
section("checked");
note("data " + recorded(base(), e -> { throw new java.io.IOException("boom"); }).users().update(update).size());
section("unlogged");
base().onInvalidate(e -> { throw new IllegalStateException("boom"); }).build().users().update(update);
note("returned");`;

/** Java's own call-side cases: a hook throwing an unchecked or a checked exception, and one without onLog. */
const OWN: readonly Case[] = [
  [
    "returns the write's data past a hook throwing unchecked, calls the others and tells onLog",
    "unchecked",
    PAST_FAILED,
  ],
  ["returns the write's data past a hook throwing checked, calls the others and tells onLog", "checked", PAST_FAILED],
  ["drops a hook's exception without onLog: the write returns", "unlogged", ["returned"]],
];

let opened: Promise<JavaRun> | undefined;
let called: Promise<JavaRun> | undefined;

/** OPENS' run against OPEN_REPLIES, once. */
function opens(): Promise<JavaRun> {
  opened ??= served(OPEN_REPLIES, (server) => compiledJavaSdk(sdkFiles()).exec(MAIN, probe(server.url, OPENS)));

  return opened;
}

/** CALLS' run against CALL_REPLIES, once. */
function calls(): Promise<JavaRun> {
  called ??= served(CALL_REPLIES, (server) => compiledJavaSdk(sdkFiles()).exec(MAIN, probe(server.url, CALLS)));

  return called;
}

describe("onInvalidate: stream and socket opens call the hooks once, detached", () => {
  it.each(openCases(SHOWN))(
    "%s",
    async (_title, section, notes) => {
      const run = await opens();
      expect(notesOf(run, section), failureOf(run)).toStrictEqual(ran(notes));
    },
    600_000,
  );
});

describe("onInvalidate: a write calls the hooks once, before it returns, and never fails for them", () => {
  it.each([...callCases(SHOWN), ...OWN])(
    "%s",
    async (_title, section, notes) => {
      const run = await calls();
      expect(notesOf(run, section), failureOf(run)).toStrictEqual(ran(notes));
    },
    600_000,
  );

  it("prints nothing for a hook's exception without onLog, the probe run to its end", async () => {
    const run = await calls();
    expect([run.status, run.stderr]).toStrictEqual([0, ""]);
  }, 600_000);
});
