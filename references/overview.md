---
description: What it generates
order: 10
---

# What it generates

Generates SDKs (TypeScript, Go, Rust, Python, C#, Java), a Go command-line client and a Model Context Protocol
server from an OpenAPI 3.x document, or straight from a
[`@workerstack/backend`](https://www.npmjs.com/package/@workerstack/backend) app.

Every target reads one intermediate representation and vendors its own small runtime, so a generated SDK has no
dependency on backend, and a spec from another framework generates just as well. The output is formatted and
deterministic: regenerating an unchanged spec changes nothing on disk.
