import { describe, expect, it } from "vitest";

import { type OpenApiDocument, toIR } from "./build.ts";
import { invalidateReads } from "./invalidate-reads.ts";

const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } };

/** A required string path parameter. */
function param(name: string) {
  return { in: "path", name, required: true, schema: { type: "string" } };
}

/** A required path parameter that spans segments (`x-backend-wildcard`). */
function wildcardParam(name: string) {
  return { ...param(name), "x-backend-wildcard": true };
}

/** A read `operationId` over the path params `params`. */
function read(operationId: string, params: object[] = []) {
  return { operationId, parameters: params, responses: OK };
}

/** A write `operationId` over the path params `params` that invalidates `targets`. */
function write(operationId: string, params: object[], targets: string[]) {
  return { ...read(operationId, params), "x-invalidate": targets };
}

/**
 * Reads of each selector kind, and two writes: `state.save` names one read by `:id`, one by `*rest` and both
 * `docs` reads by `:id?`; `docs.archive` names a DELETE, a path no read has, and one read.
 */
const DOCUMENT = {
  info: { title: "t", version: "1" },
  openapi: "3.1.0",
  paths: {
    "/docs": { get: read("docs.list") },
    "/docs/{id}": { delete: read("docs.remove", [param("id")]), get: read("docs.get", [param("id")]) },
    "/docs/{id}/archive": {
      post: write("docs.archive", [param("id")], ["DELETE /docs/:id", "GET /nowhere", "GET /docs/:id"]),
    },
    "/files/{rest}": { get: read("files.get", [wildcardParam("rest")]) },
    "/items/{id}": { get: read("items.get", [param("id")]) },
    "/state/{id}/files/{rest}": {
      put: write(
        "state.save",
        [param("id"), wildcardParam("rest")],
        ["GET /items/:id", "GET /files/*rest", "GET /docs/:id?"],
      ),
    },
  },
} satisfies OpenApiDocument;

describe("invalidateReads: each write's x-invalidate selectors, resolved to the reads they name", () => {
  it("resolves `:id` and `*rest` to their read, and `:id?` to both reads, each with its own path params", () => {
    expect(invalidateReads(toIR(DOCUMENT)).reads.get("state.save")).toStrictEqual([
      { operationId: "items.get", params: ["id"] },
      { operationId: "files.get", params: ["rest"] },
      { operationId: "docs.list", params: [] },
      { operationId: "docs.get", params: ["id"] },
    ]);
  });

  it("skips a non-GET target and a selector no read matches, warning about each, and keeps the rest", () => {
    const { reads, warnings } = invalidateReads(toIR(DOCUMENT));
    expect([reads.get("docs.archive"), warnings]).toStrictEqual([
      [{ operationId: "docs.get", params: ["id"] }],
      [expect.stringContaining("DELETE /docs/:id"), expect.stringContaining("GET /nowhere")],
    ]);
  });
});

describe("invalidateReads: duplicates and selectors that name nothing", () => {
  it("names a read once however many selectors name it; skips a selector with no method, and a bare write", () => {
    const document = {
      ...DOCUMENT,
      paths: {
        "/docs/{id}": { get: read("docs.get", [param("id")]) },
        "/docs/{id}/poke": { post: write("docs.poke", [param("id")], ["GET"]) },
        "/docs/{id}/touch": {
          post: write("docs.touch", [param("id")], ["GET /docs/:id", "GET /docs/{id}", "/docs/:id"]),
        },
      },
    } satisfies OpenApiDocument;

    const { reads, warnings } = invalidateReads(toIR(document));
    expect([[...reads.entries()], warnings]).toStrictEqual([
      [["docs.touch", [{ operationId: "docs.get", params: ["id"] }]]],
      [expect.stringContaining("docs.poke"), expect.stringContaining("is not a route selector")],
    ]);
  });

  it("holds only the writes that invalidate something", () => {
    expect(new Set(invalidateReads(toIR(DOCUMENT)).reads.keys())).toStrictEqual(
      new Set(["docs.archive", "state.save"]),
    );
  });
});
