# AGENTS.md

## 1. Role

The WeChat adapter over Tencent iLink (`https://ilinkai.weixin.qq.com`). It logs a bot in by QR code (`get_bot_qrcode`, `get_qrcode_status`), long-polls `getupdates` with a persisted cursor, accepts private messages from the person who scanned, downloads and decrypts the images, files, voice, and video they carry into the binding's media folder, sends plain text with `sendmessage` and the latest `context_token`, shows "typing" with `getconfig` and `sendtyping`, and probes the account with one `getconfig` call. The protocol layer is adapted from `@tencent-weixin/openclaw-weixin` 2.4.10 (MIT); the sender rule follows `dsh-weixin-ilink` 0.9.1 (MIT).

## 2. Constraints

- Adapter-owned state in the binding file: `ilinkUserId`, `botId`, `baseUrl`, `syncBuf`, `contextToken`. The bot token is never written there.
- A host from the server (`baseurl`, `redirect_host`) is used only if it is https on a `qq.com` domain or equals the configured base URL, so a token never leaves Tencent.
- HTTP errors report the endpoint and status only, never the body.
- The cursor is saved as soon as a new one arrives, before its messages are handled, as upstream does.
- The first poll of each loop has a short client timeout (`firstPollMs`, 5 s), so a start or a reconnect reports its health within seconds; a client timeout counts as connected, as upstream treats the end of a long poll.
- `probe` reads only: `getconfig` with the token; `-14` means the token is refused; any other non-zero code leaves the token's state unknown.
- Failed polls back off from 2 s, doubling up to 5 min; a stale token (`-14`) or a missing credential reports `expired` and waits an hour, as upstream pauses; the loop ends only on abort. `CONNECTION_PROBLEM` holds the plain-Chinese texts for `network`, `server`, and `expired`.
- `send` uses the `context_token` an outbox entry recorded, falling back to the latest one. When iLink answers `-2` with "prepare failed" or "unknown error" (the chat's session went stale after a quiet period), the message goes once more without the token, under a new client id, as `dsh-weixin-ilink` 0.10.3 does. Any other non-zero `ret` or `errcode` is a failure.
- A media URL from the server is used only on an https Tencent host or the configured CDN; a download stops at 100 MB and 120 s; failures reach the session as plain Chinese, without URLs or keys. Voice stays raw SILK, and its text is iLink's transcript.
- Every adapted file states its upstream file, the MIT license, and the changes at the top.
- Timings are injectable through `WechatOptions` so specs run in milliseconds; the defaults follow upstream.

## 3. Contents

- `index.ts` — `WechatAdapter`, implementing the channel seam (including `probe`), and the connection problem texts.
- `api.ts` — iLink wire types, headers, one function per endpoint, and the stale-session retry of `sendmessage`.
- `login.ts` — the QR login as a sequence of steps.
- `monitor.ts` — the getupdates long-poll loop with a short first poll, exponential reconnect, health reports, and the stale-token pause.
- `inbound.ts` — which messages to accept, the text they carry, the saved files it names (returned for attaching), quotes; user id masking.
- `media.ts` — CDN download, AES-128-ECB, file names, and saving.
- `send.ts` — one plain-text message with a fresh client id.
- `typing.ts` — typing tickets and the keepalive indicator.

## 4. Progress

- Done: login, receiving, sending, typing, with specs against a fake iLink server.
- Open: never run against the real service; the protocol identity headers report openclaw-weixin 2.4.10 and are untested with the real server.
- Done (2026-11-05): images, files, voice, video, and quotes, with specs against a fake server and CDN.
- Done (2026-11-06): the stale-session retry of `sendmessage`, with a fake server that refuses a stale token.
- Known limits: no sending of media, no group chats, no voice transcoding; `need_verifycode` ends the login.
- Goal later: sending media.
