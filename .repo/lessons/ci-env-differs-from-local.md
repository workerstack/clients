---
name: ci-env-differs-from-local
paths: ["src/**",".github/workflows/ci.yml"]
hits: 1
last-hit: 2026-11-01
evidence: ["plan 21"]
---

# CI runs the same scripts as local, not the same environment

## Mistake
Product code read `CLIENTS_REQUIRE_TOOLCHAINS`, a harness switch CI sets, so a missing formatter threw in CI and not locally. oxfmt is an optional peer in the packed tarball, so CI's install legs printed a report line that exact-stderr asserts never saw locally.

## Fix
Product code gets its own variable, never a harness one: `tests/structure/env-ownership.test.ts` fails a `CLIENTS_REQUIRE_*` read under `src`. Before pushing toolchain or generation work, run the gates with `CLIENTS_REQUIRE_TOOLCHAINS=1`. Pin PATH or `$RUFF`/`$RUSTFMT`/`$GOFMT` in exact-output legs.
