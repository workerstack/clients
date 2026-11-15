/**
 * A realtime operation with declared messages (`x-websocket` `send` and `receive`) in the Rust SDK: its connection is
 * `ResumableConnection<In, Out>`, `In` what the server sends and `Out` what it receives, so `send` takes only what
 * the server receives and `recv` gives what it sends. A union keyed on one field (D9) is the enum Rust already
 * declares for it, `Unknown` keeping a value the op does not declare, and the read side's members each get
 * `on_<value>`, except a `message` member, which `on_message` names. A typed message that is no JSON, or does not fit
 * `In`, is `Error::Decode` from `recv` once, and the connection reads on. Each message is parsed once, so an int64
 * past 2^53 arrives exact and its cursor fields still resume a reconnect. An op without messages keeps its declared
 * event type, or reads `ResumableConnection` of `serde_json::Value`, a message that is no JSON as text.
 */
import { describe, expect, it } from "vitest"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { typedStreams } from "../shared/__fixtures__/documents-typed.ts"
import { consume, sections, seen } from "./__fixtures__/consumer.ts"
import { withRust } from "./__fixtures__/rust-env.ts"
import { generateRustSdk } from "./sdk.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()
/** Every compiled describe's bound: a cold gate builds the crate first, past SPAWN_TIMEOUT. */
const COLD_BUILD = 600_000
const SLOW = { timeout: COLD_BUILD }

const typed = generateRustSdk(typedStreams()).files

/** What each realtime method of `files` answers, from its signature line. */
const connections = (files: Readonly<Record<string, string>>) =>
	(files["src/client.rs"] ?? "")
		.split("\n")
		.filter((line) => line.includes("-> Call<ResumableConnection"))
		.map((line) => line.replace(/^.*-> /, ""))

/** The header and the `on_<value>` signatures of each `impl` block on `ResumableConnection` in the typed crate. */
function handlers(): string[] {
	const lines = (typed["src/types.rs"] ?? "").split("\n")
	return lines.flatMap((line, i) => {
		if (!line.startsWith("impl<Out> crate::ResumableConnection<")) return []
		const end = lines.indexOf("}", i)
		return [line, ...lines.slice(i, end).filter((inner) => /^ {4}pub fn on_/.test(inner))].map((l) => l.trim())
	})
}

describe("a realtime operation with declared messages: its types", () => {
	it("answers a connection typed both ways, a one-way op its other side untyped, an op without messages as before", () => {
		expect({
			typed: connections(typed),
			untyped: connections(generateRustSdk(FIXTURES.realtime.document()).files),
		}).toEqual({
			typed: [
				"Call<ResumableConnection<CountFeedCountSend>> {",
				"Call<ResumableConnection<OnlyFeedTapSend>> {",
				"Call<ResumableConnection<RoomRoomOut, RoomRoomIn>> {",
				"Call<ResumableConnection<RtRoomOut, RtRoomIn>> {",
			],
			untyped: ["Call<ResumableConnection<Payload>> {", "Call<ResumableConnection> {"],
		})
	})

	it("gives a keyed read type an on_<value> per member but message, and an only-message union none", () => {
		expect(handlers()).toEqual([
			"impl<Out> crate::ResumableConnection<RoomRoomOut, Out> {",
			"pub fn on_said(&mut self, mut handler: impl FnMut(&RoomRoomSaid) + Send + 'static) {",
			"pub fn on_left(&mut self, mut handler: impl FnMut(&RoomRoomLeft) + Send + 'static) {",
		])
	})
})

/** A connection of each typed op held in its declared type; compiling is the assertion. */
const SPELLED = `    let c = client(base)?;
    let _: sdk::Call<sdk::ResumableConnection<sdk::RoomRoomOut, sdk::RoomRoomIn>> = c.room().room().join(&Default::default());
    let _: sdk::Call<sdk::ResumableConnection<sdk::RtRoomOut, sdk::RtRoomIn>> = c.rt().room().join("r", &Default::default());
    let _: sdk::Call<sdk::ResumableConnection<sdk::OnlyFeedTapSend>> = c.only().feed().tap(&Default::default());
    let _: sdk::Call<sdk::ResumableConnection<sdk::CountFeedCountSend>> = c.count().feed().count(&Default::default());
    let _ = room;
    n.note("typed");`

/** Sends a member, takes each handler and matches what it reads. */
const ROOM_USE = `async fn room(
    mut s: sdk::ResumableConnection<sdk::RoomRoomOut, sdk::RoomRoomIn>,
    mut only: sdk::ResumableConnection<sdk::OnlyFeedTapSend>,
) -> Result<(), sdk::Error> {
    s.send(&sdk::RoomRoomIn::Say(sdk::RoomRoomSay { text: "hi".into(), r#type: "say".into() })).await?;
    s.send_text("raw").await?;
    s.on_said(|m: &sdk::RoomRoomSaid| drop(m.text.len()));
    s.on_left(|m: &sdk::RoomRoomLeft| drop(m.r#type.len()));
    s.on_message(|m: &sdk::RoomRoomOut| drop(m.clone()));
    let read: Option<Result<sdk::RoomRoomOut, sdk::Error>> = s.recv().await;
    if let Some(Ok(m)) = read {
        let _: String = match m {
            sdk::RoomRoomOut::Said(m) => m.text,
            sdk::RoomRoomOut::Left(m) => m.r#type,
            sdk::RoomRoomOut::Unknown(v) => v.to_string(),
        };
    }
    only.on_message(|m: &sdk::OnlyFeedTapSend| drop(m.clone()));
    only.send(&serde_json::json!({"any": 1})).await?;
    Ok(())
}`

/** Each misuse a typed connection refuses at compile time, with the error code rustc gives for it. */
const MISUSE: readonly (readonly [string, string, string])[] = [
	[
		"wrong_direction",
		"async fn misuse(mut s: sdk::ResumableConnection<sdk::RoomRoomOut, sdk::RoomRoomIn>) {\n    let _ = s.send(&sdk::RoomRoomOut::Unknown(serde_json::Value::Null)).await;\n}",
		"error[E0308]: mismatched types",
	],
	[
		"unkeyed_on",
		"fn misuse(mut s: sdk::ResumableConnection<sdk::RtRoomOut, sdk::RtRoomIn>) {\n    s.on_said(|_| {});\n}",
		"error[E0599]: no method named `on_said`",
	],
	[
		"member_on_message",
		"fn misuse(mut s: sdk::ResumableConnection<sdk::RoomRoomOut, sdk::RoomRoomIn>) {\n    s.on_message(|_: &sdk::RoomRoomSaid| {});\n}",
		"error[E0631]: type mismatch in closure arguments",
	],
]

describe.skipIf(!RUST)("a realtime operation with declared messages, compiled", SLOW, () => {
	it("spells each connection, sends a member, takes each handler and matches what it reads", async () => {
		const { body, decls } = sections({ spelled: SPELLED })
		const run = await consume("typed", "rt_spelled", { body, decls: `${decls}\n\n${ROOM_USE}` })
		expect(seen(run, "spelled"), run.stderr).toEqual({ built: true, out: ["typed"] })
	})

	it("refuses a send the server does not receive, on_<value> on an unkeyed op, and a member as on_message", async () => {
		const refused = []
		for (const [name, decls, error] of MISUSE) {
			const run = await consume("typed", `rt_${name}`, { body: "    let _ = misuse;", decls })
			refused.push([name, run.built, run.stderr.includes(error)])
		}
		expect(refused).toEqual(MISUSE.map(([name]) => [name, false, true]))
	})
})

/** Sends, reads and handler calls on the keyed room, noted in the order they happen. */
const ROOM = sections({
	room: `    let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let note = |log: &std::sync::Arc<std::sync::Mutex<Vec<String>>>, line: String| log.lock().expect("log").push(line);
    let mut s = client(base)?.room().room().join(&Default::default()).await?;
    let l = log.clone();
    s.on_message(move |m| note(&l, format!("message {}", serde_json::to_string(m).expect("json"))));
    let l = log.clone();
    s.on_said(move |m| note(&l, format!("said {}", m.text)));
    s.send(&sdk::RoomRoomIn::Say(sdk::RoomRoomSay { text: "hi".into(), r#type: "say".into() })).await?;
    s.send_text("plain").await?;
    for _ in 0..4 {
        let read = match s.recv().await {
            None => "none".to_owned(),
            Some(Ok(sdk::RoomRoomOut::Said(m))) => format!("said {}", m.text),
            Some(Ok(sdk::RoomRoomOut::Left(m))) => format!("left {}", m.r#type),
            Some(Ok(sdk::RoomRoomOut::Unknown(v))) => format!("unknown {v}"),
            Some(Err(e)) => format!("err {} {e}", matches!(e, sdk::Error::Decode(_))),
        };
        note(&log, format!("read {read}"));
    }
    note(&log, format!("close {:?}", s.close().await.map_err(|e| e.to_string())));
    for line in log.lock().expect("log").iter() {
        n.note(line.clone());
    }`,
})

/** The counter over two dials: each message's n exact, the misfit an error, and the cursor the first dial left. */
const COUNT = sections({
	count: `    let o = sdk::CountFeedCountOpts { transport: sdk::TransportOpts { reconnect_delay_ms: Some(10), ..Default::default() }, ..Default::default() };
    let mut s = client(base)?.count().feed().count(&o).await?;
    for _ in 0..3 {
        match s.recv().await {
            Some(Ok(m)) => n.note(format!("n {}", m.n)),
            Some(Err(e)) => n.note(format!("err {} {e}", matches!(e, sdk::Error::Decode(_)))),
            None => n.note("none"),
        }
    }
    n.note(format!("cursor {:?} {:?}", s.last_event_id(), s.reconnect_token()));
    n.note(format!("close {:?}", s.close().await.map_err(|e| e.to_string())));`,
})

const NOT_JSON = "decode: realtime message is not valid JSON: expected ident at line 1 column 2"

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

describe.skipIf(!RUST)("a realtime operation with declared messages on the wire", SLOW, () => {
	it("sends JSON, hands a message to on_message and on_said, reads an undeclared one as Unknown, errors once on no JSON", async () => {
		const { received, run } = await served([ROOM_REPLY], async (server) => ({
			run: await consume("typed", "rt_room", { base: server.url, ...ROOM }),
			received: server.streams[0]?.received ?? [],
		}))
		expect(seen(run, "room"), run.stderr).toEqual({
			built: true,
			out: [
				'message {"text":"yo","type":"said"}',
				"said yo",
				"read said yo",
				`read err true ${NOT_JSON}`,
				'message {"type":"left"}',
				"read left left",
				'message {"type":"wave"}',
				'read unknown {"type":"wave"}',
				"close Ok(())",
			],
		})
		expect(received.flatMap((frame) => (frame.kind === "text" ? [frame.text] : []))).toEqual([
			'{"text":"hi","type":"say"}',
			"plain",
		])
	})

	it("decodes an int64 past 2^53 exact, errors on a misfit, and a reconnect resumes from the last cursor", async () => {
		const { run, urls } = await served(COUNT_REPLIES, async (server) => ({
			run: await consume("typed", "rt_count", { base: server.url, ...COUNT }),
			urls: server.hops.map((hop) => hop.url),
		}))
		expect({ ...seen(run, "count"), urls }, run.stderr).toEqual({
			built: true,
			out: [
				"n 9007199254740993",
				'err true decode: realtime message does not decode: invalid type: string "six", expected i64',
				"n -9007199254740993",
				'cursor Some("6") Some("rt-5")',
				"close Ok(())",
			],
			urls: ["/count/tap", "/count/tap?last_event_id=6&reconnect_token=rt-5"],
		})
	})
})
