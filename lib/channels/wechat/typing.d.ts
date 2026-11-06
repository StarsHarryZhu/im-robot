/**
 * The "typing" indicator while a WeChat-started turn runs.
 *
 * Source: adapted from `@tencent-weixin/openclaw-weixin` 2.4.10,
 * `src/api/config-cache.ts` (a per-user typing ticket from getconfig,
 * refreshed at a random time within 24 hours, failed fetches retried with a
 * doubling delay from 2 seconds up to 1 hour) and the typing start/stop calls
 * in `src/messaging/process-message.ts` (MIT License, Copyright (C) 2026
 * Tencent; full text in THIRD_PARTY_NOTICES.md).
 * Changes: one ticket per bound account (each account has one peer); the
 * indicator is re-sent on a keepalive timer and gives up after a cap, in
 * place of the OpenClaw SDK's typing callbacks; nothing here ever throws.
 * @module im-robot/channels/wechat/typing
 */
/** Indicator timings; tests shorten them. */
export interface TypingTiming {
    /** Re-send the indicator this often while the turn runs. */
    keepaliveMs: number;
    /** Stop re-sending after this long even if the turn has not ended. */
    maxMs: number;
}
export declare const DEFAULT_TYPING_TIMING: TypingTiming;
/** The account to show the indicator on. */
export interface TypingTarget {
    baseUrl: string;
    userId: string;
    contextToken?: string;
    token: () => Promise<string | undefined>;
    warn: (message: string) => void;
}
/** Cached getconfig typing tickets of one account. */
export declare class TypingTickets {
    private entry;
    /** The current ticket, fetching or refreshing it when due; '' when unavailable. */
    get(target: TypingTarget, token: string): Promise<string>;
}
/**
 * Show the indicator until the returned function is called.
 * @param target - the account and its peer.
 * @param tickets - the account's ticket cache.
 * @param timing - keepalive interval and cap.
 * @returns a stop function that also clears the indicator once.
 */
export declare function startTyping(target: TypingTarget, tickets: TypingTickets, timing?: TypingTiming): () => void;
