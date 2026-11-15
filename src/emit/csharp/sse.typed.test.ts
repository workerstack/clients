/**
 * A named-event SSE operation (an OpenAPI 3.2 `itemSchema` the IR reads into its events, D7) in the C# SDK (D17):
 * its stream is `EventStream<<Op>Event>`, an abstract record with one nested sealed record per event name in the
 * order declared, each holding `Data`, `Event`, `Id` and `Retry`, and `Unknown` for a name the op does not declare,
 * its data as sent. On the wire each JSON event is decoded by its name while a string event stays text; an unnamed
 * event is `message`; a declared JSON event that does not decode throws `DecodeException` and ends the stream, the
 * cursor already past it.
 */
import { describe, expect, it } from "vitest"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { typedStreams } from "../shared/__fixtures__/documents-typed.ts"
import { checked, consume, program, seen } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { generateCSharpSdk } from "./sdk.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every compiled or executed describe's bound: a cold gate builds the SDK first. */
const SLOW = { timeout: 600_000 }

/** Every line of the `typed` SDK's `file` that matches `pattern`, trimmed. */
const lines = (file: string, pattern: RegExp) =>
	(generateCSharpSdk(typedStreams()).files[file] ?? "")
		.split("\n")
		.filter((line) => pattern.test(line))
		.map((line) => line.trim())

describe("a named-event SSE operation's types", () => {
	it("answers an EventStream of its event record: a nested record per name in the order declared, then Unknown", () => {
		const tail =
			"(string? lastEventId = null, RequestOptions? options = null, CancellationToken cancellationToken = default) =>"
		expect({
			methods: lines("Client.cs", /EventStream<Sse\w+Event>/),
			records: lines(
				"Types.cs",
				/^public abstract record Sse\w+Event$|^ {4}public sealed record \w+\(.*\) : Sse\w+Event;$/,
			),
		}).toEqual({
			methods: [
				`public Task<EventStream<SseBeatsStreamEvent>> StreamAsync${tail}`,
				`public Task<EventStream<SseTicksStreamEvent>> StreamAsync${tail}`,
				`public Task<Result<EventStream<SseBeatsStreamEvent>>> StreamAsync${tail}`,
				`public Task<Result<EventStream<SseTicksStreamEvent>>> StreamAsync${tail}`,
			],
			records: [
				"public abstract record SseBeatsStreamEvent",
				"public sealed record Beat(long Data, string Event, string? Id, TimeSpan? Retry) : SseBeatsStreamEvent;",
				"public sealed record Unknown(string Data, string Event, string? Id, TimeSpan? Retry) : SseBeatsStreamEvent;",
				"public abstract record SseTicksStreamEvent",
				"public sealed record Tick(SseTick Data, string Event, string? Id, TimeSpan? Retry) : SseTicksStreamEvent;",
				"public sealed record Message(string Data, string Event, string? Id, TimeSpan? Retry) : SseTicksStreamEvent;",
				"public sealed record Unknown(string Data, string Event, string? Id, TimeSpan? Retry) : SseTicksStreamEvent;",
			],
		})
	})
})

/** An event named `name` whose data is `data`, JSON unless it is a string. */
const named = (name: string, data: Record<string, unknown>) => ({
	properties: {
		data: data.type === "string" ? data : { contentMediaType: "application/json", contentSchema: data, type: "string" },
		event: { const: name },
	},
	required: ["event", "data"],
	type: "object",
})

/** One SSE op whose event names clash with a member, the enclosing type, Unknown and a type the data spells. */
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
										named("data", { $ref: "#/components/schemas/Point" }),
										named("retry", { type: "string" }),
										named("unknown", { type: "string" }),
										named("point", { type: "integer" }),
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
}

describe("a named-event SSE operation's nested names", () => {
	it("suffixes Event to a name a member, Unknown, the enclosing type or a spelled type holds", () => {
		const text = generateCSharpSdk(CLASHING).files["Types.cs"] ?? ""
		expect(text.split("\n").filter((line) => line.startsWith("    public sealed record "))).toEqual([
			"    public sealed record DataEvent(Point Data, string Event, string? Id, TimeSpan? Retry) : ClashStreamEvent;",
			"    public sealed record RetryEvent(string Data, string Event, string? Id, TimeSpan? Retry) : ClashStreamEvent;",
			"    public sealed record UnknownEvent(string Data, string Event, string? Id, TimeSpan? Retry) : ClashStreamEvent;",
			"    public sealed record PointEvent(long Data, string Event, string? Id, TimeSpan? Retry) : ClashStreamEvent;",
			"    public sealed record ClashStreamEventEvent(string Data, string Event, string? Id, TimeSpan? Retry) : ClashStreamEvent;",
			"    public sealed record Unknown(string Data, string Event, string? Id, TimeSpan? Retry) : ClashStreamEvent;",
		])
	})
})

/** Holds each answer in its declared type and matches each nested record with `is`; compiling is half the assertion. */
const SPELLED = `using var c = Client();
Func<Task<EventStream<SseTicksStreamEvent>>> ticks = () => c.Sse.Ticks.StreamAsync();
Func<Task<Result<EventStream<SseBeatsStreamEvent>>>> beats = () => c.Safe.Sse.Beats.StreamAsync();
SseTicksStreamEvent[] events =
[
    new SseTicksStreamEvent.Tick(new SseTick { At = 1 }, "tick", "1", null),
    new SseTicksStreamEvent.Message("plain", "message", null, TimeSpan.FromSeconds(2)),
    new SseTicksStreamEvent.Unknown("{}", "other", "3", null),
];
foreach (var e in events)
{
    if (e is SseTicksStreamEvent.Tick t) Note($"tick {t.Data.At} {t.Id}");
    else if (e is SseTicksStreamEvent.Message m) Note($"message {m.Data} {m.Retry?.TotalSeconds}");
    else if (e is SseTicksStreamEvent.Unknown u) Note($"unknown {u.Event} {u.Data} {u.Id}");
}
SseBeatsStreamEvent beat = new SseBeatsStreamEvent.Beat(41, "beat", null, null);
if (beat is SseBeatsStreamEvent.Beat b) Note($"beat {b.Data + 1}");`

/** Reads `Data.At` off an Unknown event, which holds its data as text. */
const UNNARROWED = `SseTicksStreamEvent.Unknown u = new("{}", "other", null, null);
Note($"{u.Data.At}");`

describe.skipIf(!DOTNET)("a named-event SSE operation, compiled", SLOW, () => {
	it("spells each answer, on both styles, and matches each nested record with is", async () => {
		const run = await consume("typed", "sse-spelled", { body: SPELLED })
		expect(seen(run), run.stderr).toEqual({
			out: ["tick 1 1", "message plain 2", "unknown other {} 3", "beat 42"],
			ran: true,
		})
	})

	it("refuses Data.At read off an Unknown event", () => {
		const errors = checked("typed", program("HttpSdk", "HttpSdkClient", UNNARROWED))
		expect(errors.map((line) => line.replace(/^\(\d+,\d+\): /, ""))).toEqual([
			"error CS1061: 'string' does not contain a definition for 'At' and no accessible extension method 'At' accepting a first argument of type 'string' could be found (are you missing a using directive or an assembly reference?)",
		])
	})
})

const sse = (text: string): Reply => ({ sse: { end: "close", steps: [text] }, status: 200 })

/** Every event of each stream, matched on its nested record, and the error a stream ends on with its cursor. */
const READ = `using var c = Client();
Section("ticks");
await using (var s = await c.Sse.Ticks.StreamAsync())
{
    await foreach (var e in s)
    {
        if (e is SseTicksStreamEvent.Tick t) Note($"tick {t.Event} {t.Data.At} {t.Id}");
        else if (e is SseTicksStreamEvent.Message m) Note($"message {m.Event} {m.Data} {m.Id}");
        else if (e is SseTicksStreamEvent.Unknown u) Note($"unknown {u.Event} {u.Data} {u.Id}");
    }
}
Section("beat");
await using (var s = await c.Sse.Beats.StreamAsync())
{
    await foreach (var e in s)
    {
        if (e is SseBeatsStreamEvent.Beat b) Note($"beat {b.Data + 1}");
    }
}
Section("nope");
await using (var s = await c.Sse.Beats.StreamAsync())
{
    try
    {
        await foreach (var e in s)
        {
            Note($"event {e}");
        }
        Note("ended");
    }
    catch (DecodeException e)
    {
        Note($"{e.GetType().Name} {e.Message.Split(':')[0]} at {s.LastEventId}");
    }
}`

describe.skipIf(!DOTNET)("a named-event SSE operation on the wire", SLOW, () => {
	it("decodes a JSON event by its name, keeps a string event as sent, names an unnamed one message, ends on a bad one", async () => {
		const wire = 'event: tick\ndata: {"at":1}\nid: 1\n\ndata: plain\n\nevent: other\ndata: {"x":1}\n\n'
		const replies = [
			sse(wire),
			sse("event: beat\ndata: 42\n\n"),
			sse("event: beat\ndata: nope\nid: 5\n\nevent: beat\ndata: 1\n\n"),
		]
		const run = await served(replies, (server) => consume("typed", "sse-read", { base: server.url, body: READ }))
		expect({ beat: seen(run, "beat"), nope: seen(run, "nope"), ticks: seen(run, "ticks") }, run.stderr).toEqual({
			beat: { out: ["beat 43"], ran: true },
			nope: { out: ["DecodeException an event's data does not decode at 5"], ran: true },
			ticks: { out: ["tick tick 1 1", "message message plain 1", 'unknown other {"x":1} 1'], ran: true },
		})
	})
})
