// A C# program against an SDK generated from the Kitchen example API and a small streaming one beside it: a client, a
// call and its typed error, its `client.Safe` twin's Result, an event stream released by `await using`, and typed SSE
// events, WebSocket and realtime messages. Compiled by csc against the generated SDK in the docs' tests.
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using HttpSdk;

public static class Example
{
    public static HttpSdkClient NewClient() => new(new ClientConfig
    {
        BaseUrl = "https://api.example.com",
        BearerToken = Environment.GetEnvironmentVariable("KITCHEN_TOKEN"),
        Timeout = TimeSpan.FromSeconds(10),
    });

    public static async Task<string?> CheckHealth(HttpSdkClient client)
    {
        try
        {
            await client.Health.CheckAsync();
            return null;
        }
        catch (ApiStatusException failed)
        {
            return $"health check answered {failed.Status}";
        }
    }

    public static async Task<string> Listing(HttpSdkClient client, string id)
    {
        var result = await client.Safe.Root.ListAsync(id); // no answer (never sent, refused, timed out, canceled) still throws
        return result.Match(
            found => $"answered {result.Response.Status}: {found}",
            error => error switch
            {
                DecodeException unreadable => $"answered {result.Response.Status}, unreadable: {unreadable.Message}",
                ApiStatusException failed => $"answered {failed.Status}: {failed.Key}",
                _ => error.Message,
            });
    }

    public static async Task<List<string>> FirstEvents(HttpSdkClient client, int limit)
    {
        var seen = new List<string>();
        await using var stream = await client.Events.ListAsync(); // disposing it frees the connection
        await foreach (var ev in stream)
        {
            if (ev is EventsListEvent.Message message) seen.Add(message.Data);
            if (seen.Count == limit) break;
        }
        return seen;
    }

    public static async Task<List<long>> Ticks(HttpSdkClient client)
    {
        var at = new List<long>();
        await using var stream = await client.Ticks.StreamAsync();
        await foreach (var ev in stream)
        {
            if (ev is TicksStreamEvent.TickEvent tick) at.Add(tick.Data.At); // the name picks the type: Data is a Tick
            else if (ev is TicksStreamEvent.Unknown other) Console.WriteLine($"{other.Event}: {other.Data}");
        }
        return at;
    }

    public static async Task Chat(HttpSdkClient client)
    {
        await using var chat = await client.Chat.OpenAsync();
        chat.OnSaid(message => Console.WriteLine(message.Text));
        chat.Error += error => Console.Error.WriteLine(error.Message);
        await chat.SendAsync(new Say { Text = "hi", Type = "say" }); // a Say converts to ChatOpenOutbound
        if (await chat.ReceiveAsync() is ChatOpenInbound.Unknown other)
        {
            Console.WriteLine($"undeclared {other.Raw}"); // the handlers ran as ReceiveAsync read it
        }
    }

    public static async Task Room(HttpSdkClient client)
    {
        await using var room = await client.Room.JoinAsync();
        room.OnLeft(_ => Console.WriteLine("someone left"));
        await room.SendAsync(new RoomSay { Text = "hi", Type = "say" });
        await foreach (var message in room)
        {
            if (message is RoomJoinInbound.Said said) Console.WriteLine(said.Value.Text);
        }
    }

    public static async Task Main(string[] args)
    {
        if (args.Length < 1) return;
        using var client = NewClient();
        Console.WriteLine(await CheckHealth(client));
        Console.WriteLine(await Listing(client, args[0]));
        Console.WriteLine(string.Join(",", await FirstEvents(client, 2)));
        Console.WriteLine(string.Join(",", await Ticks(client)));
        await Chat(client);
        await Room(client);
    }
}
