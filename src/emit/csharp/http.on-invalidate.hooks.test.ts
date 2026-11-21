/**
 * `OnInvalidate`'s hooks as a C# call runs them (plan 9; plan 2's cases 1.4-1.5 in C#'s terms): detached on a
 * stream's or socket's open, once per call however many attempts it took, awaited before the write returns with the
 * caller's token, and never failing it; a hook's exception (thrown, or its Task faulted) goes to OnLog, or nowhere
 * without one. Consumer programs against the recording server (shared/__fixtures__/on-invalidate-cases.ts).
 */
import { describe, expect, it } from "vitest";

import {
  CALL_REPLIES,
  callCases,
  type Case,
  OPEN_REPLIES,
  openCases,
  PAST_FAILED,
  type Printed,
  ran,
  UPDATED,
} from "../shared/__fixtures__/on-invalidate-cases.ts";
import { served } from "../shared/__fixtures__/recording-server.ts";
import { consume, type Run, seen } from "./__fixtures__/consumer.ts";
import { invalidating, OPENS } from "./__fixtures__/on-invalidate.ts";

/** A boolean as C# prints it. */
const SHOWN: Printed = { no: "False", yes: "True" };

/** Every call-side case's section, each on its own recorded client. */
const CALLS = `Section("auth");
var sent = new ClientConfig
{
    BearerToken = "stale",
    OnAuthExpired = _ => Task.FromResult<string?>("fresh"),
    OnRequest = [(r, _) =>
    {
        Note("sent retry=" + r.IsRetry);
        return Task.CompletedTask;
    }],
};
await Client(Inv.Recorded(sent, Note)).Users.UpdateAsync("42");
Section("waits");
var done = false;
await Client(Inv.Recorded(new ClientConfig(), Note, async (e, _) =>
{
    await Task.Delay(50);
    done = true;
})).Users.UpdateAsync("42");
Note("done " + done);
Section("token");
using var caller = new System.Threading.CancellationTokenSource();
await Client(Inv.Recorded(new ClientConfig { Timeout = TimeSpan.FromSeconds(10) }, Note, (e, token) =>
{
    Note("same " + (token == caller.Token) + " canceled " + token.IsCancellationRequested);
    return Task.CompletedTask;
})).Users.UpdateAsync("42", null, null, caller.Token);
Section("safe");
var result = await Client(Inv.Recorded(new ClientConfig(), Note)).Safe.Users.UpdateAsync("42");
Note("ok " + result.IsOk);
Section("throwing");
var boom = new InvalidOperationException("boom");
var saved = await Client(Inv.Recorded(new ClientConfig(), Note, (e, _) => throw boom)).Users.UpdateAsync("42");
Note("data " + saved.Count);
Section("faulted");
saved = await Client(Inv.Recorded(new ClientConfig(), Note, async (e, _) =>
{
    await Task.Yield();
    throw boom;
})).Users.UpdateAsync("42");
Note("data " + saved.Count);
Section("unlogged");
var quiet = Client(new ClientConfig { OnInvalidate = [(e, _) => throw boom] });
await quiet.Users.UpdateAsync("42");
Note("returned");`;

/** C#'s own call-side cases: the caller's token, and a hook that throws or whose Task faults. */
const OWN: readonly Case[] = [
  ["hands each hook the caller's token, not the call's timeout token", "token", ["same True canceled False", UPDATED]],
  ["returns the write's data past a hook that throws, calls the others and tells OnLog", "throwing", PAST_FAILED],
  ["returns the write's data past a hook whose Task faults, calls the others and tells OnLog", "faulted", PAST_FAILED],
  ["drops a hook's exception without OnLog: the write returns", "unlogged", ["returned"]],
];

let opened: Promise<Run> | undefined;
let called: Promise<Run> | undefined;

/** OPENS' run against OPEN_REPLIES, once. */
function opens(): Promise<Run> {
  opened ??= served(OPEN_REPLIES, (server) => consume(...invalidating("opens", OPENS, server.url)));

  return opened;
}

/** CALLS' run against CALL_REPLIES, once. */
function calls(): Promise<Run> {
  called ??= served(CALL_REPLIES, (server) => consume(...invalidating("calls", CALLS, server.url)));

  return called;
}

describe("OnInvalidate: stream and socket opens call the hooks once, detached", () => {
  it.each(openCases(SHOWN))(
    "%s",
    async (_title, section, notes) => {
      const run = await opens();
      expect(seen(run, section), run.stderr).toStrictEqual(ran(notes));
    },
    600_000,
  );
});

describe("OnInvalidate: a write calls the hooks once, awaited, and never fails for them", () => {
  it.each([...callCases(SHOWN), ...OWN])(
    "%s",
    async (_title, section, notes) => {
      const run = await calls();
      expect(seen(run, section), run.stderr).toStrictEqual(ran(notes));
    },
    600_000,
  );

  it("prints nothing for a hook's exception without OnLog, the program run to its end", async () => {
    const run = await calls();
    expect([run.ran, run.stderr]).toStrictEqual([true, ""]);
  }, 600_000);
});
