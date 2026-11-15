/**
 * A WebSocket operation's answer (contract 20 §2.0, §2.2): `TypedWebSocket<In, Out>`, dialed offering the Opts'
 * `protocols`, its Opts' `reconnect_token` sent as one query param only when set and non-empty; a declared
 * `reconnect_token` query param is folded into that field (Fd3). `In` is what the server sends (`send`), `Out` what
 * it receives (`receive`), an inline union hoisted as `<Op>Send` or `<Op>Receive`; an op without them keeps the
 * defaults, its frames as bytes and any JSON value sent. A read side keyed on one field (D9) gets an `on_<value>` per
 * member, an inherent impl in types.rs written once per read type, except a value whose method a handler holds.
 */
import type { IRSchema } from "../../ir/model.ts";
import { dispatchOf, type SdkOp } from "../../ir/sdk-model.ts";
import { lineComment, rustString } from "../shared/escape.ts";
import { NameScope, rustTypeIdent, rustValueIdent } from "../shared/lang.ts";
import { typeAt } from "./sdk-body.ts";
import type { OptsField, StreamAnswer, StreamOpts } from "./sdk-opts.ts";
import { type RustTypeContext, rustHoisted, rustUnionVariants } from "./types.ts";

/** The resume cursor's token, which the WebSocket and realtime Opts carry. */
const RECONNECT_TOKEN = { ident: "reconnect_token", type: "Option<String>" };

/** The subprotocols a WebSocket or realtime dial offers. */
const PROTOCOLS = { doc: "The subprotocols the dial offers.", ident: "protocols", type: "Vec<String>" };

/** Whether a declared param is the `reconnect_token` query param, the resume channel a socket dial sends. */
export const isReconnectToken = (param: string, where: OptsField["in"]): boolean =>
  where === "query" && param === "reconnect_token";

// reconnect_token, sent only when set: an empty cursor names no position
const WS: StreamOpts = {
  carries: isReconnectToken,
  fields: [RECONNECT_TOKEN, PROTOCOLS],
  sends: ['spec.query("reconnect_token", &crate::request::cursor(&opts.reconnect_token));'],
};

const DOC =
  "Resolves once the socket is open: a refused handshake with an error status is `Err(Error::Api)`. `cancel_on` ends its reads quietly; dropping it closes it.";

/** One direction of `op`'s messages as its Rust type: an inline union is declared as `<Op><side>`. */
export function messageType(op: SdkOp, schema: IRSchema, side: "Receive" | "Send", at: RustTypeContext): string {
  if (schema.kind !== "union") return typeAt(schema, op.id, side, at);

  return rustHoisted(schema, at, `${op.id}.${side}`, `${rustTypeIdent(op.id)}${side}`);
}

/**
 * The `on_<value>` methods of `<base><read, Out>`, `read` the keyed `schema`, declared once in `at`: each takes the
 * messages whose key is that value; a value whose method one of `handlers` names gets none.
 */
export function valueHandlers(
  base: string,
  handlers: readonly string[],
  read: { readonly schema: IRSchema; readonly type: string },
  at: RustTypeContext,
): void {
  const key = `${read.type}.${base}`;
  const dispatch = dispatchOf(read.schema, at.names.resolve);

  if (dispatch === undefined || at.decls.has(key)) return;
  const scope = new NameScope(handlers);

  const methods = rustUnionVariants(read.type, dispatch.union, at).flatMap(({ type, value, variant }) => {
    const method = rustValueIdent(`on_${value}`);

    if (scope.has(method)) return [];

    return [
      "",
      ...lineComment(
        `Calls \`handler\` on each message whose ${rustString(dispatch.key)} is ${rustString(value)}.`,
        "///",
        "    ",
      ),
      `    pub fn ${scope.claim(method)}(&mut self, mut handler: impl FnMut(&${type}) + Send + 'static) {`,
      "        self.on_message(move |m| {",
      `            if let ${read.type}::${variant}(v) = m {`,
      "                handler(v);",
      "            }",
      "        });",
      "    }",
    ];
  });

  if (methods.length === 0) return;
  at.decls.set(key, [`impl<Out> crate::${base}<${read.type}, Out> {`, ...methods.slice(1), "}"].join("\n"));
}

/** The type params of a socket reading `read` and sending `write`, the defaults left out. */
export const typeParams = (read: string | undefined, write: string | undefined, untyped: string): string =>
  write === undefined ? (read === undefined ? "" : `<${read}>`) : `<${read ?? untyped}, ${write}>`;

// the handlers a socket takes: a member whose on_<value> one of them names gets none
const HANDLERS = ["on_message", "on_close", "on_error"];

/** The WebSocket operation `op`'s answer, its message types hoisted into `at`. */
export function wsAnswer(op: SdkOp, at: RustTypeContext): StreamAnswer {
  const { receive, send } = op.ir.messages ?? {};
  const read = send && messageType(op, send, "Send", at);
  const write = receive && messageType(op, receive, "Receive", at);

  if (send !== undefined && read !== undefined)
    valueHandlers("TypedWebSocket", HANDLERS, { schema: send, type: read }, at);
  const params = typeParams(read, write, "Vec<u8>");
  // the answer type fixes both params: a socket without a read type reads bytes
  const run = `crate::ws::${read === undefined ? "dial" : "typed"}(opts.protocols.clone())`;

  return { doc: DOC, run, stream: WS, type: `TypedWebSocket${params}` };
}
