---
name: workerd-refuses-cross-request-io
paths: ["tests/integration/conformance/app/**"]
hits: 1
last-hit: 2026-11-14
evidence: ["plan 52: realtime.capped's POST wrote into the GET's SSE stream; go send-over-cap red on CI 9dc71c8"]
---

# On workerd, one request never writes another request's stream

## Mistake
The conformance app kept a module-level `Set` of SSE streams that a POST wrote into. Bun allows that; workerd refuses I/O on another request's objects, so the write never landed and the stream ended empty. The race passed locally and failed on CI's slower runner.

## Fix
State shared across requests is plain data, never a stream, socket or writer. The request that owns the stream reads that data and writes from its own context. Prove delivery with a harness test that opens the stream in one request and acts in another (`tests/integration/ts-harness.app.test.ts`).
