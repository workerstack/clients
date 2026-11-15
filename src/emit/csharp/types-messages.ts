/**
 * C# message types (D9, D17): one direction of a socket's declared messages as the type its socket reads or sends.
 * A union keyed on one field (`dispatchOf`) is `<Op>Inbound` (what the server sends, the read side) or
 * `<Op>Outbound` (what it receives, the send side), declared beside the body union, which does not change: an
 * abstract record with a private constructor and one nested sealed record per member in the order declared, each
 * wrapping its variant record as `Value`; the read side adds `Unknown(JsonElement Raw)` for a value the op does not
 * declare, the send side an implicit conversion from each variant record. Its converter reads the discriminator and
 * decodes the variant through the context (AOT-safe). A nested name that is one of the record's members, a type it
 * spells or the enclosing type takes the suffix `Message`. Any other direction is its declared type itself, an
 * inline schema hoisted as `<Op><Side>`. Each keyed read side gets an `On<Value>` extension per member, in a static
 * class beside it, for the socket or the connection that reads it, except a member whose value names one of that
 * reader's own events.
 */
import type { IRSchema } from "../../ir/model.ts";
import { type Dispatch, dispatchOf, type SdkOp } from "../../ir/sdk-model.ts";
import { csString } from "../shared/escape.ts";
import { csTypeName, NameScope } from "../shared/lang.ts";
import { docLines } from "./sdk-doc.ts";
import { type CsTypeContext, csTypeOf } from "./types.ts";

/** Which way a direction goes: the server's `send` is the client's read, its `receive` the client's send. */
export type Side = "Receive" | "Send";

// the names a nested record never takes: its members, every record's, and the types its converter spells
const TAKEN = [
  "Value",
  "Raw",
  "Unknown",
  "Clone",
  "Deconstruct",
  "EqualityContract",
  "Equals",
  "Finalize",
  "GetHashCode",
  "GetType",
  "MemberwiseClone",
  "PrintMembers",
  "ToString",
  "JsonElement",
];

/** One keyed member as a nested record: the value that selects it, its record, and its variant's type. */
type Nested = { readonly value: string; readonly record: string; readonly type: string };

/** `JsonTypeInfo<T>` of `type` from the converter's options. */
const info = (type: string) => `(JsonTypeInfo<${type}>)options.GetTypeInfo(typeof(${type}))`;

/** Each member of `dispatch` once per value, its variant typed at `<parent><Value>`, its nested name claimed. */
function nestedOf(name: string, dispatch: Dispatch, parent: string, at: CsTypeContext): Nested[] {
  const seen = new Set<string>();

  const members = dispatch.members.flatMap(({ value, variant }) => {
    if (seen.has(value)) return [];
    seen.add(value);
    const type = csTypeOf(variant, { ...at, fieldName: value, parentName: parent }).replace(/\?$/, "");
    at.serialized.add(type);

    return [{ type, value }];
  });

  // a type a member spells would be shadowed by a nested record of its name
  const spelled = members.flatMap(({ type }) => type.split(/\W+/).filter((word) => word !== ""));
  const reserved = new Set([...TAKEN, ...spelled, name]);
  const scope = new NameScope(reserved);

  return members.map((member) => {
    const base = csTypeName(member.value);

    return { ...member, record: scope.claim(reserved.has(base) ? `${base}Message` : base) };
  });
}

/** The converter's `Read`: the key's string value selects a member; any other value is `Unknown`, or refused. */
function readLines(name: string, key: string, nested: readonly Nested[], read: boolean): string[] {
  const other = read ? `new ${name}.Unknown(raw)` : `throw new JsonException($"no ${name} member is keyed {kind}")`;

  return [
    `    public override ${name} Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)`,
    "    {",
    "        var raw = JsonElement.ParseValue(ref reader);",
    `        var kind = raw.ValueKind == JsonValueKind.Object && raw.TryGetProperty(${csString(key)}, out var at) && at.ValueKind == JsonValueKind.String ? at.GetString() : null;`,
    "        return kind switch",
    "        {",
    ...nested.map(
      ({ record, type, value }) =>
        `            ${csString(value)} => new ${name}.${record}(raw.Deserialize(${info(type)}) ?? throw new JsonException("a ${record} message is null")),`,
    ),
    `            _ => ${other},`,
    "        };",
    "    }",
  ];
}

/** The converter's `Write`: the member's variant through its own type, `Unknown` as received. */
function writeLines(name: string, nested: readonly Nested[], read: boolean): string[] {
  const arms = [
    ...nested.map(({ record, type }, i) => [
      `value is ${name}.${record} member${i}`,
      `JsonSerializer.Serialize(writer, member${i}.Value, ${info(type)});`,
    ]),
    ...(read ? [[`value is ${name}.Unknown unknown`, "unknown.Raw.WriteTo(writer);"]] : []),
  ];

  return [
    `    public override void Write(Utf8JsonWriter writer, ${name} value, JsonSerializerOptions options)`,
    "    {",
    ...arms.flatMap(([test, write], i) => [
      `        ${i > 0 ? "else " : ""}if (${test})`,
      "        {",
      `            ${write}`,
      "        }",
    ]),
    "        else",
    "        {",
    "            writer.WriteNullValue();",
    "        }",
    "    }",
  ];
}

/** One direction's C# type, and a keyed one's key and nested records in the order declared. */
export type MessageType = {
  readonly type: string;
  readonly keyed?: { readonly key: string; readonly nested: readonly Nested[] };
};

/** `<Op>Inbound` or `<Op>Outbound` for the keyed `dispatch`, hoisted with its converter into `at.decls`. */
function keyedType(op: SdkOp, dispatch: Dispatch, side: Side, at: CsTypeContext): MessageType {
  const read = side === "Send";
  const name = at.names.claim(`${csTypeName(op.id)}${read ? "Inbound" : "Outbound"}`);
  // claimed before its body: what the members hoist comes after it
  at.decls.set(name, "");
  const nested = nestedOf(name, dispatch, `${op.id}.${side}`, at);
  const converter = at.names.claim(`${name}Converter`);
  const list = nested.map(({ record }) => record).join(", ");

  const summary = read
    ? `One message ${op.id} reads: ${list}, or Unknown for a value the operation does not declare, as received. An is match reads its Value.`
    : `One message ${op.id} sends: ${list}. Each member's record converts to it implicitly.`;

  const converts = [...new Map(nested.map((n) => [n.type, n])).values()].map(
    ({ record, type }) => `    public static implicit operator ${name}(${type} value) => new ${record}(value);`,
  );

  at.decls.set(
    name,
    [
      ...docLines("summary", summary),
      `[JsonConverter(typeof(${converter}))]`,
      `public abstract record ${name}`,
      "{",
      `    private ${name}()`,
      "    {",
      "    }",
      "",
      ...nested.map(({ record, type }) => `    public sealed record ${record}(${type} Value) : ${name};`),
      ...(read ? [`    public sealed record Unknown(JsonElement Raw) : ${name};`] : ["", ...converts]),
      "}",
      "",
      `public sealed class ${converter} : JsonConverter<${name}>`,
      "{",
      ...readLines(name, dispatch.key, nested, read),
      "",
      ...writeLines(name, nested, read),
      "}",
    ].join("\n"),
  );

  return { keyed: { key: dispatch.key, nested }, type: name };
}

/** One direction of `op`'s messages as its C# type: a keyed union's hierarchy, else the declared type itself. */
export function messageType(op: SdkOp, schema: IRSchema, side: Side, at: CsTypeContext): MessageType {
  const dispatch = dispatchOf(schema, at.names.resolve);

  const message =
    dispatch === undefined
      ? { type: csTypeOf(schema, { ...at, fieldName: side, parentName: op.id }).replace(/\?$/, "") }
      : keyedType(op, dispatch, side, at);

  at.serialized.add(message.type);

  return message;
}

/** What reads a keyed side: its generic type, the name its extensions give their `this` param, and its own events. */
export type Reader = { readonly base: string; readonly receiver: string; readonly handlers: readonly string[] };

/**
 * The `On<Value>` extensions of `<base><read, TOut>` (a socket or a connection, `reader`), `read` a keyed read side,
 * declared beside it in `at`: each takes the variant of the member its value selects, matched inside the reader's
 * `Message`; a value whose method one of the reader's `handlers` names gets none.
 */
export function valueHandlers({ base, handlers, receiver }: Reader, read: MessageType, at: CsTypeContext): void {
  const declared = at.decls.get(read.type);

  if (read.keyed === undefined || declared === undefined) return;
  const { key, nested } = read.keyed;
  const scope = new NameScope(handlers);

  const methods = nested.flatMap(({ record, type, value }) => {
    const method = `On${csTypeName(value)}`;

    if (scope.has(method)) return [];

    return [
      "",
      ...docLines(
        "summary",
        `Calls handler with each message whose ${csString(key)} is ${csString(value)}, inside Message.`,
        "    ",
      ),
      `    public static void ${scope.claim(method)}<TOut>(this ${base}<${read.type}, TOut> ${receiver}, Action<${type}> handler)`,
      "    {",
      `        ${receiver}.Message += message =>`,
      "        {",
      `            if (message is ${read.type}.${record} matched)`,
      "            {",
      "                handler(matched.Value);",
      "            }",
      "        };",
      "    }",
    ];
  });

  if (methods.length === 0) return;
  const holder = at.names.claim(`${read.type}Extensions`);
  at.decls.set(
    read.type,
    [
      declared,
      "",
      ...docLines(
        "summary",
        `A handler per member of ${read.type}, each matching inside the Message of a ${base} that reads it.`,
      ),
      `public static class ${holder}`,
      "{",
      ...methods.slice(1),
      "}",
    ].join("\n"),
  );
}
