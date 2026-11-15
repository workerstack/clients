# SDK recipes

Each generated SDK in its own idiom: a client, a call and its typed error, and an event stream released the way the
language releases things. Each excerpt comes from a complete program under `docs/examples/`, compiled against an SDK
generated from a small example API (`Kitchen`) by the docs' tests. Your client is named after your document.

## TypeScript

A call throws a typed error per status. `client.safe` holds the same calls, each answering a Result to narrow on
`ok`: its data and response, or the error the call would have thrown and its response. Leaving a `for await` loop
over a stream frees its connection.

```ts sdk
import { DecodeError, Kitchen, NotFoundError } from "./kitchen"

export async function organization(client: Kitchen, orgId: string): Promise<string | null> {
	try {
		await client.organizations.retrieve({ params: { orgId } })
		return orgId
	} catch (error) {
		if (error instanceof NotFoundError) return null
		throw error
	}
}

export async function health(client: Kitchen): Promise<string> {
	const result = await client.safe.health.check()
	if (result.ok) return "up"
	if (result.error instanceof DecodeError) return `unreadable answer: ${result.error.message}`
	return `answered ${result.error.status}`
}
```

A stream the document types is typed end to end. An SSE operation with named events yields a union keyed on `event`,
each `data` typed and parsed from JSON; an unnamed event reads `event: "message"`. A WebSocket or realtime operation
with declared messages sends what the server receives and hears what it sends, and when those are a union keyed on one
field, `on("<value>")` hears each member. A socket's text frame that is not JSON reaches `on("error")`. A member named
like a socket event (`open`, `close`, `error`, `binary`, `message`) is heard only through `on("message")`. A browser
socket sends no headers or cookies, so a socket call takes neither. This excerpt compiles against an SDK of a small
streaming API (`Streams`).

```ts sdk
import type { Streams } from "./streams"

export async function ticks(client: Streams): Promise<number[]> {
	const at: number[] = []
	for await (const event of client.ticks.stream()) {
		if (event.event === "tick") at.push(event.data.at)
		else console.log("note", event.data)
	}
	return at
}

export function chat(client: Streams): void {
	const chat = client.chat.open()
	chat.on("said", (message) => console.log(message.text))
	chat.on("error", (error) => console.error(error))
	chat.send({ type: "say", text: "hi" })
}

export async function room(client: Streams): Promise<void> {
	const room = client.room.join()
	room.on("left", () => console.log("someone left"))
	await room.send({ type: "say", text: "hi" })
	for await (const message of room) if (message.type === "said") console.log(message.text)
}
```

## Go

Breaking out of a `range` over a stream closes it; a context ends it quietly.

```go
	for event, err := range client.Events.List(ctx, nil) {
		if err != nil {
			return seen, err
		}
		seen = append(seen, event.Untyped().Data) // any event's data as text; a type switch reads it typed
		if len(seen) == limit {
			break // leaving the loop closes the stream and frees its connection
		}
	}
```

A stream the document types is typed end to end. An SSE operation with named events yields `<Op>Event`, a sealed
interface with one type per name, each holding `SSEEvent[Data]`, so a type switch reads `Data` typed, each JSON event
parsed by its name; a name the operation does not declare is `<Op>OtherEvent`, and `Untyped()` reads any event's data
as text. A WebSocket or realtime operation with declared messages sends what the server receives and reads what it
sends, every `Send` JSON, and `SendText` sends text as is. When those are a union keyed on one field, the read side is
a sealed interface too, `On<Value>` takes a handler of that member's type, and a value the operation does not declare
reads as `<Op>OtherMessage`. A socket's frame that is not JSON is a `*DecodeError` from `Read`, handed to `OnError`,
and the socket stays open; a realtime connection sends it to `Errors()` and reads on. A member named like a socket
handler (`message`, `close`, `error`; on realtime only `message`) is heard only through `OnMessage`. This excerpt runs
against the small streaming API the TypeScript one calls.

```go
func ticks(ctx context.Context, client *sdk.Client) ([]int64, error) {
	var at []int64
	for event, err := range client.Ticks.Stream(ctx, nil) {
		if err != nil {
			return at, err
		}
		switch e := event.(type) {
		case sdk.TicksStreamTickEvent: // the name picks the type: Data is a Tick
			at = append(at, e.Data.At)
		default:
			fmt.Println("note", e.Untyped().Data)
		}
	}
	return at, nil
}

func chat(ctx context.Context, client *sdk.Client) error {
	chat, err := client.Chat.Open(ctx, nil)
	if err != nil {
		return err
	}
	defer chat.Close(1000, "")
	chat.OnSaid(func(message sdk.Said) { fmt.Println(message.Text) })
	chat.OnError(func(err error) { fmt.Fprintln(os.Stderr, err) })
	if err := chat.Send(ctx, sdk.Say{Type: "say", Text: "hi"}); err != nil {
		return err
	}
	_, err = chat.Read(ctx) // the handlers run as Read reads
	return err
}

func room(ctx context.Context, client *sdk.Client) error {
	room, err := client.Room.Join(ctx, nil)
	if err != nil {
		return err
	}
	defer room.Close()
	room.OnLeft(func(sdk.RoomLeft) { fmt.Println("someone left") })
	if err := room.Send(ctx, sdk.RoomSay{Type: "say", Text: "hi"}); err != nil {
		return err
	}
	for message := range room.Events() {
		if said, ok := message.(sdk.RoomSaid); ok {
			fmt.Println(said.Text)
		}
	}
	return nil
}
```

## Rust

The SDK is async. Dropping a stream closes its connection.

```rust
    while let Some(event) = stream.next().await {
        seen.push(match event? {
            EventsListEvent::Message(e) | EventsListEvent::Unknown(e) => e.data, // each name's data as text
        });
        if seen.len() == limit {
            break;
        }
    }
```

A stream the document types is typed end to end. An SSE operation with named events yields `<Op>Event`, an enum
with one variant per name, each holding `SseEvent<Data>`, so a `match` reads `data` typed, each JSON event decoded by
its name; a name the operation does not declare is `Unknown(SseEvent<String>)`. A WebSocket operation with declared
messages answers `TypedWebSocket<In, Out>` and a realtime one `ResumableConnection<In, Out>`: `send` takes what the
server receives, `recv` gives what it sends, every `send` is JSON, and `send_text` sends text as is. When those are a
union keyed on one field, the read side is an enum that keeps a value the operation does not declare as `Unknown`,
and `on_<value>` takes a handler of that member's type, run as `recv` reads. A socket's frame that is not JSON is
`Error::Decode` from `recv`, handed to `on_error`, and the socket stays open; a realtime connection returns it once
and reads on. A member named like a handler (`message`, `close`, `error`; on realtime only `message`) is heard only
through `on_message`. This excerpt runs against the small streaming API the TypeScript one calls.

```rust
async fn chat(client: &Client) -> Result<(), Error> {
    let mut chat = client.chat().open(&ChatOpenOpts::default()).await?;
    chat.on_said(|message| println!("{}", message.text));
    chat.on_error(|error| eprintln!("{error}"));
    chat.send(&ChatIn::Say(Say { r#type: "say".into(), text: "hi".into() })).await?;
    if let Some(Ok(ChatOut::Unknown(other))) = chat.recv().await {
        println!("undeclared {other}"); // the handlers ran as recv read it
    }
    Ok(())
}
```

From blocking code, drive the SDK with a runtime of your own: one per thread, never inside async code. In your own
crate, `tokio::runtime::Runtime::new()` with the `rt-multi-thread` feature does the same.

```rust
fn health_blocking(client: &Client) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(check_health(client))
}
```

## Python

`async with` frees a stream's connection when the block ends; a dropped stream frees it only when it is collected.

```python
    async with await client.events.list() as stream:  # leaving the block frees the connection
        async for event in stream:
            seen.append(event.data)
            if len(seen) == limit:
                break
```

A stream the document types is typed end to end. An SSE operation with named events yields a union of
`SseEventOf[Literal[name], Data]`, so checking `event.event` narrows `event.data`, each JSON event parsed by its name;
an unnamed event reads `event == "message"`. A WebSocket or realtime operation with declared messages sends what the
server receives and reads what it sends, every send JSON. When those are a union keyed on one field, `on("<value>")`
takes a handler of that member's type. A socket's frame that is not JSON reaches `on("error")` and raises
`DecodeError` from `recv()`, and the socket stays open; a realtime connection raises it the same way and reads on. A
member named like a socket event (`message`, `close`, `error`; on realtime only `message`) is heard only through
`on("message")`. This excerpt runs against the small streaming API the TypeScript one calls.

```python
async def ticks(client: AsyncSDK) -> list[int]:
    at: list[int] = []
    async with await client.ticks.stream() as stream:
        async for event in stream:
            if event.event == "tick":  # the name narrows the data
                at.append(event.data["at"])
            else:
                print("note", event.data)
    return at


async def chat(client: AsyncSDK) -> None:
    async with await client.chat.open() as chat:
        chat.on("said", lambda message: print(message["text"]))
        chat.on("error", lambda error: print(error, file=sys.stderr))
        await chat.send({"type": "say", "text": "hi"})


async def room(client: AsyncSDK) -> None:
    async with await client.room.join() as room:
        room.on("left", lambda _: print("someone left"))
        await room.send({"type": "say", "text": "hi"})
        async for message in room:
            if message["type"] == "said":
                print(message["text"])
```

## C#

`await using` disposes a stream, and with it its connection.

```csharp
        await using var stream = await client.Events.ListAsync(); // disposing it frees the connection
        await foreach (var ev in stream)
        {
            seen.Add(ev.Data);
            if (seen.Count == limit) break;
        }
```

## Java

Open a stream in try-with-resources: a `break` out of a for-each without one keeps the connection.

```java
    try (EventStream<String> stream = client.events().list(EventsListParams.builder().build())) {
      for (SseEvent<String> event : stream) {
        seen.add(event.data());
        if (seen.size() == limit) {
          break;
        }
      }
    }
```
