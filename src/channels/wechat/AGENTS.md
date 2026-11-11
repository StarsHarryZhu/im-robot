# AGENTS.md

## 1. Role

The WeChat adapter over Tencent iLink (`https://ilinkai.weixin.qq.com`). It logs a bot in by QR code (`get_bot_qrcode`, `get_qrcode_status`), long-polls `getupdates` with a persisted cursor, accepts private messages from the person who scanned, downloads and decrypts the images, files, voice, and video they carry into the binding's media folder, sends plain text with `sendmessage` and the latest `context_token`, sends files by uploading them encrypted (`getuploadurl` and the CDN) as images, videos, or files to open, shows "typing" with `getconfig` and `sendtyping`, and probes the account with one `getconfig` call. The protocol layer is adapted from `@tencent-weixin/openclaw-weixin` 2.4.10 (MIT); the sender rule follows `dsh-weixin-ilink` 0.9.1 (MIT), and what it measured about uploads follows `dsh-weixin-ilink` 0.10.3 (MIT).

## 2. Constraints

- Adapter-owned state in the binding file: `ilinkUserId`, `botId`, `baseUrl`, `syncBuf`, `contextToken`. The bot token is never written there.
- A host from the server (`baseurl`, `redirect_host`) is used only if it is https on a `qq.com` domain or equals the configured base URL, so a token never leaves Tencent.
- HTTP errors report the endpoint and status only, never the body.
- The cursor is saved as soon as a new one arrives, before its messages are handled, as upstream does.
- The first poll of each loop has a short client timeout (`firstPollMs`, 5 s), so a start or a reconnect reports its health within seconds; a client timeout counts as connected, as upstream treats the end of a long poll.
- `probe` reads only: `getconfig` with the token; `-14` means the token is refused; any other non-zero code leaves the token's state unknown.
- Failed polls back off from 2 s, doubling up to 5 min; a stale token (`-14`) or a missing credential reports `expired` and waits an hour, as upstream pauses; the loop ends only on abort. `CONNECTION_PROBLEM` holds the plain-Chinese texts for `network`, `server`, and `expired`.
- `send` uses the `context_token` an outbox entry recorded, falling back to the latest one. When iLink answers `-2` with "prepare failed" or "unknown error" (the chat's session went stale after a quiet period), the message goes once more without the token, under a new client id, as `dsh-weixin-ilink` 0.10.3 does. A `-2` that remains throws `ChatRefusedError`; any other non-zero `ret` or `errcode` is a plain failure. Errors carry the code and iLink's `errmsg`, never a token.
- `replyWindowMs` is a day (`REPLY_WINDOW_MS`): third-party bridges describe iLink refusing the bot's messages a day after the person's last one, and on the user's Desktop sends 5 hours after it arrived while sends 33 and 38 hours after it did not.
- A media URL from the server is used only on an https Tencent host or the configured CDN; a download stops at 100 MB and 120 s; failures reach the session as plain Chinese, without URLs or keys. Voice stays raw SILK, and its text is iLink's transcript.
- A file sent registers by its extension (pictures as images, `.mp4`, `.m4v`, and `.mov` as videos, everything else as a file, other videos included), with a fresh key and `filekey` per try; it is posted to the URL built from `upload_param` on the configured CDN, or to a full upload URL only on an https Tencent host or that CDN; the item points at the CDN's `x-encrypted-param` (else `upload_param`), carries `aes_key` as base64 of the key's hex text and `encrypt_type` 1, and goes alone in its message, under the same stale-session retry as text. A file that is gone, not regular, empty, or over 100 MB throws `UnsendableFileError` before anything is asked of the server; an upload waits at most 300 s.
- Every adapted file states its upstream file, the MIT license, and the changes at the top.
- Timings are injectable through `WechatOptions` so specs run in milliseconds; the defaults follow upstream.

## 3. Contents

- `index.ts` — `WechatAdapter`, implementing the channel seam (including `probe`), and the connection problem texts.
- `api.ts` — iLink wire types, headers, one function per endpoint, and the stale-session retry of `sendmessage`.
- `login.ts` — the QR login as a sequence of steps.
- `monitor.ts` — the getupdates long-poll loop with a short first poll, exponential reconnect, health reports, and the stale-token pause.
- `inbound.ts` — which messages to accept, the text they carry, the saved files it names (returned for attaching), quotes; user id masking.
- `media.ts` — CDN download, AES-128-ECB, file names, and saving.
- `send.ts` — one plain-text message, or one uploaded file, with a fresh client id.
- `upload.ts` — how a file is sent by its extension, AES-128-ECB, the upload URL, the CDN upload, and the image, video, or file item.
- `typing.ts` — typing tickets and the keepalive indicator.

## 4. Progress

- Done: login, receiving, sending, typing, with specs against a fake iLink server.
- Open: never run against the real service; the protocol identity headers report openclaw-weixin 2.4.10 and are untested with the real server.
- Done (2026-11-05): images, files, voice, video, and quotes, with specs against a fake server and CDN.
- Done (2026-11-06): the stale-session retry of `sendmessage`, with a fake server that refuses a stale token.
- Done (2026-11-07): a remaining `-2` is a `ChatRefusedError`, and the adapter states its one-day reply window.
- Done (2026-11-10): sending images, videos, and files, with specs against a fake server and CDN that decrypt what was uploaded with the item's key; not yet seen on a real phone.
- Known limits: no sending of voice (no SILK encoder, and the caller has no speech to send), no group chats, no voice transcoding; `need_verifycode` ends the login.
