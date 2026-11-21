/**
 * `on_invalidate` on the Python SDK (plan 2's cases 1.3-1.4, in Python's terms): `AsyncSDK`'s `on_invalidate` and
 * `SDK`'s `on_invalidate_sync` hooks, called once per successful write with the reads it made stale, as operationIds
 * with the write's params as the call took them (`str`, as Python's path params are); which answers call them; a hook
 * list the client would not run refused at construction. One consumer program on the registry's `invalidate` package,
 * one section per case and client (http.on-invalidate.hooks.test.ts holds streams, sockets, the auth retry and the
 * hooks' own errors).
 */
import { describe, expect, it } from "vitest";

import { consume, type Run } from "./__fixtures__/consumer.ts";
import {
  clean,
  CREATED,
  invalidating,
  KINDS,
  noted,
  unresolvedDocument,
  UPDATED,
} from "./__fixtures__/on-invalidate.ts";
import { generatePythonSdk } from "./sdk.ts";

/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 };

/** Every case's section on each client, `<kind> <case>`, without an invalidation config unless it says otherwise. */
const BODY = `for kind in ("async", "sync"):
    c = recorded(kind)
    section(f"{kind} renamed")
    await done(c.safe_.save("7", "a/b.txt", {}))
    section(f"{kind} partial")
    await done(c.orgs.update("acme", {}))
    section(f"{kind} string")
    await done(c.users.update("42", {}))
    for name, status, body in (("4xx", 404, '{"error":"missing"}'), ("5xx", 500, '{"error":"fail"}')):
        section(f"{kind} {name}")
        REPLIES["PATCH /users/42"] = (status, body)
        try:
            await done(c.users.update("42", {}))
        except sdk.APIStatusError:
            note("failed True")
        del REPLIES["PATCH /users/42"]
        await done(c.users.create({}))
    section(f"{kind} network")
    refused = recorded(kind, base_url="http://127.0.0.1:1", http_client=None, async_http_client=None)
    try:
        await done(refused.users.update("42", {}))
    except sdk.APIConnectionError:
        note("failed True")
    await done(c.users.create({}))
    for name, read in (("get", c.users.list), ("get-invalidating", c.feed.refresh)):
        section(f"{kind} {name}")
        before = len(SENT)
        await done(read())
        await done(c.users.create({}))
        note(f"sent {len(SENT) - before}")
    section(f"{kind} undecodable")
    REPLIES["PATCH /users/42"] = (200, "{not json")
    try:
        await done(c.users.update("42", {}))
    except sdk.DecodeError:
        note("decode True")
    del REPLIES["PATCH /users/42"]
    section(f"{kind} empty")
    REPLIES["PUT /users/42/avatar"] = (204, "")
    note(f"avatar {await done(c.users.avatar('42', {}))}")
    del REPLIES["PUT /users/42/avatar"]
    section(f"{kind} invalidation")
    staling = recorded(kind, invalidation=sdk.InvalidationConfig(stale_time=5))
    await done(staling.users.update("42", {}))
    section(f"{kind} wrong-kind")
    wrong = "on_invalidate" if kind == "sync" else "on_invalidate_sync"
    try:
        (sdk.SDK if kind == "sync" else sdk.AsyncSDK)(sdk.ClientConfig(base_url="http://api.test", **{wrong: [print]}))
        note("built")
    except Exception as error:
        note(type(error).__name__)`;

let memo: Promise<Run> | undefined;

/** BODY's run on the `invalidate` package, once. */
function outcomes(): Promise<Run> {
  memo ??= consume("invalidate", "on_invalidate", invalidating(BODY));

  return memo;
}

/** The notes of `section` with whether the run ran to the end; its stderr is the failure's message. */
async function section(name: string) {
  const run = await outcomes();
  expect(run.ran, run.stderr).toBe(true);

  return noted(run, name);
}

describe("on_invalidate: a 2xx write calls the hooks once with the reads it made stale", SLOW, () => {
  it.each(KINDS)("%s: names the write by operationId, not its renamed member; fills each selector kind", async (k) => {
    expect(await section(`${k} renamed`)).toStrictEqual(
      clean([
        'invalidated safe.save | items.get {"id": "7"} | files.get {"rest": "a/b.txt"} | ' +
          'docs.list {} | docs.get {"id": "7"}',
      ]),
    );
  });

  it.each(KINDS)("%s: omits a target param the write does not know", async (kind) => {
    expect(await section(`${kind} partial`)).toStrictEqual(
      clean(['invalidated orgs.update | members.get {"org": "acme"}']),
    );
  });

  it.each(KINDS)("%s: gives an integer path param as the str the call took", async (kind) => {
    expect(await section(`${kind} string`)).toStrictEqual(clean([UPDATED]));
  });
});

describe("on_invalidate: a write that failed, or a read, calls no hook", SLOW, () => {
  it.each(KINDS.flatMap((kind) => ["4xx", "5xx", "network"].map((name) => `${kind} ${name}`)))(
    "%s: calls nothing for the failure, then once for the next 2xx write",
    async (name) => {
      expect(await section(name)).toStrictEqual(clean(["failed True", CREATED]));
    },
  );

  it.each(KINDS.flatMap((kind) => ["get", "get-invalidating"].map((name) => `${kind} ${name}`)))(
    "%s: calls nothing for the read, sent beside the next 2xx write",
    async (name) => {
      expect(await section(name)).toStrictEqual(clean([CREATED, "sent 2"]));
    },
  );
});

describe("on_invalidate: a 2xx write calls them whatever its body", SLOW, () => {
  it.each(KINDS)("%s: calls them for a 2xx whose body does not decode, the call raising DecodeError", async (kind) => {
    expect(await section(`${kind} undecodable`)).toStrictEqual(clean([UPDATED, "decode True"]));
  });

  it.each(KINDS)("%s: calls them for a 2xx with no body", async (kind) => {
    expect(await section(`${kind} empty`)).toStrictEqual(
      clean(['invalidated users.avatar | users.get {"id": "42"}', "avatar None"]),
    );
  });

  it.each(KINDS)("%s: calls them with an invalidation config, as without one", async (kind) => {
    expect([await section(`${kind} invalidation`), await section(`${kind} string`)]).toStrictEqual([
      clean([UPDATED]),
      clean([UPDATED]),
    ]);
  });
});

describe("on_invalidate: a client refuses the other client's hook list", SLOW, () => {
  it.each(KINDS)("%s: raises ConfigError at construction", async (kind) => {
    expect(await section(`${kind} wrong-kind`)).toStrictEqual(clean(["ConfigError"]));
  });
});

describe("on_invalidate: a selector that names no read", () => {
  it("is a python: notice of the generation, the selector skipped and the write's other reads kept", () => {
    const { files, notices } = generatePythonSdk(unresolvedDocument());
    const client = Object.entries(files).find(([path]) => path.endsWith("/client.py"))?.[1];
    expect([notices, client?.includes('reads=(("users.list", ()),)')]).toStrictEqual([
      [
        'python: users.update: x-invalidate "GET /nowhere" matches no GET read; skipped',
        'python: users.update: x-invalidate "POST /users" names a POST route; only GET reads are cached; skipped',
      ],
      true,
    ]);
  });
});
