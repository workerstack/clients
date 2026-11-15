/**
 * A WebSocket operation with declared messages (`x-websocket` `send` and `receive`) in the Go SDK: its socket is
 * `TypedWebSocket[In, Out]`, `In` what the server sends and `Out` what it receives, so `Send` takes only what the
 * server receives and `Read` gives what it sends. A union keyed on one field (D9) is a sealed interface per direction
 * (D16), `<Op>Inbound` and `<Op>Outbound`, and the read side's members each get `On<Value>` on a per-op `<Op>Socket`,
 * except one whose value names a socket handler (message, close, error). A value the op does not declare reads as
 * `<Op>OtherMessage`, as sent. Every send is JSON; a frame that is no JSON is a `*DecodeError` from `Read`, fired at
 * `OnError`, and the socket stays open. An op without messages reads `TypedWebSocket[[]byte, any]`.
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

const MODULE = "example.com/sockets";

const spec = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, `../../ir/__fixtures__/specs/streams/${name}.json`), "utf8"),
  ) as Json;

const KEYED = spec("ws-keyed");
const MESSAGES = spec("ws-messages");

/** A keyed op whose union is inline: its members are the types the union hoists for them. */
const INLINE: Json = {
  info: { title: "Inline", version: "1" },
  openapi: "3.2.1",
  paths: {
    "/feed": {
      get: {
        operationId: "feed.join",
        responses: { 101: { description: "Switching Protocols" } },
        "x-websocket": {
          send: {
            discriminator: { propertyName: "type" },
            oneOf: [
              {
                properties: { text: { type: "string" }, type: { const: "said" } },
                required: ["type", "text"],
                type: "object",
              },
              { properties: { type: { const: "left" } }, required: ["type"], type: "object" },
            ],
          },
        },
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

/** What a socket method returns, from its signature line. */
const returns = (line: string) => line.replace(/^.*RequestOption\) /, "");

describe("a WebSocket operation with declared messages: its types", () => {
  it("returns a socket typed both ways, a keyed op its own socket type", () => {
    expect({
      inline: lines(INLINE, /\) Join\(ctx/).map(returns),
      keyed: lines(KEYED, /\) Open\(ctx/).map(returns),
      messages: lines(MESSAGES, /\) Open\(ctx/).map(returns),
    }).toEqual({
      inline: ["(*FeedJoinSocket, error) {"],
      keyed: ["(*ChatOpenSocket, error) {", "(*TypedWebSocket[Note, any], error) {"],
      messages: ["(*TypedWebSocket[ServerFrame, ChatOpenOutbound], error) {"],
    });
  });

  it("writes a sealed interface per keyed direction, Other on the read side, and On<Value> per member left", () => {
    expect({
      inline: lines(INLINE, /^func \(s \*\w+Socket\) On/),
      keyed: lines(KEYED, /^type ChatOpen(?!Opts)\w* |^func \(s \*\w+Socket\) On/),
    }).toEqual({
      inline: [
        "func (s *FeedJoinSocket) OnSaid(handler func(FeedJoinSendSaid)) {",
        "func (s *FeedJoinSocket) OnLeft(handler func(FeedJoinSendLeft)) {",
      ],
      keyed: [
        "type ChatOpenInbound interface {",
        "type ChatOpenOtherMessage struct {",
        "type ChatOpenOutbound interface {",
        "type ChatOpenSocket struct {",
        "func (s *ChatOpenSocket) OnSaid(handler func(Said)) {",
      ],
    });
  });
});

/** A consumer that spells each socket, sends a member, reads the union and takes a member by its value. */
const SPELLED = `	var chat func(context.Context, *sdk.ChatOpenOpts, ...sdk.RequestOption) (*sdk.ChatOpenSocket, error) = client(input.Base).Chat.Open
	var notes func(context.Context, *sdk.NotesOpenOpts, ...sdk.RequestOption) (*sdk.TypedWebSocket[sdk.Note, any], error) = client(input.Base).Notes.Open
	var socket *sdk.ChatOpenSocket
	use := func() {
		var typed *sdk.TypedWebSocket[sdk.ChatOpenInbound, sdk.ChatOpenOutbound] = socket.TypedWebSocket
		_ = socket.Send(ctx, sdk.Say{Text: "hi", Type: "say"})
		_ = socket.Send(ctx, sdk.Ping{Type: "ping"})
		_ = socket.SendText(ctx, "raw")
		var read sdk.ChatOpenInbound
		read, _ = socket.Read(ctx)
		switch m := read.(type) {
		case sdk.Said:
			note(m.Text)
		case sdk.Closing:
			note(m.Reason)
		case sdk.ChatOpenOtherMessage:
			note(string(m.Raw))
		}
		socket.OnSaid(func(m sdk.Said) { note(m.Text) })
		socket.OnMessage(func(m sdk.ChatOpenInbound) { note(m) })
		socket.OnClose(func(reason string) { note(reason) })
		socket.OnError(func(err error) { note(err) })
		_ = typed
	}
	_, _, _ = chat, notes, use`;

/** Each misuse a typed socket refuses at compile time, with the error Go gives for it. */
const MISUSE: readonly (readonly [string, string])[] = [
  [
    "socket.Send(ctx, sdk.Said{})",
    "sdk.Said does not implement sdk.ChatOpenOutbound (missing method isChatOpenOutbound)",
  ],
  ["socket.OnClose(func(m sdk.Closing) {})", "as func(reason string) value in argument to socket.OnClose"],
  ["socket.OnPing(func(m sdk.Ping) {})", "socket.OnPing undefined"],
];

const misuse = (statement: string) => `	var socket *sdk.ChatOpenSocket
	if socket != nil {
		${statement}
	}`;

describe.skipIf(!GO)("a WebSocket operation with declared messages, compiled", SLOW, () => {
  it("spells each socket, sends a member, switches on what it reads, and takes a member by its value", () => {
    const files = generateGoSdk(KEYED, { modulePath: MODULE }).files;
    expect(seen(check(files, MODULE, SPELLED))).toEqual({ built: true, out: undefined, vet: [] });
  });

  it("compiles an inline union's members as the types it hoists for them", () => {
    const files = generateGoSdk(INLINE, { modulePath: MODULE }).files;

    const body = `	var socket *sdk.FeedJoinSocket
	if socket != nil {
		socket.OnSaid(func(m sdk.FeedJoinSendSaid) { note(m.Text) })
		socket.OnLeft(func(m sdk.FeedJoinSendLeft) { note(m.Type) })
	}`;

    expect(seen(check(files, MODULE, body))).toEqual({ built: true, out: undefined, vet: [] });
  });

  it("refuses a send the server does not receive, a member as OnClose and a handler for a value it does not send", () => {
    const files = generateGoSdk(KEYED, { modulePath: MODULE }).files;

    const refused = MISUSE.map(([statement, error]) => {
      const run = check(files, MODULE, misuse(statement));

      return [statement, run.built, run.stderr.includes(error)];
    });

    expect(refused).toEqual(MISUSE.map(([statement]) => [statement, false, true]));
  });

  it("gives an op whose read side is not keyed no On<Value>", () => {
    const files = generateGoSdk(MESSAGES, { modulePath: MODULE }).files;

    const body = `	var socket *sdk.TypedWebSocket[sdk.ServerFrame, sdk.ChatOpenOutbound]
	if socket != nil {
		socket.OnSaid(func(m sdk.ServerFrame) {})
	}`;

    const run = check(files, MODULE, body);
    expect({ built: run.built, refused: run.stderr.includes("socket.OnSaid undefined") }).toEqual({
      built: false,
      refused: true,
    });
  });
});

/** Sends, reads and handler calls on the keyed chat, noted in order. */
const CHAT = `	live := sdk.NewClient(sdk.Config{BaseURL: input.Base})
	socket, err := live.Chat.Open(ctx, nil)
	if err != nil {
		note("dial:", err)
		return
	}
	socket.OnMessage(func(m sdk.ChatOpenInbound) {
		raw, _ := json.Marshal(m)
		note("message", fmt.Sprintf("%T", m), string(raw))
	})
	socket.OnSaid(func(m sdk.Said) { note("said", m.Text) })
	socket.OnError(func(err error) { note("error", err) })
	socket.OnClose(func(reason string) { note("close", reason) })
	note("send", socket.Send(ctx, sdk.Say{Text: "hi", Type: "say"}))
	note("send", socket.SendText(ctx, "plain"))
	for range 5 {
		m, err := socket.Read(ctx)
		var decode *sdk.DecodeError
		note("read", fmt.Sprintf("%T", m), errors.As(err, &decode), err)
	}`;

describe.skipIf(!GO)("a WebSocket operation with declared messages on the wire", SLOW, () => {
  it("sends JSON, hands a frame to OnMessage and On<Value>, reads an undeclared one as Other, and errors on no JSON", async () => {
    const files = generateGoSdk(KEYED, { modulePath: MODULE }).files;

    const reply: Reply = {
      status: 101,
      ws: {
        steps: [
          { receive: 2 },
          { json: { text: "yo", type: "said" } },
          { text: "not json" },
          { json: { reason: "bye", type: "close" } },
          { json: { type: "wave" } },
          { close: { code: 1000, reason: "done" } },
        ],
      },
    };

    const { received, run } = await served([reply], async (server) => ({
      run: await consume(files, MODULE, { base: server.url, body: CHAT, imports: ["errors"] }),
      received: server.streams[0]?.received ?? [],
    }));

    expect({ built: run.built, out: run.out?.main, vet: run.vet }, run.stderr).toEqual({
      built: true,
      out: [
        "send <nil>",
        "send <nil>",
        'message sdk.Said {"text":"yo","type":"said"}',
        "said yo",
        "read sdk.Said false <nil>",
        "error httpsdk: decode response: WebSocket frame is not valid JSON: invalid character 'o' in literal null (expecting 'u')",
        "read <nil> true httpsdk: decode response: WebSocket frame is not valid JSON: invalid character 'o' in literal null (expecting 'u')",
        'message sdk.Closing {"reason":"bye","type":"close"}',
        "read sdk.Closing false <nil>",
        'message sdk.ChatOpenOtherMessage {"type":"wave"}',
        "read sdk.ChatOpenOtherMessage false <nil>",
        "close done",
        'read <nil> false failed to get reader: received close frame: status = StatusNormalClosure and reason = "done"',
      ],
      vet: [],
    });
    expect(received.flatMap((frame) => (frame.kind === "text" ? [frame.text] : []))).toEqual([
      '{"text":"hi","type":"say"}',
      "plain",
    ]);
  });
});
