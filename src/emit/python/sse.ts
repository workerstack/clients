/**
 * An SSE operation's answer (contract 34 §2.0–2.1): `EventStream[E]`, opened by awaiting the method (G15), and its
 * `last_event_id` field, sent as Last-Event-ID only when set and non-empty; a declared Last-Event-ID header param is
 * folded into that field (Fd3). An operation that names its events (D7) yields `<Op>Event`, a union of
 * `SseEventOf[Literal[name], Data]` hoisted beside the types; any other yields `SseEvent[T]`, `T` its declared
 * event schema's type (`str` for untyped events).
 */
import { sseEvents, type SdkOp } from "../../ir/sdk-model.ts";
import { pyClassName } from "../shared/lang.ts";
import { eventType, type PyStream } from "./sdk-answer.ts";
import type { MethodEnv } from "./sdk-method.ts";
import { aliasDecl } from "./types-union.ts";
import { pyTypeOf } from "./types.ts";

/** The header the SSE and realtime dials resume an event stream with. */
const LAST_EVENT_ID = "Last-Event-ID";

/** Whether a declared param is the Last-Event-ID header (any casing), the resume channel an SSE dial sends. */
export const isLastEventIdHeader = (name: string, where: string): boolean =>
  where === "header" && name.toLowerCase() === LAST_EVENT_ID.toLowerCase();

/**
 * The event type of an op that names its events: `<Op>Event`, each event's `data` typed at `<Op><Name>`, declared
 * in types.py; null for an op that names none.
 */
function namedEvents(op: SdkOp, env: MethodEnv): string | null {
  const events = sseEvents(op.ir);

  if (events === undefined) return null;
  const typing = env.at.declTyping;
  const at = { ...env.at, parentName: op.id, typing };

  const members = events.map(({ data, name }) => {
    const literal = pyTypeOf({ kind: "const", value: name }, { ...at, fieldName: "" });

    return `SseEventOf[${literal}, ${pyTypeOf(data, { ...at, fieldName: name })}]`;
  });

  const alias = env.at.names.claim(`${pyClassName(op.id)}Event`);
  typing.add("TypeAlias");
  env.typesImports.add("SseEventOf");
  env.at.decls.set(alias, aliasDecl(alias, members.join(" | ")));

  return alias;
}

/** The SSE operation's answer, its one field and its docstring's lines. */
export const sseStream: PyStream = {
  answer: (op, env) => {
    const named = namedEvents(op, env);

    if (named !== null) return { returns: `EventStream[${named}]`, run: "sse", type: named };
    env.imports.add("SseEvent");
    const event = `SseEvent[${eventType(op, env, () => "str")}]`;

    return { returns: `EventStream[${event}]`, run: "sse", type: event };
  },
  carries: isLastEventIdHeader,
  doc: [
    "Opens the stream: an error status raises before any event. No timeout bounds it after that;",
    'options["cancel"], aclose() or dropping it ends it.',
  ],
  fields: ["last_event_id: str | None = None"],
};
