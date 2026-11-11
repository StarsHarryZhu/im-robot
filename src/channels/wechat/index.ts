/**
 * The WeChat adapter: Tencent iLink behind the {@link ChannelAdapter} seam.
 *
 * Adapter-owned state kept in the binding's state file:
 * - `ilinkUserId` — the person who scanned; the only sender accepted and the reply target;
 * - `botId` — the bot account iLink created for this login;
 * - `baseUrl` — the API host iLink assigned;
 * - `syncBuf` — the getupdates cursor;
 * - `contextToken` — the latest `context_token`, echoed on every reply.
 * The bot token itself lives in `ctx.credentials`.
 * @module im-robot/channels/wechat
 */

import type { ChannelAdapter, ChannelLink, ChannelProbe, InboundMessage, AdapterLoginState } from '../adapter.ts'
import { DEFAULT_BASE_URL, IlinkHttpError, STALE_TOKEN_ERRCODE, getConfig, isAbort } from './api.ts'
import { maskUserId, readInbound } from './inbound.ts'
import { DEFAULT_CDN_BASE_URL, saveMedia } from './media.ts'
import { DEFAULT_LOGIN_TIMING, loginWithQr } from './login.ts'
import type { LoginTiming } from './login.ts'
import { DEFAULT_MONITOR_TIMING, monitorUpdates } from './monitor.ts'
import type { MonitorHealth, MonitorTiming } from './monitor.ts'
import { sendFile, sendText } from './send.ts'
import { DEFAULT_TYPING_TIMING, TypingTickets, startTyping } from './typing.ts'
import type { TypingTiming } from './typing.ts'

export { DEFAULT_BASE_URL } from './api.ts'

/** What a user reads as `lastError` while the loop is not connected. */
export const CONNECTION_PROBLEM: Record<Exclude<MonitorHealth, 'connected'>, string> = {
  network: '连不上微信服务器，正在自动重连',
  server: '微信服务器暂时出错，正在自动重连',
  expired: '微信登录已失效，请重新绑定',
}

/** Default timeout of the `probe` call. */
const PROBE_TIMEOUT_MS = 5_000

/**
 * How long after the person's latest message iLink still takes the bot's
 * messages: a day, as third-party bridges describe it (Tencent documents no
 * figure). On the user's Desktop, sends 5 hours after their last message
 * arrived and sends 33 and 38 hours after it did not.
 */
export const REPLY_WINDOW_MS = 24 * 60 * 60_000

/** Construction options; tests point `baseUrl` at a fake server and shorten timings. */
export interface WechatOptions {
  baseUrl?: string
  login?: Partial<LoginTiming>
  monitor?: Partial<MonitorTiming>
  typing?: Partial<TypingTiming>
  /** Timeout of the getconfig call behind `probe`. */
  probeTimeoutMs?: number
  /** Where media comes from when the server gives no full URL. */
  cdnBaseUrl?: string
  /** Timeout and size limit of one media download. */
  mediaTimeoutMs?: number
  mediaMaxBytes?: number
  /** Timeout and size limit of one file sent. */
  uploadTimeoutMs?: number
  sendMaxBytes?: number
}

/** WeChat over iLink. */
export class WechatAdapter implements ChannelAdapter {
  readonly channel = 'wechat' as const
  readonly replyWindowMs = REPLY_WINDOW_MS
  private readonly baseUrl: string
  private readonly loginTiming: LoginTiming
  private readonly monitorTiming: MonitorTiming
  private readonly typingTiming: TypingTiming
  private readonly probeTimeoutMs: number
  private readonly cdnBaseUrl: string
  private readonly mediaLimits: { timeoutMs?: number; maxBytes?: number }
  private readonly uploadLimits: { timeoutMs?: number; maxBytes?: number }
  private readonly tickets = new Map<string, TypingTickets>()

  constructor(options: WechatOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.loginTiming = { ...DEFAULT_LOGIN_TIMING, ...options.login }
    this.monitorTiming = { ...DEFAULT_MONITOR_TIMING, ...options.monitor }
    this.typingTiming = { ...DEFAULT_TYPING_TIMING, ...options.typing }
    this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS
    this.cdnBaseUrl = options.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL
    this.mediaLimits = {
      ...(options.mediaTimeoutMs === undefined ? {} : { timeoutMs: options.mediaTimeoutMs }),
      ...(options.mediaMaxBytes === undefined ? {} : { maxBytes: options.mediaMaxBytes }),
    }
    this.uploadLimits = {
      ...(options.uploadTimeoutMs === undefined ? {} : { timeoutMs: options.uploadTimeoutMs }),
      ...(options.sendMaxBytes === undefined ? {} : { maxBytes: options.sendMaxBytes }),
    }
  }

  async *login(signal: AbortSignal): AsyncGenerator<AdapterLoginState> {
    for await (const step of loginWithQr({ baseUrl: this.baseUrl, timing: this.loginTiming, signal })) {
      if (step.status !== 'confirmed') {
        yield step
        continue
      }
      const { token, botId, userId, baseUrl } = step.login
      yield {
        status: 'confirmed',
        account: { token, user: maskUserId(userId), state: { ilinkUserId: userId, botId, baseUrl } },
      }
    }
  }

  async receive(link: ChannelLink, deliver: (message: InboundMessage) => Promise<void>, signal: AbortSignal): Promise<void> {
    const ownerId = link.state.ilinkUserId
    if (!ownerId) throw new Error('the binding has no ilinkUserId; scan the login code again')
    await monitorUpdates({
      baseUrl: this.apiBase(link),
      cursor: link.state.syncBuf ?? '',
      token: () => link.token(),
      saveCursor: syncBuf => link.update({ syncBuf }),
      handle: async (message) => {
        const inbound = await readInbound(message, ownerId, item => saveMedia(item, {
          directory: link.mediaDir,
          cdnBaseUrl: this.cdnBaseUrl,
          now: new Date(),
          signal,
          ...this.mediaLimits,
        }))
        if (inbound === undefined) return
        const contextToken = message.context_token?.trim()
        if (contextToken && contextToken !== link.state.contextToken) await link.update({ contextToken })
        await deliver(inbound)
      },
      report: health => link.report(health === 'connected', health === 'connected' ? undefined : CONNECTION_PROBLEM[health]),
      logger: link.logger,
      label: `wechat binding ${link.bindingId}`,
      timing: this.monitorTiming,
      signal,
    })
  }

  replyContext(link: ChannelLink): string | undefined {
    return link.state.contextToken || undefined
  }

  async send(link: ChannelLink, text: string, context?: string): Promise<void> {
    await sendText(await this.target(link, context), text)
  }

  async sendFile(link: ChannelLink, path: string, context?: string): Promise<void> {
    await sendFile({ ...await this.target(link, context), cdnBaseUrl: this.cdnBaseUrl, ...this.uploadLimits }, path)
  }

  /** The account's host, secret, and recipient, and the context to send in. */
  private async target(link: ChannelLink, context?: string): Promise<{ baseUrl: string; token: string; to: string; contextToken?: string }> {
    const token = await link.token()
    if (token === undefined) throw new Error('the binding has no stored credential')
    const to = link.state.ilinkUserId
    if (!to) throw new Error('the binding has no ilinkUserId')
    const contextToken = context ?? link.state.contextToken
    return { baseUrl: this.apiBase(link), token, to, ...(contextToken ? { contextToken } : {}) }
  }

  /** One getconfig call: it needs the bot token and only reads the account's typing ticket. */
  async probe(link: ChannelLink, signal: AbortSignal): Promise<ChannelProbe> {
    let token: string | undefined
    try {
      token = await link.token()
    } catch {
      token = undefined
    }
    try {
      const response = await getConfig(link.state.ilinkUserId ?? '', link.state.contextToken, {
        baseUrl: this.apiBase(link), token, timeoutMs: this.probeTimeoutMs, signal,
      })
      const code = response.ret !== undefined && response.ret !== 0 ? response.ret : response.errcode ?? 0
      if (code === STALE_TOKEN_ERRCODE) return { reachable: true, tokenAccepted: false, problem: CONNECTION_PROBLEM.expired }
      if (code !== 0) return { reachable: true, problem: `微信服务器拒绝了这次检查（错误码 ${code}）` }
      return token === undefined ? { reachable: true } : { reachable: true, tokenAccepted: true }
    } catch (error) {
      if (error instanceof IlinkHttpError) return { reachable: false, problem: `微信服务器出错（HTTP ${error.status}）` }
      if (error instanceof SyntaxError) return { reachable: false, problem: '微信服务器的回答看不懂' }
      if (isAbort(error)) return { reachable: false, problem: '微信服务器没有及时回应' }
      return { reachable: false, problem: '连不上微信服务器' }
    }
  }

  startTyping(link: ChannelLink): () => void {
    const userId = link.state.ilinkUserId
    if (!userId) return () => undefined
    let tickets = this.tickets.get(link.bindingId)
    if (tickets === undefined) {
      tickets = new TypingTickets()
      this.tickets.set(link.bindingId, tickets)
    }
    return startTyping({
      baseUrl: this.apiBase(link),
      userId,
      contextToken: link.state.contextToken,
      token: () => link.token(),
      warn: message => link.logger.warn(message),
    }, tickets, this.typingTiming)
  }

  /** Forget per-account caches when a binding goes away. */
  forget(bindingId: string): void {
    this.tickets.delete(bindingId)
  }

  /** The account's API host: the one iLink assigned at login, else the default. */
  private apiBase(link: ChannelLink): string {
    return link.state.baseUrl || this.baseUrl
  }
}
