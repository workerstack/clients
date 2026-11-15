---
description: Gates, push, CI and release
order: 800
---

# Gates

## Script contract

This repo has these `package.json` scripts. Hooks and CI call only these names, so a tool change is one line in `package.json`.

| script                       | runs                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `fmt` / `fmt:check`          | `repo fmt`: oxfmt with the standards pack's generated `.oxfmtrc.jsonc`                    |
| `lint` / `lint:fix`          | `repo lint`: oxlint with the generated `.oxlintrc.jsonc`, the repo's own plugin in `lint/` |
| `typecheck`                  | `tsc -p tsconfig.json`: src, tests and scripts                                            |
| `typecheck:src`              | `tsc -p tsconfig.src.json`: the source under the strict preset                            |
| `test`                       | the repo's suite                                                                          |

The lint and format configs, `knip.jsonc` and the git hooks are written by `bun repo sync` from `repo.config.ts`. The
repo's own lint rules are `lint.plugins` and `lint.rules` there; a rule that does not fit a file is a `lint.skip` entry
with its reason, and a use knip cannot see is a `knip.ignore` entry with its reason.

## Where each gate runs

| when       | what                                                                                                                         | blocks                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| pre-commit | `repo precommit`: fmt and `lint --fix` on the staged files (restaged), lint held to the baseline, typecheck, sync, the related tests, `repo check` | the commit            |
| commit-msg | `repo commit-msg`: Conventional Commits and the change-size rule                                                             | the commit            |
| pre-push   | `repo link --pre-push`, then `repo commit-msg --pre-push` on each pushed commit                                              | the push              |
| CI         | on every push to `main`: the `commits` job (`repo commit-msg --range`), `fmt:check`, `repo check`, `typecheck`, `typecheck:src`, `test`, `test:harness` | new work, until fixed |

`bun repo sync` points `core.hooksPath` at `.githooks/`, so the hooks come with `bun install`.

## Push and CI

No full suite runs locally. Each commit runs the tests its change reaches: the touched test files and the tests of the code it changed. Then push, and run `bun repo ci wait` in the background. It waits for CI's run on the pushed commit and names any failed job and its log. A push cancels the run before it, so batch the commits and push once.

## Release

The version bump rides in the final push. Only a commit CI passed on `main` gets the `v*` tag. The release workflow runs no tests: it waits for that commit's `ci.yml` push run and publishes on its success, so a bump made after the green push is a new commit and costs another CI run. The tag's notes are the `## [Unreleased]` entry of `CHANGELOG.md` for a prerelease and the dated `## [x.y.z] - YYYY-MM-DD` entry for a final release; `scripts/changelog.ts` refuses a tag without them.

## Browsers

- Chrome: `offscreen --hypr` adds a hidden virtual monitor to the running Hyprland; tests drive Chrome on it over CDP. It never takes focus. `exec` and `run` are refused in that mode.
- Safari: the MacBook Air M3 over Tailscale (`ssh mac`, `safaridriver -p 4799`), one run at a time.
