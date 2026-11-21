/**
 * The grid's SDK-only rows (bit 21 i0, features-sdk.ts), in the default run: they reach the six SDKs and no other
 * target, so the CLI and the MCP server keep exactly their cells, and every SDK holds the same seven, the over-cap row
 * (staged per SDK from i2 to i6) and the realtime send past the cap (i7) among them; TS, Go and Python also hold the
 * invalidate-once row's two (plans 6-7), which each other SDK joins in its own slice.
 */
import { describe, expect, it } from "vitest";

import { SDK_ROWS } from "./features-sdk.ts";
import { SDKS } from "./features.ts";
import { cellsFor, FEATURES, TARGETS } from "./matrix.ts";

const SDK_CELLS = [
  "decode/undecodable-2xx",
  "over-cap/over-cap-2xx",
  "realtime/send-over-cap",
  "stream/initial-error",
  "stream/mid-drop",
  "text/plain",
  "transport/refused",
];

/** The rows targeting the six SDKs alone, in grid order. */
const SIX_SDK_ROWS = ["decode", "transport", "stream", "text", "over-cap", "realtime"];

/** The invalidate-once row's cells, TS's and Go's (plan 6) and Python's (plan 7) so far. */
const INVALIDATE_CELLS = ["invalidate-once/failing-hook", "invalidate-once/write"];

/** The keys of `target`'s cells from the SDK-only rows, sorted. */
const sdkCellsOf = (target: (typeof TARGETS)[number]) =>
  cellsFor(target)
    .filter((cell) => SDK_ROWS.some((row) => row.id === cell.feature))
    .map((cell) => cell.key)
    .sort();

describe("the SDK-only rows", () => {
  it("are the grid's rows targeting the six SDKs alone", () => {
    expect(FEATURES.filter((f) => f.targets.join() === SDKS.join()).map((f) => f.id)).toEqual(SIX_SDK_ROWS);
    expect(SDK_ROWS.map((row) => row.id)).toEqual([...SIX_SDK_ROWS, "invalidate-once"]);
  });

  it("give every SDK the same seven cells, TS, Go and Python the invalidate-once two too, CLI and MCP none", () => {
    expect(Object.fromEntries(TARGETS.map((target) => [target, sdkCellsOf(target)]))).toEqual({
      cli: [],
      csharp: SDK_CELLS,
      go: [...SDK_CELLS.slice(0, 1), ...INVALIDATE_CELLS, ...SDK_CELLS.slice(1)],
      java: SDK_CELLS,
      mcp: [],
      python: [...SDK_CELLS.slice(0, 1), ...INVALIDATE_CELLS, ...SDK_CELLS.slice(1)],
      rust: SDK_CELLS,
      ts: [...SDK_CELLS.slice(0, 1), ...INVALIDATE_CELLS, ...SDK_CELLS.slice(1)],
    });
  });
});
