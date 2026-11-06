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

import { fetchQrCode, pollQrStatus, trustedBaseUrl } from './api.ts'
import type { QrStatusResponse } from './api.ts'

/** Login timings; tests shorten them. */
export interface LoginTiming {
  /** How long one code stays usable before it counts as expired. */
  qrLifetimeMs: number
  /** Pause between status polls. */
  pollDelayMs: number
  /** Give up on the whole login after this long. */
  deadlineMs: number
}

export const DEFAULT_LOGIN_TIMING: LoginTiming = {
  qrLifetimeMs: 5 * 60_000,
  pollDelayMs: 1_000,
  deadlineMs: 8 * 60_000,
}

/** Codes in one login, counting the first; openclaw-weixin's MAX_QR_REFRESH_COUNT. */
const MAX_CODES = 3

/** A confirmed login: the secret and the ids the channel keeps. */
export interface ConfirmedLogin {
  token: string
  botId: string
  userId: string
  baseUrl: string
}

/** One login step as this module yields it. */
export type WechatLoginStep =
  | { status: 'qr'; qr: string; expiresAt: number }
  | { status: 'scanned' }
  | { status: 'confirmed'; login: ConfirmedLogin }
  | { status: 'expired' | 'failed'; reason: string }

const REASON = {
  unreachable: '连不上微信的服务器，请检查网络后再试一次。',
  expired: '二维码过期了，请重新点「绑定微信」再扫一次。',
  timeout: '等了太久还没有确认，请重新点「绑定微信」再扫一次。',
  verifyCode: '微信要求输入手机上显示的数字，这个版本还不支持，请过一会儿再扫一次。',
  blocked: '输错的次数太多，微信暂时不让登录，请过一会儿再试。',
  alreadyBound: '这个微信已经连接过了。如果要重新绑定，请先解除绑定再扫码。',
  noCredential: '微信没有给出登录凭据，请重新扫一次。',
} as const

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
 * Run one QR login.
 * @param options - the API host to start on, timings, and the abort signal.
 * @yields each step; the last is `confirmed`, `expired`, or `failed`, unless the signal aborts first.
 */
export async function* loginWithQr(options: {
  baseUrl: string
  timing?: LoginTiming
  signal: AbortSignal
}): AsyncGenerator<WechatLoginStep> {
  const { signal } = options
  const timing = options.timing ?? DEFAULT_LOGIN_TIMING
  const fail = (reason: string): WechatLoginStep => ({ status: 'failed', reason })
  const deadline = Date.now() + timing.deadlineMs

  const newCode = async (): Promise<{ qrcode: string; content: string; expiresAt: number } | undefined> => {
    try {
      const response = await fetchQrCode({ baseUrl: options.baseUrl, signal })
      if (!response.qrcode || !response.qrcode_img_content) return undefined
      return { qrcode: response.qrcode, content: response.qrcode_img_content, expiresAt: Date.now() + timing.qrLifetimeMs }
    } catch {
      return undefined
    }
  }

  let code = await newCode()
  if (signal.aborted) return
  if (code === undefined) {
    yield fail(REASON.unreachable)
    return
  }
  yield { status: 'qr', qr: code.content, expiresAt: code.expiresAt }
  let codes = 1
  let pollBase = options.baseUrl
  let scanned = false

  while (!signal.aborted) {
    if (Date.now() >= deadline) {
      yield { status: 'expired', reason: REASON.timeout }
      return
    }
    let response: QrStatusResponse
    try {
      response = await pollQrStatus(code.qrcode, { baseUrl: pollBase, signal })
    } catch {
      // A timed-out long poll or a gateway error just means "keep waiting".
      response = { status: 'wait' }
    }
    if (signal.aborted) return
    const status = Date.now() >= code.expiresAt && response.status !== 'confirmed' ? 'expired' : response.status

    switch (status) {
      case 'scaned':
      case 'scaned_but_redirect':
        if (status === 'scaned_but_redirect' && response.redirect_host) {
          pollBase = trustedBaseUrl(`https://${response.redirect_host}`, options.baseUrl)
        }
        if (!scanned) {
          scanned = true
          yield { status: 'scanned' }
        }
        break
      case 'expired': {
        if (codes >= MAX_CODES) {
          yield { status: 'expired', reason: REASON.expired }
          return
        }
        const next = await newCode()
        if (signal.aborted) return
        if (next === undefined) {
          yield fail(REASON.unreachable)
          return
        }
        code = next
        codes += 1
        pollBase = options.baseUrl
        scanned = false
        yield { status: 'qr', qr: code.content, expiresAt: code.expiresAt }
        continue
      }
      case 'need_verifycode':
        yield fail(REASON.verifyCode)
        return
      case 'verify_code_blocked':
        yield fail(REASON.blocked)
        return
      case 'binded_redirect':
        yield fail(REASON.alreadyBound)
        return
      case 'confirmed': {
        const token = response.bot_token?.trim()
        const botId = response.ilink_bot_id?.trim()
        const userId = response.ilink_user_id?.trim()
        if (!token || !botId || !userId) {
          yield fail(REASON.noCredential)
          return
        }
        yield {
          status: 'confirmed',
          login: { token, botId, userId, baseUrl: trustedBaseUrl(response.baseurl, options.baseUrl) },
        }
        return
      }
      default:
        break
    }
    await pause(timing.pollDelayMs, signal)
  }
}
