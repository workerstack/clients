/**
 * `on_invalidate`'s hooks as a Rust call runs them (plan 8; plan 2's cases 1.4-1.5 in Rust's terms): once per call
 * however many attempts it took, awaited before the write returns and outside its `timeout`, from the safe twin, and
 * never failing it; a hook's `Err` or panic goes to on_log, or nowhere without one. One consumer program over the
 * `fixtures` crate's `writes` namespace against a recording server (http.on-invalidate.opens.test.ts holds streams and
 * sockets).
 */
import { describe, expect, it } from "vitest";

import { type Reply, served } from "../shared/__fixtures__/recording-server.ts";
import { consume, type Run, sections } from "./__fixtures__/consumer.ts";
import { BUILD_TIMEOUT, clean, invalidating, noted, OK, UPDATED } from "./__fixtures__/on-invalidate.ts";

/** The hook helpers: `fresh`, an on_auth_expired handing out `fresh`; `failing`, a hook whose `Err` names boom. */
const DECLS = `type Fresh = Result<Option<String>, sdk::Error>;
type Refreshed = std::pin::Pin<Box<dyn std::future::Future<Output = Fresh> + Send>>;

fn fresh(_: Option<String>) -> Refreshed {
    Box::pin(async { Ok(Some("fresh".to_owned())) })
}

fn failing() -> sdk::OnInvalidateHook {
    sdk::on_invalidate(|_| async { Err::<(), sdk::Error>(sdk::Error::Hook("boom".into())) })
}`;

/** `users.update` of 42 on `config`, its data noted as JSON after the lines. */
const SAVED = `    let data = update(config).await?;
    drain(n, &lines);
    n.note(format!("data {}", serde_json::to_string(&data).expect("json")));`;

/** Every call-side case's section, each on its own client; `sections` runs them in name order. */
const PROGRAM = sections({
  auth: `    let lines: Lines = Default::default();
    let mut config = recorded(base, &lines, vec![]);
    config.bearer_token = Some("stale".into());
    config.on_auth_expired = Some(std::sync::Arc::new(fresh));
    update(config).await?;
    drain(n, &lines);`,
  failing: `    let lines: Lines = Default::default();
    let config = recorded(base, &lines, vec![failing()]);
${SAVED}`,
  panicking: `    let lines: Lines = Default::default();
    let boomed = sdk::on_invalidate(|_| async {
        if true {
            panic!("boom");
        }
        Ok::<(), sdk::Error>(())
    });
    let config = recorded(base, &lines, vec![boomed]);
    std::panic::set_hook(Box::new(|_| {}));
${SAVED}
    let _ = std::panic::take_hook();`,
  safe: `    let lines: Lines = Default::default();
    let c = sdk::Client::new(recorded(base, &lines, vec![]))?;
    let answer = c.safe().writes().users().update("42", &body(), &Default::default()).await?;
    drain(n, &lines);
    n.note(format!("ok {}", matches!(answer, sdk::Answer::Ok { .. })));`,
  timeout: `    let lines: Lines = Default::default();
    let slow = sdk::on_invalidate(|_| async {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        Ok::<(), sdk::Error>(())
    });
    let mut config = recorded(base, &lines, vec![slow]);
    config.timeout = Some(std::time::Duration::from_millis(100));
    let answer = update(config).await;
    drain(n, &lines);
    n.note(format!("ok {}", answer.is_ok()));`,
  unlogged: `    let on_invalidate = vec![failing()];
    let config = sdk::ClientConfig { base_url: base.into(), on_invalidate, ..Default::default() };
    n.note(format!("ok {}", update(config).await.is_ok()));`,
  waits: `    let lines: Lines = Default::default();
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let set = std::sync::Arc::clone(&done);
    let slow = sdk::on_invalidate(move |_| {
        let set = std::sync::Arc::clone(&set);
        async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            set.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok::<(), sdk::Error>(())
        }
    });
    update(recorded(base, &lines, vec![slow])).await?;
    drain(n, &lines);
    n.note(format!("done {}", done.load(std::sync::atomic::Ordering::SeqCst)));`,
});

/** A JSON 200 the write answers with, which a failing hook must leave its data. */
const SAVED_REPLY: Reply = { json: { saved: true }, status: 200 };

/** The answers, hop by hop, sections in name order: a 401 then its retry's 200; failing and panicking; the rest. */
const REPLIES: readonly Reply[] = [{ json: { message: "expired" }, status: 401 }, OK, SAVED_REPLY, SAVED_REPLY];

let memo: Promise<{ readonly run: Run; readonly tokens: readonly (string | undefined)[] }> | undefined;

/** PROGRAM's run against a server answering REPLIES, once, with each hop's Authorization header. */
function outcomes() {
  memo ??= served(REPLIES, async (server) => {
    const run = await consume(
      ...invalidating("hooked", { ...PROGRAM, base: server.url, decls: `${PROGRAM.decls}\n\n${DECLS}` }),
    );

    return { run, tokens: server.hops.map((hop) => hop.headers.authorization) };
  });

  return memo;
}

/** The notes of `section`; the run must have built. */
async function section(name: string) {
  const { run } = await outcomes();

  return noted(run, name);
}

describe("on_invalidate: once per call, not once per attempt", { timeout: BUILD_TIMEOUT }, () => {
  it("calls them once for a 401 that on_auth_expired refreshes into a 2xx", async () => {
    const { tokens } = await outcomes();
    expect([await section("auth"), tokens.slice(0, 2)]).toStrictEqual([
      clean([UPDATED]),
      ["Bearer stale", "Bearer fresh"],
    ]);
  });
});

describe("on_invalidate: the write runs the hooks before it returns", { timeout: BUILD_TIMEOUT }, () => {
  it("returns only after a slow hook returned", async () => {
    expect(await section("waits")).toStrictEqual(clean([UPDATED, "done true"]));
  });

  it("runs them outside the call's timeout: a hook slower than it leaves the write Ok", async () => {
    expect(await section("timeout")).toStrictEqual(clean([UPDATED, "ok true"]));
  });

  it("calls them from the safe twin", async () => {
    expect(await section("safe")).toStrictEqual(clean([UPDATED, "ok true"]));
  });
});

describe("on_invalidate: a hook's error never fails the write", { timeout: BUILD_TIMEOUT }, () => {
  it("returns the write's data when a hook returns an Err, calls the others and tells on_log", async () => {
    expect(await section("failing")).toStrictEqual(clean(["log error error", UPDATED, 'data {"saved":true}']));
  });

  it("catches a panicking hook: on_log gets its error, the next hook runs, the data stands", async () => {
    expect(await section("panicking")).toStrictEqual(clean(["log error error", UPDATED, 'data {"saved":true}']));
  });

  it("drops the error without on_log: the write succeeds and nothing is printed", async () => {
    const { run } = await outcomes();
    expect([await section("unlogged"), run.stderr]).toStrictEqual([clean(["ok true"]), ""]);
  });
});
