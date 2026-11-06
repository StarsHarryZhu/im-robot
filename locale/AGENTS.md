# AGENTS.md

## 1. Role

Plugin metadata the host's Plugins page reads through the package export `./locale/*.json`: the title and one-sentence description of the plugin in each supported language. The plugin has no settings page and no browser half, so these two strings are all the user-facing copy outside the login reasons and chat notices in the source.

## 2. Constraints

- Each file holds only `meta.title` and `meta.description`.
- The titles are pinned by `tests/manifest.test.ts`: "IM Robot" in English and its Chinese name in Chinese.
- English and Chinese say the same thing.

## 3. Contents

- `en.json` — English title and description.
- `zh.json` — Chinese title and description.

## 4. Progress

- Done: both languages.
- Open: nothing.
- Goal later: nothing planned.
