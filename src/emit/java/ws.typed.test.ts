/**
 * A WebSocket operation with declared messages (`x-websocket` `send` and `receive`) in the Java SDK (D9, D17): its
 * socket is `TypedWebSocket<TIn, TOut>`, `TIn` what the server sends and `TOut` what it receives, so `send` takes only
 * what the server receives, as JSON, and `receive` gives what it sends. A direction keyed on one field is the sealed
 * interface Java already declares for the union, one wrapper record per member plus `<Union>Unknown`; a keyed read side
 * answers `<Read>Socket<TOut>`, a `TypedWebSocket` with an `on<Value>` per member that matches inside `onMessage`, none
 * for a value that names a handler (message, closed, error). A side the op does not declare is `WsMessage` read,
 * `JsonNode` sent, so an untyped `send("raw")` no longer compiles: `sendText` and `sendBinary` send raw frames. A typed
 * frame that is no JSON throws `DecodeException` from `receive`, reaches `onError`, and the socket reads on; a binary
 * frame is read as UTF-8 JSON. The subclass and handler names are claimed, so a `socket` member and two values that
 * spell one handler compile.
 */
import { describe, expect, it } from "vitest";

import { type Reply, served } from "../shared/__fixtures__/recording-server.ts";
import { compiledJavaSdk, type JavaRun } from "./__fixtures__/compiled.ts";
import { FIXTURES } from "./__fixtures__/documents.ts";
import { withJava } from "./__fixtures__/java-env.ts";
import { FAKE } from "./__fixtures__/socket-probe.ts";
import { generateJavaSdk } from "./sdk.ts";

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava();

/** Every compiled or executed describe's bound: a cold gate builds the SDK first. */
const SLOW = { timeout: 600_000 };

const PACKAGE = "src/main/java/com/example";
const STRING = { type: "string" };

type Json = Record<string, unknown>;

/** The SDK of `document`'s files. */
const filesOf = (document: Json) => generateJavaSdk(document).files;

/** The `typed` document. */
const TYPED = () => FIXTURES.typed.document() as Json;

/** Every one-argument socket method of `files`, normal and safe, as its signature line, sorted. */
const socketsOf = (files: Readonly<Record<string, string>>) =>
  Object.values(files)
    .flatMap((source) => source.split("\n"))
    .filter((line) => /^ {2}public \w+(<.*>)? \w+\(\w+Params params\) \{$/.test(line))
    .filter((line) => /Socket|TypedWebSocket/.test(line))
    .map((line) => line.trim())
    .sort();

/** The class header and the public method lines of the generated socket `name` in `files`, each joined into one line. */
function socketClass(files: Readonly<Record<string, string>>, name: string): string[] {
  const text = (files[`${PACKAGE}/${name}.java`] ?? "").replaceAll(/\s*\n\s+/g, " ");

  const pattern = new RegExp(
    `public final class ${name}<TOut> extends [^{]*\\{|public ${name}<TOut> on\\w+\\([^)]*\\)`,
    "g",
  );

  return [...text.matchAll(pattern)].map((match) => match[0]);
}

/** A keyed member `value` written inline, with the string fields `fields`. */
const member = (value: string, ...fields: string[]) => ({
  properties: { type: { const: value }, ...Object.fromEntries(fields.map((field) => [field, STRING])) },
  required: ["type", ...fields],
  type: "object",
});

/**
 * One socket op whose read side's members clash: `socket` (its wrapper is `<Read>Socket`), `saidIt` and `said_it`
 * (one handler name), and `message`, `closed` and `error`, which name the socket's own handlers.
 */
const CLASHING: Json = {
  components: {
    schemas: {
      Frame: {
        discriminator: { propertyName: "type" },
        oneOf: [
          member("socket"),
          member("saidIt"),
          member("said_it", "text"),
          member("message"),
          member("closed"),
          member("error"),
        ],
      },
    },
  },
  info: { title: "Clash", version: "1" },
  openapi: "3.1.0",
  paths: {
    "/clash": {
      get: {
        operationId: "clash.open",
        responses: { 101: { description: "Switching Protocols" } },
        "x-websocket": { send: { $ref: "#/components/schemas/Frame" } },
      },
    },
  },
};

// the typed document's sockets: keyed both ways, inline keyed, unkeyed, keyed send alone, receive-only
const SOCKETS = [
  "public InlineFeedJoinSendSocket<JsonNode> join(InlineFeedJoinParams params) {",
  "public KeyedChatOutSocket<KeyedChatIn> open(KeyedChatOpenParams params) {",
  "public TypedWebSocket<JsonNode, JsonNode> open(KeyedNotesOpenParams params) {",
  "public TypedWebSocket<WsMessage, TellFeedTellReceive> tell(TellFeedTellParams params) {",
  "public TypedWebSocket<WsServerFrame, WsClientFrame> open(WsChatOpenParams params) {",
];

describe("a WebSocket operation with declared messages: its types", () => {
  it("answers a keyed read side's socket, an unkeyed side's type, a missing side WsMessage or JsonNode", () => {
    expect({ typed: socketsOf(filesOf(TYPED())), untyped: socketsOf(filesOf(FIXTURES.ws.document())) }).toEqual({
      // each method and its client.safe() twin
      typed: SOCKETS.flatMap((line) => [line, line]).sort(),
      untyped: [
        "public TypedWebSocket<WsMessage, JsonNode> socket(PlainSocketParams params) {",
        "public TypedWebSocket<WsMessage, JsonNode> socket(PlainSocketParams params) {",
        "public TypedWebSocket<WsMessage, JsonNode> socket(RoomsSocketParams params) {",
        "public TypedWebSocket<WsMessage, JsonNode> socket(RoomsSocketParams params) {",
      ],
    });
  });

  it("gives a keyed read side, an inline one too, an on<Value> per member taking its variant", () => {
    const files = filesOf(TYPED());
    expect({
      inline: socketClass(files, "InlineFeedJoinSendSocket"),
      keyed: socketClass(files, "KeyedChatOutSocket"),
    }).toEqual({
      inline: [
        "public final class InlineFeedJoinSendSocket<TOut> extends TypedWebSocket<InlineFeedJoinSend, TOut> {",
        "public InlineFeedJoinSendSocket<TOut> onLeft(Consumer<InlineFeedJoinSendLeftBody> handler)",
        "public InlineFeedJoinSendSocket<TOut> onSaid(Consumer<InlineFeedJoinSendSaidBody> handler)",
      ],
      keyed: [
        "public final class KeyedChatOutSocket<TOut> extends TypedWebSocket<KeyedChatOut, TOut> {",
        "public KeyedChatOutSocket<TOut> onClose(Consumer<KeyedClosing> handler)",
        "public KeyedChatOutSocket<TOut> onSaid(Consumer<KeyedSaid> handler)",
      ],
    });
  });

  it("claims the socket's name past a socket member's wrapper, numbers a second handler name, skips a handler's", () => {
    expect(socketClass(filesOf(CLASHING), "FrameSocket2")).toEqual([
      "public final class FrameSocket2<TOut> extends TypedWebSocket<Frame, TOut> {",
      "public FrameSocket2<TOut> onSaidIt(Consumer<FrameSaidItBody> handler)",
      "public FrameSocket2<TOut> onSaidIt2(Consumer<FrameSaidItBody2> handler)",
      "public FrameSocket2<TOut> onSocket(Consumer<FrameSocketBody> handler)",
    ]);
  });
});

/** A consumer program on `client` at `url` running `body`, each `note(…)` one line of its output. */
const consumer = (url: string, body: string) => `package probe;

import com.example.*;
import java.util.function.Consumer;
import java.util.function.Supplier;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;

public class Probe {
  static void note(Object value) {
    System.out.println(value);
  }

  public static void main(String[] args) throws Exception {
    ExampleClient c = ExampleClient.builder().baseUrl("${url}").build();
${body
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
    System.exit(0);
  }
}
`;

/** The SDK of `document`, compiled clean. */
function compiled(document: Json) {
  const sdk = compiledJavaSdk(filesOf(document));
  expect(sdk.javac.diagnostics).toEqual([]);

  return sdk;
}

/** `body` compiled against the SDK of `document` and run, with a server answering `replies`; what it received too. */
async function consume(document: Json, replies: readonly Reply[], body: string) {
  const sdk = compiled(document);

  return served(replies, async (server) => {
    const ran = await sdk.exec("probe.Probe", consumer(server.url, body));

    const received = server.streams.flatMap((stream) =>
      (stream?.received ?? []).flatMap((frame) => (frame.kind === "text" ? [frame.text] : [])),
    );

    return { out: ran.stdout.split("\n").filter((line) => line !== ""), ran, received };
  });
}

/** The errors javac reports on `run`, each its message alone. */
const errorsOf = (run: JavaRun) =>
  run.diagnostics.filter((line) => / error: /.test(line)).map((line) => line.replace(/^.*error: /, ""));

const OPEN = (resource: string, params: string) => `c.${resource}(${params}.builder().build())`;

/** Holds each typed socket in its declared type, sends a member, takes each handler and matches a read. */
const SPELLED = `Supplier<KeyedChatOutSocket<KeyedChatIn>> chat = () -> ${OPEN("keyed().chat().open", "KeyedChatOpenParams")};
Supplier<KeyedChatOutSocket<KeyedChatIn>> safe = () -> ${OPEN("safe().keyed().chat().open", "KeyedChatOpenParams")};
Supplier<TypedWebSocket<JsonNode, JsonNode>> notes = () -> ${OPEN("keyed().notes().open", "KeyedNotesOpenParams")};
Supplier<TypedWebSocket<WsServerFrame, WsClientFrame>> frames = () -> ${OPEN("ws().chat().open", "WsChatOpenParams")};
Supplier<InlineFeedJoinSendSocket<JsonNode>> join = () -> ${OPEN("inline().feed().join", "InlineFeedJoinParams")};
Supplier<TypedWebSocket<WsMessage, TellFeedTellReceive>> tell = () -> ${OPEN("tell().feed().tell", "TellFeedTellParams")};
Consumer<KeyedChatOutSocket<KeyedChatIn>> use = s -> {
  s.send(new KeyedChatInSay(new KeyedSay("hi", "say")));
  s.sendText("raw");
  s.sendBinary(new byte[] {1});
  s.onSaid(m -> note(m.text())).onClose(m -> note(m.reason()));
  s.onMessage((KeyedChatOut m) -> note(m.getClass().getSimpleName()));
  s.onClosed(close -> note(close.reason()));
  s.onError(e -> note(e.getMessage()));
  KeyedChatOut read = s.receive();
  if (read instanceof KeyedChatOutSaid said) note(said.value().text());
  else if (read instanceof KeyedChatOutUnknown u) note(u.value());
};
Consumer<InlineFeedJoinSendSocket<JsonNode>> feed = f -> {
  f.onSaid((InlineFeedJoinSendSaidBody m) -> note(m.text())).onLeft((InlineFeedJoinSendLeftBody m) -> note(m.type()));
  f.send(JsonNodeFactory.instance.objectNode());
};
Consumer<TypedWebSocket<WsServerFrame, WsClientFrame>> plain = w -> {
  w.send(new WsClientFrameSay(new WsSay("hi", "say")));
  WsServerFrame read = w.receive();
  note(read.text());
};
Consumer<TypedWebSocket<WsMessage, TellFeedTellReceive>> told = t -> {
  t.send(new TellFeedTellReceive("hi"));
  WsMessage read = t.receive();
  note(read.text());
};
note(chat != null && safe != null && notes != null && frames != null && join != null && tell != null);
note(use != null && feed != null && plain != null && told != null);`;

/** Takes each handler of the clashing socket, a `socket` member's and both of one handler name's. */
const CLASHED = `Supplier<FrameSocket2<JsonNode>> open = () -> ${OPEN("clash().open", "ClashOpenParams")};
Consumer<FrameSocket2<JsonNode>> use = s -> s.onSocket(m -> note(m.type())).onSaidIt(m -> note(m.type())).onSaidIt2(m -> note(m.text()));
Consumer<FrameSocket2<JsonNode>> base = s -> s.onMessage(m -> note(m instanceof FrameClosed));
note(open != null && use != null && base != null);`;

/** Each misuse a typed socket refuses at compile time: its document, its body and the error javac gives. */
const MISUSE: readonly (readonly [string, () => Json, string, RegExp])[] = [
  [
    "a send the server does not receive",
    TYPED,
    'Consumer<KeyedChatOutSocket<KeyedChatIn>> f = s -> s.send(new KeyedChatOutSaid(new KeyedSaid("hi", "said")));',
    /^incompatible types: KeyedChatOutSaid cannot be converted to KeyedChatIn$/,
  ],
  [
    "on<Value> on an op whose read side is unkeyed",
    TYPED,
    "Consumer<TypedWebSocket<WsServerFrame, WsClientFrame>> f = s -> s.onSaid(m -> note(m));",
    /^cannot find symbol$/,
  ],
  [
    "a member whose value names a handler: onClosed takes the close, not the member",
    () => CLASHING,
    "Consumer<FrameSocket2<JsonNode>> f = s -> s.onClosed((FrameClosedBody m) -> note(m));",
    /^incompatible types: incompatible parameter types in lambda expression$/,
  ],
  [
    "an untyped socket's send of raw text",
    () => FIXTURES.ws.document(),
    'Consumer<TypedWebSocket<WsMessage, JsonNode>> f = s -> s.send("raw");',
    /^incompatible types: String cannot be converted to JsonNode$/,
  ],
];

describe.skipIf(!JAVA)("a WebSocket operation with declared messages, compiled", SLOW, () => {
  it("spells each socket, sends a member, takes each handler and matches a read with instanceof", async () => {
    const { out, ran } = await consume(TYPED(), [], SPELLED);
    expect({ diagnostics: ran.diagnostics, out, status: ran.status }, ran.stderr).toEqual({
      diagnostics: [],
      out: ["true", "true"],
      status: 0,
    });
  });

  it("compiles a socket member's handler and both handlers of one name", async () => {
    const { out, ran } = await consume(CLASHING, [], CLASHED);
    expect({ diagnostics: ran.diagnostics, out, status: ran.status }, ran.stderr).toEqual({
      diagnostics: [],
      out: ["true"],
      status: 0,
    });
  });

  it("refuses a wrong-direction send, onSaid on an unkeyed op, a member's onClosed and an untyped send of text", () => {
    const refused = MISUSE.map(([name, document, body, error]) => {
      const run = compiled(document()).run("probe.Probe", consumer("http://127.0.0.1:1", body));
      const errors = errorsOf(run);

      return [name, errors.length > 0 && errors.every((line) => error.test(line)), errors] as const;
    });

    expect(
      refused.map(([name, matched]) => [name, matched]),
      JSON.stringify(refused),
    ).toEqual(MISUSE.map(([name]) => [name, true]));
  });
});

/** Sends on the keyed chat, then five reads, each handler run and read noted in the order it happens. */
const CHAT = `KeyedChatOutSocket<KeyedChatIn> s = ${OPEN("keyed().chat().open", "KeyedChatOpenParams")};
s.onMessage(m -> note("message " + m.getClass().getSimpleName()));
s.onSaid(m -> note("said " + m.text())).onClose(m -> note("close " + m.reason()));
s.onError(e -> note("error " + e.getClass().getSimpleName() + " " + e.getMessage().split(":")[0]));
s.onClosed(close -> note("closed " + close.reason()));
s.send(new KeyedChatInSay(new KeyedSay("hi", "say")));
s.sendText("plain");
for (int i = 0; i < 5; i++) {
  try {
    KeyedChatOut read = s.receive();
    if (read == null) note("read none");
    else if (read instanceof KeyedChatOutSaid said) note("read said " + said.value().text());
    else if (read instanceof KeyedChatOutClose closing) note("read close " + closing.value().reason());
    else if (read instanceof KeyedChatOutUnknown u) note("read unknown " + u.value());
  } catch (DecodeException e) {
    note("read " + e.getClass().getSimpleName() + " " + e.getMessage().split(":")[0]);
  }
}`;

/** Sends on the receive-only op, then reads one frame as it came. */
const TELL = `TypedWebSocket<WsMessage, TellFeedTellReceive> t = ${OPEN("tell().feed().tell", "TellFeedTellParams")};
t.send(new TellFeedTellReceive("hi"));
WsMessage read = t.receive();
note(read.type() + " " + read.text());
t.close();`;

/**
 * In the SDK's package, the keyed chat's socket over the runtime's package-private `Socket` and the strict fake: a
 * binary frame holding JSON, then a binary frame that is none, each read noted.
 */
const BINARY = `package com.example;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import tools.jackson.core.type.TypeReference;

final class Probe {
  public static void main(String[] args) {
    Fake fake = new Fake();
    Socket socket = new Socket(Duration.ofSeconds(20));
    KeyedChatOutSocket<KeyedChatIn> s =
        new KeyedChatOutSocket<>(new TypedWebSocket<>(socket, TypedWebSocket.json(new TypeReference<KeyedChatOut>() {})));
    s.onError(e -> System.out.println("error " + e.getMessage().split(":")[0]));
    socket.onOpen(fake);
    byte[] said = "{\\"text\\":\\"yo\\",\\"type\\":\\"said\\"}".getBytes(StandardCharsets.UTF_8);
    socket.onBinary(fake, ByteBuffer.wrap(said), true);
    socket.onBinary(fake, ByteBuffer.wrap(new byte[] {0, 1}), true);
    KeyedChatOut read = s.receive();
    System.out.println(read instanceof KeyedChatOutSaid m ? "said " + m.value().text() : "other " + read);
    try {
      System.out.println("read " + s.receive());
    } catch (DecodeException e) {
      System.out.println("read " + e.getMessage().split(":")[0]);
    }
    System.exit(0);
  }
}

${FAKE}
`;

describe.skipIf(!JAVA)("a WebSocket operation with declared messages on the wire", SLOW, () => {
  it("sends JSON, hands a frame to onMessage and onSaid, reads an undeclared one as Unknown, reads on past no JSON", async () => {
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

    const { out, ran, received } = await consume(TYPED(), [reply], CHAT);
    expect({ out, status: ran.status }, ran.stderr).toEqual({
      out: [
        "message KeyedChatOutSaid",
        "said yo",
        "read said yo",
        "error DecodeException WebSocket frame is not valid JSON",
        "read DecodeException WebSocket frame is not valid JSON",
        "message KeyedChatOutClose",
        "close bye",
        "read close bye",
        "message KeyedChatOutUnknown",
        'read unknown {"type":"wave"}',
        "closed done",
        "read none",
      ],
      status: 0,
    });
    expect(received).toEqual(['{"text":"hi","type":"say"}', "plain"]);
  });

  it("reads a receive-only op's frame as the WsMessage it came as, and sends its type as JSON", async () => {
    const reply: Reply = { status: 101, ws: { steps: [{ receive: 1 }, { text: "not json" }] } };
    const { out, ran, received } = await consume(TYPED(), [reply], TELL);
    expect({ out, received, status: ran.status }, ran.stderr).toEqual({
      out: ["TEXT not json"],
      received: ['{"text":"hi"}'],
      status: 0,
    });
  });

  it("decodes a binary frame's bytes as UTF-8 JSON, and refuses a binary frame that is none", () => {
    const run = compiled(TYPED()).run("com.example.Probe", BINARY);
    expect({ diagnostics: run.diagnostics, out: run.stdout.split("\n").filter((l) => l !== "") }, run.stderr).toEqual({
      diagnostics: [],
      out: ["said yo", "error WebSocket frame is not valid JSON", "read WebSocket frame is not valid JSON"],
    });
  });
});
