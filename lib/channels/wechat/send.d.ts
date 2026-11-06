/**
 * Send one plain-text message to the person a WeChat binding belongs to.
 *
 * Source: adapted from `@tencent-weixin/openclaw-weixin` 2.4.10,
 * `src/messaging/send.ts` (`sendMessageWeixin`, `buildTextMessageReq`) and
 * `src/util/random.ts` (`generateId`) (MIT License, Copyright (C) 2026
 * Tencent; full text in THIRD_PARTY_NOTICES.md): a bot-typed, finished
 * message with one text item, a fresh `client_id` of the form
 * `<prefix>:<timestamp>-<8 hex>`, and the latest `context_token` echoed back.
 * Changes: text only (no media, no quote cache, no run id); the caller
 * supplies the token and the stored context token; failures are rethrown
 * without logging the message text.
 * @module im-robot/channels/wechat/send
 */
/** A fresh client-side message id. */
export declare function clientId(): string;
/**
 * Send one text message.
 * @param target - API host, bot token, recipient, and the latest context token.
 * @param text - non-empty plain text.
 */
export declare function sendText(target: {
    baseUrl: string;
    token: string;
    to: string;
    contextToken?: string;
}, text: string): Promise<void>;
