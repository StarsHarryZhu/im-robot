# AGENTS.md

## 1. Role

The vitest specs. Most drive the real service and the real WeChat adapter against a fake iLink HTTP server on 127.0.0.1 and fake host services (in-memory credentials, a recording session controller, presets per session, a command registry); turns are fed in as the `session/event` stream the host would emit. One spec loads the entry under real cordis with fake services; module specs cover reply formatting, the store, and the turn tracker; two specs check the manifest with provenance and this documentation set.

## 2. Constraints

- Never touch the network beyond the local fake server, the real iLink service, or the user's DSH home; specs that load the entry point `DSH_HOME` at a temporary directory.
- The entry under real cordis talks to the real iLink host if a binding starts receiving, so that spec disables receiving before it binds.
- Timings are shortened through `WechatOptions`; waits poll a condition instead of sleeping a guessed time where possible.
- The manifest spec reads `lib/`, so run `node build.js` before the specs (`npm test` does).

## 3. Contents

- `helpers.ts` — temporary directories, the fake iLink server (hold time, failures, getconfig answers, upload slots, a CDN that serves downloads and keeps uploads), the fake host with its command registry and its way of reading presets (current host, a host like 0.2.1-rc.5, or neither), and login, bind, and turn helpers.
- `login.test.ts` — the login sequence, expiry, failures, aborts, credentials and the state file, and `unbind`.
- `bind.test.ts` — preset checks, binding, refusals, and reading a preset across host versions.
- `reliability.test.ts` — exponential reconnect, the expired-login status, status change events, the outbox (persistence, context tokens, retry after a poll or a restart, the 24-hour and failure limits), and failures staying inside the plugin.
- `messages.test.ts` — sender filtering, voice, the inbound event before the prompt, replies, `<keep>` blocks end to end, typing, notices, the stale-token pause, reminders, follow-ups (worker reports, agent and team messages, host notes, silent turns, the outbox), cursor resume, and options.
- `media.test.ts` — key encodings, decryption, trusted URLs, file names, the size limit, and images, files, voice, video, and quotes end to end.
- `outbound-media.test.ts` — sending files: the kind by extension, encryption, the upload URL, the upload slot, CDN, and item agreeing (what the CDN got decrypts with the item's key), files after text or alone, routed files, refusals, the stale-session resend, waiting after a refusal, dropping a file that is gone or too large, and upload failures.
- `send.test.ts` — `send`, `autoPush` off, no double answers, sending before the account's first message, the stale-session resend, waiting for the next message after a refusal or a day of silence, `route`, and the `silentReply` marker.
- `controls.test.ts` — what the parent's settings panel drives: per-binding options and their persistence, switching one binding off, its own reply length, message times, steering, `/` commands, `reconnect`, and `diagnose`.
- `reply.test.ts` — Markdown stripping, splitting by sentence and clause marks in several scripts, numbers and links left whole, character counting, and `<keep>` blocks.
- `store.test.ts` — binding ids, credential names, the data directory, and state files, including defaults for older files.
- `turns.test.ts` — binding request ids, the turn tracker with follow-up sources, and WeChat helpers.
- `plugin.test.ts` — the entry and its exports under real cordis, including real services shaped like host 0.2.1-rc.5.
- `manifest.test.ts` — identity, peers, bundle row, locale titles, built files, and provenance.
- `agents-md.test.ts` — every folder carries a four-section English AGENTS.md whose Contents list is true.

## 4. Progress

- Done: all specs pass.
- Open: the real host and the real iLink service are not exercised; the 0.2.1-rc.5 shapes come from reading its package source.
- Goal later: nothing planned.
