/**
 * WeChat QR login as a sequence of states: show a code, the code was
 * scanned, then confirmed with a bot token, or ended with a reason.
 *
 * Source: adapted from `@tencent-weixin/openclaw-weixin` 2.4.10,
 * `src/auth/login-qr.ts` (MIT License, Copyright (C) 2026 Tencent; full text
 * in THIRD_PARTY_NOTICES.md). The status handling follows that file: poll
 * `get_qrcode_status`, switch hosts on `scaned_but_redirect`, refresh an
 * expired code up to three codes in all, require `ilink_bot_id` on
 * confirmation, and treat a network error while polling as "still waiting".
 * Changes: an async generator instead of a start/wait pair over a shared map;
 * no terminal QR drawing and no stdin verify-code prompt (a code that needs
 * one ends the login with a reason); no local token list is sent; messages
 * are plain Chinese for the user; the server's hosts pass through
 * `trustedBaseUrl`; timings are injectable for tests.
 * @module im-robot/channels/wechat/login
 */
/** Login timings; tests shorten them. */
export interface LoginTiming {
    /** How long one code stays usable before it counts as expired. */
    qrLifetimeMs: number;
    /** Pause between status polls. */
    pollDelayMs: number;
    /** Give up on the whole login after this long. */
    deadlineMs: number;
}
export declare const DEFAULT_LOGIN_TIMING: LoginTiming;
/** A confirmed login: the secret and the ids the channel keeps. */
export interface ConfirmedLogin {
    token: string;
    botId: string;
    userId: string;
    baseUrl: string;
}
/** One login step as this module yields it. */
export type WechatLoginStep = {
    status: 'qr';
    qr: string;
    expiresAt: number;
} | {
    status: 'scanned';
} | {
    status: 'confirmed';
    login: ConfirmedLogin;
} | {
    status: 'expired' | 'failed';
    reason: string;
};
/**
 * Run one QR login.
 * @param options - the API host to start on, timings, and the abort signal.
 * @yields each step; the last is `confirmed`, `expired`, or `failed`, unless the signal aborts first.
 */
export declare function loginWithQr(options: {
    baseUrl: string;
    timing?: LoginTiming;
    signal: AbortSignal;
}): AsyncGenerator<WechatLoginStep>;
