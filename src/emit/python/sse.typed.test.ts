/**
 * A named-event SSE operation (an OpenAPI 3.2 `itemSchema` the IR reads into its events) in the Python SDK: its
 * stream yields a union of `SseEventOf[Literal[name], Data]` that mypy narrows on `event`, and on the wire each JSON
 * event is parsed by its name while a string event stays text. An unnamed event is `message`; an event the
 * operation does not declare reaches the reader with its data raw. An operation without events reads
 * `EventStream[SseEvent[str]]`, as before.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type Reply, served } from "../shared/__fixtures__/recording-server.ts";
import { checked, consume } from "./__fixtures__/consumer.ts";
import { withPython } from "./__fixtures__/python-env.ts";
import { generatePythonSdk } from "./sdk.ts";

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython();

/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 };

type Json = Record<string, unknown>;

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

/** The lines of `file` in the package for `document` that match `pattern`. */
function lines(document: Json, file: string, pattern: RegExp): string[] {
  const text = generatePythonSdk(document).files[`src/http_sdk/${file}`] ?? "";

  return text.split("\n").filter((line) => pattern.test(line));
}

describe("a named-event SSE operation's types", () => {
  it("answers EventStream of an event alias: a SseEventOf per name, in the order declared", () => {
    expect({
      aliases: lines(EVENTS, "types.py", /StreamEvent: TypeAlias/),
      methods: lines(EVENTS, "client.py", /def stream\(/).map((line) => line.replace(/^.*\) -> /, "")),
    }).toEqual({
      aliases: [
        'BeatsStreamEvent: TypeAlias = "SseEventOf[Literal[\\"beat\\"], int]"',
        'TicksStreamEvent: TypeAlias = "SseEventOf[Literal[\\"tick\\"], Tick] | SseEventOf[Literal[\\"message\\"], str]"',
      ],
      methods: ["EventStream[BeatsStreamEvent]:", "EventStream[TicksStreamEvent]:"],
    });
  });

  it("keeps an operation without events on SseEvent of its data, its event optional", () => {
    expect(lines(PLAIN, "client.py", /def stream\(/).map((line) => line.replace(/^.*\) -> /, ""))).toEqual([
      "EventStream[SseEvent[str]]:",
    ]);
  });
});

/** A program mypy checks against the `typed` package: narrowing on `event` types `data`. */
const NARROWED = [
  "from typing import Literal, assert_type",
  "",
  "import http_sdk as sdk",
  "",
  "",
  "async def run(c: sdk.AsyncSDK) -> None:",
  "    async for e in await c.sse_item_schema.ticks.stream():",
  "        assert_type(e.event, Literal['tick', 'message'])",
  "        if e.event == 'tick':",
  "            assert_type(e.data, sdk.SseItemSchemaTick)",
  "        else:",
  "            assert_type(e.data, str)",
  "        print(e.data['at'])",
  "        if e.event == 'tock':",
  "            pass",
  "    async for b in await c.sse_item_schema.beats.stream():",
  "        assert_type(b.data, int)",
  "    plain: sdk.EventStream[sdk.SseEvent[str]] = await c.sse_item_schema.beats.stream()",
  "    print(plain)",
];

/** The finding mypy gives at `line` of NARROWED, as `<line>: <message>`. */
const at = (line: string, message: string) => `${NARROWED.indexOf(line) + 1}: ${message}`;

describe.skipIf(!PY)("a named-event SSE operation under mypy", SLOW, () => {
  it("narrows data on event, refuses the unnarrowed data and an undeclared name", () => {
    const findings = checked("typed", `${NARROWED.join("\n")}\n`).map((line) =>
      line.replace(/^[^:]+:(\d+): error: /, "$1: "),
    );

    expect(findings).toEqual([
      // unnarrowed, data may be the message's str, which no str key indexes
      at(
        "        print(e.data['at'])",
        'Invalid index type "str" for "str"; expected type "SupportsIndex | slice[SupportsIndex | None, SupportsIndex | None, SupportsIndex | None]"  [index]',
      ),
      at(
        "        if e.event == 'tock':",
        `Non-overlapping equality check (left operand type: "Literal['tick', 'message']", right operand type: "Literal['tock']")  [comparison-overlap]`,
      ),
      at("            pass", "Statement is unreachable  [unreachable]"),
      at(
        "    plain: sdk.EventStream[sdk.SseEvent[str]] = await c.sse_item_schema.beats.stream()",
        'Incompatible types in assignment (expression has type "EventStream[SseEventOf[Literal[\'beat\'], int]]", variable has type "EventStream[SseEventOf[str | None, str]]")  [assignment]',
      ),
    ]);
  });
});

const sse = (text: string): Reply => ({ sse: { end: "close", steps: [text] }, status: 200 });

/** Every event of each stream, as `[event, data, id]`, and a stream's error as its class and text. */
const READ = `async with aclient() as c:
    streams = c.sse_item_schema
    for name, open in (("ticks", streams.ticks.stream), ("beat", streams.beats.stream), ("nope", streams.beats.stream)):
        section(name)
        try:
            async for e in await open():
                note([e.event, e.data, e.id])
        except sdk.DecodeError as error:
            note(f"{type(error).__name__}: {error}")`;

describe.skipIf(!PY)("a named-event SSE operation on the wire", SLOW, () => {
  it("parses a JSON event by its name, keeps a string event as text, names an unnamed one message", async () => {
    const wire = 'event: tick\ndata: {"at":1}\nid: 1\n\ndata: plain\n\nevent: other\ndata: {"x":1}\n\n';
    const replies = [sse(wire), sse("event: beat\ndata: 42\n\n"), sse("event: beat\ndata: nope\n\n")];
    const run = await served(replies, (server) => consume("typed", "named_events", { base: server.url, body: READ }));
    expect({ out: run.out, ran: run.ran }, run.stderr).toEqual({
      out: {
        beat: ['["beat", 42, null]'],
        nope: ["DecodeError: an event's data is not a JSON value"],
        ticks: ['["tick", {"at": 1}, "1"]', '["message", "plain", "1"]', '["other", "{\\"x\\":1}", "1"]'],
      },
      ran: true,
    });
  });
});
