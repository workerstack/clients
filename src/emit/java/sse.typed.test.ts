/**
 * A named-event SSE operation (an OpenAPI 3.2 `itemSchema` the IR reads into its events, D7) in the Java SDK (D17):
 * its stream is `EventStream<<Op>Event>`, a sealed interface with one nested record per event name in the order
 * declared, each holding `data`, `event`, `id` and `retry`, then `Unknown` for a name the op does not declare, its
 * data as sent; `<Op>Event.of` decodes one event by its name. A consumer matches the records with `instanceof` (no
 * pattern switch at `--release 17`). On the wire each JSON event is decoded by its name while a string event stays
 * text; an unnamed event is `message`; a declared JSON event that does not decode throws `DecodeException` and ends
 * the stream, the cursor already past it. A nested name never shadows a type the declaration spells (`String` for an
 * event named `string`), the enclosing interface or `Unknown`.
 */
import { describe, expect, it } from "vitest";

import { type Reply, served } from "../shared/__fixtures__/recording-server.ts";
import { compiledJavaSdk, type JavaRun } from "./__fixtures__/compiled.ts";
import { FIXTURES } from "./__fixtures__/documents.ts";
import { withJava } from "./__fixtures__/java-env.ts";
import { generateJavaSdk } from "./sdk.ts";

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava();

/** Every compiled or executed describe's bound: a cold gate builds the SDK first. */
const SLOW = { timeout: 600_000 };

const PACKAGE = "src/main/java/com/example";

/** The SDK of `document`'s files. */
const filesOf = (document: Record<string, unknown>) => generateJavaSdk(document).files;

/** The `typed` SDK's files. */
const typed = () => filesOf(FIXTURES.typed.document());

/**
 * The declaration lines of the sealed interface `name` in `files`: its header, each nested record (its wrapped
 * header joined into one line) and its `of`, in order.
 */
function declaredIn(files: Readonly<Record<string, string>>, name: string): string[] {
  const text = (files[`${PACKAGE}/${name}.java`] ?? "").replaceAll(/\s*\n\s*/g, " ");

  const pattern = new RegExp(
    `public sealed interface ${name} \\{|record \\w+\\([^)]*\\) implements ${name}|static ${name} of\\([^)]*\\)`,
    "g",
  );

  return [...text.matchAll(pattern)].map((match) => match[0]);
}

/** Every one-argument stream method of the SDK's files, normal and safe. */
const methodsOf = (files: Readonly<Record<string, string>>) =>
  Object.values(files)
    .flatMap((source) => source.split("\n"))
    .filter((line) => /^ {2}public .*EventStream<.*> stream\(\w+ params\) \{$/.test(line))
    .map((line) => line.trim())
    .sort();

const REST = "String event, String id, Duration retry";

describe("a named-event SSE operation's types", () => {
  it("answers an EventStream of its event interface: a nested record per name in the order declared, then Unknown", () => {
    const files = typed();
    expect({
      beats: declaredIn(files, "SseBeatsStreamEvent"),
      methods: methodsOf(files),
      ticks: declaredIn(files, "SseTicksStreamEvent"),
    }).toEqual({
      beats: [
        "public sealed interface SseBeatsStreamEvent {",
        `record Beat(Long data, ${REST}) implements SseBeatsStreamEvent`,
        `record Unknown(String data, ${REST}) implements SseBeatsStreamEvent`,
        "static SseBeatsStreamEvent of(SseEvent<String> e)",
      ],
      methods: [
        "public EventStream<SseBeatsStreamEvent> stream(SseBeatsStreamParams params) {",
        "public EventStream<SseTicksStreamEvent> stream(SseTicksStreamParams params) {",
        "public Result<EventStream<SseBeatsStreamEvent>> stream(SseBeatsStreamParams params) {",
        "public Result<EventStream<SseTicksStreamEvent>> stream(SseTicksStreamParams params) {",
      ],
      ticks: [
        "public sealed interface SseTicksStreamEvent {",
        `record Tick(SseTick data, ${REST}) implements SseTicksStreamEvent`,
        `record Message(String data, ${REST}) implements SseTicksStreamEvent`,
        `record Unknown(String data, ${REST}) implements SseTicksStreamEvent`,
        "static SseTicksStreamEvent of(SseEvent<String> e)",
      ],
    });
  });
});

/** An event named `name` whose data is `data`, JSON unless it is a string. */
const named = (name: string, data: Record<string, unknown>) => ({
  properties: {
    data: data.type === "string" ? data : { contentMediaType: "application/json", contentSchema: data, type: "string" },
    event: { const: name },
  },
  required: ["event", "data"],
  type: "object",
});

/** One SSE op whose event names clash with java.lang, a spelled type, the enclosing interface and Unknown. */
const CLASHING = {
  components: { schemas: { Point: { properties: { x: { type: "integer" } }, required: ["x"], type: "object" } } },
  info: { title: "Clash", version: "1" },
  openapi: "3.2.0",
  paths: {
    "/clash": {
      get: {
        operationId: "clash.stream",
        responses: {
          200: {
            content: {
              "text/event-stream": {
                itemSchema: {
                  oneOf: [
                    named("string", { type: "string" }),
                    named("long", { type: "integer" }),
                    named("point", { $ref: "#/components/schemas/Point" }),
                    named("data", { type: "string" }),
                    named("unknown", { type: "string" }),
                    named("clashStreamEvent", { type: "string" }),
                  ],
                },
              },
            },
            description: "Clashes",
          },
        },
      },
    },
  },
};

describe("a named-event SSE operation's nested names", () => {
  it("suffixes Event to a name java.lang, a spelled type, Unknown or the enclosing interface holds", () => {
    expect(declaredIn(filesOf(CLASHING), "ClashStreamEvent")).toEqual([
      "public sealed interface ClashStreamEvent {",
      `record StringEvent(String data, ${REST}) implements ClashStreamEvent`,
      `record LongEvent(Long data, ${REST}) implements ClashStreamEvent`,
      `record PointEvent(Point data, ${REST}) implements ClashStreamEvent`,
      `record Data(String data, ${REST}) implements ClashStreamEvent`,
      `record UnknownEvent(String data, ${REST}) implements ClashStreamEvent`,
      `record ClashStreamEventEvent(String data, ${REST}) implements ClashStreamEvent`,
      `record Unknown(String data, ${REST}) implements ClashStreamEvent`,
      "static ClashStreamEvent of(SseEvent<String> e)",
    ]);
  });
});

/** A consumer program on `client` at `url` running `body`, each `note(…)` one line of its output. */
const consumer = (client: string, url: string, body: string) => `package probe;

import com.example.*;
import java.util.Iterator;
import java.util.function.Supplier;

public class Probe {
  static void note(Object value) {
    System.out.println(value);
  }

  public static void main(String[] args) throws Exception {
    ${client} c = ${client}.builder().baseUrl("${url}").build();
${body
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
  }
}
`;

/** `body` compiled against the SDK of `document` and run, with a server answering `replies`. */
async function consume(document: Record<string, unknown>, replies: readonly Reply[], body: string) {
  const sdk = compiledJavaSdk(filesOf(document));
  expect(sdk.javac.diagnostics).toEqual([]);

  return served(replies, async (server) => {
    const ran = await sdk.exec("probe.Probe", consumer("ExampleClient", server.url, body));

    return { out: ran.stdout.split("\n").filter((line) => line !== ""), ran };
  });
}

/** The errors javac reports on `run`, each its message alone. */
const errorsOf = (run: JavaRun) =>
  run.diagnostics.filter((line) => / error: /.test(line)).map((line) => line.replace(/^.*error: /, ""));

/** Holds each answer in its declared type and matches each nested record with `instanceof`. */
const SPELLED = `Supplier<EventStream<SseTicksStreamEvent>> ticks =
    () -> c.sse().ticks().stream(SseTicksStreamParams.builder().build());
Supplier<Result<EventStream<SseBeatsStreamEvent>>> beats =
    () -> c.safe().sse().beats().stream(SseBeatsStreamParams.builder().build());
SseTicksStreamEvent[] events = {
  new SseTicksStreamEvent.Tick(new SseTick(1L), "tick", "1", null),
  new SseTicksStreamEvent.Message("plain", "message", null, java.time.Duration.ofSeconds(2)),
  new SseTicksStreamEvent.Unknown("{}", "other", "3", null),
};
for (SseTicksStreamEvent e : events) {
  if (e instanceof SseTicksStreamEvent.Tick t) note("tick " + t.data().at() + " " + t.id());
  else if (e instanceof SseTicksStreamEvent.Message m) note("message " + m.data() + " " + m.retry().toSeconds());
  else if (e instanceof SseTicksStreamEvent.Unknown u) note("unknown " + u.event() + " " + u.data() + " " + u.id());
}
SseBeatsStreamEvent beat = new SseBeatsStreamEvent.Beat(41L, "beat", null, null);
if (beat instanceof SseBeatsStreamEvent.Beat b) note("beat " + (b.data() + 1));
note(ticks != null && beats != null);`;

/** Reads `data().at()` off an Unknown event, which holds its data as text. */
const UNNARROWED = `SseTicksStreamEvent.Unknown u = new SseTicksStreamEvent.Unknown("{}", "other", null, null);
note(u.data().at());`;

describe.skipIf(!JAVA)("a named-event SSE operation, compiled", SLOW, () => {
  it("spells each answer, on both styles, and matches each nested record with instanceof", async () => {
    const { out, ran } = await consume(FIXTURES.typed.document(), [], SPELLED);
    expect({ diagnostics: ran.diagnostics, out, status: ran.status }, ran.stderr).toEqual({
      diagnostics: [],
      out: ["tick 1 1", "message plain 2", "unknown other {} 3", "beat 42", "true"],
      status: 0,
    });
  });

  it("refuses data().at() read off an Unknown event", () => {
    const sdk = compiledJavaSdk(typed());
    const run = sdk.run("probe.Probe", consumer("ExampleClient", "http://127.0.0.1:1", UNNARROWED));
    expect(errorsOf(run)).toEqual(["cannot find symbol"]);
    expect(run.diagnostics.join("\n")).toMatch(/symbol: +method at\(\)\n.*location: class String/);
  });
});

const sse = (text: string): Reply => ({ sse: { end: "close", steps: [text] }, status: 200 });

/** Every event of each stream, matched on its nested record, and the error a stream ends on with its cursor. */
const READ = `try (EventStream<SseTicksStreamEvent> s = c.sse().ticks().stream(SseTicksStreamParams.builder().build())) {
  for (SseTicksStreamEvent e : s) {
    if (e instanceof SseTicksStreamEvent.Tick t) note("tick " + t.event() + " " + t.data().at() + " " + t.id());
    else if (e instanceof SseTicksStreamEvent.Message m) note("message " + m.event() + " " + m.data() + " " + m.id());
    else if (e instanceof SseTicksStreamEvent.Unknown u) note("unknown " + u.event() + " " + u.data() + " " + u.id());
  }
}
try (EventStream<SseBeatsStreamEvent> s = c.sse().beats().stream(SseBeatsStreamParams.builder().build())) {
  for (SseBeatsStreamEvent e : s) {
    if (e instanceof SseBeatsStreamEvent.Beat b) note("beat " + (b.data() + 1));
  }
}
try (EventStream<SseBeatsStreamEvent> s = c.sse().beats().stream(SseBeatsStreamParams.builder().build())) {
  Iterator<SseBeatsStreamEvent> it = s.iterator();
  try {
    while (it.hasNext()) {
      note("event " + it.next());
    }
    note("ended");
  } catch (DecodeException e) {
    note(e.getClass().getSimpleName() + " " + e.getMessage().split(":")[0] + " at " + s.lastEventId());
  }
  note("after " + it.hasNext());
}`;

describe.skipIf(!JAVA)("a named-event SSE operation on the wire", SLOW, () => {
  it("decodes a JSON event by its name, keeps a string event as sent, names an unnamed one message, ends on a bad one", async () => {
    const wire = 'event: tick\ndata: {"at":1}\nid: 1\n\ndata: plain\n\nevent: other\ndata: {"x":1}\n\n';

    const replies = [
      sse(wire),
      sse("event: beat\ndata: 42\n\n"),
      sse("event: beat\ndata: nope\nid: 5\n\nevent: beat\ndata: 1\n\n"),
    ];

    const { out, ran } = await consume(FIXTURES.typed.document(), replies, READ);
    expect({ out, status: ran.status }, ran.stderr).toEqual({
      out: [
        "tick tick 1 1",
        "message message plain 1",
        'unknown other {"x":1} 1',
        "beat 43",
        "DecodeException an event's data does not decode at 5",
        "after false",
      ],
      status: 0,
    });
  });

  it("reads an event named string as text and one named long as a Long, beside the String they would shadow", async () => {
    const body = `try (EventStream<ClashStreamEvent> s = c.clash().stream(ClashStreamParams.builder().build())) {
  for (ClashStreamEvent e : s) {
    if (e instanceof ClashStreamEvent.StringEvent t) note("string " + t.data().length());
    else if (e instanceof ClashStreamEvent.LongEvent n) note("long " + (n.data() + 1));
    else if (e instanceof ClashStreamEvent.PointEvent p) note("point " + p.data().x());
    else if (e instanceof ClashStreamEvent.Data d) note("data " + d.data());
  }
}`;

    const wire =
      'event: string\ndata: hello\n\nevent: long\ndata: 7\n\nevent: point\ndata: {"x":3}\n\nevent: data\ndata: d\n\n';

    const { out, ran } = await consume(CLASHING, [sse(wire)], body);
    expect({ out, status: ran.status }, ran.stderr).toEqual({
      out: ["string 5", "long 8", "point 3", "data d"],
      status: 0,
    });
  });
});
