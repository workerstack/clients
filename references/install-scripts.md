---
description: Install scripts for a CLI
order: 90
---

# Install scripts

The CLI's `install.sh` and `install.ps1` are written by installgen, which ships in this package as the `installgen`
bin and the `@workerstack/clients/installers` library (it was `@lovrozagar/installgen`). The generated release
workflow checks every release with the installgen of the clients release that generated the module:

```sh
npx --yes --package @workerstack/clients@<version> installgen check --default-version v1.2.3
```

installgen also writes installers for any prebuilt binary, outside a generated CLI:

```ts
import { defineConfig } from "@workerstack/clients/installers"

export default defineConfig({
	name: "my-cli",
	baseUrl: "https://dl.example.com/my-cli",
	assetPath: ({ version, os, arch }) => `${version}/my-cli-${os}-${arch}.tar.gz`,
})
```

Full reference: [installgen](https://github.com/workerstack/clients/blob/main/src/installers/README.md).
