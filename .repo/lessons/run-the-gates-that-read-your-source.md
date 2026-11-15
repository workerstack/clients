---
name: run-the-gates-that-read-your-source
paths: ["src/**","lint/**","tests/structure/**","blueprint/files.tsv"]
hits: 5
last-hit: 2026-11-07
evidence: ["plan 21","roadmap 2","plan 32","plan 33","plan 40 rc.22: init.test.ts spawned bun -e on core source without --conditions=honey-source, so the new #output-check package import resolved to an unbuilt dist; lane gates passed, the first tip verify caught it"]
---

# Changed source reds the gates that read it, not only its own tests

## Mistake
I ran only the suites of touched files and called it done. The lint spawner derivation, the toolchain structure tests, the 100% coverage floor on a new `src` file and `blueprint/files.tsv` read the same source and failed later, over four full gate passes.

## Fix
After changing `src`, `lint` or `tests/structure`, run `bun vitest run lint tests/structure` and `bun run test` (the coverage floor) before pushing. A new file needs its `blueprint/files.tsv` row, which check-tree reads. A lint rule that follows named calls cannot see through a closure stored in a table.
