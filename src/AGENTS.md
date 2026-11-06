# AGENTS.md

## 1. Role

The plugin source, compiled by `build.js` into `lib/`. The entry provides the `imRobot` service and wires it to the host: credentials for secrets, the session controller for prompts and session lookup, agent presets for the bind check, and the global `session/event` stream for turns. The service is channel-neutral; each chat platform sits behind the adapter seam in `channels`, and the service never speaks a platform's wire protocol itself.

## 2. Constraints

- Host services are structural mirrors, so the compiler cannot see what an older host lacks: a method that is not on every host in the engine range is optional in `types.ts` and checked before the call (`presetOf` in `service.ts`).
- `observe` and `start` run inside the host's dispatch and loading: they log failures and never throw. Outgoing work goes through `enqueue`, which logs an escaped failure so later messages still go out and no rejection goes unhandled.
- `types.ts` holds the public contract (`ImRobotService`, `LoginState`, `BindingStatus`, the two events); change it only together with the parent package.
- No tool, prompt, or command registration anywhere.
- Prompts go through `sessionController.prompt` in `queue` mode with request ids `im-robot:<bindingId>:<uuid>`, so a turn's `user/message` source tells which binding asked, even after a restart. Any other `user` source is web input and clears `lastInputFromChat`.
- Per-binding options live in the state file (`options`, defaults `queue` and commands on). `steer` is used only while the tracker sees a running turn of the session, so an idle session gets `queue`. A `/` line goes to the host's `commands` registry when commands are on; a name the registry does not know is prompted as text (that is how skills are invoked), and the outcome of a known one is the reply, through the outbox.
- `reconnect` replaces the receive loop (only the new loop's reports count) and waits for its first report, at most `RECONNECT_WAIT_MS`; it never logs in. `diagnose` reads only, through the adapter's `probe`, the credential, the session lookup, and the outbox, and clears `lastError` only when every check passes.
- `lastInboundAt` / `lastOutboundAt` are persisted with the binding but left out of the change check, so they never emit `im-robot/status` on their own.
- Follow-up sources (`subagent-settled`, `agent-message`, `team-message`, `host-note`) and reminders are answered on the chat only while `autoPush` is on and `lastInputFromChat` holds, and a turn with no text sends nothing. `send` needs neither; a turn it ran during sends nothing by itself.
- `route` decides for the running turn and overrides all of that: `chat: true` sends its final text through the outbox whatever started the turn, `chat: false` keeps even the answer to a chat message off the chat (typing still clears). A routed turn with no text sends nothing, not the no-reply notice.
- `notBefore` (from `send` or `route`, at most 24 hours ahead) holds an outbox entry until then without holding back the entries behind it; its 24-hour age counts from that moment.
- A message's saved files go into the prompt after its text: images as image parts the host stores and normalizes (within `ctx.attachments.imageLimits`), other files up to `MAX_ATTACHED_FILE_BYTES` by a `ctx.fileUploads.uploadStream` receipt. Both services are read lazily with `ctx.get` and optional, since 0.2.1-rc.5 is untested with them and a missing injection makes a 0.2.2 host reject the plugin. A file that cannot be attached is only named in the text; a prompt refused with attachments (a model without image input) goes again as text alone.
- The `im-robot/inbound` listeners are awaited before the prompt; a failing listener is logged, never blocks the prompt.
- Outgoing messages of one binding are sent in order. Final replies go through the persisted outbox (retried after the next successful poll, dropped after 24 hours or more than three failures); so do follow-up answers and `send`; notices and reminder pushes are sent once and never retried. An entry with no reply context, on a binding that has none yet, waits for the account's first message instead of counting failures.
- `status` reports `connected` from the adapter's health reports and `lastError` as plain Chinese; `im-robot/status` is emitted only when the reported status changes.
- A binding runs only while the global `enabled` and its own are both on. An off binding neither polls, prompts, nor sends; replies made meanwhile wait in the outbox. `setOptions` and `setBindingOptions` validate these two options alike.
- `setBindingOptions` returns without a write or an event when nothing changed, because the parent answers status events by calling it.
- Reply segments are at most the binding's `replyMaxChars` (its own, else the global one) characters (code points), except a `<keep>` block, which stays whole up to `KEEP_MAX_CHARS` (2000); the markers never reach the reader.
- State files are written atomically with mode 0600; secrets never touch them or the logs.
- Adapted files keep their source, license, and change notes at the top.

## 3. Contents

- `index.ts` — plugin entry: name, injections, config schema, and `apply`.
- `types.ts` — the public service contract (with binding options and diagnosis shapes), event typings, and structural host types.
- `service.ts` — the `imRobot` service: logins, bindings, delivery, steering, commands, replies, follow-ups, `send` and `route` through the outbox, held entries, reminders, connection status, reconnect, diagnose, options.
- `attach.ts` — the prompt parts for a message's saved files: inline images and uploaded files, with the names their cards show.
- `turns.ts` — turn tracking over `session/event`, follow-up sources, each turn's route, and the request-id scheme for bindings.
- `reply.ts` — Markdown stripping, reply splitting by sentence and clause marks, and `<keep>` blocks.
- `store.ts` — binding ids, credential names, the data directory under the host's DSH home, the state files with their option defaults, media folder check, and the outbox entry shape.
- `channels` — the adapter seam and the WeChat adapter.

## 4. Progress

- Done: everything the first version needs, including follow-up pushes and host notes, covered by the specs.
- Done (2026-11-06, after the user reported proactive messages never arriving): a message to a chat quiet for a day was refused as stale and dropped after its retries; the adapter now sends it again without the old context token. `route` lets the caller decide where each turn's text goes, `notBefore` holds an entry until quiet hours end, and received images and files are attached to the prompt so the conversation view shows them.
- Open: the stale-session retry and the attachments are checked against fakes only, not against the real iLink server or host.
- Goal later: nothing planned beyond new channels.
