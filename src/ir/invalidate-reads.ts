/**
 * Which reads each write makes stale, resolved once at generation for every emitter: a write's `x-invalidate`
 * selectors are backend route patterns (`GET /users/:id`, `GET /files/*rest`, `GET /docs/:id?`), and a read is an
 * OpenAPI path (`/users/{id}`), so this is the one place the two spellings meet. A runtime then fills each read's
 * params from the write's own and never parses a selector.
 */
import { compareCodeUnits } from "../emit/shared/lang.ts";
import type { IR, IROperation } from "./model.ts";
import { READ_METHOD } from "./read-method.constants.ts";
import { openApiPathParams } from "./slots.ts";

/** One read a write makes stale: its operationId and its own path params, in path order. */
export type InvalidatedRead = { operationId: string; params: string[] };

/** Each write's reads, by its operationId, and why any selector resolved to nothing. */
export type InvalidateReads = { reads: Map<string, InvalidatedRead[]>; warnings: string[] };

/**
 * The key a read's path and a selector both reduce to: the segments joined by `/`, each fixed text as `=text`, one
 * param as `:` and the rest of the path as `*`. Param names never take part: a route is one route whatever it names
 * them.
 */
type RouteKey = string;

const PARAM = ":";
const WILDCARD = "*";

/** A whole-segment OpenAPI param, `{name}`. */
const BRACED = /^\{([^{}/]+)\}$/;

/** A segment of fixed text, as a route key spells it. */
function literal(text: string): string {
  return `=${text}`;
}

/** A read: a GET that answers once, never a stream or a connection. */
function isRead(op: IROperation): boolean {
  const { realtime, sse, websocket } = op.extensions;

  return op.method === READ_METHOD && !sse && !websocket && !realtime;
}

/** The key of a read's OpenAPI path: a whole `{name}` is a param, a wildcard one the rest of the path. */
function readKey(op: IROperation): RouteKey {
  const wildcards = new Set(op.params.path.filter((p) => p.wildcard === true).map((p) => p.name));

  return op.path
    .split("/")
    .map((text) => {
      const name = BRACED.exec(text)?.[1];

      if (name === undefined) return literal(text);

      return wildcards.has(name) ? WILDCARD : PARAM;
    })
    .join("/");
}

/**
 * Every key a selector's route pattern spells (`:name`, `{name}`, a trailing `*name` or `*`, or text): an optional
 * `:name?` segment both left out and kept.
 */
function selectorKeys(path: string): RouteKey[] {
  const texts = path.split("/");
  let keys: string[][] = [[]];

  for (const [i, text] of texts.entries()) {
    const isParam = text.length > 1 && text.startsWith(":");
    let segment = literal(text);

    if (text.startsWith("*") && i === texts.length - 1) segment = WILDCARD;
    else if (isParam || BRACED.test(text)) segment = PARAM;
    const kept = keys.map((key) => [...key, segment]);
    keys = isParam && text.endsWith("?") ? [...keys, ...kept] : kept;
  }

  return keys.map((key) => key.join("/"));
}

/** The reads whose key is `at`, by operationId. */
function readsAt(reads: readonly { key: RouteKey; op: IROperation }[], at: RouteKey): IROperation[] {
  return reads
    .filter(({ key }) => key === at)
    .map(({ op }) => op)
    .toSorted((a, b) => compareCodeUnits(a.id, b.id));
}

/**
 * The reads `selector` names, in the order its keys spell them (an optional segment left out first) and by
 * operationId within one key, so a document's path order never reorders them; or why it names none.
 */
function resolve(
  selector: string,
  reads: readonly { key: RouteKey; op: IROperation }[],
): { ops: IROperation[] } | { why: string } {
  const space = selector.indexOf(" ");

  if (space <= 0) return { why: "is not a route selector" };
  const method = selector.slice(0, space).toUpperCase();

  if (method !== READ_METHOD) return { why: `names a ${method} route; only ${READ_METHOD} reads are cached` };
  const matched = selectorKeys(selector.slice(space + 1)).flatMap((at) => readsAt(reads, at));

  return matched.length > 0 ? { ops: matched } : { why: `matches no ${READ_METHOD} read` };
}

/**
 * Each write's reads: every selector of its `x-invalidate` resolved to the reads it names, deduped, in selector
 * order. A write is any operation with `x-invalidate` but a read (a stream or a socket counts: it marks on open). A
 * non-GET selector and one no read matches are skipped with a warning; a write left with no reads is not held.
 */
export function invalidateReads(ir: IR): InvalidateReads {
  const readOps = ir.operations.filter(isRead).map((op) => ({ key: readKey(op), op }));
  const reads = new Map<string, InvalidatedRead[]>();
  const warnings: string[] = [];

  for (const op of ir.operations) {
    const selectors = op.extensions.invalidates ?? [];

    if (selectors.length === 0 || isRead(op)) continue;
    const seen = new Map<string, InvalidatedRead>();

    for (const selector of selectors) {
      const resolved = resolve(selector, readOps);

      if ("why" in resolved) {
        warnings.push(`${op.id}: x-invalidate ${JSON.stringify(selector)} ${resolved.why}; skipped`);
        continue;
      }

      for (const read of resolved.ops)
        if (!seen.has(read.id)) seen.set(read.id, { operationId: read.id, params: openApiPathParams(read.path) });
    }

    if (seen.size > 0) reads.set(op.id, [...seen.values()]);
  }

  return { reads, warnings };
}
