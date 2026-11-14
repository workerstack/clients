---
name: workerd-refuses-cross-request-io
paths: ["tests/integration/conformance/app/**"]
hits: 1
last-hit: 2026-11-14
evidence: ["plan 52: realtime.capped's POST wrote into the GET's SSE stream; go send-over-cap red on CI 9dc71c8"]
---

# On workerd, one request never writes another request's stream

The conformance app moved from Bun to workerd and kept a module-level `Set` of open SSE streams that a POST
wrote into. Bun allows that. workerd does not.

## Mistake
`realtime.capped`'s POST handler called `sse.send` on a stream a different request had opened. workerd
refuses I/O on another request's objects: the write never lands, workerd cancels the stream's request as
hung ("your Worker's code had hung"), and the stream ends with no frame. Locally the Go cell still
passed because the send's decode error beat the stream's end; on CI's slower runner the end won and the
cell read `transport`. Twelve isolated local runs stayed green, so the race hid the defect.

## Fix
Shared state across requests is plain data (a counter, a log array), never a stream, socket or writer.
The request that owns the stream does the write: it waits on its own timer (or its own I/O), reads the
shared data, and sends from its own context. Prove delivery with a harness test that opens the stream in
one request, acts in another, and asserts the frame arrives (`tests/integration/ts-harness.app.test.ts`).
When porting a fixture to workerd, grep it for module-level `Set`/`Map` of streams, sockets or listeners
that another route's handler reaches.
