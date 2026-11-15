---
name: slow-leg-default-timeout
paths: ["src/**/*.test.ts","tests/**/*.test.ts","scripts/*.test.ts"]
hits: 2
last-hit: 2026-11-03
evidence: ["plan 21","plan 39"]
---

# A heavy leg without an explicit timeout reds only under load

## Mistake
The MCP server test's compiled-twin leg passed alone and timed out in the suite. I judged "is this mine?" by whether it fails, not whether it fails alone. It erased types over every emitted file with no timeout bound.

## Fix
Give every leg that spawns, drives a toolchain or does heavy work `{ timeout: SPAWN_TIMEOUT }` from `src/gen/__fixtures__/spawn-timeout.ts`. When a leg reds in a suite, rerun that file alone first: green alone means a budget or shared-resource clash, not the change.
