/**
 * A named-event SSE operation (an OpenAPI 3.2 `itemSchema` the IR reads into its events, D7) in the Go SDK: its
 * stream yields `<Op>Event`, a sealed interface (D16) with one type per event name, each embedding
 * `SSEEvent[Data]`, and `<Op>OtherEvent` for a name the op does not declare. On the wire each JSON event is decoded
 * by its name while a string event stays text; an unnamed event is `message`; a declared JSON event that does not
 * decode is a `*DecodeError` and ends the stream. An operation without events reads `SSEEvent[string]`, as before.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type Reply, served } from "../shared/__fixtures__/recording-server.ts";
import { check, consume, seen } from "./__fixtures__/consumer.ts";
import { withGo } from "./__fixtures__/go-env.ts";
import { generateGoSdk } from "./sdk.ts";

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const GO = withGo();

/** Every compiled describe's bound: a cold gate builds the module first, past SPAWN_TIMEOUT. */
const COLD_BUILD = 600_000;
const SLOW = { timeout: COLD_BUILD };

type Json = Record<string, unknown>;

const MODULE = "example.com/events";

const EVENTS = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../ir/__fixtures__/specs/streams/sse-item-schema.json"), "utf8"),
) as Json;

const PLAIN: Json = {
  info: { title: "Plain", version: "1" },
  openapi: "3.1.0",
  paths: {
    "/events": {
      get: {
        operationId: "events.stream",
        responses: { 200: { content: { "text/event-stream": { schema: { type: "string" } } }, description: "" } },
      },
    },
  },
};

/** Every line of the SDK for `document` that matches `pattern`, its files in name order. */
function lines(document: Json, pattern: RegExp): string[] {
  const files = generateGoSdk(document, { modulePath: MODULE }).files;

  return Object.keys(files)
    .sort()
    .flatMap((name) => (files[name] ?? "").split("\n"))
    .filter((line) => pattern.test(line));
}

/** What a stream method returns, from its signature line. */
const returns = (line: string) => line.replace(/^.*RequestOption\) /, "");

describe("a named-event SSE operation's types", () => {
  it("returns iter.Seq2 of a sealed event interface: a type per name in the order declared, then Other", () => {
    expect({
      methods: lines(EVENTS, /\) Stream\(ctx/).map(returns),
      types: lines(EVENTS, /^type \w+Stream\w*Event /),
    }).toEqual({
      methods: ["iter.Seq2[BeatsStreamEvent, error] {", "iter.Seq2[TicksStreamEvent, error] {"],
      types: [
        "type BeatsStreamEvent interface {",
        "type BeatsStreamBeatEvent struct {",
        "type BeatsStreamOtherEvent struct {",
        "type TicksStreamEvent interface {",
        "type TicksStreamTickEvent struct {",
        "type TicksStreamMessageEvent struct {",
        "type TicksStreamOtherEvent struct {",
      ],
    });
  });

  it("keeps an operation without events on SSEEvent of its data", () => {
    expect(lines(PLAIN, /\) Stream\(ctx/).map(returns)).toEqual(["iter.Seq2[SSEEvent[string], error] {"]);
  });
});

/** A consumer that spells each answer, a variant's embedded event and a Safe() twin; compiling is the proof. */
const SPELLED = `	var ticks iter.Seq2[sdk.TicksStreamEvent, error] = client(input.Base).Ticks.Stream(ctx, nil)
	var beats iter.Seq2[sdk.BeatsStreamEvent, error] = client(input.Base).Beats.Stream(ctx, nil)
	var safe func(context.Context, *sdk.TicksStreamOpts, ...sdk.RequestOption) (sdk.Result[iter.Seq2[sdk.TicksStreamEvent, error]], error) = client(input.Base).Safe().Ticks.Stream
	var tick sdk.SSEEvent[sdk.Tick] = sdk.TicksStreamTickEvent{}.SSEEvent
	var beat sdk.SSEEvent[int64] = sdk.BeatsStreamBeatEvent{}.SSEEvent
	var other sdk.SSEEvent[string] = sdk.TicksStreamOtherEvent{}.Untyped()
	var event sdk.TicksStreamEvent = sdk.TicksStreamMessageEvent{}
	_, _, _, _, _, _, _ = ticks, beats, safe, tick, beat, other, event`;

/** A consumer that reads `Data` off the interface, which no event type promotes there. */
const UNNARROWED = `	for ev, err := range client(input.Base).Ticks.Stream(ctx, nil) {
		note(ev.Data.At, err)
	}`;

describe.skipIf(!GO)("a named-event SSE operation, compiled", SLOW, () => {
  it("spells each variant's data type, the interface and the Safe() twin", () => {
    const files = generateGoSdk(EVENTS, { modulePath: MODULE }).files;
    expect(seen(check(files, MODULE, SPELLED, ["iter"]))).toEqual({ built: true, out: undefined, vet: [] });
  });

  it("refuses Data read off the interface, unnarrowed", () => {
    const files = generateGoSdk(EVENTS, { modulePath: MODULE }).files;
    const run = check(files, MODULE, UNNARROWED);
    expect({ built: run.built, refused: run.stderr.includes("ev.Data undefined (type sdk.TicksStreamEvent") }).toEqual({
      built: false,
      refused: true,
    });
  });
});

const sse = (text: string): Reply => ({ sse: { end: "close", steps: [text] }, status: 200 });

/** Every event of each stream, narrowed by a type switch, and a stream's error with whether it is a *DecodeError. */
const READ = `	live := sdk.NewClient(sdk.Config{BaseURL: input.Base})
	section("ticks")
	for ev, err := range live.Ticks.Stream(ctx, nil) {
		if err != nil {
			note("error:", err)
			break
		}
		switch e := ev.(type) {
		case sdk.TicksStreamTickEvent:
			note("tick", e.Event, e.Data.At, e.ID)
		case sdk.TicksStreamMessageEvent:
			note("message", e.Event, e.Data, e.ID)
		case sdk.TicksStreamOtherEvent:
			note("other", e.Event, e.Data, e.ID)
		}
	}
	section("beat")
	for ev, err := range live.Beats.Stream(ctx, nil) {
		if e, ok := ev.(sdk.BeatsStreamBeatEvent); ok {
			note("beat", e.Data+1, err)
		}
	}
	section("nope")
	for ev, err := range live.Beats.Stream(ctx, nil) {
		var decode *sdk.DecodeError
		note(ev == nil, errors.As(err, &decode), err)
	}`;

describe.skipIf(!GO)("a named-event SSE operation on the wire", SLOW, () => {
  it("decodes a JSON event by its name, keeps a string event as sent, names an unnamed one message, ends on a bad one", async () => {
    const files = generateGoSdk(EVENTS, { modulePath: MODULE }).files;
    const wire = 'event: tick\ndata: {"at":1}\nid: 1\n\ndata: plain\n\nevent: other\ndata: {"x":1}\n\n';

    const replies = [
      sse(wire),
      sse("event: beat\ndata: 42\n\n"),
      sse("event: beat\ndata: nope\n\nevent: beat\ndata: 1\n\n"),
    ];

    const run = await served(replies, (server) =>
      consume(files, MODULE, { base: server.url, body: READ, imports: ["errors"] }),
    );

    expect({ built: run.built, out: run.out, vet: run.vet }, run.stderr).toEqual({
      built: true,
      out: {
        beat: ["beat 43 <nil>"],
        nope: [
          `true true httpsdk: decode response: sse event "beat": invalid character 'o' in literal null (expecting 'u')`,
        ],
        ticks: ["tick tick 1 1", "message message plain 1", 'other other {"x":1} 1'],
      },
      vet: [],
    });
  });
});
