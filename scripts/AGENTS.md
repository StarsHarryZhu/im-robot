# AGENTS.md

## 1. Role

Development scripts. The plugin installs no packages of its own: the compiler, the test runner, Node types, and the three host packages it builds against are symlinked from a sibling DeepSeek Harness checkout, so the plugin always compiles and tests against the host version it runs in.

## 2. Constraints

- Scripts write only inside this package's `node_modules` and never touch the network.
- An existing real directory in `node_modules` is never replaced; only stale symlinks move.
- `DSH_CHECKOUT` overrides the default checkout location, a `deepseek-harness` folder two levels above this package.
- A `link:` install loads the plugin with these symlinks as its peers, so `node_modules` must not be deleted while the plugin is installed that way.

## 3. Contents

- `link-dev.mjs` — links typescript, vitest, Node types, cordis, schemastery, and dsh-credentials from the harness checkout.

## 4. Progress

- Done: linking works against the local 0.2.2-alpha.2 checkout.
- Open: nothing.
- Goal later: nothing planned.
