/**
 * A realtime operation with declared messages (`x-websocket` `send` and `receive`) in the C# SDK (D9, D17): its
 * connection is `ResumableConnection<TIn, TOut>`, `TIn` what the server sends and `TOut` what it receives, so
 * `SendAsync` takes only what the server receives and the enumeration gives what it sends. A direction keyed on one
 * field is `<Op>Inbound` or `<Op>Outbound`, as a typed socket's is, and each read-side member gets an `On<Value>`
 * extension, except a `message` member, which the connection's `Message` event names. `Message` fires in the
 * enumeration before each message is yielded. A typed message that is no JSON, or does not fit `TIn`, throws
 * `DecodeException` once and ends that `await foreach`, the cursor already past it, and a new `await foreach` reads
 * on. An int64 past 2^53 arrives exact and its cursor fields still resume a reconnect. An op without messages is
 * `ResumableConnection<T, JsonElement>`, `T` its event schema's type or `JsonElement`.
 */
import { describe, expect, it } from "vitest"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { typedStreams } from "../shared/__fixtures__/documents-typed.ts"
import { checked, consume, program, seen } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { generateCSharpSdk } from "./sdk.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every compiled or executed describe's bound: a cold gate builds the SDK first. */
const SLOW = { timeout: 600_000 }

const typed = generateCSharpSdk(typedStreams()).files

/** Every line of `text` that matches `pattern`, trimmed. */
const lines = (text: string | undefined, pattern: RegExp) =>
	(text ?? "")
		.split("\n")
		.filter((line) => pattern.test(line))
		.map((line) => line.trim())

/** What each realtime method of `files` answers, its normal and its twin, from its signature line. */
const connections = (files: Readonly<Record<string, string>>) =>
	lines(files["Client.cs"], /public Task<ResumableConnection/).map((line) =>
		line.replace(/^public (Task<ResumableConnection<[^>]*>>) .*$/, "$1"),
	)

/** What each typed op's connection is, in the order Client.cs declares the ops. */
const TYPED = [
	"Task<ResumableConnection<CountFeedCountSend, JsonElement>>",
	"Task<ResumableConnection<OnlyFeedTapInbound, JsonElement>>",
	"Task<ResumableConnection<RoomRoomJoinInbound, RoomRoomJoinOutbound>>",
	"Task<ResumableConnection<RtRoomOut, RtRoomIn>>",
]

/** What each of the realtime fixture's ops answers: its event schema's type, or JsonElement without one. */
const UNTYPED = [
	"Task<ResumableConnection<Payload, JsonElement>>",
	"Task<ResumableConnection<Payload, JsonElement>>",
	"Task<ResumableConnection<JsonElement, JsonElement>>",
]

describe("a realtime operation with declared messages: its types", () => {
	it("answers a connection typed both ways, a missing side JsonElement, an op without messages by its event schema", () => {
		expect({
			typed: connections(typed),
			untyped: connections(generateCSharpSdk(FIXTURES.realtime.document()).files),
		}).toEqual({
			/* the methods, then their client.Safe twins */
			typed: [...TYPED, ...TYPED],
			untyped: [...UNTYPED, ...UNTYPED],
		})
	})

	it("declares a keyed side as a record per member, a member keyed message one too", () => {
		expect(
			lines(
				typed["Types.cs"],
				/^public abstract record (OnlyFeedTap|RoomRoomJoin)\w+$|^ {4}public sealed record \w+\(.*\) : (OnlyFeedTap|RoomRoomJoin)\w+;$|^ {4}public static implicit operator RoomRoom/,
			),
		).toEqual([
			"public abstract record OnlyFeedTapInbound",
			"public sealed record Message(OnlyFeedTapSendMessage Value) : OnlyFeedTapInbound;",
			"public sealed record Unknown(JsonElement Raw) : OnlyFeedTapInbound;",
			"public abstract record RoomRoomJoinInbound",
			"public sealed record Said(RoomRoomSaid Value) : RoomRoomJoinInbound;",
			"public sealed record Left(RoomRoomLeft Value) : RoomRoomJoinInbound;",
			"public sealed record Unknown(JsonElement Raw) : RoomRoomJoinInbound;",
			"public abstract record RoomRoomJoinOutbound",
			"public sealed record Say(RoomRoomSay Value) : RoomRoomJoinOutbound;",
			"public static implicit operator RoomRoomJoinOutbound(RoomRoomSay value) => new Say(value);",
		])
	})

	it("gives a keyed read side an On<Value> per member but message, and an only-message union none", () => {
		expect(
			lines(
				typed["Types.cs"],
				/^public static class (OnlyFeedTap|RoomRoomJoin)\w+Extensions$|^ {4}public static void On\w+<TOut>\(this ResumableConnection</,
			),
		).toEqual([
			"public static class RoomRoomJoinInboundExtensions",
			"public static void OnSaid<TOut>(this ResumableConnection<RoomRoomJoinInbound, TOut> connection, Action<RoomRoomSaid> handler)",
			"public static void OnLeft<TOut>(this ResumableConnection<RoomRoomJoinInbound, TOut> connection, Action<RoomRoomLeft> handler)",
		])
	})
})

/** Holds each typed connection in its declared type, sends a member, takes each handler and matches a read with is. */
const SPELLED = `using var c = Client();
Func<Task<ResumableConnection<RoomRoomJoinInbound, RoomRoomJoinOutbound>>> room = () => c.Room.Room.JoinAsync();
Func<Task<ResumableConnection<RtRoomOut, RtRoomIn>>> rt = () => c.Rt.Room.JoinAsync("r");
Func<Task<ResumableConnection<OnlyFeedTapInbound, JsonElement>>> only = () => c.Only.Feed.TapAsync();
Func<Task<ResumableConnection<CountFeedCountSend, JsonElement>>> count = () => c.Count.Feed.CountAsync();
Func<ResumableConnection<RoomRoomJoinInbound, RoomRoomJoinOutbound>, Task> use = async s =>
{
    await s.SendAsync(new RoomRoomSay { Text = "hi", Type = "say" });
    await s.SendAsync(new RoomRoomJoinOutbound.Say(new RoomRoomSay { Text = "hi", Type = "say" }));
    await s.SendAsync("raw");
    s.OnSaid(m => Note(m.Text));
    s.OnLeft((RoomRoomLeft m) => Note(m.Type));
    s.Message += (RoomRoomJoinInbound m) => Note(m.GetType().Name);
    await foreach (RoomRoomJoinInbound m in s)
    {
        Note(m is RoomRoomJoinInbound.Said said ? said.Value.Text : m is RoomRoomJoinInbound.Unknown u ? u.Raw.GetRawText() : "");
    }
};
Func<ResumableConnection<RtRoomOut, RtRoomIn>, Task> plain = async r =>
{
    await r.SendAsync(new RtRoomIn { Say = "hi" });
    await foreach (RtRoomOut m in r) { Note(m.Said); }
};
Func<ResumableConnection<OnlyFeedTapInbound, JsonElement>, Task> tap = async o =>
{
    o.Message += (OnlyFeedTapInbound m) => Note(m is OnlyFeedTapInbound.Message ? "message" : "other");
    await o.SendAsync(JsonDocument.Parse("{}").RootElement);
};
Func<ResumableConnection<CountFeedCountSend, JsonElement>, Task> counted = async k =>
{
    await foreach (CountFeedCountSend m in k) { long n = m.N; Note(n); }
};
Note("typed");`

/** Each misuse a typed connection refuses at compile time, with the error csc gives for it. */
const MISUSE: readonly (readonly [string, string, string])[] = [
	[
		"a send the server does not receive",
		'Func<ResumableConnection<RoomRoomJoinInbound, RoomRoomJoinOutbound>, Task> f = s => s.SendAsync(new RoomRoomSaid { Text = "hi", Type = "said" });',
		"error CS1503: Argument 1: cannot convert from 'HttpSdk.RoomRoomSaid' to 'HttpSdk.RoomRoomJoinOutbound'",
	],
	[
		/* CS1929, not CS1061: the room's OnSaid is in scope, for another receiver */
		"On<Value> on an op whose read side is unkeyed",
		"Action<ResumableConnection<RtRoomOut, RtRoomIn>> f = s => s.OnSaid(_ => { });",
		"error CS1929: 'ResumableConnection<RtRoomOut, RtRoomIn>' does not contain a definition for 'OnSaid'",
	],
	[
		"a member keyed message",
		"Action<ResumableConnection<OnlyFeedTapInbound, JsonElement>> f = s => s.OnMessage(_ => { });",
		"error CS1061: 'ResumableConnection<OnlyFeedTapInbound, JsonElement>' does not contain a definition for 'OnMessage'",
	],
]

describe.skipIf(!DOTNET)("a realtime operation with declared messages, compiled", SLOW, () => {
	it("spells each connection, sends a member through its implicit conversion, takes each handler, matches a read", async () => {
		const run = await consume("typed", "rt-spelled", { body: SPELLED })
		expect(seen(run), run.stderr).toEqual({ out: ["typed"], ran: true })
	})

	it("refuses a send the server does not receive, On<Value> on an unkeyed op, and a member keyed message", () => {
		const refused = MISUSE.map(([name, body, error]) => {
			const errors = checked("typed", program("HttpSdk", "HttpSdkClient", body))
			return [name, errors.length > 0 && errors.every((line) => line.includes(error)), errors]
		})
		expect(
			refused.map(([name, matched]) => [name, matched]),
			JSON.stringify(refused),
		).toEqual(MISUSE.map(([name]) => [name, true]))
	})
})

/** Sends on the keyed room, then two enumerations, each handler run and read noted in the order it happens. */
const ROOM = `using var c = Client();
var s = await c.Room.Room.JoinAsync();
s.Message += m => Note($"message {m.GetType().Name}");
s.OnSaid(m => Note($"said {m.Text}"));
await s.SendAsync(new RoomRoomSay { Text = "hi", Type = "say" });
await s.SendAsync("plain");
for (var round = 0; round < 2; round++)
{
    try
    {
        await foreach (var m in s)
        {
            Note(m switch
            {
                RoomRoomJoinInbound.Said said => $"read said {said.Value.Text}",
                RoomRoomJoinInbound.Left left => $"read left {left.Value.Type}",
                RoomRoomJoinInbound.Unknown u => $"read unknown {u.Raw.GetRawText()}",
                _ => "read other",
            });
            if (m is RoomRoomJoinInbound.Unknown)
            {
                break;
            }
        }
        Note("left the loop");
    }
    catch (DecodeException e)
    {
        Note($"read {e.GetType().Name} {e.Message.Split(':')[0]}");
    }
}
await s.CloseAsync();
Note($"{s.State}");`

/** The counter over two dials: each message's n exact, the misfit an error, and the cursor the first dial left. */
const COUNT = `using var c = Client();
var k = await c.Count.Feed.CountAsync(transport: new() { ReconnectDelay = TimeSpan.FromMilliseconds(10) });
var reads = 0;
while (reads < 3)
{
    try
    {
        await foreach (var m in k)
        {
            Note($"n {m.N}");
            if (++reads == 3)
            {
                break;
            }
        }
    }
    catch (DecodeException e)
    {
        reads++;
        Note($"err {e.Message.Split(':')[0]}");
    }
}
Note($"cursor {k.Options.LastEventId} {k.Options.ReconnectToken}");
await k.CloseAsync();
Note($"{k.State}");`

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

describe.skipIf(!DOTNET)("a realtime operation with declared messages on the wire", SLOW, () => {
	it("sends JSON, runs Message and OnSaid before each read, reads an undeclared value as Unknown, throws once on no JSON", async () => {
		const { received, run } = await served([ROOM_REPLY], async (server) => ({
			run: await consume("typed", "rt-room", { base: server.url, body: ROOM }),
			received: server.streams[0]?.received ?? [],
		}))
		expect(seen(run), run.stderr).toEqual({
			out: [
				"message Said",
				"said yo",
				"read said yo",
				"read DecodeException realtime message is not valid JSON",
				"message Left",
				"read left left",
				"message Unknown",
				'read unknown {"type":"wave"}',
				"left the loop",
				"Disconnected",
			],
			ran: true,
		})
		expect(received.flatMap((frame) => (frame.kind === "text" ? [frame.text] : []))).toEqual([
			'{"text":"hi","type":"say"}',
			"plain",
		])
	})

	it("decodes an int64 past 2^53 exact, throws on a misfit, and a reconnect resumes from the last cursor", async () => {
		const { run, urls } = await served(COUNT_REPLIES, async (server) => ({
			run: await consume("typed", "rt-count", { base: server.url, body: COUNT }),
			urls: server.hops.map((hop) => hop.url),
		}))
		expect({ ...seen(run), urls }, run.stderr).toEqual({
			out: [
				"n 9007199254740993",
				"err realtime message does not decode",
				"n -9007199254740993",
				"cursor 6 rt-5",
				"Disconnected",
			],
			ran: true,
			urls: ["/count/tap", "/count/tap?last_event_id=6&reconnect_token=rt-5"],
		})
	})
})
