/**
 * A named-event SSE operation (an OpenAPI 3.2 `itemSchema` the IR reads into its events, D7) in the Rust SDK: its
 * stream is `EventStream<<Op>Event>`, an enum with one variant per event name holding `SseEvent<Data>`, and
 * `Unknown(SseEvent<String>)` for a name the op does not declare. On the wire each JSON event is decoded by its
 * name while a string event stays text; an unnamed event is `message`; a declared JSON event that does not decode
 * is `Error::Decode` and ends the stream. An operation without events reads `EventStream` of `SseEvent<String>`,
 * and one with a single event schema `EventStream<SseEvent<T>>`.
 */
import { describe, expect, it } from "vitest"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { typedStreams } from "../shared/__fixtures__/documents-typed.ts"
import { consume, sections, seen } from "./__fixtures__/consumer.ts"
import { withRust } from "./__fixtures__/rust-env.ts"
import { generateRustSdk } from "./sdk.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()
/** Every compiled describe's bound: a cold gate builds the crate first, past SPAWN_TIMEOUT. */
const COLD_BUILD = 600_000
const SLOW = { timeout: COLD_BUILD }

/** Every line of the `typed` crate's `file` that matches `pattern`. */
const lines = (file: string, pattern: RegExp) =>
	(generateRustSdk(typedStreams()).files[file] ?? "").split("\n").filter((line) => pattern.test(line))

describe("a named-event SSE operation's types", () => {
	it("answers an EventStream of its event enum: a variant per name in the order declared, then Unknown", () => {
		expect({
			methods: lines("src/client.rs", /pub fn stream\(/).map((line) => line.trim()),
			variants: lines("src/types.rs", /^pub enum Sse\w+Event |^ {4}\w+\(crate::SseEvent/).map((line) => line.trim()),
		}).toEqual({
			methods: [
				"pub fn stream(&self, opts: &SseBeatsStreamOpts) -> Call<EventStream<SseBeatsStreamEvent>, S> {",
				"pub fn stream(&self, opts: &SseTicksStreamOpts) -> Call<EventStream<SseTicksStreamEvent>, S> {",
			],
			variants: [
				"pub enum SseBeatsStreamEvent {",
				"Beat(crate::SseEvent<i64>),",
				"Unknown(crate::SseEvent<String>),",
				"pub enum SseTicksStreamEvent {",
				"Tick(crate::SseEvent<SseTick>),",
				"Message(crate::SseEvent<String>),",
				"Unknown(crate::SseEvent<String>),",
			],
		})
	})
})

/** Holds each answer and each variant's event in its declared type; compiling is the assertion. */
const SPELLED = `    let c = client(base)?;
    let _: sdk::Call<sdk::EventStream<sdk::SseTicksStreamEvent>> = c.sse().ticks().stream(&Default::default());
    let _: sdk::Call<sdk::EventStream<sdk::SseBeatsStreamEvent>, sdk::Safe> = c.safe().sse().beats().stream(&Default::default());
    let tick: sdk::SseEvent<sdk::SseTick> = sdk::SseEvent { data: sdk::SseTick { at: 1 }, event: "tick".into(), id: String::new(), retry: None };
    let events = [
        sdk::SseTicksStreamEvent::Tick(tick),
        sdk::SseTicksStreamEvent::Message(sdk::SseEvent::default()),
        sdk::SseTicksStreamEvent::Unknown(sdk::SseEvent::default()),
    ];
    let _: sdk::SseEvent<i64> = match sdk::SseBeatsStreamEvent::Beat(sdk::SseEvent::default()) {
        sdk::SseBeatsStreamEvent::Beat(e) => e,
        sdk::SseBeatsStreamEvent::Unknown(e) => sdk::SseEvent { data: 0, event: e.event, id: e.id, retry: e.retry },
    };
    n.note(format!("{}", events.len()));`

/** Reads `data.at` off an Unknown event, which holds its data as text. */
const UNNARROWED = `    if let sdk::SseTicksStreamEvent::Unknown(e) = sdk::SseTicksStreamEvent::Unknown(sdk::SseEvent::default()) {
        n.note(format!("{}", e.data.at));
    }`

describe.skipIf(!RUST)("a named-event SSE operation, compiled", SLOW, () => {
	it("spells each answer, on both styles, and each variant's event type", async () => {
		const run = await consume("typed", "sse_spelled", sections({ spelled: SPELLED }))
		expect(seen(run, "spelled"), run.stderr).toEqual({ built: true, out: ["3"] })
	})

	it("refuses data.at read off an Unknown event", async () => {
		const run = await consume("typed", "sse_unnarrowed", { body: UNNARROWED })
		expect({ built: run.built, refused: run.stderr.includes("error[E0609]: no field `at`") }, run.stderr).toEqual({
			built: false,
			refused: true,
		})
	})
})

const sse = (text: string): Reply => ({ sse: { end: "close", steps: [text] }, status: 200 })

/** Every event of each stream, matched on its variant, and the error a stream ends on. */
const READ = sections({
	ticks: `    let mut s = client(base)?.sse().ticks().stream(&Default::default()).await?;
    while let Some(event) = s.next().await {
        match event? {
            sdk::SseTicksStreamEvent::Tick(e) => n.note(format!("tick {} {} {}", e.event, e.data.at, e.id)),
            sdk::SseTicksStreamEvent::Message(e) => n.note(format!("message {} {} {}", e.event, e.data, e.id)),
            sdk::SseTicksStreamEvent::Unknown(e) => n.note(format!("unknown {} {} {}", e.event, e.data, e.id)),
        }
    }`,
	beat: `    let mut s = client(base)?.sse().beats().stream(&Default::default()).await?;
    while let Some(event) = s.next().await {
        if let sdk::SseBeatsStreamEvent::Beat(e) = event? {
            n.note(format!("beat {}", e.data + 1));
        }
    }`,
	nope: `    let mut s = client(base)?.sse().beats().stream(&Default::default()).await?;
    while let Some(event) = s.next().await {
        match event {
            Err(e) => n.note(format!("{} {e}", matches!(e, sdk::Error::Decode(_)))),
            Ok(_) => n.note("event"),
        }
    }`,
})

describe.skipIf(!RUST)("a named-event SSE operation on the wire", SLOW, () => {
	it("decodes a JSON event by its name, keeps a string event as sent, names an unnamed one message, ends on a bad one", async () => {
		const wire = 'event: tick\ndata: {"at":1}\nid: 1\n\ndata: plain\n\nevent: other\ndata: {"x":1}\n\n'
		const replies = [
			sse(wire),
			sse("event: beat\ndata: 42\n\n"),
			sse("event: beat\ndata: nope\n\nevent: beat\ndata: 1\n\n"),
		]
		const run = await served(replies, (server) => consume("typed", "sse_read", { base: server.url, ...READ }))
		expect({ built: run.built, out: run.out }, run.stderr).toEqual({
			built: true,
			out: {
				beat: ["beat 43"],
				nope: ['true decode: sse event "beat": expected ident at line 1 column 2'],
				ticks: ["tick tick 1 1", "message message plain 1", 'unknown other {"x":1} 1'],
			},
		})
	})
})
