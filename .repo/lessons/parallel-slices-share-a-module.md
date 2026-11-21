---
name: parallel-slices-share-a-module
paths: ["src/ir/**","tests/integration/conformance/**"]
hits: 1
last-hit: 2026-11-21
evidence: ["roadmap 1 (sdk query cache): plans 7, 8 and 9 each fixed src/ir/invalidate-reads.ts's order bug their own way (by key, by path, by key then operationId), and each widened the same conformance lists (targets, OWN_TARGETS, INVALIDATING) for its own SDKs"]
---

# Parallel slices fix the same shared module, each its own way

## Mistake
Three SDK slices ran in parallel on one base. Each fixed the same resolver bug its own way and rewrote the same grid lists for its SDKs, so every rebase conflicted, and one merged list in the wrong order (not SDKS order) failed.

## Fix
Land the slice that changes a shared module first; rebase the others onto it before they commit. On a conflict keep the strongest fix and run every target's tests against it (`bunx vitest run src/emit src/ir tests/integration/conformance`). Write grid lists in `SDKS` order.
