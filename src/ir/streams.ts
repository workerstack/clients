/**
 * The typed stream shapes an operation declares: an OpenAPI 3.2 SSE `itemSchema`'s named events, and the
 * rich `x-websocket` object's `receive` and `send` messages (realtime operations carry the same object).
 * Both read any document, so a malformed shape is left out, never refused.
 */
import type { IRSchema, IRSseEvent, IRWebSocketMessages } from "./model.ts";
import { schemaToIR } from "./schema.ts";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The events an SSE `itemSchema` declares, in order: one event object, or a `oneOf`/`anyOf` of them, each
 * followed through `follow`. A member is named by its `event` const, `message` when it has none; its data
 * is its `data`'s `contentSchema` when it has one, else the `data` schema. None for a non-object itemSchema.
 */
export function sseEventsOf(
  itemSchema: unknown,
  follow: (value: unknown) => Json | undefined,
): IRSseEvent[] | undefined {
  const root = follow(itemSchema);

  if (!isObject(root)) return undefined;
  const union = root.oneOf ?? root.anyOf;
  const members = Array.isArray(union) ? union.map(follow) : [root];

  return members.flatMap((member) => {
    if (!isObject(member)) return [];
    const properties = isObject(member.properties) ? member.properties : {};
    const event = isObject(properties.event) ? properties.event.const : undefined;

    if (event !== undefined && typeof event !== "string") return [];

    return [{ data: dataOf(properties.data), name: event ?? "message" }];
  });
}

// an event's data: what `contentSchema` encodes when it is there, else the schema itself
function dataOf(data: unknown): IRSchema {
  if (!isObject(data)) return { kind: "unknown" };

  return schemaToIR(isObject(data.contentSchema) ? data.contentSchema : data);
}

/** The rich `x-websocket` object's message schemas, each direction only when it is an object; none for any other value. */
export function websocketMessagesOf(raw: unknown): IRWebSocketMessages | undefined {
  if (!isObject(raw)) return undefined;
  const out: IRWebSocketMessages = {};

  if (isObject(raw.receive)) out.receive = schemaToIR(raw.receive);

  if (isObject(raw.send)) out.send = schemaToIR(raw.send);

  return out;
}
