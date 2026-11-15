---
description: First generation
order: 30
---

# Start

From a document:

```sh
npx clients generate --spec openapi.json --target ts --target python --out generated
```

From a backend app module, with no document written first:

```sh
npx clients generate --app src/app.ts --target ts --target go --go-module-path github.com/acme/shop/sdk \
  --out generated
```

The targets are `ts`, `go`, `rust`, `python`, `csharp`, `java`, `cli` and `mcp`. Each target's files go under
`<out>/<target>`.
