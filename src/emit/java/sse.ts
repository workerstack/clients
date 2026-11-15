/**
 * An SSE operation's method (bit 16 phase d1, J1/J3/J7; C#'s `sse.ts`), opened by the call through the exchange's
 * `events`, so an error status throws before any event; the stream decodes each event whole through the function the
 * method hands it. An operation that names its events (D7) answers `EventStream<<Op>Event>` (D17): `<Op>Event` is a
 * sealed interface with one nested record per event name in the order declared, each holding `data` (JSON decoded by
 * its name, a string event's text as sent), `event`, `id` and `retry`, then `Unknown` for a name the operation does
 * not declare, its data as sent; its `of` dispatches by name, an unnamed event `message`. A nested name the models
 * scope holds (a java.lang or runtime type), a type the declaration spells, `Unknown` or the interface's own takes the
 * suffix `Event`. Any other operation answers `EventStream<SseEvent<T>>`, `T` the declared event schema's type, or
 * `EventStream<SseEvent<String>>` for untyped events. Its cursor field, `lastEventId`, is sent as Last-Event-ID only
 * when set and non-empty; a declared Last-Event-ID header param folds into it. A stream method is the same text in
 * either mode: it answers no Result. Its javadoc says how a stream lets its connection go (F1: a for-each `break` has
 * no close hook).
 */
import type { IRSseEvent } from "../../ir/model.ts";
import { isJsonEventData, type SdkOp, sseEvents } from "../../ir/sdk-model.ts";
import { javaString } from "../shared/escape.ts";
import { javaTypeName, NameScope } from "../shared/lang.ts";
import {
  bin,
  call as callOf,
  cond,
  type Declaration,
  type Expr,
  id,
  lambda,
  lit,
  local,
  methodHeader,
  param,
  newOf,
  ref,
  returnStmt,
  rule,
  statement,
  typeHeader,
} from "./layout.ts";
import { type JavaTypeContext, javaTypeOf } from "./models.ts";
import { docOf } from "./sdk-decl.ts";
import type { JavaHeaders } from "./sdk-headers.ts";

/** The header an SSE open resumes an event stream with. */
export const LAST_EVENT_ID = "Last-Event-ID";

/** The cursor's Params field. */
export const CURSOR = "lastEventId";

/** Whether a declared header param is Last-Event-ID (any casing), the resume channel the cursor field carries. */
export const isLastEventIdHeader = (name: string): boolean => name.toLowerCase() === LAST_EVENT_ID.toLowerCase();

/** F1's doc obligation: how a stream lets its connection go. */
const RELEASE = "Open it in try-with-resources: a for-each break without one keeps the connection.";

/** The SSE runtime's files: the stream, its event, the parser and the body's pump; core, with every exchange. */
export const SSE_FILES: readonly string[] = ["EventStream", "Pump", "Sse", "SseEvent"];

// the names a nested record never takes besides the models scope's: the types its declaration spells
const SPELLED = ["Duration", "EventStream", "Object", "SseEvent", "String", "TypeReference"];

/** One declared event as a nested record: the name it is sent under, its record, its data's type, and whether it is JSON. */
type Nested = { readonly event: string; readonly record: string; readonly data: string; readonly json: boolean };

/** A nested record's header: its data, then the event's name, id and retry. */
const recordLines = (record: string, data: string, name: string) =>
  typeHeader(2, {
    components: [
      { name: "data", type: data },
      { name: "event", type: "String" },
      { name: "id", type: "String" },
      { name: "retry", type: "Duration" },
    ],
    end: "{}",
    implements: name,
    kind: "record",
    modifiers: ["public"],
    name: record,
  });

/** The record `record` built from `e` under `name`, its data `data`. */
const built = (record: string, data: Expr) => newOf(record, [data, "name", callOf("e", "id"), callOf("e", "retry")]);

/** The `of` arm of `nested`: its data from JSON by its type, or as sent. */
const armOf = ({ data, event, json, record }: Nested) => {
  const text = callOf("e", "data");
  const value = json ? callOf("EventStream", "data", [text, newOf(`TypeReference<${data}>`, [], true)]) : text;

  return statement(6, rule(lit(javaString(event)), built(record, value)));
};

/**
 * The nested records of `name`, one per event name (a name declared twice is its first declaration's): each data's
 * type, and a record name that never shadows a type the declaration spells, one the models scope holds, `Unknown` or
 * `name` itself.
 */
function nestedOf(op: SdkOp, events: readonly IRSseEvent[], name: string, ctx: JavaTypeContext): Nested[] {
  const typed = events
    .filter((e, i) => events.findIndex((other) => other.name === e.name) === i)
    .map(({ data, name: event }) => {
      const json = isJsonEventData(data, ctx.names.resolve);
      const type = json ? javaTypeOf(data, { ...ctx, fieldName: event, parentName: op.id, path: "" }) : "String";

      return { data: type, event, json };
    });

  // a type a record's data spells would be shadowed by a nested record of its name
  const spelled = typed.flatMap(({ data }) => data.split(/\W+/).filter((word) => word !== ""));
  const reserved = new Set([...SPELLED, ...spelled, name, "Unknown"]);
  const scope = new NameScope(reserved);

  return typed.map((t): Nested => {
    const base = javaTypeName(t.event);

    return { ...t, record: scope.claim(reserved.has(base) || ctx.names.has(base) ? `${base}Event` : base) };
  });
}

/** `name`'s `of`: the event's name, then the record its switch builds. */
const ofLines = (name: string, nested: readonly Nested[]) => [
  docOf(
    "The event {@code e} decoded by its name, an unnamed one {@code message}; a JSON event that does not decode throws {@link DecodeException}.",
  ),
  ...methodHeader(2, { modifiers: ["static"], name: "of", params: [param("SseEvent<String>", "e")], returns: name }),
  ...statement(4, local({ init: callOf("EventStream", "nameOf", ["e"]), name: "name", type: "String" })),
  "    return switch (name) {",
  ...nested.flatMap(armOf),
  ...statement(6, rule(null, built("Unknown", callOf("e", "data")))),
  "    };",
  "  }",
];

/** `<Op>Event`, hoisted into `ctx.decls` once with its nested records and its `of`; its name. */
function namedEvents(op: SdkOp, events: readonly IRSseEvent[], ctx: JavaTypeContext): string {
  const name = ctx.names.hoist(`${op.id}.events`, `${javaTypeName(op.id)}Event`);

  if (ctx.decls.has(name)) return name;
  // claimed before its body: what the data types hoist comes after it
  ctx.decls.set(name, "");
  const nested = nestedOf(op, events, name, ctx);
  const records = nested.map(({ record }) => record).join(", ");
  // the nested records are its permits
  const header = typeHeader(0, { end: "{", kind: "interface", modifiers: ["public", "sealed"], name, permits: [] });
  ctx.decls.set(
    name,
    [
      docOf(
        `One event of ${op.id}: ${records}, or Unknown for a name the operation does not declare, its data as sent. An instanceof match reads the event's data.`,
        "",
      ),
      ...header,
      ...nested.flatMap(({ data, record }) => [...recordLines(record, data, name), ""]),
      ...recordLines("Unknown", "String", name),
      "",
      ...ofLines(name, nested),
      "}",
    ].join("\n"),
  );

  return name;
}

/**
 * What an SSE op's stream yields and the decode the method hands the runtime: a named-event op's `<Op>Event` through
 * its `of`; else `SseEvent<T>` through `EventStream.typed`, `T` the declared event schema's type, or `SseEvent<String>`
 * as parsed for untyped or string events.
 */
export function sseEventOf(op: SdkOp, ctx: JavaTypeContext): { readonly type: string; readonly decode: Expr } {
  const events = sseEvents(op.ir);

  if (events !== undefined) {
    const name = namedEvents(op, events, ctx);

    return { decode: ref(name, "of"), type: name };
  }

  const type =
    op.events === undefined ? "String" : javaTypeOf(op.events, { ...ctx, fieldName: "Event", parentName: op.id });

  if (type === "String") return { decode: lambda("e", id("e")), type: "SseEvent<String>" };

  return {
    decode: callOf("EventStream", "typed", [newOf(`TypeReference<${type}>`, [], true)]),
    type: `SseEvent<${type}>`,
  };
}

/** What an SSE method's lines need: its name and constant, its Params, its headers holder, and its Call's lines. */
export type SseSite = {
  readonly name: string;
  readonly constant: string;
  readonly params: string;
  readonly headers: JavaHeaders | null;
  readonly call: readonly string[];
};

/**
 * An SSE method's lines: `op(params)` and `op(params, options)`, and `op(params, headersInto, options)` for an operation
 * with response headers, filled at the open; the shorter overloads delegate to the longest.
 */
export function sseMethodLines(op: SdkOp, site: SseSite, ctx: JavaTypeContext): string[] {
  const { call, constant, headers, name, params } = site;
  const { decode, type } = sseEventOf(op, ctx);

  const doc = docOf(
    `${op.id}: the open stream. An error status throws before any event, and no timeout bounds it after that. ${RELEASE}`,
  );

  const signature = (args: readonly Declaration[]) =>
    methodHeader(2, { modifiers: ["public"], name, params: args, returns: `EventStream<${type}>` });

  const holder = headers === null ? "null" : cond(bin("==", "headersInto", "null"), "null", ref("headersInto", "read"));

  const open = [
    ...call,
    ...statement(4, returnStmt(callOf("exchange", "events", [constant, "call", "options", holder, decode]))),
  ];

  const delegate = (args: readonly string[]) => statement(4, returnStmt(callOf(null, name, args)));
  const longest = headers === null ? open : delegate(["params", "null", "options"]);

  return [
    doc,
    ...signature([param(params, "params")]),
    ...delegate(headers === null ? ["params", "null"] : ["params", "null", "null"]),
    "  }",
    "",
    doc,
    ...signature([param(params, "params"), param("RequestOptions", "options")]),
    ...longest,
    "  }",
    "",
    ...(headers === null
      ? []
      : [
          doc,
          ...signature([
            param(params, "params"),
            param(headers.type, "headersInto"),
            param("RequestOptions", "options"),
          ]),
          ...open,
          "  }",
          "",
        ]),
  ];
}
