"""A Python program against an SDK generated from the Kitchen example API and a small typed streaming API beside it: a
client, a call and its typed error, the same call through ``client.safe`` narrowed by ``match``, an event stream
released through ``async with``, and the typed streams: named SSE events, a keyed WebSocket and a keyed realtime
connection. Type-checked by mypy --strict in the docs' tests."""

import asyncio
import os
import sys

from http_sdk import APIStatusError, AsyncSDK, ClientConfig, DecodeError, Err, Ok


def new_client() -> AsyncSDK:
    return AsyncSDK(
        ClientConfig(base_url="https://api.example.com", bearer_token=os.environ.get("KITCHEN_TOKEN"), timeout=10)
    )


async def check_health(client: AsyncSDK) -> str | None:
    try:
        await client.health.check()
    except APIStatusError as failed:
        return f"health check answered {failed.status}"
    return None


async def health(client: AsyncSDK) -> str:
    match await client.safe.health.check():
        case Ok(data, response):
            return f"answered {response.status}: {data}"
        case Err(DecodeError() as unreadable, response):
            return f"answered {response.status}, unreadable: {unreadable}"
        case Err(error, response):
            return f"answered {response.status}: {error}"


async def first_events(client: AsyncSDK, limit: int) -> list[str]:
    seen: list[str] = []
    async with await client.events.list() as stream:  # leaving the block frees the connection
        async for event in stream:
            seen.append(event.data)
            if len(seen) == limit:
                break
    return seen


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


async def main() -> None:
    async with new_client() as client:
        print(await check_health(client))
        print(await health(client))
        print(await first_events(client, 2))


if __name__ == "__main__" and len(sys.argv) > 1:
    asyncio.run(main())
