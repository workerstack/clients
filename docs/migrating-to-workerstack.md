# Migrating to the workerstack names

In 1.0.0-rc.23, honey moved to the workerstack org. The packages, their imports and the repository changed name.
Nothing else changed: the API, the bins, the generated code's shape and every wire name are the same as in rc.22.

## What changed

| Before                                                                               | After                                                                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `@lovrozagar/honey`                                                                  | `@workerstack/backend`                                                                           |
| `@lovrozagar/honey/<subpath>` (every subpath, `/openapi`, `/ws/workers`, `/tree`, …) | `@workerstack/backend/<subpath>`                                                                 |
| `@lovrozagar/honey-clients`                                                          | `@workerstack/clients`                                                                           |
| `@lovrozagar/honey-clients/cli`                                                      | `@workerstack/clients/cli`                                                                       |
| github.com/lovrozagar/honey                                                          | github.com/workerstack/backend (github.com/workerstack/clients for the generator, once it moves) |

## What keeps its name

- The `honey` and `honey-clients` commands
- `HoneyError`, `HoneyContext` and every other exported name
- `HONEY_*` environment variables and the `honey-source` export condition
- `x-honey-*` headers and error codes

## Upgrade

1. Swap the packages:

   ```sh
   npm uninstall @lovrozagar/honey @lovrozagar/honey-clients
   npm install @workerstack/backend@next
   npm install --save-dev @workerstack/clients@next
   ```

2. Replace `@lovrozagar/honey-clients` with `@workerstack/clients` in your source first, and only then replace
   `@lovrozagar/honey` with `@workerstack/backend`. Doing it in the other order turns the clients import into
   `@workerstack/backend-clients`.
3. Rerun `honey generate` and `honey-clients generate`, so the generated files import the new names.

The old packages are deprecated on npm, and each one's message points to this page.
