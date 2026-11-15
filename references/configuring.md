---
description: Configuring generation
order: 120
---

# Configuring generation

In a backend project the generation is configured once, in the Vite plugin, and `clients generate --app` reads
the same app. `codegen.mcp` writes the handler `mcp()` mounts, and `codegen.openApi` the document the SDKs are
generated from:

```sh
# the whole set, from the app module, in one run
npx clients generate --app src/app.ts \
  --target ts --target go --target python --target cli --target mcp \
  --go-module-path github.com/acme/shop/sdk --cli-repo acme/shop-cli --out generated
```

```json
{
	"scripts": {
		"generate": "backend generate && clients generate --app src/app.ts --target ts --out generated"
	}
}
```

What each target names its package, its client class and its environment variables is the `--<target>-<option>` set
above; nothing is read from a config file of ours, so one command line is the whole input and a CI run cannot drift
from a developer's.
