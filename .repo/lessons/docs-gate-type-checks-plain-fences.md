---
name: docs-gate-type-checks-plain-fences
paths: ["references/**","README.md","src/emit/ts/examples-compile.test.ts"]
hits: 1
last-hit: 2026-11-21
evidence: ["roadmap 1 plan 3: three new TanStack ```ts fences in references/sdks.md passed every test, then bun repo ci failed on its docs leg (no module, undeclared names, unused bindings); plan 5 added a fourth the same way, as an sdk ts tanstack block"]
---

# The docs gate type-checks every plain ts fence on its own

## Mistake
I added ```ts examples to references/sdks.md that use a generated SDK and @tanstack packages. `bun run test` passed. `bun repo docs --check` then type-checked each plain fence alone, with no generated code, and failed.

## Fix
Fence an example that needs a generated SDK as `sdk ts` (or `sdk ts tanstack`). The docs gate skips those, and `src/emit/ts/examples-compile.test.ts` compiles them against the kitchen SDK. Make each block whole: its imports, every name declared, nothing left unused. Run `bun repo docs --check` as well as the tests before calling the docs done.
