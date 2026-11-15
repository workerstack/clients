import { defineConfig } from "@workerstack/repo";

export default defineConfig({
  packs: ["agents", "standards", "docs"],
  link: { push: "allow" },
  workflow: "main",
  agents: {
    defaultApproval: "ask",
    defaultEffort: "fast",
    defaultStrategy: "spawn-fast",
    hosts: ["claude", "codex", "antigravity", "grok", "cursor"],
  },
  lint: {
    plugins: { clients: "lint/index.js" },
    rules: [
      {
        files: ["src/**", "tests/**", "lint/**"],
        rules: {
          "clients/boundaries": "error",
          "clients/content-type-exact-essence": "error",
          "clients/unversioned-public": "error",
        },
      },
      { files: ["**/*.test.ts"], rules: { "clients/spawn-timeout": "error" } },
    ],
    skip: [
      {
        files: ["src/runtime/ts-tanstack-query/query.ts"],
        rules: ["typescript/no-explicit-any"],
        reason:
          "AnyMethod and Surface's call signature must accept and return any SDK method; unknown or never " +
          "collapses the call signatures the emitted tanstack-query file narrows back to exact types",
      },
      {
        files: ["src/runtime/**"],
        rules: [
          "repo/require-readable-spacing",
          "repo/no-block-comment",
          "repo/consistent-type-definitions",
          "eslint/curly",
          "eslint/sort-keys",
          "typescript/no-unnecessary-type-assertion",
          "typescript/no-meaningless-void-operator",
          "typescript/no-unnecessary-type-arguments",
          "unicorn/no-useless-undefined",
          "unicorn/switch-case-braces",
          "unicorn/prefer-string-replace-all",
        ],
        reason:
          "the runtime is copied as text into every generated SDK, its bytes are locked in scripts/sdk-budget*.test.ts " +
          "and it keeps the generators' style (src/runtime/.oxfmtrc.jsonc), so no fix may rewrite it",
      },
      {
        files: ["src/_tokenizer/**"],
        rules: [
          "repo/require-readable-spacing",
          "repo/consistent-type-definitions",
          "typescript/consistent-type-imports",
          "typescript/no-duplicate-type-constituents",
          "typescript/no-redundant-type-constituents",
          "eslint/curly",
          "eslint/sort-keys",
          "unicorn/switch-case-braces",
          "unicorn/no-negated-condition",
          "unicorn/prefer-string-replace-all",
        ],
        reason:
          "the vendored third-party tokenizer, kept byte for byte as upstream ships it (.prettierignore leaves it " +
          "unformatted too), so no fix may rewrite it",
      },
      {
        files: [
          "lint/boundaries.test.ts",
          "scripts/capture-token-budget.ts",
          "src/gen/write.ts",
          "src/emit/mcp/output-schema.ts",
          "src/emit/mcp/tools.ts",
          "src/ir/schema.test.ts",
          "src/ir/slots.test.ts",
          "src/emit/mcp/literal.test.ts",
          "src/emit/mcp/result.test.ts",
          "src/emit/mcp/server.test.ts",
          "src/emit/mcp/tools.test.ts",
          "src/emit/ts/request.search.test.ts",
          "src/emit/csharp/{http.response,realtime.typed,types.compiled,ws.typed}.test.ts",
          "src/emit/go/{realtime.typed,sse,ws.typed}.test.ts",
          "src/emit/python/{http.hooks,http,realtime.typed,sdk.calls,ws.typed}.test.ts",
          "src/emit/rust/{binary,http.auth,http.hooks,http,realtime.typed,sdk.bodies,sse.typed,ws.typed}.test.ts",
          "src/emit/mcp/schema.ts",
          "vitest.config.ts",
        ],
        rules: ["eslint/sort-keys"],
        reason:
          "key order is behavior in these files: a spec's keys kept in the order written, the JSON a manifest, " +
          "tool list or schema is written in, the order vitest runs its projects, or properties evaluated in order (a stream read after the await that fills " +
          "it), and the rule's fix sorts them",
      },
    ],
  },
  knip: {
    ignore: [
      {
        file: "src/runtime/**",
        reason:
          "the runtimes the emitters read as text (readFileSync of runtime/<lang>/...) and copy into generated SDKs; " +
          "their exports are the generated SDK's API, never imported here",
      },
      {
        file: "src/_tokenizer/**",
        reason: "vendored third-party tokenizer, kept as shipped; its unused exports and .d.ts imports are upstream's",
      },
      {
        file: "scripts/changelog.ts",
        reason: "run by path: `bun scripts/changelog.ts` in .github/workflows/release.yml",
      },
      {
        file: "scripts/rust-lock.ts",
        reason: "run by hand by path (`bun scripts/rust-lock.ts`) to refresh src/runtime/rust/Cargo.lock",
      },
      {
        file: ".github/release-fixture/codegen.mjs",
        reason: "run by path: the `codegen` command of .github/release-fixture/release.config.ts",
      },
      {
        file: "tests/integration/signal-on-spawn.ts",
        reason: "a `node --import` preload codegen-bin.test.ts passes by path, never imported",
      },
      {
        file: "docs/examples/ts/example.ts",
        reason: "read as text and type-checked against a generated SDK by src/emit/ts/examples-compile.test.ts",
      },
      {
        file: "tests/types/*.typetest.ts",
        reason: "type-only tests tsc checks through tsconfig.json's include; nothing imports or runs them",
      },
      {
        file: "tests/integration/conformance/app/{worker,app,app-secure,app-realtime,digest,reference-server}.ts",
        reason:
          "the conformance app: launcher.ts (spawned by path from harness.ts) bundles worker.ts from a generated " +
          "entry string with Bun.build, and worker.ts imports the rest",
      },
      {
        dependency: "oxlint",
        reason: "lint/rule-harness.ts resolves oxlint/package.json with createRequire to spawn its bin",
      },
      {
        binary: "mkfifo",
        reason: "a POSIX tool tests/security/emit-adversarial.mcp-files.test.ts spawns to make a fifo",
      },
    ],
  },
});
