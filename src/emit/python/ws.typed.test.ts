/**
 * A WebSocket operation with declared messages (the rich `x-websocket`) in the Python SDK: its socket is
 * `TypedWebSocket[Out, In]`, `Out` what the server sends and `In` what it receives, so `send` takes only a
 * member and a read gets the union; a union keyed on one field (D9) adds `on("<value>", handler)` per member on a
 * per-op `<Op>Socket`, except a value that names a socket event (`message`, `close`, `error`), which reaches
 * `on("message")` alone. On the wire every send is JSON and every frame is parsed: a frame that is no JSON fires
 * `on("error")` and raises from `recv()`, and the socket stays open. An operation without messages reads
 * `TypedWebSocket[str | bytes, object]`, as before.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import * as streams from "../shared/__fixtures__/documents-streams.ts";
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts";
import { checked, consume } from "./__fixtures__/consumer.ts";
import { withPython } from "./__fixtures__/python-env.ts";
import { generatePythonSdk } from "./sdk.ts";

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython();

/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 };

type Json = Record<string, unknown>;

const spec = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, `../../ir/__fixtures__/specs/streams/${name}.json`), "utf8"),
  ) as Json;

/** A keyed op whose `send` union and its members are written inline, so each member is hoisted by its value. */
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

/** The lines of `file` in the package for `document` that match `pattern`, each from `from` on. */
function lines(document: Json, file: string, pattern: RegExp, from = /^/): string[] {
  const text = generatePythonSdk(document).files[`src/http_sdk/${file}`] ?? "";

  return text
    .split("\n")
    .filter((line) => pattern.test(line))
    .map((line) => line.slice(line.search(from)).trim());
}

describe("a WebSocket operation with declared messages: its types", () => {
  it("answers TypedWebSocket of what the server sends and receives, a keyed op its own socket class", () => {
    expect({
      keyed: lines(spec("ws-keyed"), "client.py", /async def open\(/, /-> /),
      unkeyed: lines(spec("ws-messages"), "client.py", /async def open\(/, /-> /),
    }).toEqual({
      keyed: ["-> ChatOpenSocket:", "-> TypedWebSocket[Note, object]:"],
      unkeyed: ["-> TypedWebSocket[ServerFrame, ClientFrame]:"],
    });
    expect(new Set(lines(streams.ws(), "client.py", /async def \w+\(.*protocols/, /-> /))).toEqual(
      new Set(["-> TypedWebSocket[str | bytes, object]:"]),
    );
  });

  it("writes the socket class: an on overload per member, then the socket events, a clashing member left out", () => {
    expect({
      base: lines(spec("ws-keyed"), "types.py", /^class ChatOpenSocket/),
      on: lines(spec("ws-keyed"), "types.py", /def on\(/, /event: /),
    }).toEqual({
      base: ['class ChatOpenSocket(TypedWebSocket["ChatOut", "ChatIn"]):'],
      on: [
        'event: Literal["said"], handler: Callable[[Said], None]) -> None: ...',
        'event: Literal["message"], handler: Callable[[ChatOut], None]) -> None: ...',
        'event: Literal["close"], handler: Callable[[WsClose], None]) -> None: ...',
        'event: Literal["error"], handler: Callable[[HttpError], None]) -> None: ...',
        "event: str, handler: Callable[[Any], None]) -> None:",
      ],
    });
  });

  it("names an inline member by the class its union hoists for it", () => {
    expect({
      classes: lines(INLINE, "types.py", /^class FeedJoin/),
      on: lines(INLINE, "types.py", /def on\(/, /event: /).slice(0, 2),
    }).toEqual({
      classes: [
        "class FeedJoinSendLeft(TypedDict):",
        "class FeedJoinSendSaid(TypedDict):",
        'class FeedJoinSocket(TypedWebSocket["FeedJoinSendSaid | FeedJoinSendLeft", "object"]):',
      ],
      on: [
        'event: Literal["said"], handler: Callable[[FeedJoinSendSaid], None]) -> None: ...',
        'event: Literal["left"], handler: Callable[[FeedJoinSendLeft], None]) -> None: ...',
      ],
    });
  });
});

/** A program mypy checks against the `typed` package: what `send`, `recv` and `on` take. */
const TYPES = [
  "from typing import assert_type",
  "",
  "import http_sdk as sdk",
  "",
  "",
  "def said(m: sdk.WsKeyedSaid) -> None:",
  "    print(m['text'])",
  "",
  "",
  "def any_out(m: sdk.WsKeyedChatOut) -> None:",
  "    print(m)",
  "",
  "",
  "def closed(m: sdk.WsClose) -> None:",
  "    print(m.code)",
  "",
  "",
  "async def run(c: sdk.AsyncSDK) -> None:",
  "    ws = await c.ws_keyed.chat.open()",
  "    await ws.send({'type': 'say', 'text': 'hi'})",
  "    await ws.send({'type': 'shout'})",
  "    assert_type(await ws.recv(), sdk.WsKeyedChatOut | None)",
  "    ws.on('said', said)",
  "    ws.on('message', any_out)",
  "    ws.on('close', closed)",
  "    ws.on('message', said)",
  "    ws.on('left', said)",
  "    ws.on('close', said)",
  "    notes = await c.ws_keyed.notes.open()",
  "    assert_type(await notes.recv(), sdk.WsKeyedNote | None)",
  "    notes.on('message', said)",
  "    notes.on('body', said)",
];

/** The line of TYPES a finding is at, and its error code. */
const codeAt = (finding: string) => {
  const [, line, code] = /:(\d+): error: .*\[([a-z-]+)\]$/.exec(finding) ?? [];

  return `${TYPES[Number(line) - 1]?.trim()} [${code}]`;
};

describe.skipIf(!PY)("a WebSocket operation with declared messages under mypy", SLOW, () => {
  it("sends only a member, reads the union, narrows on(value) to its member, and refuses the rest", () => {
    const findings = checked("typed", `${TYPES.join("\n")}\n`);
    expect(findings.filter((line) => line.includes(": error: ")).map(codeAt)).toEqual([
      "await ws.send({'type': 'shout'}) [typeddict-item]",
      "ws.on('message', said) [call-overload]",
      "ws.on('left', said) [call-overload]",
      "ws.on('close', said) [call-overload]",
      "notes.on('message', said) [call-overload]",
      "notes.on('body', said) [call-overload]",
    ]);
    expect(findings.find((line) => line.includes("[typeddict-item]"))?.replace(/^.*: error: /, "")).toBe(
      `Incompatible types (expression has type "Literal['shout']", TypedDict item "type" has type "Literal['ping']")  [typeddict-item]`,
    );
  });
});

/** A `said` message carrying `text`. */
const said = (text: string) => ({ text, type: "said" });

/** Sends, reads and handler calls on the keyed chat socket, noted in order. */
const CHAT = `async with aclient() as c:
    ws = await c.ws_keyed.chat.open()
    ws.on("message", lambda m: note(["message", m]))
    ws.on("said", lambda m: note(["said", m]))
    ws.on("close", lambda m: note(["close", type(m).__name__]))
    ws.on("error", lambda e: note(["error", type(e).__name__]))
    await ws.send({"type": "say", "text": "hi"})
    await ws.send("plain")
    note(["recv", await ws.recv()])
    note(["recv", await ws.recv()])
    try:
        await ws.recv()
    except sdk.DecodeError as error:
        note(["raised", str(error)])
    note(["recv", await ws.recv()])
    await ws.close()`;

describe.skipIf(!PY)("a WebSocket operation with declared messages on the wire", SLOW, () => {
  it("sends JSON, hands a frame to on(message) and on(value), and raises a frame that is no JSON, still open", async () => {
    const reply: Reply = {
      status: 101,
      ws: {
        steps: [
          { receive: 2 },
          { json: { text: "yo", type: "said" } },
          { json: { reason: "bye", type: "close" } },
          { text: "not json" },
          { json: { text: "after", type: "said" } },
        ],
      },
    };

    const { received, run } = await served([reply], async (server) => ({
      run: await consume("typed", "keyed_chat", { base: server.url, body: CHAT }),
      received: server.streams[0]?.received ?? [],
    }));

    expect({ out: run.out?.main?.map((line) => JSON.parse(line)), ran: run.ran }, run.stderr).toEqual({
      out: [
        ["message", said("yo")],
        ["said", said("yo")],
        ["recv", said("yo")],
        ["message", { reason: "bye", type: "close" }],
        ["recv", { reason: "bye", type: "close" }],
        ["error", "DecodeError"],
        ["raised", "WebSocket frame is not valid JSON: Expecting value: line 1 column 1 (char 0)"],
        ["message", said("after")],
        ["said", said("after")],
        ["recv", said("after")],
        ["close", "WsClose"],
      ],
      ran: true,
    });
    expect(received.flatMap((frame) => (frame.kind === "text" ? [JSON.parse(frame.text)] : []))).toEqual([
      { text: "hi", type: "say" },
      "plain",
    ]);
  });
});
