/**
 * `on_invalidate` on a Rust stream's or socket's open (plan 8; plan 2's case 1.4 in Rust's terms): an SSE stream and a
 * WebSocket call the hooks once as they open, detached, so neither waits on a held hook; a panicking hook there is
 * caught, its error on_log's, and the next hook still runs. One consumer program over the `fixtures` crate's `writes`
 * namespace against a recording server answering the stream, the socket and the panicking client's stream.
 */
import { describe, expect, it } from "vitest";

import { type Reply, served } from "../shared/__fixtures__/recording-server.ts";
import { consume, type Run, sections } from "./__fixtures__/consumer.ts";
import { BUILD_TIMEOUT, clean, invalidating, noted } from "./__fixtures__/on-invalidate.ts";

/**
 * The helpers: `Seen`, the channel a hook sends each event's note on; `next`, the next note within 2 s, or `none`;
 * `telling`, a hook sending `shown(e)`; `holding`, a hook that holds until `release` is notified, setting `held` once
 * it waited out 3 s.
 */
const DECLS = `type Seen = tokio::sync::mpsc::UnboundedSender<String>;

async fn next(rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>) -> String {
    match tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv()).await {
        Ok(Some(note)) => note,
        _ => "none".to_owned(),
    }
}

fn telling(tx: &Seen) -> sdk::OnInvalidateHook {
    let tx = tx.clone();
    sdk::on_invalidate(move |e| {
        let tx = tx.clone();
        async move {
            let _ = tx.send(shown(&e));
            Ok::<(), sdk::Error>(())
        }
    })
}

type Held = std::sync::Arc<std::sync::atomic::AtomicBool>;

fn holding(release: &std::sync::Arc<tokio::sync::Notify>, held: &Held) -> sdk::OnInvalidateHook {
    let (release, held) = (std::sync::Arc::clone(release), std::sync::Arc::clone(held));
    sdk::on_invalidate(move |_| {
        let (release, held) = (std::sync::Arc::clone(&release), std::sync::Arc::clone(&held));
        async move {
            let wait = std::time::Duration::from_secs(3);
            if tokio::time::timeout(wait, release.notified()).await.is_err() {
                held.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            Ok::<(), sdk::Error>(())
        }
    })
}`;

/** One client whose hooks tell then hold: the feed's stream read to its end, then the room's socket dialed. */
const OPENS = `    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let release = std::sync::Arc::new(tokio::sync::Notify::new());
    let held = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let hooks = vec![telling(&tx), holding(&release, &held)];
    let config = sdk::ClientConfig { base_url: base.into(), on_invalidate: hooks, ..Default::default() };
    let live = sdk::Client::new(config)?;
    let mut stream = live.writes().feed().live(&Default::default()).await?;
    while let Some(event) = stream.next().await {
        n.note(format!("event {}", event?.data));
    }
    n.note(format!("held {}", held.load(std::sync::atomic::Ordering::SeqCst)));
    n.note(format!("invalidated {}", next(&mut rx).await));
    n.section("ws");
    let mut socket = live.writes().rooms().live("r1", &Default::default()).await?;
    n.note("dial ok");
    n.note(format!("held {}", held.load(std::sync::atomic::Ordering::SeqCst)));
    n.note(format!("invalidated {}", next(&mut rx).await));
    let _ = socket.close(sdk::WS_STATUS_NORMAL_CLOSURE, "").await;
    release.notify_waiters();
    n.note(format!("more {}", rx.try_recv().is_ok()));`;

/** A client whose first hook panics: its stream read to its end, then what on_log and the next hook saw. */
const PANICKING = `    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let (logs, mut logged) = tokio::sync::mpsc::unbounded_channel::<String>();
    let boomed = sdk::on_invalidate(|_| async {
        if true {
            panic!("boom");
        }
        Ok::<(), sdk::Error>(())
    });
    let on_log: sdk::OnLogHook = std::sync::Arc::new(move |entry: sdk::LogEntry| {
        if entry.error.as_deref().is_some_and(|text| text.contains("boom")) {
            let _ = logs.send(format!("{} {}", entry.level, entry.event));
        }
    });
    let hooks = vec![boomed, telling(&tx)];
    let on_log = Some(on_log);
    let config = sdk::ClientConfig { base_url: base.into(), on_invalidate: hooks, on_log, ..Default::default() };
    std::panic::set_hook(Box::new(|_| {}));
    let mut stream = sdk::Client::new(config)?.writes().feed().live(&Default::default()).await?;
    while let Some(event) = stream.next().await {
        n.note(format!("event {}", event?.data));
    }
    n.note(format!("log {}", next(&mut logged).await));
    n.note(format!("invalidated {}", next(&mut rx).await));
    let _ = std::panic::take_hook();`;

const PROGRAM = sections({ sse: OPENS, "sse-panic": PANICKING });

/** The answers: the feed's stream, the room's socket, the panicking client's stream. */
const REPLIES: readonly Reply[] = [
  { sse: { end: "close", steps: ["data: x\n\n"] }, status: 200 },
  { status: 101, ws: { steps: [] } },
  { sse: { end: "close", steps: ["data: y\n\n"] }, status: 200 },
];

let memo: Promise<Run> | undefined;

/** PROGRAM's run against a server answering REPLIES, once. */
function opens(): Promise<Run> {
  memo ??= served(REPLIES, (server) =>
    consume(...invalidating("opened", { ...PROGRAM, base: server.url, decls: `${PROGRAM.decls}\n\n${DECLS}` })),
  );

  return memo;
}

describe("on_invalidate: stream and socket opens call the hooks once, detached", { timeout: BUILD_TIMEOUT }, () => {
  it("calls them once as the SSE stream and the WS socket open, neither waiting on a held hook", async () => {
    const run = await opens();

    expect([noted(run, "sse"), noted(run, "ws")], run.stderr).toStrictEqual([
      clean(["event x", "held false", "invalidated writes.feed.live | writes.feed.get {}"]),
      clean([
        "dial ok",
        "held false",
        'invalidated writes.rooms.live | writes.rooms.messages {"room": "r1"}',
        "more false",
      ]),
    ]);
  });

  it("catches a panicking hook on a stream's open: on_log gets its error, the next hook still runs", async () => {
    const run = await opens();
    expect(noted(run, "sse-panic"), run.stderr).toStrictEqual(
      clean(["event y", "log error error", "invalidated writes.feed.live | writes.feed.get {}"]),
    );
  });
});
