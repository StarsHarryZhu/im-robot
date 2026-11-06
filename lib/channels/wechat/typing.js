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
import { TypingStatus, getConfig, sendTyping } from "./api.js";
export const DEFAULT_TYPING_TIMING = { keepaliveMs: 5_000, maxMs: 10 * 60_000 };
const TICKET_TTL_MS = 24 * 60 * 60_000;
const TICKET_FIRST_RETRY_MS = 2_000;
const TICKET_MAX_RETRY_MS = 60 * 60_000;
/** Cached getconfig typing tickets of one account. */
export class TypingTickets {
    entry;
    /** The current ticket, fetching or refreshing it when due; '' when unavailable. */
    async get(target, token) {
        const now = Date.now();
        if (this.entry !== undefined && now < this.entry.nextFetchAt)
            return this.entry.ticket;
        try {
            const response = await getConfig(target.userId, target.contextToken, { baseUrl: target.baseUrl, token });
            if (response.ret === 0 || response.ret === undefined) {
                this.entry = { ticket: response.typing_ticket ?? '', nextFetchAt: now + Math.random() * TICKET_TTL_MS, retryMs: TICKET_FIRST_RETRY_MS };
                return this.entry.ticket;
            }
            throw new Error(`getconfig ret=${response.ret}`);
        }
        catch (error) {
            target.warn(`im-robot: wechat getconfig failed (typing is skipped): ${String(error)}`);
            const retryMs = Math.min((this.entry?.retryMs ?? TICKET_FIRST_RETRY_MS / 2) * 2, TICKET_MAX_RETRY_MS);
            this.entry = { ticket: this.entry?.ticket ?? '', nextFetchAt: now + retryMs, retryMs };
            return this.entry.ticket;
        }
    }
}
/**
 * Show the indicator until the returned function is called.
 * @param target - the account and its peer.
 * @param tickets - the account's ticket cache.
 * @param timing - keepalive interval and cap.
 * @returns a stop function that also clears the indicator once.
 */
export function startTyping(target, tickets, timing = DEFAULT_TYPING_TIMING) {
    let stopped = false;
    let timer;
    let cap;
    let ticket = '';
    const send = async (status) => {
        try {
            const token = await target.token();
            if (token === undefined)
                return;
            if (ticket === '')
                ticket = await tickets.get(target, token);
            if (ticket === '')
                return;
            await sendTyping(target.userId, ticket, status, { baseUrl: target.baseUrl, token });
        }
        catch (error) {
            target.warn(`im-robot: wechat sendtyping failed: ${String(error)}`);
        }
    };
    const halt = () => {
        if (timer !== undefined)
            clearInterval(timer);
        if (cap !== undefined)
            clearTimeout(cap);
        timer = undefined;
        cap = undefined;
    };
    void send(TypingStatus.TYPING);
    timer = setInterval(() => { void send(TypingStatus.TYPING); }, timing.keepaliveMs);
    cap = setTimeout(halt, timing.maxMs);
    timer.unref?.();
    cap.unref?.();
    return () => {
        if (stopped)
            return;
        stopped = true;
        halt();
        void send(TypingStatus.CANCEL);
    };
}
