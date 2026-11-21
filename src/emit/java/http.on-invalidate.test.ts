/**
 * `onInvalidate` on the Java SDK (plan 9; plan 2's cases 1.3-1.4 in Java's terms): a client's builder hooks, called
 * once per successful write with the reads it made stale, as operationIds with the write's params as the call took
 * them (strings); which answers call them. One probe against the recording server, one section per case
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
import { compiledJavaSdk, type JavaRun } from "./__fixtures__/compiled.ts";
import { failureOf, MAIN, notesOf, probe, sdkFiles } from "./__fixtures__/on-invalidate.ts";
import { generateJavaSdk } from "./sdk.ts";

/** Every case's section, on one client without an invalidation config unless the section says otherwise. */
const BODY = `ExampleClient c = recorded(base());
UsersUpdateParams update = UsersUpdateParams.builder().id("42").build();
section("renamed");
c.safe_().save(SafeSaveParams.builder().id("7").rest("a/b.txt").build());
section("partial");
c.orgs().update(OrgsUpdateParams.builder().org("acme").build());
section("string");
c.users().update(update);
for (String failure : List.of("4xx", "5xx", "network")) {
  section(failure);
  RequestOptions.Builder options = RequestOptions.builder();
  if (failure.equals("network")) {
    options.baseUrl("http://127.0.0.1:1");
  }
  try {
    c.users().update(update, options.build());
    note("failed false");
  } catch (HttpException e) {
    note("failed true");
  }
  c.users().create(UsersCreateParams.builder().build());
}
section("get");
c.users().list(UsersListParams.builder().build());
c.users().create(UsersCreateParams.builder().build());
section("get-invalidating");
c.feed().refresh(FeedRefreshParams.builder().build());
c.users().create(UsersCreateParams.builder().build());
section("undecodable");
try {
  c.users().update(update);
} catch (DecodeException e) {
  note("decode true");
}
section("empty");
c.users().avatar(UsersAvatarParams.builder().id("42").build());
note("avatar done");
section("invalidation");
InvalidationConfig window = InvalidationConfig.builder().staleTime(java.time.Duration.ofSeconds(5)).build();
recorded(base().invalidation(window)).users().update(update);`;

let memo: Promise<JavaRun> | undefined;

/** BODY's run against OUTCOME_REPLIES, once. */
function outcomes(): Promise<JavaRun> {
  memo ??= served(OUTCOME_REPLIES, (server) => compiledJavaSdk(sdkFiles()).exec(MAIN, probe(server.url, BODY)));

  return memo;
}

describe("onInvalidate: a 2xx write calls the hooks once with the reads it made stale; nothing else does", () => {
  it.each(OUTCOME_CASES)(
    "%s",
    async (_title, section, notes) => {
      const run = await outcomes();
      expect(notesOf(run, section), failureOf(run)).toStrictEqual(ran(notes));
    },
    600_000,
  );

  it("names a selector that matches no read in a java: notice of the generation, the selector skipped", () => {
    expect(generateJavaSdk(UNRESOLVED).notices).toStrictEqual(unresolvedNotices("java"));
  });
});
