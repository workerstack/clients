/**
 * TypeScript text for JSON values: property keys and literal types. Strings go through the one
 * escape layer (F2), never `JSON.stringify` alone.
 */
import { tsString } from "./escape.ts";
import { UNKNOWN_TYPE } from "./unknown-type.constants.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * An optional property's type: under `exactOptionalPropertyTypes` a `k?: T` refuses the `undefined` a zod
 * `.optional()` infers, so the generated type says it too; `unknown` already holds it.
 */
export function optionalType(type: string): string {
  return type === UNKNOWN_TYPE ? type : `${type} | undefined`;
}

/** A property key in a type or object literal: bare when it is an identifier, a string literal otherwise. */
export function quoteKey(key: string): string {
  return IDENTIFIER.test(key) ? key : tsString(key);
}

/** The TypeScript literal type of a JSON `value` (an array as a tuple, an object field by field); else its type, or `unknown`. */
export function literalType(value: unknown): string {
  if (value === null) return "null";

  if (value === undefined) return "undefined";

  if (typeof value === "string") return tsString(value);

  if (typeof value === "boolean") return String(value);

  if (typeof value === "bigint") return `${value}n`;

  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "number";

  if (Array.isArray(value)) return `[${value.map(literalType).join(", ")}]`;

  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return "unknown";
  const fields = Object.entries(value).map(([key, child]) => `${quoteKey(key)}: ${literalType(child)}`);

  return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`;
}
