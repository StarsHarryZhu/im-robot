/**
 * The getupdates long-poll loop of one bound account. It never gives up on
 * its own: errors reconnect with exponential backoff, and only the caller's
 * signal ends it.
 *
 * Source: adapted from `@tencent-weixin/openclaw-weixin` 2.4.10,
 * `src/monitor/monitor.ts` and `src/api/session-guard.ts` (MIT License,
 * Copyright (C) 2026 Tencent; full text in THIRD_PARTY_NOTICES.md). Kept: the
 * stored cursor is sent back on every poll and replaced as soon as the server
 * returns a new one; the server's suggested long-poll timeout is honored; a
 * stale token (`-14`) pauses the account for an hour.
 * Changes: messages go to a callback instead of the OpenClaw reply pipeline;
 * the cursor is persisted through the caller (`saveCursor`); failed polls back
 * off exponentially from 2 seconds up to 5 minutes instead of 2 seconds then
 * 30 seconds; the loop reports its health (`connected`, `network`, `server`,
 * `expired`) to the caller; the token is resolved before every poll and a
 * missing one counts as expired instead of ending the loop; the pause is
 * local to the loop; the first poll of a loop has a short client timeout, so a
 * start or a reconnect reports its health within seconds; timings are
 * injectable for tests.
 * @module im-robot/channels/wechat/monitor
 */
import type { WeixinMessage } from './api.ts';
import type { LoggerLike } from '../../types.ts';
/** Loop timings; tests shorten them. */
export interface MonitorTiming {
    /** Client-side timeout of one long poll until the server suggests another. */
    longPollMs: number;
    /** Client-side timeout of the loop's first poll, at most `longPollMs`; a timeout counts as connected. */
    firstPollMs: number;
    /** Pause after the first failed poll; it doubles with each failure in a row. */
    retryDelayMs: number;
    /** Longest pause between reconnect attempts. */
    maxRetryDelayMs: number;
    /** Pause after the server reports a stale token, or when no token is stored. */
    stalePauseMs: number;
}
export declare const DEFAULT_MONITOR_TIMING: MonitorTiming;
/**
 * The loop's health after each poll: `connected` after a successful poll,
 * `network` when the server could not be reached, `server` when it answered
 * with an error, `expired` when the token is stale or gone.
 */
export type MonitorHealth = 'connected' | 'network' | 'server' | 'expired';
/** What the loop needs from its caller. */
export interface MonitorOptions {
    baseUrl: string;
    /** The stored cursor; empty on a fresh account. */
    cursor: string;
    /** Resolve the bot token for the next poll; undefined counts as expired. */
    token: () => Promise<string | undefined>;
    /** Persist a new cursor before its messages are handled. */
    saveCursor: (cursor: string) => Promise<void>;
    /** Handle one message, in order. */
    handle: (message: WeixinMessage) => Promise<void>;
    /** Hear the loop's health after every poll. */
    report: (health: MonitorHealth) => void;
    logger: LoggerLike;
    label: string;
    /** Missing fields take {@link DEFAULT_MONITOR_TIMING}'s. */
    timing?: Partial<MonitorTiming>;
    signal: AbortSignal;
}
/**
 * The pause before reconnect attempt `failures` (1 for the first failure).
 * @param failures - failed polls in a row, at least 1.
 * @param timing - the first delay and the cap.
 * @returns milliseconds to wait.
 */
export declare function retryDelay(failures: number, timing: Pick<MonitorTiming, 'retryDelayMs' | 'maxRetryDelayMs'>): number;
/**
 * Poll until the signal aborts.
 * @param options - account, cursor persistence, message handler, health report, and timings.
 */
export declare function monitorUpdates(options: MonitorOptions): Promise<void>;
