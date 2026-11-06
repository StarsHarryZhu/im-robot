# AGENTS.md

## 1. Role

Chat platforms behind one seam. `adapter.ts` defines what the service needs from a platform: a login that yields states and ends with an account, a receive loop that hands over accepted messages in order, saving what they carry in the link's media folder and naming it in their text, and reports its health, a plain-text send in a given reply context, the current reply context for the outbox, a read-only probe of the server and the secret, and a typing indicator. An adapter keeps its own per-account state in the link the service gives it, and the service persists that state in the binding's file. Adding a platform means adding a folder here and listing the adapter in the entry.

## 2. Constraints

- An adapter never stores secrets itself: the token comes from `link.token()` on every call.
- An adapter accepts only the person who logged in, in a private chat.
- What the person sends is saved only in `link.mediaDir`, under names that cannot leave it.
- Login reasons are plain Chinese for the user; protocol details go to the log only.
- `startTyping` never throws; failures there are cosmetic.
- `probe` never throws and changes nothing: one lightweight authenticated call, reported as reachable or not, the secret accepted, refused, or unknown, and a plain-Chinese problem.
- `receive` never ends on its own: it reconnects with backoff and reports `link.report(connected, problem)` after every poll, with `problem` in plain Chinese.

## 3. Contents

- `adapter.ts` — the `ChannelAdapter` and `ChannelLink` interfaces, the login, message, and probe shapes.
- `wechat` — the WeChat adapter over Tencent iLink.

## 4. Progress

- Done: the seam and the WeChat adapter.
- Open: no second platform yet.
- Goal later: more platforms when users need them.
