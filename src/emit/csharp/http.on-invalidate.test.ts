/**
 * `OnInvalidate` on the C# SDK (plan 9; plan 2's cases 1.3-1.4 in C#'s terms): a client's config hooks, called once
 * per successful write with the reads it made stale, as operationIds with the write's params as the call took them
 * (strings); which answers call them. One consumer program against the recording server, one section per case
 * (shared/__fixtures__/on-invalidate-cases.ts); http.on-invalidate.hooks.test.ts holds streams, sockets, the auth
 * retry and the hooks' own errors.
 */
import { describe, expect, it } from "vitest";

import {
  OUTCOME_CASES,
  OUTCOME_REPLIES,
  ran,
  UNRESOLVED,
  unresolvedNotices,
} from "../shared/__fixtures__/on-invalidate-cases.ts";
import { served } from "../shared/__fixtures__/recording-server.ts";
import { consume, type Run, seen } from "./__fixtures__/consumer.ts";
import { invalidating } from "./__fixtures__/on-invalidate.ts";
import { generateCSharpSdk } from "./sdk.ts";

/** Every case's section, on one client without an invalidation config unless the section says otherwise. */
const BODY = `var c = Client(Inv.Recorded(new ClientConfig(), Note));
Section("renamed");
await c.Safe_.SaveAsync("7", "a/b.txt");
Section("partial");
await c.Orgs.UpdateAsync("acme");
Section("string");
await c.Users.UpdateAsync("42");
foreach (var failure in new[] { "4xx", "5xx", "network" })
{
    Section(failure);
    var options = failure == "network" ? new RequestOptions { BaseUrl = "http://127.0.0.1:1" } : null;
    try
    {
        await c.Users.UpdateAsync("42", null, options);
        Note("failed false");
    }
    catch (HttpException)
    {
        Note("failed true");
    }
    await c.Users.CreateAsync();
}
Section("get");
await c.Users.ListAsync();
await c.Users.CreateAsync();
Section("get-invalidating");
await c.Feed.RefreshAsync();
await c.Users.CreateAsync();
Section("undecodable");
try
{
    await c.Users.UpdateAsync("42");
}
catch (DecodeException)
{
    Note("decode true");
}
Section("empty");
await c.Users.AvatarAsync("42");
Note("avatar done");
Section("invalidation");
var window = new ClientConfig { Invalidation = new InvalidationConfig { StaleTime = TimeSpan.FromSeconds(5) } };
await Client(Inv.Recorded(window, Note)).Users.UpdateAsync("42");`;

let memo: Promise<Run> | undefined;

/** BODY's run against OUTCOME_REPLIES, once. */
function outcomes(): Promise<Run> {
  memo ??= served(OUTCOME_REPLIES, (server) => consume(...invalidating("outcomes", BODY, server.url)));

  return memo;
}

describe("OnInvalidate: a 2xx write calls the hooks once with the reads it made stale; nothing else does", () => {
  it.each(OUTCOME_CASES)(
    "%s",
    async (_title, section, notes) => {
      const run = await outcomes();
      expect(seen(run, section), run.stderr).toStrictEqual(ran(notes));
    },
    600_000,
  );

  it("names a selector that matches no read in a csharp: notice of the generation, the selector skipped", () => {
    expect(generateCSharpSdk(UNRESOLVED).notices).toStrictEqual(unresolvedNotices("csharp"));
  });
});
