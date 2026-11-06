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

import { IlinkHttpError, STALE_TOKEN_ERRCODE, getUpdates, isAbort } from './api.ts'
import type { WeixinMessage } from './api.ts'
import type { LoggerLike } from '../../types.ts'

/** Loop timings; tests shorten them. */
export interface MonitorTiming {
  /** Client-side timeout of one long poll until the server suggests another. */
  longPollMs: number
  /** Client-side timeout of the loop's first poll, at most `longPollMs`; a timeout counts as connected. */
  firstPollMs: number
  /** Pause after the first failed poll; it doubles with each failure in a row. */
  retryDelayMs: number
  /** Longest pause between reconnect attempts. */
  maxRetryDelayMs: number
  /** Pause after the server reports a stale token, or when no token is stored. */
  stalePauseMs: number
}

export const DEFAULT_MONITOR_TIMING: MonitorTiming = {
  longPollMs: 35_000,
  firstPollMs: 5_000,
  retryDelayMs: 2_000,
  maxRetryDelayMs: 5 * 60_000,
  stalePauseMs: 60 * 60_000,
}

/**
 * The loop's health after each poll: `connected` after a successful poll,
 * `network` when the server could not be reached, `server` when it answered
 * with an error, `expired` when the token is stale or gone.
 */
export type MonitorHealth = 'connected' | 'network' | 'server' | 'expired'

/** What the loop needs from its caller. */
export interface MonitorOptions {
  baseUrl: string
  /** The stored cursor; empty on a fresh account. */
  cursor: string
  /** Resolve the bot token for the next poll; undefined counts as expired. */
  token: () => Promise<string | undefined>
  /** Persist a new cursor before its messages are handled. */
  saveCursor: (cursor: string) => Promise<void>
  /** Handle one message, in order. */
  handle: (message: WeixinMessage) => Promise<void>
  /** Hear the loop's health after every poll. */
  report: (health: MonitorHealth) => void
  logger: LoggerLike
  label: string
  /** Missing fields take {@link DEFAULT_MONITOR_TIMING}'s. */
  timing?: Partial<MonitorTiming>
  signal: AbortSignal
}

/**
 * The pause before reconnect attempt `failures` (1 for the first failure).
 * @param failures - failed polls in a row, at least 1.
 * @param timing - the first delay and the cap.
 * @returns milliseconds to wait.
 */
export function retryDelay(failures: number, timing: Pick<MonitorTiming, 'retryDelayMs' | 'maxRetryDelayMs'>): number {
  const doublings = Math.min(Math.max(0, failures - 1), 30)
  return Math.min(timing.retryDelayMs * 2 ** doublings, timing.maxRetryDelayMs)
}

/** Sleep that ends early, without throwing, when the signal aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Poll until the signal aborts.
 * @param options - account, cursor persistence, message handler, health report, and timings.
 */
export async function monitorUpdates(options: MonitorOptions): Promise<void> {
  const { signal, logger, label } = options
  const timing: MonitorTiming = { ...DEFAULT_MONITOR_TIMING, ...options.timing }
  let cursor = options.cursor
  let timeoutMs = timing.longPollMs
  let first = true
  let failures = 0

  const failed = async (health: 'network' | 'server', message: string): Promise<void> => {
    failures += 1
    const delay = retryDelay(failures, timing)
    options.report(health)
    logger.warn(`im-robot: ${label} getupdates failed (${failures} in a row), reconnecting in ${Math.round(delay / 1000)} s: ${message}`)
    await pause(delay, signal)
  }
  const expired = async (message: string): Promise<void> => {
    failures = 0
    options.report('expired')
    logger.warn(`im-robot: ${label} ${message}; pausing for ${Math.ceil(timing.stalePauseMs / 60_000)} min (scan again to reconnect sooner)`)
    await pause(timing.stalePauseMs, signal)
  }

  while (!signal.aborted) {
    let token: string | undefined
    try {
      token = await options.token()
    } catch (error) {
      await failed('server', `the credential could not be read: ${String(error)}`)
      continue
    }
    if (token === undefined) {
      await expired('has no stored credential')
      continue
    }
    const pollMs = first ? Math.min(timing.firstPollMs, timeoutMs) : timeoutMs
    first = false
    try {
      const response = await getUpdates(cursor, { baseUrl: options.baseUrl, token, timeoutMs: pollMs, signal })
      if (signal.aborted) return
      if (response.longpolling_timeout_ms !== undefined && response.longpolling_timeout_ms > 0) {
        timeoutMs = response.longpolling_timeout_ms
      }
      const apiError = (response.ret !== undefined && response.ret !== 0) || (response.errcode !== undefined && response.errcode !== 0)
      if (apiError) {
        if (response.ret === STALE_TOKEN_ERRCODE || response.errcode === STALE_TOKEN_ERRCODE) {
          await expired('token is stale')
          continue
        }
        await failed('server', `ret=${response.ret ?? ''} errcode=${response.errcode ?? ''} ${response.errmsg ?? ''}`.trim())
        continue
      }
      failures = 0
      options.report('connected')
      if (response.get_updates_buf !== undefined && response.get_updates_buf !== '' && response.get_updates_buf !== cursor) {
        cursor = response.get_updates_buf
        try {
          await options.saveCursor(cursor)
        } catch (error) {
          // The batch is still handled; only a restart before the next save would replay it.
          logger.warn(`im-robot: ${label} could not save the cursor: ${String(error)}`)
        }
      }
      for (const message of response.msgs ?? []) {
        if (signal.aborted) return
        try {
          await options.handle(message)
        } catch (error) {
          logger.warn(`im-robot: ${label} could not handle a message: ${String(error)}`)
        }
      }
    } catch (error) {
      if (signal.aborted) return
      const server = error instanceof IlinkHttpError || error instanceof SyntaxError
      await failed(server ? 'server' : 'network', isAbort(error) ? 'request timed out' : String(error))
    }
  }
}
