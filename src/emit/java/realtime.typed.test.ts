/**
 * A realtime operation with declared messages (`x-websocket` `send` and `receive`) in the Java SDK (D9, D17): its
 * connection is `ResumableConnection<TIn, TOut>`, `TIn` what the server sends and `TOut` what it receives, so `send`
 * takes only what the server receives, as JSON, and a read gives what it sends. A direction keyed on one field is the
 * sealed interface Java already declares for the union; a keyed read side answers `<Read>Connection<TOut>`, a
 * `ResumableConnection` with an `on<Value>` per member that matches inside `onMessage`, none for a `message` member,
 * which `onMessage` names, and none at all for a union of only `message`. Handlers run inside the read, before it
 * returns. A typed message that is no JSON, or does not fit `TIn`, throws `DecodeException` once, from `receive` or
 * from a for-each's `hasNext` (it reads ahead), the cursor already past it, and the next read reads the next. An int64
 * past 2^53 arrives exact and its cursor fields resume a reconnect. An op without messages is
 * `ResumableConnection<T, JsonNode>`, `T` its event schema's type or `JsonNode`, so an untyped `send("raw")` no longer
 * compiles: `sendText` sends raw text. The subclass and handler names are claimed, so a `connection` member and two
 * values that spell one handler compile.
 */
import { describe, expect, it } from "vitest"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { compiledJavaSdk, type JavaRun } from "./__fixtures__/compiled.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { withJava } from "./__fixtures__/java-env.ts"
import { generateJavaSdk } from "./sdk.ts"

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** Every compiled or executed describe's bound: a cold gate builds the SDK first. */
const SLOW = { timeout: 600_000 }

const PACKAGE = "src/main/java/com/example"
const STRING = { type: "string" }

type Json = Record<string, unknown>

/** The SDK of `document`'s files. */
const filesOf = (document: Json) => generateJavaSdk(document).files

/** The `typed` document. */
const TYPED = () => FIXTURES.typed.document() as Json
/** The `realtime` document, whose ops declare no messages. */
const UNTYPED = () => FIXTURES.realtime.document() as Json

/** Every one-argument realtime method of `files`, normal and safe, as its signature line, sorted. */
const connectionsOf = (files: Readonly<Record<string, string>>) =>
	Object.values(files)
		.flatMap((source) => source.split("\n"))
		.filter((line) => /^ {2}public \w+(<.*>)? \w+\(\w+Params params\) \{$/.test(line))
		.filter((line) => /Connection/.test(line))
		.map((line) => line.trim())
		.sort()

/** The class header and the public method lines of the generated connection `name` in `files`, each one line. */
function connectionClass(files: Readonly<Record<string, string>>, name: string): string[] {
	const text = (files[`${PACKAGE}/${name}.java`] ?? "").replace(/\s*\n\s+/g, " ")
	const pattern = new RegExp(
		`public final class ${name}<TOut> extends [^{]*\\{|public ${name}<TOut> on\\w+\\([^)]*\\)`,
		"g",
	)
	return [...text.matchAll(pattern)].map((match) => match[0])
}

/** A keyed member `value` written inline, with the string fields `fields`. */
const member = (value: string, ...fields: string[]) => ({
	properties: { type: { const: value }, ...Object.fromEntries(fields.map((field) => [field, STRING])) },
	required: ["type", ...fields],
	type: "object",
})

/**
 * One realtime op whose read side's members clash: `connection` (its wrapper is `<Read>Connection`), `saidIt` and
 * `said_it` (one handler name), and `message`, which names the connection's own handler.
 */
const CLASHING: Json = {
	components: {
		schemas: {
			Frame: {
				discriminator: { propertyName: "type" },
				oneOf: [member("connection"), member("saidIt"), member("said_it", "text"), member("message")],
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
				"x-realtime": true,
				"x-websocket": { send: { $ref: "#/components/schemas/Frame" } },
			},
		},
	},
}

/* the typed document's connections: an int64 counter, only `message`, keyed both ways, unkeyed both ways */
const CONNECTIONS = [
	"public ResumableConnection<CountFeedCountSend, JsonNode> count(CountFeedCountParams params) {",
	"public ResumableConnection<OnlyFeedTapSend, JsonNode> tap(OnlyFeedTapParams params) {",
	"public ResumableConnection<RtRoomOut, RtRoomIn> join(RtRoomJoinParams params) {",
	"public RoomRoomOutConnection<RoomRoomIn> join(RoomRoomJoinParams params) {",
]

describe("a realtime operation with declared messages: its types", () => {
	it("answers a keyed read side's connection, an unkeyed side's type, a missing side JsonNode", () => {
		expect({
			typed: connectionsOf(filesOf(TYPED())),
			untyped: connectionsOf(filesOf(UNTYPED())),
		}).toEqual({
			/* each method and its client.safe() twin */
			typed: CONNECTIONS.flatMap((line) => [line, line]).sort(),
			untyped: [
				"public ResumableConnection<JsonNode, JsonNode> resume(FeedResumeParams params) {",
				"public ResumableConnection<JsonNode, JsonNode> resume(FeedResumeParams params) {",
				"public ResumableConnection<Payload, JsonNode> feed(ClashFeedParams params) {",
				"public ResumableConnection<Payload, JsonNode> feed(ClashFeedParams params) {",
				"public ResumableConnection<Payload, JsonNode> live(FeedLiveParams params) {",
				"public ResumableConnection<Payload, JsonNode> live(FeedLiveParams params) {",
			],
		})
	})

	it("gives a keyed read side an on<Value> per member taking its variant, and an only-message union no class", () => {
		const files = filesOf(TYPED())
		expect({
			keyed: connectionClass(files, "RoomRoomOutConnection"),
			only: Object.keys(files).filter((path) => /OnlyFeedTap\w*Connection/.test(path)),
		}).toEqual({
			keyed: [
				"public final class RoomRoomOutConnection<TOut> extends ResumableConnection<RoomRoomOut, TOut> {",
				"public RoomRoomOutConnection<TOut> onLeft(Consumer<RoomRoomLeft> handler)",
				"public RoomRoomOutConnection<TOut> onSaid(Consumer<RoomRoomSaid> handler)",
			],
			only: [],
		})
	})

	it("claims the connection's name past a connection member's wrapper, numbers a second handler, skips message", () => {
		expect(connectionClass(filesOf(CLASHING), "FrameConnection2")).toEqual([
			"public final class FrameConnection2<TOut> extends ResumableConnection<Frame, TOut> {",
			"public FrameConnection2<TOut> onConnection(Consumer<FrameConnectionBody> handler)",
			"public FrameConnection2<TOut> onSaidIt(Consumer<FrameSaidItBody> handler)",
			"public FrameConnection2<TOut> onSaidIt2(Consumer<FrameSaidItBody2> handler)",
		])
	})
})

/** A consumer program on `client` at `url` running `body`, each `note(…)` one line of its output. */
const consumer = (url: string, body: string) => `package probe;

import com.example.*;
import java.time.Duration;
import java.util.function.Consumer;
import java.util.function.Function;
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
`

/** The SDK of `document`, compiled clean. */
function compiled(document: Json) {
	const sdk = compiledJavaSdk(filesOf(document))
	expect(sdk.javac.diagnostics).toEqual([])
	return sdk
}

/** `body` compiled against the SDK of `document` and run, with a server answering `replies`; what it saw too. */
async function consume(document: Json, replies: readonly Reply[], body: string) {
	const sdk = compiled(document)
	return served(replies, async (server) => {
		const ran = await sdk.exec("probe.Probe", consumer(server.url, body))
		const received = server.streams.flatMap((stream) =>
			(stream?.received ?? []).flatMap((frame) => (frame.kind === "text" ? [frame.text] : [])),
		)
		const urls = server.hops.map((hop) => hop.url)
		return { out: ran.stdout.split("\n").filter((line) => line !== ""), ran, received, urls }
	})
}

/** The errors javac reports on `run`, each its message alone. */
const errorsOf = (run: JavaRun) =>
	run.diagnostics.filter((line) => / error: /.test(line)).map((line) => line.replace(/^.*error: /, ""))

const OPEN = (resource: string, params: string) => `c.${resource}(${params}.builder().build())`

/** Holds each typed connection in its declared type, sends a member, takes each handler and matches a read. */
const SPELLED = `Supplier<RoomRoomOutConnection<RoomRoomIn>> room = () -> ${OPEN("room().room().join", "RoomRoomJoinParams")};
Supplier<RoomRoomOutConnection<RoomRoomIn>> safe = () -> ${OPEN("safe().room().room().join", "RoomRoomJoinParams")};
Supplier<ResumableConnection<RtRoomOut, RtRoomIn>> rt = () -> c.rt().room().join(RtRoomJoinParams.builder().roomId("r").build());
Supplier<ResumableConnection<OnlyFeedTapSend, JsonNode>> only = () -> ${OPEN("only().feed().tap", "OnlyFeedTapParams")};
Supplier<ResumableConnection<CountFeedCountSend, JsonNode>> count = () -> ${OPEN("count().feed().count", "CountFeedCountParams")};
Consumer<RoomRoomOutConnection<RoomRoomIn>> use = s -> {
  s.send(new RoomRoomInSay(new RoomRoomSay("hi", "say")));
  s.sendText("raw");
  s.onSaid(m -> note(m.text())).onLeft(m -> note(m.type()));
  s.onMessage((RoomRoomOut m) -> note(m.getClass().getSimpleName()));
  RoomRoomOut read = s.receive();
  if (read instanceof RoomRoomOutSaid said) note(said.value().text());
  else if (read instanceof RoomRoomOutUnknown u) note(u.value());
  for (RoomRoomOut m : s) note(m);
};
Consumer<ResumableConnection<RtRoomOut, RtRoomIn>> plain = r -> {
  r.send(new RtRoomIn("hi"));
  for (RtRoomOut m : r) note(m.said());
};
Consumer<ResumableConnection<OnlyFeedTapSend, JsonNode>> tap = o -> {
  o.onMessage(m -> note(m instanceof OnlyFeedTapSendMessage ? "message" : "other"));
  o.send(JsonNodeFactory.instance.objectNode());
};
Consumer<ResumableConnection<CountFeedCountSend, JsonNode>> counted = k -> {
  for (CountFeedCountSend m : k) {
    long n = m.n();
    note(n);
  }
};
note(room != null && safe != null && rt != null && only != null && count != null);
note(use != null && plain != null && tap != null && counted != null);`

/** Takes each handler of the clashing connection, a `connection` member's and both of one handler name's. */
const CLASHED = `Supplier<FrameConnection2<JsonNode>> open = () -> ${OPEN("clash().open", "ClashOpenParams")};
Consumer<FrameConnection2<JsonNode>> use = s -> s.onConnection(m -> note(m.type())).onSaidIt(m -> note(m.type())).onSaidIt2(m -> note(m.text()));
Consumer<FrameConnection2<JsonNode>> base = s -> s.onMessage(m -> note(m instanceof FrameMessage));
note(open != null && use != null && base != null);`

/** Each misuse a typed connection refuses at compile time: its document, its body and the error javac gives. */
const MISUSE: readonly (readonly [string, () => Json, string, RegExp])[] = [
	[
		"a send the server does not receive",
		TYPED,
		'Consumer<RoomRoomOutConnection<RoomRoomIn>> f = s -> s.send(new RoomRoomOutSaid(new RoomRoomSaid("hi", "said")));',
		/^incompatible types: RoomRoomOutSaid cannot be converted to RoomRoomIn$/,
	],
	[
		"on<Value> on an op whose read side is unkeyed",
		TYPED,
		"Consumer<ResumableConnection<RtRoomOut, RtRoomIn>> f = s -> s.onSaid(m -> note(m));",
		/^cannot find symbol$/,
	],
	[
		"an untyped connection's send of raw text",
		UNTYPED,
		'Consumer<ResumableConnection<JsonNode, JsonNode>> f = s -> s.send("raw");',
		/^incompatible types: String cannot be converted to JsonNode$/,
	],
]

describe.skipIf(!JAVA)("a realtime operation with declared messages, compiled", SLOW, () => {
	it("spells each connection, sends a member, takes each handler and matches a read with instanceof", async () => {
		const { out, ran } = await consume(TYPED(), [], SPELLED)
		expect({ diagnostics: ran.diagnostics, out, status: ran.status }, ran.stderr).toEqual({
			diagnostics: [],
			out: ["true", "true"],
			status: 0,
		})
	})

	it("compiles a connection member's handler and both handlers of one name", async () => {
		const { out, ran } = await consume(CLASHING, [], CLASHED)
		expect({ diagnostics: ran.diagnostics, out, status: ran.status }, ran.stderr).toEqual({
			diagnostics: [],
			out: ["true"],
			status: 0,
		})
	})

	it("refuses a wrong-direction send, onSaid on an unkeyed op and an untyped send of text", () => {
		const refused = MISUSE.map(([name, document, body, error]) => {
			const run = compiled(document()).run("probe.Probe", consumer("http://127.0.0.1:1", body))
			const errors = errorsOf(run)
			return [name, errors.length > 0 && errors.every((line) => error.test(line)), errors] as const
		})
		expect(
			refused.map(([name, matched]) => [name, matched]),
			JSON.stringify(refused),
		).toEqual(MISUSE.map(([name]) => [name, true]))
	})
})

/**
 * Sends on the keyed room, then reads: a for-each until it throws, a for-each left after one, then two receives;
 * each handler run and read noted in the order it happens.
 */
const ROOM = `RoomRoomOutConnection<RoomRoomIn> s = ${OPEN("room().room().join", "RoomRoomJoinParams")};
s.onMessage(m -> note("message " + m.getClass().getSimpleName()));
s.onSaid(m -> note("said " + m.text())).onLeft(m -> note("left " + m.type()));
s.send(new RoomRoomInSay(new RoomRoomSay("hi", "say")));
s.sendText("plain");
Function<RoomRoomOut, String> shown = m -> {
  if (m instanceof RoomRoomOutSaid said) return "said " + said.value().text();
  if (m instanceof RoomRoomOutLeft left) return "left " + left.value().type();
  if (m instanceof RoomRoomOutUnknown u) return "unknown " + u.value();
  return "other";
};
Function<DecodeException, String> failed = e -> e.getClass().getSimpleName() + " " + e.getMessage().split(":")[0];
try {
  for (RoomRoomOut m : s) note("for " + shown.apply(m));
} catch (DecodeException e) {
  note("for " + failed.apply(e));
}
for (RoomRoomOut m : s) {
  note("for " + shown.apply(m));
  break;
}
try {
  note("receive " + shown.apply(s.receive()));
} catch (DecodeException e) {
  note("receive " + failed.apply(e));
}
note("receive " + shown.apply(s.receive()));
s.close();
note(s.state());`

/** The counter over two dials: each message's n exact, the misfit an error, and the cursor the first dial left. */
const COUNT = `ResumableConnection<CountFeedCountSend, JsonNode> k = c.count().feed().count(CountFeedCountParams.builder().reconnectDelay(Duration.ofMillis(10)).build());
for (int reads = 0; reads < 3; reads++) {
  try {
    note("n " + k.receive().n());
  } catch (DecodeException e) {
    note("err " + e.getMessage().split(":")[0]);
  }
}
note("cursor " + k.options().lastEventId() + " " + k.options().reconnectToken());
k.close();
note(k.state());`

/** The room's server: two messages received, then a said, no JSON, a left, no JSON again and an undeclared value. */
const ROOM_REPLY: Reply = {
	status: 101,
	ws: {
		steps: [
			{ receive: 2 },
			{ json: { text: "yo", type: "said" } },
			{ text: "not json" },
			{ json: { type: "left" } },
			{ text: "{still not" },
			{ json: { type: "wave" } },
		],
	},
}

/** The counter's two dials: an int64 past 2^53 with the cursor, a misfit, a drop, then a negative one. */
const COUNT_REPLIES: readonly Reply[] = [
	{
		status: 101,
		ws: {
			steps: [
				{ text: '{"id":"5","n":9007199254740993,"reconnect_token":"rt-5"}' },
				{ text: '{"id":"6","n":"six"}' },
				{ close: { code: 1011, reason: "restart" } },
			],
		},
	},
	{ status: 101, ws: { steps: [{ text: '{"n":-9007199254740993}' }] } },
]

describe.skipIf(!JAVA)("a realtime operation with declared messages on the wire", SLOW, () => {
	it("sends JSON, runs onMessage and onSaid inside each read, reads Unknown, throws once on no JSON and reads on", async () => {
		const { out, ran, received } = await consume(TYPED(), [ROOM_REPLY], ROOM)
		expect({ out, received, status: ran.status }, ran.stderr).toEqual({
			out: [
				"message RoomRoomOutSaid",
				"said yo",
				"for said yo",
				"for DecodeException realtime message is not valid JSON",
				"message RoomRoomOutLeft",
				"left left",
				"for left left",
				"receive DecodeException realtime message is not valid JSON",
				"message RoomRoomOutUnknown",
				'receive unknown {"type":"wave"}',
				"DISCONNECTED",
			],
			received: ['{"text":"hi","type":"say"}', "plain"],
			status: 0,
		})
	})

	it("decodes an int64 past 2^53 exact, throws on a misfit, and a reconnect resumes from the last cursor", async () => {
		const { out, ran, urls } = await consume(TYPED(), COUNT_REPLIES, COUNT)
		expect({ out, status: ran.status, urls }, ran.stderr).toEqual({
			out: [
				"n 9007199254740993",
				"err realtime message does not decode",
				"n -9007199254740993",
				"cursor 6 rt-5",
				"DISCONNECTED",
			],
			status: 0,
			urls: ["/count/tap", "/count/tap?last_event_id=6&reconnect_token=rt-5"],
		})
	})
})
