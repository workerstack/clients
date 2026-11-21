/**
 * `OnInvalidate`'s hooks as a Go call runs them (plan 2's cases 1.4-1.5, in Go's terms): detached on a stream's or
 * socket's open, once per call however many attempts it took, run before the write returns with the call's context,
 * and never failing it; a hook's error goes to OnLog, or nowhere without one. Consumer programs over the recording
 * transport, and over a recording server for the stream and the socket.
 */
import { describe, expect, it } from "vitest";

import { served } from "../shared/__fixtures__/recording-server.ts";
import { consume, type Run } from "./__fixtures__/consumer.ts";
import { clean, invalidating, noted, UPDATED } from "./__fixtures__/on-invalidate.ts";

/**
 * One client whose hooks note each event on `seen` then hold until `release` closes (`held` once they waited out 3 s),
 * reading the feed's stream to its end, then dialing the room's socket; after each, what the hooks saw.
 */
const OPENS = `	release := make(chan struct{})
	seen := make(chan string, 4)
	var held atomic.Bool
	tell := func(_ context.Context, e sdk.InvalidateEvent) error {
		seen <- shown(e)
		return nil
	}
	hung := func(context.Context, sdk.InvalidateEvent) error {
		select {
		case <-release:
		case <-time.After(3 * time.Second):
			held.Store(true)
		}
		return nil
	}
	hooks := []func(context.Context, sdk.InvalidateEvent) error{tell, hung}
	live := sdk.NewClient(sdk.Config{BaseURL: input.Base, OnInvalidate: hooks})
	section("sse")
	for ev, err := range live.Feed.Live(ctx, nil) {
		note("event", ev.Data, err)
	}
	note("held", held.Load())
	note("invalidated", next(seen))
	section("ws")
	socket, err := live.Rooms.Live(ctx, "r1", nil)
	note("dial", err)
	note("held", held.Load())
	note("invalidated", next(seen))
	if socket != nil {
		_ = socket.Close(sdk.WSStatusNormalClosure, "")
	}
	close(release)
	note("more", len(seen))
	section("sse-panic")
	logged := make(chan string, 4)
	boomed := func(context.Context, sdk.InvalidateEvent) error { panic(boom) }
	onLog := func(entry sdk.LogEntry) {
		if errors.Is(entry.Err, boom) {
			logged <- entry.Level + " " + entry.Event
		}
	}
	panicky := []func(context.Context, sdk.InvalidateEvent) error{boomed, tell}
	config := sdk.Config{BaseURL: input.Base, OnInvalidate: panicky, OnLog: onLog}
	for ev, err := range sdk.NewClient(config).Feed.Live(ctx, nil) {
		note("event", ev.Data, err)
	}
	note("log", next(logged))
	note("invalidated", next(seen))`;

/** The next event `seen` carries within 2 s, or `none`. */
const NEXT = `func next(seen <-chan string) string {
	select {
	case e := <-seen:
		return e
	case <-time.After(2 * time.Second):
		return "none"
	}
}`;

/** Every call-side case's section, each on its own recorded client. */
const CALLS = `	body := map[string]interface{}{}
	section("auth")
	expired := func(context.Context) (string, error) { return "fresh", nil }
	gated := &http.Client{Transport: gate{}}
	authed := recorded(sdk.Config{BearerToken: "stale", HTTPClient: gated, OnAuthExpired: expired})
	must(authed.Users.Update(ctx, "42", body, nil))
	section("waits")
	done := false
	slow := func(context.Context, sdk.InvalidateEvent) error {
		time.Sleep(50 * time.Millisecond)
		done = true
		return nil
	}
	must(recorded(sdk.Config{}, slow).Users.Update(ctx, "42", body, nil))
	note("done", done)
	section("context")
	type key struct{}
	probe := func(hctx context.Context, _ sdk.InvalidateEvent) error {
		note("ctx", hctx.Value(key{}), hctx.Err())
		return nil
	}
	must(recorded(sdk.Config{}, probe).Users.Update(context.WithValue(ctx, key{}, "caller"), "42", body, nil))
	section("safe")
	result, err := recorded(sdk.Config{}).Safe().Users.Update(ctx, "42", body, nil)
	note("ok", result.Ok(), err)
	section("failing")
	failing := func(context.Context, sdk.InvalidateEvent) error { return boom }
	replies["PATCH /users/42"] = reply{status: 200, body: \`{"saved":true}\`}
	note("data", *must(recorded(sdk.Config{}, failing).Users.Update(ctx, "42", body, nil)))
	section("panicking")
	panicking := func(context.Context, sdk.InvalidateEvent) error { panic(boom) }
	note("data", *must(recorded(sdk.Config{}, panicking).Users.Update(ctx, "42", body, nil)))
	section("unlogged")
	hooks := []func(context.Context, sdk.InvalidateEvent) error{failing}
	quiet := sdk.NewClient(sdk.Config{BaseURL: "http://api.test", HTTPClient: transport, OnInvalidate: hooks})
	_, err = quiet.Users.Update(ctx, "42", body, nil)
	note("err", err)`;

let opened: Promise<Run> | undefined;

/** OPENS' run over a server answering the stream, the socket and the panicking client's stream, once. */
function opens(): Promise<Run> {
  opened ??= served(
    [
      { sse: { end: "close", steps: ["data: x\n\n"] }, status: 200 },
      { status: 101, ws: { steps: [] } },
      { sse: { end: "close", steps: ["data: y\n\n"] }, status: 200 },
    ],
    (server) => consume(...invalidating(OPENS, { base: server.url, decls: NEXT, imports: ["sync/atomic", "time"] })),
  );

  return opened;
}

let memo: Promise<Run> | undefined;

/** CALLS' run, once. */
function calls(): Promise<Run> {
  memo ??= consume(...invalidating(CALLS, { imports: ["time"] }));

  return memo;
}

/** The notes of CALLS' `section`, less its request lines; the run must have built. */
async function section(name: string) {
  const run = await calls();
  expect(run.built, run.stderr).toBe(true);

  return noted(run, name);
}

describe("OnInvalidate: stream and socket opens call the hooks once, detached", () => {
  it("calls them once as the SSE stream and the WS socket open, neither waiting on a held hook", async () => {
    const run = await opens();

    expect([noted(run, "sse"), noted(run, "ws")], run.stderr).toStrictEqual([
      clean(["event x <nil>", "held false", "invalidated feed.live | feed.get map[]"]),
      clean(["dial <nil>", "held false", "invalidated rooms.live | rooms.messages map[room:r1]", "more 0"]),
    ]);
  }, 600_000);

  it("recovers a panicking hook on a stream's open: OnLog gets its error, the next hook still runs", async () => {
    const run = await opens();
    expect(noted(run, "sse-panic"), run.stderr).toStrictEqual(
      clean(["event y <nil>", "log error error", "invalidated feed.live | feed.get map[]"]),
    );
  }, 600_000);
});

describe("OnInvalidate: once per call, not once per attempt", () => {
  it("calls them once for a 401 that OnAuthExpired refreshes into a 2xx", async () => {
    expect(await section("auth")).toStrictEqual(clean(["sent Bearer stale", "sent Bearer fresh", UPDATED]));
  }, 600_000);
});

describe("OnInvalidate: the write runs the hooks before it returns", () => {
  it("returns only after a slow hook returned", async () => {
    expect(await section("waits")).toStrictEqual(clean([UPDATED, "done true"]));
  }, 600_000);

  it("hands each hook the call's context, not done once the call's timeout ended", async () => {
    expect(await section("context")).toStrictEqual(clean(["ctx caller <nil>", UPDATED]));
  }, 600_000);

  it("calls them from the safe twin", async () => {
    expect(await section("safe")).toStrictEqual(clean([UPDATED, "ok true <nil>"]));
  }, 600_000);
});

describe("OnInvalidate: a hook's error never fails the write", () => {
  it("returns the write's data when a hook returns an error, calls the others and tells OnLog", async () => {
    expect(await section("failing")).toStrictEqual(clean(["log error error", UPDATED, "data map[saved:true]"]));
  }, 600_000);

  it("recovers a panicking hook on a write: OnLog gets its error, the next hook runs, the data stands", async () => {
    expect(await section("panicking")).toStrictEqual(clean(["log error error", UPDATED, "data map[saved:true]"]));
  }, 600_000);

  it("drops the error without OnLog: the write succeeds and nothing is printed", async () => {
    const run = await calls();
    expect([await section("unlogged"), run.stderr]).toStrictEqual([clean(["err <nil>"]), ""]);
  }, 600_000);
});
