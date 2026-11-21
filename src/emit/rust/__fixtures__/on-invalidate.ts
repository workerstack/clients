/**
 * What the Rust `on_invalidate` cases (http.on-invalidate*.test.ts, plan 8) share: the consumer programs' helpers
 * over the `fixtures` crate's `writes` namespace (documents-invalidate.ts), each hook built with `sdk::on_invalidate`
 * from a bare closure, and the notes a case expects. A program here builds arguments only: the cases call `consume`
 * (a listed spawning helper) themselves.
 */
import { expect } from "vitest"

import type { Reply } from "../../shared/__fixtures__/recording-server.ts"
import type { Consumer, Run } from "./consumer.ts"
import type { FixtureKey } from "./documents.ts"

/** The registry crate whose `writes` namespace holds the on_invalidate document. */
const KEY: FixtureKey = "fixtures"

/**
 * The programs' helpers: `Lines`, the notes hooks push from their tasks; `shown`, an event as one note (`by`, then
 * each target's operationId and params, `|` between); `body`, an empty JSON object; `update`, users.update of 42
 * on a client of `config`; `recorded`, a config aimed at `base` whose on_invalidate runs `hooks` then notes
 * `invalidated <event>`, and whose on_log notes `log <level> <event>` for an entry whose error names `boom`; `drain`,
 * the lines moved into the section's notes.
 */
const HELPERS = `type Lines = std::sync::Arc<std::sync::Mutex<Vec<String>>>;

fn shown(e: &sdk::InvalidateEvent) -> String {
    let mut parts = vec![e.by.clone()];
    for t in &e.targets {
        parts.push(format!("{} {:?}", t.operation_id, t.params));
    }
    parts.join(" | ")
}

type Data = std::collections::HashMap<String, serde_json::Value>;

fn body() -> Data {
    Default::default()
}

async fn update(config: sdk::ClientConfig) -> Result<Data, sdk::Error> {
    sdk::Client::new(config)?.writes().users().update("42", &body(), &Default::default()).await
}

fn recorded(base: &str, lines: &Lines, hooks: Vec<sdk::OnInvalidateHook>) -> sdk::ClientConfig {
    let (seen, logged) = (std::sync::Arc::clone(lines), std::sync::Arc::clone(lines));
    let mut on_invalidate = hooks;
    on_invalidate.push(sdk::on_invalidate(move |e| {
        let seen = std::sync::Arc::clone(&seen);
        async move {
            seen.lock().expect("lines").push(format!("invalidated {}", shown(&e)));
            Ok::<(), sdk::Error>(())
        }
    }));
    sdk::ClientConfig {
        base_url: base.into(),
        on_invalidate,
        on_log: Some(std::sync::Arc::new(move |entry: sdk::LogEntry| {
            if entry.error.as_deref().is_some_and(|text| text.contains("boom")) {
                logged.lock().expect("lines").push(format!("log {} {}", entry.level, entry.event));
            }
        })),
        ..Default::default()
    }
}

fn drain(n: &mut Notes, lines: &Lines) {
    for line in lines.lock().expect("lines").drain(..) {
        n.note(line);
    }
}`

/**
 * What `consume` takes to build and run program `name` (its `body` and `decls`, HELPERS beside them) on the
 * `fixtures` crate against `base`.
 */
export function invalidating(name: string, program: Consumer): [FixtureKey, string, Consumer] {
	return [KEY, name, { ...program, decls: `${program.decls ?? ""}\n\n${HELPERS}` }]
}

/** What a case reads of `run`, which must have built (its stderr the failure's message): the notes of `section`. */
export function noted(run: Run, section: string) {
	expect(run.built, run.stderr).toBe(true)
	return { built: run.built, out: run.out?.[section] }
}

/** A built run's notes of a section: `out`. */
export function clean(out: readonly string[]) {
	return { built: true, out }
}

/** A JSON 200 of `{}`: the answer every write and read a case does not name gets. */
export const OK: Reply = { json: {}, status: 200 }

/** The note `users.update` with id 42 makes: its one target, `users.get` with the id as the call took it. */
export const UPDATED = 'invalidated writes.users.update | writes.users.get {"id": "42"}'

/** The note `users.create` makes: the control write a case runs after the call it checks. */
export const CREATED = "invalidated writes.users.create | writes.users.list {}"

/** How long a case may take: a cold cargo build of the crate and its program (the Rust unit tests' bound). */
export const BUILD_TIMEOUT = 600_000
