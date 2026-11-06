# Third-party notices

im-robot is MIT licensed. Parts of it are adapted from the two MIT-licensed
packages below. Each adapted source file names its origin, the license, and
what changed in its header comment.

No code is taken from `@michengai/dsh-im-connect` (Apache-2.0), and none from
the files that `dsh-weixin-ilink`'s own NOTICE lists as derived from
`dsh-plugin-weixin` (`persona.js`, `life-state.js`, `human-pace.js`,
`proactive.js`, `quiet-hours.js`).

## @tencent-weixin/openclaw-weixin 2.4.10

- Source: https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin (version 2.4.10)
- Used for the iLink protocol layer:
  - `src/api/api.ts`, `src/api/types.ts` → `src/channels/wechat/api.ts`
  - `src/auth/login-qr.ts` → `src/channels/wechat/login.ts`
  - `src/monitor/monitor.ts`, `src/api/session-guard.ts` → `src/channels/wechat/monitor.ts`
  - `src/messaging/send.ts`, `src/util/random.ts` → `src/channels/wechat/send.ts`
  - `src/api/config-cache.ts`, typing calls in `src/messaging/process-message.ts` → `src/channels/wechat/typing.ts`
  - `bodyFromItemList` and `inlineQuoteBody` in `src/messaging/inbound.ts` → `src/channels/wechat/inbound.ts`
  - `src/cdn/pic-decrypt.ts`, `src/cdn/aes-ecb.ts`, `src/cdn/cdn-url.ts`, `src/media/media-download.ts` → `src/channels/wechat/media.ts`
  - `src/messaging/markdown-filter.ts` → `src/reply.ts`

```
Tencent is pleased to support the open source community by making openclaw-weixin available.

Copyright (C) 2026 Tencent.  All rights reserved.

openclaw-weixin is licensed under the MIT.


Terms of the MIT:
--------------------------------------------------------------------
Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## dsh-weixin-ilink 0.9.1

- Source: https://www.npmjs.com/package/dsh-weixin-ilink (version 0.9.1)
- Used for how a chat account is bridged into DeepSeek Harness (ideas, not
  copied code), from its first-party files only:
  - `src/agent-bridge.js` → `src/service.ts`
  - `src/session-reader.js` → `src/turns.ts`
  - `normalizeInbound` in `src/transport/ilink.js` → `src/channels/wechat/inbound.ts`

```
MIT License

Copyright (c) 2026 dsh-weixin contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
