/**
 * A WebSocket operation with declared messages (`x-websocket` `send` and `receive`) in the C# SDK (D9, D17): its
 * socket is `TypedWebSocket<TIn, TOut>`, `TIn` what the server sends and `TOut` what it receives, so `SendAsync`
 * takes only what the server receives and `ReceiveAsync` gives what it sends. A direction keyed on one field is
 * `<Op>Inbound` or `<Op>Outbound`, an abstract record with one nested sealed record per member wrapping its variant
 * as `Value`, the read side's `Unknown` keeping an undeclared value as `Raw`, the send side converting from each
 * variant implicitly; each read-side member gets an `On<Value>` extension, except one whose value names a socket
 * event (message, close, error). Every `SendAsync` is JSON; a frame that is no JSON throws `DecodeException` from
 * `ReceiveAsync`, fires `Error`, and the socket reads on; so does JSON that does not decode. An op without messages
 * keeps `TypedWebSocket`, its frames as bytes.
 */
import { describe, expect, it } from "vitest";

import { typedStreams } from "../shared/__fixtures__/documents-typed.ts";
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts";
import { checked, consume, program, seen } from "./__fixtures__/consumer.ts";
import { withDotnet } from "./__fixtures__/csharp-env.ts";
import { FIXTURES } from "./__fixtures__/documents.ts";
import { generateCSharpSdk } from "./sdk.ts";

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet();

/** Every compiled or executed describe's bound: a cold gate builds the SDK first. */
const SLOW = { timeout: 600_000 };

const typed = generateCSharpSdk(typedStreams()).files;

/** Every line of `text` that matches `pattern`, trimmed. */
const lines = (text: string | undefined, pattern: RegExp) =>
  (text ?? "")
    .split("\n")
    .filter((line) => pattern.test(line))
    .map((line) => line.trim());

/** The realtime ops' message types, which realtime.typed.test.ts asserts. */
const REALTIME = /OnlyFeedTap|RoomRoomJoin/;

/** Every line of Types.cs that matches `pattern` and names no realtime op's type, trimmed. */
const wsLines = (pattern: RegExp) => lines(typed["Types.cs"], pattern).filter((line) => !REALTIME.test(line));

/** What each WebSocket method of `files` answers, its normal and its twin, from its signature line. */
const sockets = (files: Readonly<Record<string, string>>) =>
  lines(files["Client.cs"], /public Task<TypedWebSocket/).map((line) =>
    line.replace(/^public (Task<TypedWebSocket(?:<[^>]*>)?>) .*$/, "$1"),
  );

/** What each typed op's socket is, in the order Client.cs declares the ops. */
const TYPED = [
  "Task<TypedWebSocket<InlineFeedJoinInbound, JsonElement>>",
  "Task<TypedWebSocket<KeyedChatOpenInbound, KeyedChatOpenOutbound>>",
  "Task<TypedWebSocket<JsonElement, JsonElement>>",
  "Task<TypedWebSocket<JsonElement, TellFeedTellReceive>>",
  "Task<TypedWebSocket<WsServerFrame, WsChatOpenOutbound>>",
];

describe("a WebSocket operation with declared messages: its types", () => {
  it("answers a socket typed both ways, a missing side JsonElement, an op without messages untyped", () => {
    expect({
      typed: sockets(typed),
      untyped: sockets(generateCSharpSdk(FIXTURES.ws.document()).files),
    }).toEqual({
      // the methods, then their client.Safe twins
      typed: [...TYPED, ...TYPED],
      untyped: ["Task<TypedWebSocket>", "Task<TypedWebSocket>", "Task<TypedWebSocket>", "Task<TypedWebSocket>"],
    });
  });

  it("declares a keyed side as a record per member, Unknown on the read side, an implicit conversion on the send side", () => {
    expect(
      wsLines(
        /^public abstract record \w+bound$|^ {4}public sealed record \w+\(.*\) : \w+bound;$|^ {4}public static implicit operator /,
      ),
    ).toEqual([
      "public abstract record InlineFeedJoinInbound",
      "public sealed record Said(InlineFeedJoinSendSaid Value) : InlineFeedJoinInbound;",
      "public sealed record Left(InlineFeedJoinSendLeft Value) : InlineFeedJoinInbound;",
      "public sealed record Unknown(JsonElement Raw) : InlineFeedJoinInbound;",
      "public abstract record KeyedChatOpenInbound",
      "public sealed record Said(KeyedSaid Value) : KeyedChatOpenInbound;",
      "public sealed record Close(KeyedClosing Value) : KeyedChatOpenInbound;",
      "public sealed record Unknown(JsonElement Raw) : KeyedChatOpenInbound;",
      "public abstract record KeyedChatOpenOutbound",
      "public sealed record Say(KeyedSay Value) : KeyedChatOpenOutbound;",
      "public sealed record Ping(KeyedPing Value) : KeyedChatOpenOutbound;",
      "public static implicit operator KeyedChatOpenOutbound(KeyedSay value) => new Say(value);",
      "public static implicit operator KeyedChatOpenOutbound(KeyedPing value) => new Ping(value);",
      "public abstract record WsChatOpenOutbound",
      "public sealed record Say(WsSay Value) : WsChatOpenOutbound;",
      "public sealed record Leave(WsLeave Value) : WsChatOpenOutbound;",
      "public static implicit operator WsChatOpenOutbound(WsSay value) => new Say(value);",
      "public static implicit operator WsChatOpenOutbound(WsLeave value) => new Leave(value);",
    ]);
  });

  it("gives each keyed read side an On<Value> per member a socket event does not name, an inline one too", () => {
    expect(wsLines(/^public static class \w+Extensions$|^ {4}public static void On\w+</)).toEqual([
      "public static class InlineFeedJoinInboundExtensions",
      "public static void OnSaid<TOut>(this TypedWebSocket<InlineFeedJoinInbound, TOut> socket, Action<InlineFeedJoinSendSaid> handler)",
      "public static void OnLeft<TOut>(this TypedWebSocket<InlineFeedJoinInbound, TOut> socket, Action<InlineFeedJoinSendLeft> handler)",
      "public static class KeyedChatOpenInboundExtensions",
      "public static void OnSaid<TOut>(this TypedWebSocket<KeyedChatOpenInbound, TOut> socket, Action<KeyedSaid> handler)",
    ]);
  });
});

/** A record schema keyed `type` on `value`, with one more string field `field`. */
const member = (value: string, field: string) => ({
  properties: { [field]: { type: "string" }, type: { const: value } },
  required: ["type", field],
  type: "object",
});

/** One keyed WebSocket op whose server sends two members of one value: `said` twice, then `left`. */
const SHARED = {
  components: {
    schemas: {
      Echoed: member("said", "echo"),
      Left: member("left", "who"),
      Said: member("said", "text"),
      Out: {
        discriminator: { propertyName: "type" },
        oneOf: [
          { $ref: "#/components/schemas/Said" },
          { $ref: "#/components/schemas/Echoed" },
          { $ref: "#/components/schemas/Left" },
        ],
      },
    },
  },
  info: { title: "Shared", version: "1" },
  openapi: "3.1.0",
  paths: {
    "/shared": {
      get: {
        operationId: "shared.open",
        responses: { 101: { description: "Switching Protocols" } },
        "x-websocket": { send: { $ref: "#/components/schemas/Out" } },
      },
    },
  },
};

describe("a keyed WebSocket side whose members share a value", () => {
  it("keeps the first member of a value: one record, one converter arm and one On<Value> each", () => {
    const text = generateCSharpSdk(SHARED).files["Types.cs"] ?? "";
    expect(
      lines(
        text,
        /^ {4}public sealed record \w+\(.*\) : SharedOpenInbound;$|^ {12}"\w+" => new SharedOpenInbound|OnSaid|OnLeft/,
      ),
    ).toEqual([
      "public sealed record SaidMessage(Said Value) : SharedOpenInbound;",
      "public sealed record LeftMessage(Left Value) : SharedOpenInbound;",
      "public sealed record Unknown(JsonElement Raw) : SharedOpenInbound;",
      '"said" => new SharedOpenInbound.SaidMessage(raw.Deserialize((JsonTypeInfo<Said>)options.GetTypeInfo(typeof(Said))) ?? throw new JsonException("a SaidMessage message is null")),',
      '"left" => new SharedOpenInbound.LeftMessage(raw.Deserialize((JsonTypeInfo<Left>)options.GetTypeInfo(typeof(Left))) ?? throw new JsonException("a LeftMessage message is null")),',
      "public static void OnSaid<TOut>(this TypedWebSocket<SharedOpenInbound, TOut> socket, Action<Said> handler)",
      "public static void OnLeft<TOut>(this TypedWebSocket<SharedOpenInbound, TOut> socket, Action<Left> handler)",
    ]);
  });
});

/** Holds each typed socket in its declared type, sends a member, takes each handler and matches a read with is. */
const SPELLED = `using var c = Client();
Func<Task<TypedWebSocket<KeyedChatOpenInbound, KeyedChatOpenOutbound>>> chat = () => c.Keyed.Chat.OpenAsync();
Func<Task<TypedWebSocket<JsonElement, JsonElement>>> notes = () => c.Keyed.Notes.OpenAsync();
Func<Task<TypedWebSocket<WsServerFrame, WsChatOpenOutbound>>> frames = () => c.Ws.Chat.OpenAsync();
Func<Task<TypedWebSocket<InlineFeedJoinInbound, JsonElement>>> join = () => c.Inline.Feed.JoinAsync();
Func<Task<TypedWebSocket<JsonElement, TellFeedTellReceive>>> tell = () => c.Tell.Feed.TellAsync();
Func<TypedWebSocket<KeyedChatOpenInbound, KeyedChatOpenOutbound>, Task> use = async s =>
{
    await s.SendAsync(new KeyedSay { Text = "hi", Type = "say" });
    await s.SendAsync(new KeyedChatOpenOutbound.Ping(new KeyedPing { Type = "ping" }));
    await s.SendAsync("raw");
    s.OnSaid(m => Note(m.Text));
    s.Message += (KeyedChatOpenInbound m) => Note(m.GetType().Name);
    s.Closed += (WsClose close) => Note(close.Reason);
    s.Error += (Exception e) => Note(e.Message);
    KeyedChatOpenInbound? read = await s.ReceiveAsync();
    Note(read is KeyedChatOpenInbound.Said said ? said.Value.Text : read is KeyedChatOpenInbound.Unknown u ? u.Raw.GetRawText() : "");
};
Func<TypedWebSocket<InlineFeedJoinInbound, JsonElement>, Task> feed = async f =>
{
    f.OnSaid((InlineFeedJoinSendSaid m) => Note(m.Text));
    f.OnLeft((InlineFeedJoinSendLeft m) => Note(m.Type));
    JsonElement any = default;
    await f.SendAsync(any);
};
Note("typed");`;

/** Each misuse a typed socket refuses at compile time, with the error csc gives for it. */
const MISUSE: readonly (readonly [string, string, string])[] = [
  [
    "a send the server does not receive",
    'Func<TypedWebSocket<KeyedChatOpenInbound, KeyedChatOpenOutbound>, Task> f = s => s.SendAsync(new KeyedSaid { Text = "hi", Type = "said" });',
    "error CS1503: Argument 1: cannot convert from 'HttpSdk.KeyedSaid' to 'HttpSdk.KeyedChatOpenOutbound'",
  ],
  [
    // CS1929, not CS1061: another op's OnSaid is in scope, for another receiver
    "On<Value> on an op whose read side is unkeyed",
    "Action<TypedWebSocket<WsServerFrame, WsChatOpenOutbound>> f = s => s.OnSaid(_ => { });",
    "error CS1929: 'TypedWebSocket<WsServerFrame, WsChatOpenOutbound>' does not contain a definition for 'OnSaid'",
  ],
  [
    "a member whose value names a socket event",
    "Action<TypedWebSocket<KeyedChatOpenInbound, KeyedChatOpenOutbound>> f = s => s.OnClose(_ => { });",
    "error CS1061: 'TypedWebSocket<KeyedChatOpenInbound, KeyedChatOpenOutbound>' does not contain a definition for 'OnClose'",
  ],
];

describe.skipIf(!DOTNET)("a WebSocket operation with declared messages, compiled", SLOW, () => {
  it("spells each socket, sends a member through its implicit conversion, takes each handler, matches a read", async () => {
    const run = await consume("typed", "ws-spelled", { body: SPELLED });
    expect(seen(run), run.stderr).toEqual({ out: ["typed"], ran: true });
  });

  it("refuses a send the server does not receive, On<Value> on an unkeyed op, and a member's OnClose", () => {
    const refused = MISUSE.map(([name, body, error]) => {
      const errors = checked("typed", program("HttpSdk", "HttpSdkClient", body));

      return [name, errors.length > 0 && errors.every((line) => line.includes(error)), errors];
    });

    expect(
      refused.map(([name, matched]) => [name, matched]),
      JSON.stringify(refused),
    ).toEqual(MISUSE.map(([name]) => [name, true]));
  });
});

/** Sends on the keyed chat, then six reads, each handler run and read noted in the order it happens. */
const CHAT = `using var c = Client();
var s = await c.Keyed.Chat.OpenAsync();
s.Message += m => Note($"message {m.GetType().Name}");
s.OnSaid(m => Note($"said {m.Text}"));
s.Error += e => Note($"error {e.GetType().Name} {e.Message.Split(':')[0]}");
s.Closed += close => Note($"close {close.Reason}");
await s.SendAsync(new KeyedSay { Text = "hi", Type = "say" });
await s.SendAsync("plain");
for (var i = 0; i < 6; i++)
{
    try
    {
        var read = await s.ReceiveAsync();
        Note(read switch
        {
            null => "read none",
            KeyedChatOpenInbound.Said said => $"read said {said.Value.Text}",
            KeyedChatOpenInbound.Close closing => $"read close {closing.Value.Reason}",
            KeyedChatOpenInbound.Unknown u => $"read unknown {u.Raw.GetRawText()}",
            _ => "read other",
        });
    }
    catch (DecodeException e)
    {
        Note($"read {e.GetType().Name} {e.Message.Split(':')[0]}");
    }
}`;

describe.skipIf(!DOTNET)("a WebSocket operation with declared messages on the wire", SLOW, () => {
  it("sends JSON, hands a frame to Message and OnSaid, reads an undeclared one as Unknown, throws on no JSON or a misfit", async () => {
    const reply: Reply = {
      status: 101,
      ws: {
        steps: [
          { receive: 2 },
          { json: { text: "yo", type: "said" } },
          { text: "not json" },
          { json: { type: "said" } },
          { json: { reason: "bye", type: "close" } },
          { json: { type: "wave" } },
          { close: { code: 1000, reason: "done" } },
        ],
      },
    };

    const { received, run } = await served([reply], async (server) => ({
      run: await consume("typed", "ws-chat", { base: server.url, body: CHAT }),
      received: server.streams[0]?.received ?? [],
    }));

    expect(seen(run), run.stderr).toEqual({
      out: [
        "message Said",
        "said yo",
        "read said yo",
        "error DecodeException WebSocket frame is not valid JSON",
        "read DecodeException WebSocket frame is not valid JSON",
        "error DecodeException WebSocket frame does not decode",
        "read DecodeException WebSocket frame does not decode",
        "message Close",
        "read close bye",
        "message Unknown",
        'read unknown {"type":"wave"}',
        "close done",
        "read none",
      ],
      ran: true,
    });
    expect(received.flatMap((frame) => (frame.kind === "text" ? [frame.text] : []))).toEqual([
      '{"text":"hi","type":"say"}',
      "plain",
    ]);
  });
});
