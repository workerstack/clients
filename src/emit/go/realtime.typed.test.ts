/**
 * A realtime operation with declared messages (`x-websocket` `send` and `receive`) in the Go SDK: its connection is
 * `ResumableConnection[In, Out]`, `In` what the server sends (else the declared event schema's type, `any` for a
 * string or absent one) and `Out` what it receives, so `Send` takes only what the server receives and `Events()`
 * gives what it sends. A union keyed on one field (D9) is a sealed interface per direction (D16), and the read side's
 * members each get `On<Value>` on a per-op `<Op>Connection`, except a `message` member, which `OnMessage` names. A
 * message that is no JSON, or does not fit the declared type, is a `*DecodeError` on `Errors()`, and the connection
 * reads on. Each message is decoded from its bytes once, so an int64 past 2^53 arrives exact, and its cursor fields
 * still resume a reconnect.
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

const MODULE = "example.com/rooms";

const spec = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, `../../ir/__fixtures__/specs/streams/${name}.json`), "utf8"),
  ) as Json;

const KEYED = spec("realtime-keyed");
const MESSAGES = spec("realtime-messages");

/** A realtime op whose `send` schema is `send`. */
const realtimeOp = (operationId: string, send: Json): Json => ({
  info: { title: "Taps", version: "1" },
  openapi: "3.2.1",
  paths: {
    "/tap": {
      get: {
        operationId,
        responses: { 101: { description: "Switching Protocols" } },
        "x-realtime": true,
        "x-websocket": { send },
      },
    },
  },
});

/** A keyed op whose only member is `message`, the one value `OnMessage` already names. */
const ONLY_MESSAGE = realtimeOp("feed.tap", {
  discriminator: { propertyName: "type" },
  oneOf: [{ properties: { type: { const: "message" } }, required: ["type"], type: "object" }],
});

/** An op whose messages hold an int64 and the resume cursor. */
const COUNTS = realtimeOp("feed.count", {
  properties: {
    id: { type: "string" },
    n: { format: "int64", type: "integer" },
    reconnect_token: { type: "string" },
  },
  required: ["n"],
  type: "object",
});

/** Every line of the SDK for `document` that matches `pattern`, its files in name order. */
function lines(document: Json, pattern: RegExp): string[] {
  const files = generateGoSdk(document, { modulePath: MODULE }).files;

  return Object.keys(files)
    .sort()
    .flatMap((name) => (files[name] ?? "").split("\n"))
    .filter((line) => pattern.test(line));
}

/** What a connection method returns, from its signature line. */
const returns = (line: string) => line.replace(/^.*RequestOption\) /, "");

describe("a realtime operation with declared messages: its types", () => {
  it("returns a connection typed both ways, a keyed op its own connection type", () => {
    expect({
      keyed: lines(KEYED, /\) Join\(ctx/).map(returns),
      messages: lines(MESSAGES, /\) Join\(ctx/).map(returns),
      onlyMessage: lines(ONLY_MESSAGE, /\) Tap\(ctx/).map(returns),
    }).toEqual({
      keyed: ["(*RoomJoinConnection, error) {"],
      messages: ["(*ResumableConnection[RoomOut, RoomIn], error) {"],
      onlyMessage: ["(*ResumableConnection[FeedTapInbound, any], error) {"],
    });
  });

  it("writes a sealed interface per keyed direction, Other on the read side, and On<Value> per member but message", () => {
    const decls = /^type (RoomJoin|FeedTap)(?!Opts)\w* |^func \(s \*\w+Connection\) On/;
    expect({ keyed: lines(KEYED, decls), onlyMessage: lines(ONLY_MESSAGE, decls) }).toEqual({
      keyed: [
        "type RoomJoinConnection struct {",
        "func (s *RoomJoinConnection) OnSaid(handler func(RoomSaid)) {",
        "func (s *RoomJoinConnection) OnLeft(handler func(RoomLeft)) {",
        "type RoomJoinInbound interface {",
        "type RoomJoinOtherMessage struct {",
        "type RoomJoinOutbound interface {",
      ],
      onlyMessage: [
        "type FeedTapInbound interface {",
        "type FeedTapOtherMessage struct {",
        "type FeedTapSendMessage struct {",
      ],
    });
  });
});

/** A consumer that spells each connection, sends a member, reads the union and takes a member by its value. */
const SPELLED = `	var join func(context.Context, *sdk.RoomJoinOpts, ...sdk.RequestOption) (*sdk.RoomJoinConnection, error) = client(input.Base).Room.Join
	var conn *sdk.RoomJoinConnection
	use := func() {
		var typed *sdk.ResumableConnection[sdk.RoomJoinInbound, sdk.RoomJoinOutbound] = conn.ResumableConnection
		var events <-chan sdk.RoomJoinInbound = conn.Events()
		_ = conn.Send(ctx, sdk.RoomSay{Text: "hi", Type: "say"})
		_ = conn.SendText(ctx, "raw")
		switch m := (<-events).(type) {
		case sdk.RoomSaid:
			note(m.Text)
		case sdk.RoomLeft:
			note(m.Type)
		case sdk.RoomJoinOtherMessage:
			note(string(m.Raw))
		}
		conn.OnSaid(func(m sdk.RoomSaid) { note(m.Text) })
		conn.OnMessage(func(m sdk.RoomJoinInbound) { note(m) })
		var plain *sdk.ResumableConnection[any, any] = sdk.NewResumableConnection("http://rt.test", nil, nil)
		_, _ = typed, plain
	}
	_, _ = join, use`;

/** Each misuse a typed connection refuses at compile time, with the error Go gives for it. */
const MISUSE: readonly (readonly [string, string])[] = [
  [
    "conn.Send(ctx, sdk.RoomSaid{})",
    "sdk.RoomSaid does not implement sdk.RoomJoinOutbound (missing method isRoomJoinOutbound)",
  ],
  ["var _ <-chan sdk.RoomSaid = conn.Events()", "cannot use conn.Events()"],
  ["conn.OnSay(func(m sdk.RoomSay) {})", "conn.OnSay undefined"],
];

const misuse = (statement: string) => `	var conn *sdk.RoomJoinConnection
	if conn != nil {
		${statement}
	}`;

describe.skipIf(!GO)("a realtime operation with declared messages, compiled", SLOW, () => {
  it("spells each connection, sends a member, switches on what it reads, and takes a member by its value", () => {
    const files = generateGoSdk(KEYED, { modulePath: MODULE }).files;
    expect(seen(check(files, MODULE, SPELLED))).toEqual({ built: true, out: undefined, vet: [] });
  });

  it("refuses a send the server does not receive, Events of a member, and a handler for a value it does not send", () => {
    const files = generateGoSdk(KEYED, { modulePath: MODULE }).files;

    const refused = MISUSE.map(([statement, error]) => {
      const run = check(files, MODULE, misuse(statement));

      return [statement, run.built, run.stderr.includes(error)];
    });

    expect(refused).toEqual(MISUSE.map(([statement]) => [statement, false, true]));
  });
});

/** The keyed room: handler runs, then the Events and Errors values in order, and what the server got. */
const ROOM = `	live := sdk.NewClient(sdk.Config{BaseURL: input.Base})
	conn, err := live.Room.Join(ctx, nil)
	if err != nil {
		note("dial:", err)
		return
	}
	ran := make(chan string, 16)
	conn.OnMessage(func(m sdk.RoomJoinInbound) { ran <- fmt.Sprintf("message %T", m) })
	conn.OnSaid(func(m sdk.RoomSaid) { ran <- "said " + m.Text })
	note("send", conn.Send(ctx, sdk.RoomSay{Text: "hi", Type: "say"}))
	note("send", conn.SendText(ctx, "plain"))
	for range 3 {
		m := <-conn.Events()
		raw, _ := json.Marshal(m)
		note("event", fmt.Sprintf("%T", m), string(raw))
	}
	failed := <-conn.Errors()
	var decode *sdk.DecodeError
	note("error", errors.As(failed, &decode), failed)
	note("close", conn.Close())
	for range 4 {
		note(<-ran)
	}`;

/** The room's server: two messages received, then a said, no JSON, a left and a value the op does not declare. */
const ROOM_REPLY: Reply = {
  status: 101,
  ws: {
    steps: [
      { receive: 2 },
      { json: { text: "yo", type: "said" } },
      { text: "not json" },
      { json: { type: "left" } },
      { json: { type: "wave" } },
    ],
  },
};

/** What ROOM notes against ROOM_REPLY: the sends, the three messages, the decode error, then the handler runs. */
const ROOM_NOTES = [
  "send <nil>",
  "send <nil>",
  'event sdk.RoomSaid {"text":"yo","type":"said"}',
  'event sdk.RoomLeft {"type":"left"}',
  'event sdk.RoomJoinOtherMessage {"type":"wave"}',
  "error true httpsdk: decode response: realtime message is not valid JSON: invalid character 'o' in literal null (expecting 'u')",
  "close <nil>",
  "message sdk.RoomSaid",
  "said yo",
  "message sdk.RoomLeft",
  "message sdk.RoomJoinOtherMessage",
];

/** The counter over two dials: each message's n exact, and the second dial resuming from the first's cursor. */
const COUNT = `	live := sdk.NewClient(sdk.Config{BaseURL: input.Base})
	conn, err := live.Feed.Count(ctx, &sdk.FeedCountOpts{Transport: sdk.TransportOpts{ReconnectDelayMs: 10}})
	if err != nil {
		note("dial:", err)
		return
	}
	for range 2 {
		m := <-conn.Events()
		note("n", m.N)
	}
	id, token := conn.Cursor()
	note("cursor", id, token)
	note("close", conn.Close())`;

describe.skipIf(!GO)("a realtime operation with declared messages on the wire", SLOW, () => {
  it("sends JSON, hands a message to OnMessage and On<Value>, reads an undeclared one as Other, and errors on no JSON", async () => {
    const files = generateGoSdk(KEYED, { modulePath: MODULE }).files;

    const { received, run } = await served([ROOM_REPLY], async (server) => ({
      run: await consume(files, MODULE, { base: server.url, body: ROOM, imports: ["errors"] }),
      received: server.streams[0]?.received ?? [],
    }));

    expect({ built: run.built, out: run.out?.main, vet: run.vet }, run.stderr).toEqual({
      built: true,
      out: ROOM_NOTES,
      vet: [],
    });
    expect(received.flatMap((frame) => (frame.kind === "text" ? [frame.text] : []))).toEqual([
      '{"text":"hi","type":"say"}',
      "plain",
    ]);
  });

  it("decodes an int64 past 2^53 exact, and a reconnect resumes from the last message's cursor", async () => {
    const files = generateGoSdk(COUNTS, { modulePath: MODULE }).files;

    const first: Reply = {
      status: 101,
      ws: {
        steps: [
          { text: '{"id":"5","n":9007199254740993,"reconnect_token":"rt-5"}' },
          { close: { code: 1011, reason: "restart" } },
        ],
      },
    };

    const second: Reply = { status: 101, ws: { steps: [{ text: '{"n":-9007199254740993}' }] } };

    const { run, urls } = await served([first, second], async (server) => ({
      run: await consume(files, MODULE, { base: server.url, body: COUNT }),
      urls: server.hops.map((hop) => hop.url),
    }));

    expect({ built: run.built, out: run.out?.main, urls, vet: run.vet }, run.stderr).toEqual({
      built: true,
      out: ["n 9007199254740993", "n -9007199254740993", "cursor 5 rt-5", "close <nil>"],
      urls: ["/tap", "/tap?last_event_id=5&reconnect_token=rt-5"],
      vet: [],
    });
  });
});
