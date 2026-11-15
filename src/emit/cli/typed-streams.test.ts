/**
 * Typed streams through the CLI: a WebSocket command checks each stdin line against what the server receives (its
 * `receive`), a keyed union by the member its key names (D9), before it is sent. A refused line is not sent: its
 * refusal goes to stderr as an error does, naming the line, the conversation reads on, a blank line is skipped, and
 * the run ends a usage error, exit 4, counting the lines not sent. Each message prints as its type re-encodes it, a
 * value the op does not declare as sent; a frame that does not decode ends the run, exit 1, after a close frame 1007.
 * An event stream that names its events (D7) prints each by its name, an unnamed one as `message` and an undeclared
 * name as sent; an event whose data does not decode ends it, exit 1.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { withGo } from "../go/__fixtures__/go-env.ts";
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts";
import type { WsStep } from "../shared/__fixtures__/stream-server.ts";
import { builtCli } from "./__fixtures__/built.ts";
import { generateGoCli } from "./module.ts";

const GO = withGo();
const SLOW = { timeout: 600_000 };

// a leg the server holds open: a regression that never ends fails in this, not the file's bound
const HOLD = { timeout: 30_000 };

type Json = Record<string, unknown>;

const spec = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, `../../ir/__fixtures__/specs/streams/${name}.json`), "utf8")) as {
    paths: Json;
    components: { schemas: Json };
  };

/** The keyed WebSocket ops and the named-event streams, with a socket that receives one object type and one a string. */
function document(): Json {
  const [keyed, events] = [spec("ws-keyed"), spec("sse-item-schema")];
  const count = { properties: { n: { type: "integer" } }, required: ["n"], type: "object" };

  const echo = {
    get: {
      operationId: "echo.open",
      responses: { 101: { description: "Switching Protocols" } },
      "x-websocket": { receive: { $ref: "#/components/schemas/Count" }, send: { $ref: "#/components/schemas/Count" } },
    },
  };

  const word = {
    get: {
      operationId: "word.open",
      responses: { 101: { description: "Switching Protocols" } },
      "x-websocket": { receive: { type: "string" }, send: { type: "string" } },
    },
  };

  return {
    components: { schemas: { ...keyed.components.schemas, ...events.components.schemas, Count: count } },
    info: { title: "Typed", version: "1.0.0" },
    openapi: "3.2.1",
    paths: { ...keyed.paths, ...events.paths, "/echo": echo, "/word": word },
  };
}

const built = () => builtCli(generateGoCli(document()).files);

const ws = (steps: readonly WsStep[]): Reply => ({ status: 101, ws: { steps } });
const sse = (steps: readonly string[]): Reply => ({ sse: { end: "close", steps }, status: 200 });

/** One run against a server answering `replies`; the run and its streams. */
async function call(args: readonly string[], replies: readonly Reply[], input = "") {
  return served(replies, async (server) => {
    const ran = await built().cli(args, { env: { TYPED_BASE_URL: server.url }, input });

    return { ...ran, streams: server.streams };
  });
}

/** Each line of `text` as JSON. */
const jsonLines = (text: string) =>
  text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

/** A usage error as stderr writes it under JSON. */
const usage = (message: string) => ({ error: { kind: "usage", message } });

describe.skipIf(!GO)("a typed WebSocket command's input lines", SLOW, () => {
  beforeAll(() => void built(), SLOW.timeout);

  it(
    "sends a line that is a member its key names, refuses any other on stderr and reads on, then exits 4",
    HOLD,
    async () => {
      const input = [
        '{"type":"say","text":"hi"}',
        "not json",
        '{"type":"shout"}',
        "",
        '{"type":"say"}',
        '{"type":"ping"}',
        "",
      ].join("\n");

      const ran = await call(["chat", "open"], [ws([{ receive: 2 }, { close: { code: 1000, reason: "" } }])], input);
      const sent = ran.streams[0]?.received.filter((frame) => frame.kind === "text");
      expect([ran.status, sent, jsonLines(ran.stderr)]).toEqual([
        4,
        [
          { kind: "text", text: '{"type":"say","text":"hi"}' },
          { kind: "text", text: '{"type":"ping"}' },
        ],
        [
          usage("input line 2 not sent: not valid JSON: invalid character 'o' in literal null (expecting 'u')"),
          usage('input line 3 not sent: want an object whose "type" is one of "ping", "say"'),
          usage('input line 5 not sent: missing "text"'),
          usage("input lines not sent: 3"),
        ],
      ]);
    },
  );

  it("refuses a line that does not decode as the one type the server receives, and sends the next", HOLD, async () => {
    const steps: WsStep[] = [{ receive: 1 }, { json: { more: true, n: 3 } }, { close: { code: 1000, reason: "" } }];
    const ran = await call(["echo", "open"], [ws(steps)], '{"n":"x"}\n{"n":2}\n');
    const [refused, ended] = jsonLines(ran.stderr) as { error: { kind: string; message: string } }[];
    expect([ran.status, ran.stdout, ran.streams[0]?.received[0], refused?.error.kind, ended]).toEqual([
      4,
      '{"n":3}\n',
      { kind: "text", text: '{"n":2}' },
      "usage",
      usage("input lines not sent: 1"),
    ]);
    expect(refused?.error.message).toMatch(/^input line 1 not sent: json: cannot unmarshal string into .*\bn\b/);
  });
});

describe.skipIf(!GO)("a WebSocket command that receives no object", SLOW, () => {
  beforeAll(() => void built(), SLOW.timeout);

  it(
    "checks a line against a type the server receives that is no object: a string is sent, a number refused",
    HOLD,
    async () => {
      const ran = await call(
        ["word", "open"],
        [ws([{ receive: 1 }, { close: { code: 1000, reason: "" } }])],
        '"hi"\n5\n',
      );

      const [refused, ended] = jsonLines(ran.stderr) as { error: { kind: string; message: string } }[];
      expect([ran.status, ran.streams[0]?.received[0], refused?.error.kind, ended]).toEqual([
        4,
        { kind: "text", text: '"hi"' },
        "usage",
        usage("input lines not sent: 1"),
      ]);
      expect(refused?.error.message).toMatch(
        /^input line 2 not sent: json: cannot unmarshal number into Go value of type string/,
      );
    },
  );
});

describe.skipIf(!GO)("a typed WebSocket command's messages", SLOW, () => {
  beforeAll(() => void built(), SLOW.timeout);

  it(
    "prints each message as its type re-encodes it, an undeclared value as sent; a frame that is no JSON ends it, exit 1, close 1007",
    HOLD,
    async () => {
      const steps: WsStep[] = [
        { json: { extra: 1, text: "a", type: "said" } },
        { json: { type: "wave" } },
        { text: "oops" },
        { waitMs: 60_000 },
      ];

      const ran = await call(["chat", "open"], [ws(steps)]);
      const [error] = jsonLines(ran.stderr) as { error: { kind: string; message: string } }[];
      expect([ran.status, jsonLines(ran.stdout), error?.error.kind, ran.streams[0]?.received.at(-1)]).toEqual([
        1,
        [{ text: "a", type: "said" }, { type: "wave" }],
        "error",
        { code: 1007, kind: "close", reason: "a message did not decode" },
      ]);
      expect(error?.error.message).toMatch(/WebSocket frame is not valid JSON/);
    },
  );
});

describe.skipIf(!GO)("an event stream that names its events", SLOW, () => {
  beforeAll(() => void built(), SLOW.timeout);

  it("prints each event by its name: an unnamed one as message, an undeclared name as sent", async () => {
    const ran = await call(
      ["ticks", "stream"],
      [sse(['event: tick\ndata: {"at":1,"x":2}\n\n', "data: plain\n\n", 'event: later\ndata: {"k":1}\n\n'])],
    );

    expect([ran.status, jsonLines(ran.stdout)]).toEqual([
      0,
      [
        { data: { at: 1 }, event: "tick" },
        { data: "plain", event: "message" },
        { data: { k: 1 }, event: "later" },
      ],
    ]);
  });

  it("ends on an event whose data does not decode as its name's type, exit 1", async () => {
    const ran = await call(
      ["ticks", "stream"],
      [sse(['event: tick\ndata: {"at":1}\n\n', "event: tick\ndata: nope\n\n"])],
    );

    const [error] = jsonLines(ran.stderr) as { error: { kind: string; message: string } }[];
    expect([ran.status, ran.stdout, error?.error.kind]).toEqual([1, '{"event":"tick","data":{"at":1}}\n', "error"]);
    expect(error?.error.message).toMatch(/sse event "tick"/);
  });
});
