/**
 * The C# `OnInvalidate` cases' programs (http.on-invalidate.test.ts, http.on-invalidate.hooks.test.ts): plan 2's
 * document rides in the registry's `fixtures` entry (documents.ts; the registry is at its 16-document budget), so
 * every program runs against that SDK, `Safe_` beside `client.Safe` among its members. `Inv`, declared after the
 * program, shows an event as one note and wraps a config so its hooks note each event and its log each hook error.
 */
import type { Consumer } from "./consumer.ts"

/** The registry entry that carries plan 2's document. */
const KEY = "fixtures"

/**
 * `Inv.Shown`, an event as `by | operationId [key=value ...]` per target, keys sorted; `Inv.Recorded(config, note,
 * hooks)`, `config` whose OnInvalidate runs `hooks` then notes `invalidated <event>`, and whose OnLog notes
 * `log <level> <event>` for an entry carrying `boom`; `Inv.Next`, what a channel carries within 2 s, else `none`.
 */
const DECLS = `internal static class Inv
{
    public static string Shown(InvalidateEvent e)
    {
        var parts = new List<string> { e.By };
        foreach (var t in e.Targets)
        {
            var keys = new List<string>(t.Params.Keys);
            keys.Sort(StringComparer.Ordinal);
            parts.Add(t.OperationId + " [" + string.Join(" ", keys.ConvertAll(key => key + "=" + t.Params[key])) + "]");
        }
        return string.Join(" | ", parts);
    }

    public static ClientConfig Recorded(ClientConfig config, Action<object?> note, params Func<InvalidateEvent, System.Threading.CancellationToken, Task>[] hooks) =>
        config with
        {
            OnInvalidate = [.. hooks, (e, _) =>
            {
                note("invalidated " + Shown(e));
                return Task.CompletedTask;
            }],
            OnLog = entry =>
            {
                if (entry.Error?.Contains("boom") == true)
                {
                    note("log " + entry.Level + " " + entry.Event);
                }
            },
        };

    public static async Task<string> Next(System.Threading.Channels.ChannelReader<string> seen)
    {
        try
        {
            return await seen.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(2));
        }
        catch (TimeoutException)
        {
            return "none";
        }
    }
}`

/**
 * What `consume` takes to run `body` as program `name` against `base`, `Inv` declared after it. It builds the
 * arguments and spawns nothing, so the cases call `consume` (a listed spawning helper) themselves.
 */
export function invalidating(name: string, body: string, base: string): [typeof KEY, string, Consumer] {
	return [KEY, `on-invalidate-${name}`, { base, body, decls: DECLS }]
}

/**
 * One client whose hooks write each event to `seen`, then hold until `release` is set (`held` once they waited out
 * 3 s), reading the feed's stream to its end, then dialing the room's socket; after each, what the hooks saw. Then a
 * client whose first hook throws, on the feed's stream again.
 */
export const OPENS = `var release = new TaskCompletionSource();
var seen = System.Threading.Channels.Channel.CreateUnbounded<string>();
var held = false;
Func<InvalidateEvent, System.Threading.CancellationToken, Task> tell = (e, _) =>
{
    seen.Writer.TryWrite(Inv.Shown(e));
    return Task.CompletedTask;
};
Func<InvalidateEvent, System.Threading.CancellationToken, Task> hung = async (e, _) =>
{
    if (await Task.WhenAny(release.Task, Task.Delay(3000)) != release.Task)
    {
        held = true;
    }
};
var live = Client(new ClientConfig { OnInvalidate = [tell, hung] });
Section("sse");
await foreach (var ev in await live.Feed.LiveAsync())
{
    Note("event " + ev.Data);
}
Note("held " + held);
Note("invalidated " + await Inv.Next(seen.Reader));
Section("ws");
var socket = await live.Rooms.LiveAsync("r1");
Note("dial done");
Note("held " + held);
Note("invalidated " + await Inv.Next(seen.Reader));
await socket.CloseAsync();
release.SetResult();
Note("more " + seen.Reader.Count);
Section("sse-throw");
var logged = System.Threading.Channels.Channel.CreateUnbounded<string>();
Func<InvalidateEvent, System.Threading.CancellationToken, Task> boomed = (e, _) => throw new InvalidOperationException("boom");
var throwing = new ClientConfig
{
    OnInvalidate = [boomed, tell],
    OnLog = entry =>
    {
        if (entry.Error?.Contains("boom") == true)
        {
            logged.Writer.TryWrite(entry.Level + " " + entry.Event);
        }
    },
};
await foreach (var ev in await Client(throwing).Feed.LiveAsync())
{
    Note("event " + ev.Data);
}
Note("log " + await Inv.Next(logged.Reader));
Note("invalidated " + await Inv.Next(seen.Reader));`
