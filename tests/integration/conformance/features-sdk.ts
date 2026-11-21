/**
 * The SDK-only rows of the conformance grid (bit 21 i0): the answers no shared row had, each through the NORMAL client
 * of the six SDKs, and a text answer no shared row had (F2); a 2xx past the response cap (i2, on every SDK since i6); and a realtime
 * send's 2xx past it (i7). An undecodable 2xx is the target's decode error: TS's and Python's DecodeError, Go's *DecodeError
 * (i3), Rust's Error::Decode (its DecodeError since i4), C#'s and Java's DecodeException: each driver reads its target's. Every expectation is what the reference app (core `conformance/app.ts`) answers.
 * A write's OnInvalidate hooks called once (plan 6) run on TS, Go, Python (plan 7) and Rust (plan 8) so far.
 */
import { call, data, error, events, hop } from "./cells.ts";
import type { Expected, Feature, Scenario, Target } from "./matrix.ts";

/** The SDK targets: the six generated clients, each with its normal (throwing) and safe styles (bit 21 i). */
export const SDKS = ["ts", "go", "rust", "python", "csharp", "java"] as const satisfies readonly Target[];

const decode: Scenario[] = [
  {
    calls: [call("faults.undecodable", "GET", "/v1/faults/undecodable")],
    expect: [{ kind: "decode", status: 200 }],
    id: "undecodable-2xx",
    wire: [hop("GET", "/v1/faults/undecodable")],
  },
];

// the item's 28-byte answer past a 16-byte cap: the status and headers arrived, so it is an answer whose body the
// client reads no further, its decode error
const overCap: Scenario[] = [
  {
    calls: [call("items.get", "GET", "/v1/items/:id", { params: { id: "i1" } })],
    expect: [{ kind: "decode", status: 200 }],
    id: "over-cap-2xx",
    setup: { maxResponseBytes: 16 },
    wire: [hop("GET", "/v1/items/i1")],
  },
];

// a realtime send is a POST on the open connection, so its 2xx past the cap is an answer, the target's decode error
// (i7), never no answer: the upgrade 404s, the event stream opens quiet, the send's answer is past 16 bytes. A client
// that took it reads the `{ n: 1 }` the app then streams. A dial past the cap stays no answer (each SDK's unit legs).
const realtime: Scenario[] = [
  {
    calls: [call("realtime.capped", "GET", "/v1/realtime/capped", { send: [JSON.stringify({ say: "hi" })], take: 1 })],
    expect: [{ kind: "decode", status: 200 }],
    id: "send-over-cap",
    setup: { maxResponseBytes: 16 },
  },
];

// nothing listens on the refused origin: no answer, so no hop (f2)
const transport: Scenario[] = [
  {
    calls: [call("echo.get", "GET", "/v1/echo", { origin: "refused" })],
    expect: [{ kind: "transport" }],
    id: "refused",
    wire: [],
  },
];

const stream: Scenario[] = [
  // the opening answer is an error status: the typed error at open, never an event
  {
    calls: [call("ticks.refused", "GET", "/v1/ticks/refused", { take: 1 })],
    expect: [error(403, "limit_reached")],
    id: "initial-error",
    wire: [hop("GET", "/v1/ticks/refused")],
  },
  // the drop origin cuts the connection after the three ticks: each delivered, then the stream's own error (f2)
  {
    calls: [call("ticks.stream", "GET", "/v1/ticks", { origin: "drop" })],
    expect: [{ events: events(1, 3, "tick"), failed: "transport", kind: "events" }],
    id: "mid-drop",
    wire: [hop("GET", "/v1/ticks", { origin: "drop" })],
  },
];

// a text/plain answer as the exact string (F2): `health`, the app's one text op, unmarked so no MCP tool, already in
// the CLI's index; no shared row answered text before
const text: Scenario[] = [
  { calls: [call("health", "GET", "/v1/health")], expect: [data("ok")], id: "plain", wire: [hop("GET", "/v1/health")] },
];

/**
 * A users.update of `id` (plan 6's invalidate-once row) under the recording setup: the target records each event the
 * client's OnInvalidate hooks see, after a hook that fails when `recordInvalidate.failFirst`, as the call's
 * `invalidated` result: the write's data and the events. One event, the reads the write names with its id as a string.
 */
function invalidateOnce(id: string, recordInvalidate: { readonly failFirst: boolean }): Scenario {
  const targets: Expected[] = [
    { operationId: "users.list", params: {} },
    { operationId: "users.get", params: { id } },
  ];

  return {
    calls: [
      call("users.update", "PUT", "/v1/secure/users/:id", {
        body: { kind: "json", value: { name: "N" } },
        params: { id },
      }),
    ],
    expect: [{ ...data({ email: "", id, name: "N" }), events: [{ by: "users.update", targets }], kind: "invalidated" }],
    id: recordInvalidate.failFirst ? "failing-hook" : "write",
    setup: { auth: { kind: "bearer", token: "valid-token" }, recordInvalidate },
    wire: [hop("PUT", `/v1/secure/users/${id}`)],
  };
}

/** Rows the six SDKs run. */
const sdks = (id: string, asserted: string, scenarios: Scenario[]): Feature => ({
  asserted,
  id,
  scenarios,
  targets: SDKS,
});

/** The SDK-only rows. */
export const SDK_ROWS: readonly Feature[] = [
  sdks("decode", "a 2xx whose body does not decode is the target's decode error, never data", decode),
  sdks("transport", "no answer (a refused connection) is the target's connection error, never an API error", transport),
  sdks(
    "stream",
    "an error opening a stream is the typed error at open; a drop after events is the stream's own error",
    stream,
  ),
  sdks("text", "a text/plain answer is the exact string, never decoded as JSON", text),
  sdks("over-cap", "a 2xx past the response cap is the target's decode error, never no answer", overCap),
  sdks(
    "realtime",
    "a realtime send's 2xx past the response cap is the target's decode error, never no answer",
    realtime,
  ),
  // TS and Go (plan 6), Python (plan 7) and Rust (plan 8) record the hooks; each other SDK joins in its own slice
  {
    asserted: "a 2xx write calls its OnInvalidate hooks once with the reads it made stale; a failing hook leaves it ok",
    id: "invalidate-once",
    scenarios: [invalidateOnce("inv-1", { failFirst: false }), invalidateOnce("inv-2", { failFirst: true })],
    targets: ["ts", "go", "python", "rust"],
  },
];
