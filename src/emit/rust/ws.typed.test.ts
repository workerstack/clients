/**
 * A WebSocket operation with declared messages (`x-websocket` `send` and `receive`) in the Rust SDK: its socket is
 * `TypedWebSocket<In, Out>`, `In` what the server sends and `Out` what it receives, so `send` takes only what the
 * server receives and `recv` gives what it sends. A union keyed on one field (D9) is the enum Rust already declares
 * for it, `Unknown` keeping a value the op does not declare, and the read side's members each get `on_<value>`,
 * except one whose value names a socket handler (message, close, error). Every `send` is JSON; a frame that is no
 * JSON is `Error::Decode` from `recv`, fired at `on_error`, and the socket reads on. An op without messages reads
 * `TypedWebSocket`, its frames as bytes.
 */
import { describe, expect, it } from "vitest";

import { typedStreams } from "../shared/__fixtures__/documents-typed.ts";
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts";
import { consume, sections, seen } from "./__fixtures__/consumer.ts";
import { FIXTURES } from "./__fixtures__/documents.ts";
import { withRust } from "./__fixtures__/rust-env.ts";
import { generateRustSdk } from "./sdk.ts";

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust();

/** Every compiled describe's bound: a cold gate builds the crate first, past SPAWN_TIMEOUT. */
const COLD_BUILD = 600_000;
const SLOW = { timeout: COLD_BUILD };

const typed = generateRustSdk(typedStreams()).files;

/** What each WebSocket method of `files` answers, from its signature line. */
const sockets = (files: Readonly<Record<string, string>>) =>
  (files["src/client.rs"] ?? "")
    .split("\n")
    .filter((line) => line.includes("-> Call<TypedWebSocket"))
    .map((line) => line.replace(/^.*-> /, ""));

/** The header and the `on_<value>` signatures of each `impl` block on `TypedWebSocket` in the typed crate. */
function handlers(): string[] {
  const lines = (typed["src/types.rs"] ?? "").split("\n");

  return lines.flatMap((line, i) => {
    if (!line.startsWith("impl<Out> crate::TypedWebSocket<")) return [];
    const end = lines.indexOf("}", i);

    return [line, ...lines.slice(i, end).filter((inner) => /^ {4}pub fn on_/.test(inner))].map((l) => l.trim());
  });
}

describe("a WebSocket operation with declared messages: its types", () => {
  it("answers a socket typed both ways, a one-way op its other side untyped, an op without messages untyped", () => {
    expect({ typed: sockets(typed), untyped: sockets(generateRustSdk(FIXTURES.ws.document()).files) }).toEqual({
      typed: [
        "Call<TypedWebSocket<InlineFeedJoinSend>> {",
        "Call<TypedWebSocket<KeyedChatOut, KeyedChatIn>> {",
        "Call<TypedWebSocket<KeyedNote>> {",
        "Call<TypedWebSocket<Vec<u8>, TellFeedTellReceive>> {",
        "Call<TypedWebSocket<WsServerFrame, WsClientFrame>> {",
      ],
      untyped: ["Call<TypedWebSocket> {", "Call<TypedWebSocket> {"],
    });
  });

  it("gives each keyed read type an on_<value> per member a socket handler does not name, an inline one too", () => {
    expect(handlers()).toEqual([
      "impl<Out> crate::TypedWebSocket<InlineFeedJoinSend, Out> {",
      "pub fn on_said(&mut self, mut handler: impl FnMut(&InlineFeedJoinSendSaid) + Send + 'static) {",
      "pub fn on_left(&mut self, mut handler: impl FnMut(&InlineFeedJoinSendLeft) + Send + 'static) {",
      "impl<Out> crate::TypedWebSocket<KeyedChatOut, Out> {",
      "pub fn on_said(&mut self, mut handler: impl FnMut(&KeyedSaid) + Send + 'static) {",
    ]);
  });
});

/** A socket of each typed op held in its declared type; compiling is the assertion. */
const SPELLED = `    let c = client(base)?;
    let _: sdk::Call<sdk::TypedWebSocket<sdk::KeyedChatOut, sdk::KeyedChatIn>> = c.keyed().chat().open(&Default::default());
    let _: sdk::Call<sdk::TypedWebSocket<sdk::KeyedNote>> = c.keyed().notes().open(&Default::default());
    let _: sdk::Call<sdk::TypedWebSocket<sdk::WsServerFrame, sdk::WsClientFrame>> = c.ws().chat().open(&Default::default());
    let _: sdk::Call<sdk::TypedWebSocket<sdk::InlineFeedJoinSend>> = c.inline().feed().join(&Default::default());
    let _: sdk::Call<sdk::TypedWebSocket<Vec<u8>, sdk::TellFeedTellReceive>> = c.tell().feed().tell(&Default::default());
    let _ = chat;
    n.note("typed");`;

/** Sends a member, takes each handler and matches what it reads. */
const CHAT_USE = `async fn chat(
    mut s: sdk::TypedWebSocket<sdk::KeyedChatOut, sdk::KeyedChatIn>,
    mut f: sdk::TypedWebSocket<sdk::InlineFeedJoinSend>,
) -> Result<(), sdk::Error> {
    s.send(&sdk::KeyedChatIn::Say(sdk::KeyedSay { text: "hi".into(), r#type: "say".into() })).await?;
    s.send(&sdk::KeyedChatIn::Ping(sdk::KeyedPing { r#type: "ping".into() })).await?;
    s.send_text("raw").await?;
    s.on_said(|m: &sdk::KeyedSaid| drop(m.text.len()));
    s.on_message(|m: &sdk::KeyedChatOut| drop(m.clone()));
    s.on_close(|reason: &str| drop(reason.len()));
    s.on_error(|e: &sdk::Error| drop(e.to_string()));
    let read: Option<Result<sdk::KeyedChatOut, sdk::Error>> = s.recv().await;
    if let Some(Ok(m)) = read {
        let _: String = match m {
            sdk::KeyedChatOut::Said(m) => m.text,
            sdk::KeyedChatOut::Close(m) => m.reason,
            sdk::KeyedChatOut::Unknown(v) => v.to_string(),
        };
    }
    f.on_said(|m: &sdk::InlineFeedJoinSendSaid| drop(m.text.len()));
    f.on_left(|m: &sdk::InlineFeedJoinSendLeft| drop(m.r#type.len()));
    Ok(())
}`;

/** Each misuse a typed socket refuses at compile time, with the error code rustc gives for it. */
const MISUSE: readonly (readonly [string, string, string])[] = [
  [
    "wrong_direction",
    "async fn misuse(mut s: sdk::TypedWebSocket<sdk::KeyedChatOut, sdk::KeyedChatIn>) {\n    let _ = s.send(&sdk::KeyedChatOut::Unknown(serde_json::Value::Null)).await;\n}",
    "error[E0308]: mismatched types",
  ],
  [
    "unkeyed_on",
    "fn misuse(mut s: sdk::TypedWebSocket<sdk::WsServerFrame, sdk::WsClientFrame>) {\n    s.on_said(|_| {});\n}",
    "error[E0599]: no method named `on_said`",
  ],
  [
    "member_on_close",
    "fn misuse(mut s: sdk::TypedWebSocket<sdk::KeyedChatOut, sdk::KeyedChatIn>) {\n    s.on_close(|_: &sdk::KeyedClosing| {});\n}",
    "error[E0631]: type mismatch in closure arguments",
  ],
];

describe.skipIf(!RUST)("a WebSocket operation with declared messages, compiled", SLOW, () => {
  it("spells each socket, sends a member, takes each handler and matches what it reads", async () => {
    const { body, decls } = sections({ spelled: SPELLED });
    const run = await consume("typed", "ws_spelled", { body, decls: `${decls}\n\n${CHAT_USE}` });
    expect(seen(run, "spelled"), run.stderr).toEqual({ built: true, out: ["typed"] });
  });

  it("refuses a send the server does not receive, on_<value> on an unkeyed op, and a member as on_close", async () => {
    const refused = [];

    for (const [name, decls, error] of MISUSE) {
      const run = await consume("typed", `ws_${name}`, { body: "    let _ = misuse;", decls });
      refused.push([name, run.built, run.stderr.includes(error)]);
    }

    expect(refused).toEqual(MISUSE.map(([name]) => [name, false, true]));
  });
});

/** Sends, reads and handler calls on the keyed chat, noted in the order they happen. */
const CHAT = sections({
  chat: `    let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let note = |log: &std::sync::Arc<std::sync::Mutex<Vec<String>>>, line: String| log.lock().expect("log").push(line);
    let mut s = client(base)?.keyed().chat().open(&Default::default()).await?;
    let l = log.clone();
    s.on_message(move |m| note(&l, format!("message {}", serde_json::to_string(m).expect("json"))));
    let l = log.clone();
    s.on_said(move |m| note(&l, format!("said {}", m.text)));
    let l = log.clone();
    s.on_error(move |e| note(&l, format!("error {e}")));
    let l = log.clone();
    s.on_close(move |reason| note(&l, format!("close {reason}")));
    s.send(&sdk::KeyedChatIn::Say(sdk::KeyedSay { text: "hi".into(), r#type: "say".into() })).await?;
    s.send_text("plain").await?;
    for _ in 0..5 {
        let read = match s.recv().await {
            None => "none".to_owned(),
            Some(Ok(sdk::KeyedChatOut::Said(m))) => format!("said {}", m.text),
            Some(Ok(sdk::KeyedChatOut::Close(m))) => format!("close {}", m.reason),
            Some(Ok(sdk::KeyedChatOut::Unknown(v))) => format!("unknown {v}"),
            Some(Err(e)) => format!("err {} {e}", matches!(e, sdk::Error::Decode(_))),
        };
        note(&log, format!("read {read}"));
    }
    for line in log.lock().expect("log").iter() {
        n.note(line.clone());
    }`,
});

const NOT_JSON = "decode: WebSocket frame is not valid JSON: expected ident at line 1 column 2";

describe.skipIf(!RUST)("a WebSocket operation with declared messages on the wire", SLOW, () => {
  it("sends JSON, hands a frame to on_message and on_said, reads an undeclared one as Unknown, and errors on no JSON", async () => {
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

    const { received, run } = await served([reply], async (server) => ({
      run: await consume("typed", "ws_chat", { base: server.url, ...CHAT }),
      received: server.streams[0]?.received ?? [],
    }));

    expect(seen(run, "chat"), run.stderr).toEqual({
      built: true,
      out: [
        'message {"text":"yo","type":"said"}',
        "said yo",
        "read said yo",
        `error ${NOT_JSON}`,
        `read err true ${NOT_JSON}`,
        'message {"reason":"bye","type":"close"}',
        "read close bye",
        'message {"type":"wave"}',
        'read unknown {"type":"wave"}',
        "close done",
        "read none",
      ],
    });
    expect(received.flatMap((frame) => (frame.kind === "text" ? [frame.text] : []))).toEqual([
      '{"text":"hi","type":"say"}',
      "plain",
    ]);
  });
});
