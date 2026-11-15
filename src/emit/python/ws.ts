/**
 * A WebSocket operation's answer (contract 34 §2.0, §2.2): `TypedWebSocket[Out, In]`, opened by awaiting the method
 * and dialed offering `protocols`, its `reconnect_token` sent as one query param only when set and non-empty; a
 * declared `reconnect_token` query param is folded into that field (Fd3). `Out` is what the server sends (its
 * declared `send`, else `str | bytes`) and `In` what it receives (its `receive`, else `object`). A `send` union keyed
 * on one field (D9) makes the answer `<Op>Socket`, a subclass hoisted beside the types whose `on` overloads give each
 * member's value its member's type; a value that names a socket event gets none.
 */
import type { IRSchema } from "../../ir/model.ts";
import { type Dispatch, dispatchOf, type SdkOp } from "../../ir/sdk-model.ts";
import { pyString } from "../shared/escape.ts";
import { pyClassName } from "../shared/lang.ts";
import { type Answer, type PyStream, typeAt } from "./sdk-answer.ts";
import type { MethodEnv } from "./sdk-method.ts";
import { pyKeyedMembers, pyTypeOf } from "./types.ts";

/** The resume cursor's token, which the WebSocket and realtime methods take. */
const RECONNECT_TOKEN = "reconnect_token: str | None = None";

/** The subprotocols a WebSocket or realtime dial offers. */
const PROTOCOLS = "protocols: Sequence[str] | None = None";

/** Whether a declared param is the `reconnect_token` query param, the resume channel a socket dial sends. */
export const isReconnectToken = (name: string, where: string): boolean =>
  where === "query" && name === "reconnect_token";

/** A socket class's `on` events beyond its members', given its `Out`: each with the type its handler takes. */
type Lifecycle = (out: string) => readonly (readonly [event: string, handler: string])[];

/**
 * How a socket stream answers: its generic class `base[Out, In]` and the transport call it makes; what it reads and
 * sends when its op declares no `send` or `receive`; the subclass suffix a keyed `send` union names; the events
 * every `on` takes.
 */
export type SocketShape = {
  readonly base: string;
  readonly run: string;
  readonly out: () => string;
  readonly in: string;
  readonly suffix: string;
  readonly lifecycle: Lifecycle;
};

/** One `on` overload: `event` hands its handler a `type`. */
const overload = ([event, type]: readonly [string, string]) => [
  "    @overload",
  `    def on(self, event: Literal[${pyString(event)}], handler: Callable[[${type}], None]) -> None: ...`,
  "",
];

/**
 * `<Op><suffix>`, the subclass of `base[Out, In]` whose `on` takes each member of the keyed `send` union by its value
 * (one a lifecycle event names excepted), then the lifecycle events, hoisted beside the types; null when no member is
 * left to take.
 */
function keyedClass(op: SdkOp, env: MethodEnv, shape: SocketShape, dispatch: Dispatch): string | null {
  const { receive, send } = op.ir.messages as { receive?: IRSchema; send: IRSchema };
  const typing = env.at.declTyping;
  const at = { ...env.at, fieldName: "Send", parentName: op.id, typing };
  // spelled in types.py, whose typing names they then take: the same hoist keys, so the names client.py spells
  const out = pyTypeOf(send, at);
  const inType = receive === undefined ? shape.in : pyTypeOf(receive, { ...at, fieldName: "Receive" });
  const lifecycle = shape.lifecycle(out);
  const taken = new Set(lifecycle.map(([event]) => event));
  const members = pyKeyedMembers(send, dispatch, at).filter(([value]) => !taken.has(value));

  if (members.length === 0) return null;
  const name = env.at.names.claim(`${pyClassName(op.id)}${shape.suffix}`);

  for (const used of ["Any", "Literal", "overload"]) typing.add(used);
  env.typesImports.add("Callable").add(shape.base);

  for (const [, type] of lifecycle) if (type !== out) env.typesImports.add(type);
  env.at.decls.set(
    name,
    [
      `class ${name}(${shape.base}[${pyString(out)}, ${pyString(inType)}]):`,
      ...[...members, ...lifecycle].flatMap(overload),
      "    def on(self, event: str, handler: Callable[[Any], None]) -> None:",
      "        self.listen(event, handler)",
    ].join("\n"),
  );

  return name;
}

/** A socket op's answer: its `<Op><suffix>` when its `send` union is keyed (D9), else `base[Out, In]`. */
export function socketAnswer(op: SdkOp, env: MethodEnv, shape: SocketShape): Answer {
  const { receive, send } = op.ir.messages ?? {};
  const dispatch = send === undefined ? undefined : dispatchOf(send, env.at.names.resolve);
  const kind = dispatch === undefined ? null : keyedClass(op, env, shape, dispatch);

  if (kind !== null) return { kind, returns: kind, run: shape.run, type: kind };
  const out = send === undefined ? shape.out() : typeAt(op, "Send", send, env);
  const type = `${shape.base}[${out}, ${receive === undefined ? shape.in : typeAt(op, "Receive", receive, env)}]`;

  return { returns: type, run: shape.run, type };
}

/** The WebSocket operation's answer, its two fields and its docstring's lines. */
export const wsStream: PyStream = {
  answer: (op, env) =>
    socketAnswer(op, env, {
      base: "TypedWebSocket",
      in: "object",
      // the events every socket's `on` takes, with what each hands its handler
      lifecycle: (out) => [
        ["message", out],
        ["close", "WsClose"],
        ["error", "HttpError"],
      ],
      out: () => "str | bytes",
      run: "websocket",
      suffix: "Socket",
    }),
  carries: isReconnectToken,
  doc: [
    'Opens the socket: a refused handshake raises its status\'s error; options["cancel"], close() or',
    "dropping it ends it.",
  ],
  fields: [PROTOCOLS, RECONNECT_TOKEN],
};
