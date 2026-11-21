/**
 * `on_invalidate` on the Rust SDK (plan 8; plan 2's cases 1.3-1.4 in Rust's terms): a client's config hooks, called
 * once per successful write with the reads it made stale, as operationIds with the write's params as the call took
 * them (`&str`); which answers call them. One consumer program over the `fixtures` crate's `writes` namespace against
 * a recording server, one section per case (http.on-invalidate.hooks.test.ts holds the auth retry and the hooks' own
 * errors, http.on-invalidate.opens.test.ts streams and sockets).
 */
import { describe, expect, it } from "vitest";

import { type Reply, REFUSED_URL, served } from "../shared/__fixtures__/recording-server.ts";
import { consume, type Run, sections } from "./__fixtures__/consumer.ts";
import { unresolved } from "./__fixtures__/documents-invalidate.ts";
import { BUILD_TIMEOUT, clean, CREATED, invalidating, noted, OK, UPDATED } from "./__fixtures__/on-invalidate.ts";
import { generateRustSdk } from "./sdk.ts";

/** A section's one write, `call` on the `writes` namespace, then its lines. */
function wrote(call: string): string {
  return `    let lines: Lines = Default::default();
    let c = sdk::Client::new(recorded(base, &lines, vec![]))?;
    c.writes().${call}.await?;
    drain(n, &lines);`;
}

/** `n` answers of OK. */
function oks(n: number): Reply[] {
  return Array.from({ length: n }, () => OK);
}

/** `users.update` of 42 answered by a failure, then the control write `users.create` on a client aimed at `base`. */
function failed(target: string): string {
  return `    let lines: Lines = Default::default();
    let c = sdk::Client::new(recorded(${target}, &lines, vec![]))?;
    let failed = c.writes().users().update("42", &body(), &Default::default()).await.is_err();
    drain(n, &lines);
    n.note(format!("failed {failed}"));
    let c = sdk::Client::new(recorded(base, &lines, vec![]))?;
    c.writes().users().create(&body(), &Default::default()).await?;
    drain(n, &lines);`;
}

/** A read `call`, then the control write. */
function reading(call: string): string {
  return `    let lines: Lines = Default::default();
    let c = sdk::Client::new(recorded(base, &lines, vec![]))?;
    c.writes().${call}(&Default::default()).await?;
    drain(n, &lines);
    c.writes().users().create(&body(), &Default::default()).await?;
    drain(n, &lines);`;
}

/** Every case's section, each on its own recorded client; `sections` runs them in name order. */
const PROGRAM = sections({
  empty: `    let lines: Lines = Default::default();
    let c = sdk::Client::new(recorded(base, &lines, vec![]))?;
    let answer = c.writes().users().avatar("42", &body(), &Default::default()).await;
    drain(n, &lines);
    n.note(format!("avatar {answer:?}"));`,
  get: reading("users().list"),
  "get-invalidating": reading("feed().refresh"),
  invalidation: `    let lines: Lines = Default::default();
    let mut config = recorded(base, &lines, vec![]);
    let stale_time = std::time::Duration::from_secs(5);
    config.invalidation = Some(sdk::InvalidationConfig { stale_time, ..Default::default() });
    update(config).await?;
    drain(n, &lines);`,
  network: failed(JSON.stringify(REFUSED_URL)),
  partial: wrote('orgs().update("acme", &body(), &Default::default())'),
  renamed: wrote('self_().save("7", "a/b.txt", &body(), &Default::default())'),
  "status-4xx": failed("base"),
  "status-5xx": failed("base"),
  string: wrote('users().update("42", &body(), &Default::default())'),
  undecodable: `    let lines: Lines = Default::default();
    let c = sdk::Client::new(recorded(base, &lines, vec![]))?;
    let answer = c.writes().users().update("42", &body(), &Default::default()).await;
    drain(n, &lines);
    n.note(format!("decode {}", matches!(answer, Err(sdk::Error::Decode(_)))));`,
});

/**
 * The answers, hop by hop, sections in name order (as `sections` runs them): a 204; each read and its control write;
 * one write; the network failure's control write (the refused call sends none); partial, renamed; 404 then the
 * control write; 500 then it; string; an undecodable 2xx.
 */
const REPLIES: readonly Reply[] = [
  { status: 204 },
  ...oks(8),
  { json: { error: "missing" }, status: 404 },
  OK,
  { json: { error: "fail" }, status: 500 },
  OK,
  OK,
  { headers: { "content-type": "application/json" }, status: 200, text: "{not json" },
];

let memo: Promise<Run> | undefined;

/** PROGRAM's run against a server answering REPLIES, once. */
function outcomes(): Promise<Run> {
  memo ??= served(REPLIES, (server) => consume(...invalidating("invalidated", { ...PROGRAM, base: server.url })));

  return memo;
}

/** The notes of `section`; the run must have built. */
async function section(name: string) {
  return noted(await outcomes(), name);
}

describe(
  "on_invalidate: a 2xx write calls the hooks once with the reads it made stale",
  { timeout: BUILD_TIMEOUT },
  () => {
    it("names the write by operationId, not its renamed member; fills `:id`, `*rest` and `:id?` targets", async () => {
      expect(await section("renamed")).toStrictEqual(
        clean([
          'invalidated writes.self.save | writes.items.get {"id": "7"} | writes.files.get {"rest": "a/b.txt"} | ' +
            'writes.docs.list {} | writes.docs.get {"id": "7"}',
        ]),
      );
    });

    it("omits a target param the write does not know", async () => {
      expect(await section("partial")).toStrictEqual(
        clean(['invalidated writes.orgs.update | writes.members.get {"org": "acme"}']),
      );
    });

    it("gives an integer param as the string the call took", async () => {
      expect(await section("string")).toStrictEqual(clean([UPDATED]));
    });
  },
);

describe("on_invalidate: a write that failed calls no hook", { timeout: BUILD_TIMEOUT }, () => {
  it.each([["status-4xx"], ["status-5xx"], ["network"]] as const)(
    "calls nothing for a %s failure, then once for the next 2xx write",
    async (name) => {
      expect(await section(name)).toStrictEqual(clean(["failed true", CREATED]));
    },
  );

  it.each([["get"], ["get-invalidating"]] as const)(
    "calls nothing for a %s read, then once for the next 2xx write",
    async (name) => {
      expect(await section(name)).toStrictEqual(clean([CREATED]));
    },
  );
});

describe("on_invalidate: a 2xx write calls them whatever its body", { timeout: BUILD_TIMEOUT }, () => {
  it("calls them for a 2xx whose body does not decode, the call's error Error::Decode", async () => {
    expect(await section("undecodable")).toStrictEqual(clean([UPDATED, "decode true"]));
  });

  it("calls them for a 2xx with no body", async () => {
    expect(await section("empty")).toStrictEqual(
      clean(['invalidated writes.users.avatar | writes.users.get {"id": "42"}', "avatar Ok(())"]),
    );
  });

  it.each([
    ["without", "string"],
    ["with", "invalidation"],
  ] as const)("calls them %s an InvalidationConfig", async (_label, name) => {
    expect(await section(name)).toStrictEqual(clean([UPDATED]));
  });
});

describe("on_invalidate: a selector that names no read", () => {
  it("is a rust: notice of the generation, the selector skipped and the write's other reads kept", () => {
    const { files, notices } = generateRustSdk(unresolved());
    expect([
      notices,
      files["src/client.rs"]?.includes('spec.reads("users.update", &[("users.list", &[])]);'),
    ]).toStrictEqual([
      [
        'rust: users.update: x-invalidate "GET /nowhere" matches no GET read; skipped',
        'rust: users.update: x-invalidate "POST /users" names a POST route; only GET reads are cached; skipped',
      ],
      true,
    ]);
  });
});
