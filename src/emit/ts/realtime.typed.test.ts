/**
 * A realtime operation with declared messages (the rich `x-websocket` the IR reads into `messages`) in the TS SDK: its
 * connection yields what the server sends, `send` takes what it receives, and `on("message")` and, for a union keyed on
 * one field, `on(value)` (D9) hear each message beside the iterator. Once the server is gone the connection retries
 * `maxReconnectAttempts` times and ends. A scripted `WebSocket` and `fetch` stand in for the network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as morph from "ts-morph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { consumerChecker } from "./__fixtures__/consumer-types.ts";
import { emittedSdk } from "./__fixtures__/emitted.ts";
import { FakeSocket } from "./__fixtures__/fake-socket.ts";
import { generateSdk } from "./sdk.ts";

type Json = Record<string, unknown>;

type Connection = AsyncIterable<unknown> & {
  close(): void;
  on(event: string, handler: (data: unknown) => void): void;
  send(data: unknown): Promise<void>;
  readonly state: string;
};

const spec = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, `../../ir/__fixtures__/specs/streams/${name}.json`), "utf8"),
  ) as Json;

const KEYED = spec("realtime-keyed");
const MESSAGES = spec("realtime-messages");
const check = consumerChecker(morph);

/** `room.join` of the SDK over the keyed document, with `options`, its network refused but for scripted sockets. */
async function joinRoom(options: Json = {}): Promise<Connection> {
  const { TestSDK } = (await emittedSdk(KEYED)) as unknown as {
    TestSDK: new (config: Json) => { room: { join: (input: Json) => Connection } };
  };

  const fetch = () => Promise.reject(new TypeError("fetch failed"));

  return new TestSDK({ baseURL: "https://api.test", fetch }).room.join(options);
}

/** The newest scripted socket. */
const latest = () => FakeSocket.sockets.at(-1) as FakeSocket;

beforeEach(() => {
  FakeSocket.sockets = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a realtime operation with declared messages: its types", () => {
  it("writes the member line with what it yields, what it sends, and the key it dispatches on", () => {
    const line = (document: Json) => {
      const { files, stem } = generateSdk(document, { name: "TestSDK" });

      return (files[`${stem}.types.gen.ts`] ?? "").match(/"?join"?\(.*\): ResumableConnection.*/g);
    };

    expect([line(KEYED), line(MESSAGES)]).toEqual([
      ['join(input?: RealtimeCallOptions): ResumableConnection<RoomOut, RoomIn, "type">'],
      ["join(input: { params: { roomId: string } } & RealtimeCallOptions): ResumableConnection<RoomOut, RoomIn>"],
    ]);
  });

  it("sends only a member, narrows on(value) to it, and types on(message) and the iterator as the whole union", () => {
    const consumer = `const room = sdk.room.join()
void room.send({ type: "say", text: "hi" })
// @ts-expect-error "shout" is no message the server receives
void room.send({ type: "shout" })
room.on("said", (m) => {
	const text: string = m.text
	void text
})
room.on("left", (m) => {
	expectType<Equal<typeof m, { type: "left" }>>()
})
room.on("message", (m) => {
	expectType<Equal<typeof m, { type: "said"; text: string } | { type: "left" }>>()
})
// @ts-expect-error "joined" is no value the server sends
room.on("joined", () => {})
type M = typeof room extends AsyncIterable<infer V> ? V : never
expectType<Equal<M, { type: "said"; text: string } | { type: "left" }>>()`;

    expect(check(KEYED, consumer)).toEqual([]);
  });

  it("keeps an unkeyed message schema to on(message) alone", () => {
    const consumer = `const room = sdk.room.join({ params: { roomId: "r" } })
room.on("message", (m) => {
	const said: string = m.said
	void said
})
void room.send({ say: "hi" })
// @ts-expect-error an unkeyed schema gets no on(value)
room.on("said", () => {})`;

    expect(check(MESSAGES, consumer)).toEqual([]);
  });
});

describe("a realtime operation with declared messages: on the wire", () => {
  it("hands each message to the iterator, on(message) and on(value), past a handler that throws", async () => {
    const room = await joinRoom();
    const heard: unknown[][] = [];
    room.on("message", () => {
      throw new Error("a consumer's bug");
    });

    for (const event of ["message", "said", "left"]) room.on(event, (data) => heard.push([event, data]));
    const iterator = room[Symbol.asyncIterator]();
    const first = iterator.next();
    latest().accept();
    await room.send({ text: "hi", type: "say" });
    latest().receive('{"type":"said","text":"hi"}');
    latest().receive('{"type":"left"}');
    const yielded = [(await first).value, (await iterator.next()).value];
    room.close();
    expect({ heard, sent: latest().sent, yielded }).toEqual({
      heard: [
        ["message", { text: "hi", type: "said" }],
        ["said", { text: "hi", type: "said" }],
        ["message", { type: "left" }],
        ["left", { type: "left" }],
      ],
      sent: ['{"text":"hi","type":"say"}'],
      yielded: [{ text: "hi", type: "said" }, { type: "left" }],
    });
  });

  it("retries maxReconnectAttempts times once the server is gone, then ends done with state closed", async () => {
    const attempts: number[] = [];

    const room = await joinRoom({
      maxReconnectAttempts: 2,
      onReconnecting: (attempt: number) => attempts.push(attempt),
      reconnectDelayMs: 1,
    });

    const iterator = room[Symbol.asyncIterator]();
    const first = iterator.next();
    latest().accept();
    latest().receive('{"type":"left"}');
    await first;
    // the server goes: the open socket drops, and every later handshake fails
    vi.stubGlobal(
      "WebSocket",
      class extends FakeSocket {
        constructor(url: string | URL) {
          super(url);
          queueMicrotask(() => this.close(1006));
        }
      },
    );
    latest().close(1006);
    expect([await iterator.next(), attempts, room.state]).toEqual([{ done: true, value: undefined }, [1, 2], "closed"]);
  });
});
