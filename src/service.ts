/**
 * The `imRobot` service: logs chat accounts in, binds each to one session,
 * prompts the account owner's messages into that session, and sends the
 * session's answers back.
 *
 * Flow for one bound account:
 * 1. the channel adapter long-polls, reconnecting with backoff on errors, and
 *    hands over each message from the person who logged in;
 * 2. the service emits `im-robot/inbound(sessionId, channel)` and awaits its
 *    listeners; a `/` line runs as a session command when the binding allows
 *    commands and the command exists, and its outcome is the reply; anything
 *    else shows "typing" and is prompted into the session under a request id
 *    that names the binding, in `queue` mode, or `steer` mode while a turn is
 *    running if the binding asks for it;
 * 3. when the turn that consumed the message ends, the turn's final assistant
 *    text is stripped of Markdown, split by the binding's `replyMaxChars`,
 *    written to the binding's outbox on disk, and sent; a sent segment leaves the outbox, a
 *    failed one is retried after the next successful poll (so after a
 *    reconnect or a restart) while it is under 24 hours old and has failed at
 *    most three times; when only the account's next message can let it through
 *    (it never wrote, or the platform refused until it writes again, as WeChat
 *    does a day after its last message), the outbox waits for that message,
 *    uncounted, and then goes out in its context;
 * 4. when a turn without chat input ends and the session's latest human input
 *    came from the chat account, its answer is pushed too, unless `autoPush` is
 *    off: a follow-up's (a worker's report, an agent or team message, or a host
 *    note) through the outbox like a reply, a reminder's once without it; a turn
 *    with no text sends nothing;
 *    a turn whose whole text is the configured `silentReply` sends nothing in
 *    any of these cases, not even the no-reply notice;
 * 5. `send` reaches the account at any time, through the outbox; a turn running
 *    meanwhile sends no reply of its own;
 * 6. files given to `send`, or to `route` with the chat chosen, follow the text
 *    through the outbox, one entry each, read and uploaded when they go: held,
 *    retried, and waiting for the account's next message like text; a file
 *    that is gone or cannot go by then is dropped.
 *
 * Bridging a chat account to a DSH session follows the idea of
 * `dsh-weixin-ilink` 0.9.1, `src/agent-bridge.js` (MIT License, Copyright (c)
 * 2026 dsh-weixin contributors; full text in THIRD_PARTY_NOTICES.md): one
 * durable session per conversation and the reply read back from the turn.
 * This module is written for this plugin: it prompts an existing session
 * through `sessionController.prompt` instead of creating agents, and replies
 * from live `session/event` turns instead of waiting for `whenIdle()`.
 * @module im-robot/service
 */

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { ChatRefusedError, UnsendableFileError } from './channels/adapter.ts'
import type { ChannelAdapter, ChannelAccount, ChannelLink, InboundMessage } from './channels/adapter.ts'
import { attachmentParts } from './attach.ts'
import { splitReply, stripMarkdown } from './reply.ts'
import { DEFAULT_BINDING_SETTINGS, MIN_REPLY_MAX_CHARS, SEND_MODES, assertBindingId, credentialName, isMediaDir, isReplyMaxChars } from './store.ts'
import type { BindingSettings, BindingStore, OutboxEntry, StoredBinding } from './store.ts'
import { TurnTracker, requestIdFor } from './turns.ts'
import type { TurnRoute, TurnSignal } from './turns.ts'
import type {
  AgentPresetsLike, AttachmentsLike, BindingOptions, BindingStatus, Channel, CommandsLike, CredentialsLike, Diagnosis, DiagnosisCheck,
  FileUploadsLike, ImRobotOptions, ImRobotService, LoggerLike, LoginState, PromptPart, SessionControllerLike, SessionEventLike,
  SessionLike, SessionProjectionsLike,
} from './types.ts'

/** Default longest reply segment, in characters: one short chat message. */
export const DEFAULT_REPLY_MAX_CHARS = 100
/** An outbox entry older than this is dropped instead of sent. */
export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60_000
/** An outbox entry that has failed more often than this is dropped. */
export const OUTBOX_MAX_FAILURES = 3
/** Longest wait of `reconnect` for the first poll to settle. */
export const RECONNECT_WAIT_MS = 15_000

/** Latest `notBefore` a caller may ask for: an entry waits at most this long. */
export const MAX_HOLD_MS = OUTBOX_MAX_AGE_MS

/** Largest file `send` and `route` take: what WeChat's adapter sends at most. */
export const MAX_SEND_FILE_BYTES = 100 * 1024 * 1024

/**
 * Check a caller's `files`.
 * @returns the paths, in order; empty for none.
 * @throws when it is not an array of absolute paths to regular, non-empty files of at most {@link MAX_SEND_FILE_BYTES}.
 */
function filesOf(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError('im-robot: files must be an array of absolute paths')
  return value.map((path: unknown) => {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('im-robot: files must be absolute paths')
    let size: number
    try {
      const stats = statSync(path)
      if (!stats.isFile()) throw new RangeError(`im-robot: not a regular file: ${path}`)
      size = stats.size
    } catch (error) {
      if (error instanceof RangeError) throw error
      throw new RangeError(`im-robot: no file at ${path}`)
    }
    if (size === 0) throw new RangeError(`im-robot: the file is empty: ${path}`)
    if (size > MAX_SEND_FILE_BYTES) throw new RangeError(`im-robot: the file is over 100 MB: ${path}`)
    return path
  })
}

/**
 * Check a caller's `notBefore`.
 * @returns the moment, or undefined for none.
 * @throws when it is not a finite number or lies more than {@link MAX_HOLD_MS} ahead.
 */
function notBeforeOf(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('im-robot: notBefore must be epoch milliseconds')
  if (value - Date.now() > MAX_HOLD_MS) throw new RangeError('im-robot: notBefore is more than 24 hours ahead')
  return value
}

/** Plain-text notices sent to the chat account. */
const NOTICE = {
  noReply: '（这次没有得到回复，请稍后再发一次。）',
  unsupported: '（这种消息现在还看不了，可以换成文字、图片或文件再发一次。）',
  promptFailed: '（消息没能交给助理，请稍后再发一次。）',
  saveFailed: '保存微信登录信息失败，请再扫一次。',
  stopped: '助理正在关闭，请稍后再试。',
  notLoggedIn: '这个微信号还没有扫码连接，请先扫码。',
  notBound: '这个微信账号还没有绑定会话。',
  switchedOff: '这个微信连接已经关闭。',
} as const

/** The reply to a command that succeeded without text. */
const commandDone = (name: string): string => `（已执行 /${name}。）`
/** The reply to a command that failed. */
const commandFailed = (name: string, why: string): string => `（/${name} 没有执行成功：${why}）`

/** `diagnose` check labels. */
const CHECK = {
  credential: '微信登录信息',
  server: '连接微信服务器',
  token: '微信登录状态',
  session: '绑定的会话',
  outbox: '待发的回复',
} as const

/** Plain-Chinese `lastError` values the service sets itself; the adapter supplies connection problems. */
const PROBLEM = {
  sendFailed: '回复没能发到微信，会自动重试',
  dropped: '有回复多次没能发到微信，已经放弃',
  waitingForMessage: '微信暂时不让助理先发消息（多半是超过一天没在微信里说话），在微信里回一句，没发出去的就会补发',
  receiveStopped: '绑定信息不完整，请重新绑定',
} as const

/** Throw unless the options `setOptions` and `setBindingOptions` share are valid. */
function assertSharedOptions({ replyMaxChars, enabled }: ImRobotOptions): void {
  if (replyMaxChars !== undefined && !isReplyMaxChars(replyMaxChars)) {
    throw new RangeError(`im-robot: replyMaxChars must be an integer of at least ${MIN_REPLY_MAX_CHARS}`)
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new TypeError('im-robot: enabled must be a boolean')
}

/** Host services the service uses. */
export interface ServiceHost {
  credentials: CredentialsLike
  sessionController: SessionControllerLike
  /** `ctx.agentPresets` when the host has it. */
  agentPresets: () => AgentPresetsLike | undefined
  logger: LoggerLike
  /** Brand a credential reference name (`credentialRef` from dsh-credentials). */
  credentialRef: (name: string) => string
  /** Emit `im-robot/status`. */
  emitStatus: (bindingId: string, state: BindingStatus) => void
  /** Run the `im-robot/inbound` listeners and wait for them. */
  emitInbound: (sessionId: string, channel: Channel) => Promise<void>
  /** `ctx.commands` when the host has it. */
  commands?: () => CommandsLike | undefined
  /** `ctx.sessionProjections` when the host has it. */
  sessionProjections?: () => SessionProjectionsLike | undefined
  /** `ctx.attachments` when the host has it: images then go into the prompt itself. */
  attachments?: () => AttachmentsLike | undefined
  /** `ctx.fileUploads` when the host has it: files then go into the prompt by receipt. */
  fileUploads?: () => FileUploadsLike | undefined
}

/** Service settings. */
export interface ServiceOptions {
  /** Presets a session may have to be bound; empty allows any. */
  presets: readonly string[]
  replyMaxChars: number
  /** Whether turns no chat message started are answered on the chat by themselves; default true. */
  autoPush?: boolean
  /** A reply that is exactly this text, trimmed, sends nothing; empty or absent sends every reply. */
  silentReply?: string
  store: BindingStore
  adapters: readonly ChannelAdapter[]
  /** Longest wait of `reconnect`; default {@link RECONNECT_WAIT_MS}. */
  reconnectWaitMs?: number
}

/** One live binding. */
interface Runtime {
  stored: StoredBinding
  /** Aborts the receive loop. */
  receiving?: AbortController
  /** Clears the typing indicator. */
  stopTyping?: () => void
  /** Chat messages prompted whose turn has not ended yet. */
  awaiting: number
  /** Serializes outgoing messages. */
  chain: Promise<void>
  /** An outbox flush is queued or running. */
  flushing: boolean
  /** The receive loop's last poll succeeded. */
  connected: boolean
  /** Why the receive loop is not connected, in plain Chinese. */
  connectionError?: string
  /** Why the outbox is stuck, in plain Chinese. */
  sendError?: string
  /** `reconnect` calls waiting for the receive loop's next health report. */
  reportWaiters: (() => void)[]
  /**
   * Only the account's next message can let the outbox through: a send failed
   * before it ever wrote (no reply context yet), or the platform refused one
   * until it writes again. The outbox waits for that message instead of
   * failing until it gives up.
   */
  awaitingMessage: boolean
}

/** The `imRobot` service implementation. */
export class ImRobot implements ImRobotService {
  private readonly bindings = new Map<string, Runtime>()
  private readonly logins = new Map<string, AbortController>()
  private readonly turns = new TurnTracker()
  private readonly adapters: Map<Channel, ChannelAdapter>
  /** The limit of bindings without their own. */
  private replyMaxChars: number
  /** The global switch; each binding has its own as well. */
  private enabled = true
  private disposed = false
  /** Aborted on dispose; bounds `diagnose`. */
  private readonly lifetime = new AbortController()

  constructor(private readonly host: ServiceHost, private readonly options: ServiceOptions) {
    this.adapters = new Map(options.adapters.map(adapter => [adapter.channel, adapter]))
    this.replyMaxChars = options.replyMaxChars
  }

  /** Load stored bindings and resume receiving for the bound ones; their outboxes flush once connected. */
  start(): void {
    for (const stored of this.options.store.list(message => this.host.logger.warn(message))) {
      if (!this.adapters.has(stored.channel)) continue
      const runtime = this.newRuntime(stored)
      this.bindings.set(stored.bindingId, runtime)
      // This runs while the host loads plugins; one bad binding must not fail the plugin or the others.
      try {
        this.startReceiving(runtime)
      } catch (error) {
        this.host.logger.warn(`im-robot: binding ${stored.bindingId} could not start receiving: ${String(error)}`)
      }
    }
  }

  /** Stop every login, connection, and indicator. Outboxes stay on disk. */
  dispose(): void {
    this.disposed = true
    this.lifetime.abort()
    for (const controller of this.logins.values()) controller.abort()
    this.logins.clear()
    for (const runtime of this.bindings.values()) this.stopRuntime(runtime)
    this.bindings.clear()
  }

  login(bindingId: string, channel: Channel, signal?: AbortSignal): AsyncIterable<LoginState> {
    assertBindingId(bindingId)
    return this.runLogin(bindingId, this.adapterOf(channel), signal)
  }

  async bind(bindingId: string, target: { sessionId: string }): Promise<void> {
    assertBindingId(bindingId)
    const sessionId = target?.sessionId
    if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new TypeError('im-robot: bind needs a sessionId')
    const runtime = this.bindings.get(bindingId)
    if (runtime === undefined) throw new Error('这个微信号还没有扫码连接，请先扫码，再绑定会话。')
    const problem = await this.sessionProblem(sessionId, false)
    if (problem !== undefined) throw new Error(problem)
    if (this.bindings.get(bindingId) !== runtime) throw new Error('绑定在检查期间被解除了，请重新扫码。')
    this.stopRuntime(runtime)
    const sameSession = runtime.stored.sessionId === sessionId
    runtime.stored = {
      ...runtime.stored,
      sessionId,
      lastInputFromChat: sameSession && runtime.stored.lastInputFromChat,
      // Replies meant for another session's conversation are not sent into this one.
      outbox: sameSession ? runtime.stored.outbox : [],
    }
    this.options.store.write(runtime.stored)
    this.emitStatus(bindingId)
    this.startReceiving(runtime)
  }

  async unbind(bindingId: string): Promise<void> {
    assertBindingId(bindingId)
    this.logins.get(bindingId)?.abort()
    const runtime = this.bindings.get(bindingId)
    if (runtime !== undefined) {
      this.stopRuntime(runtime)
      this.bindings.delete(bindingId)
    }
    try {
      for (const adapter of this.adapters.values()) {
        adapter.forget?.(bindingId)
        await this.host.credentials.unset(this.refOf(adapter.channel, bindingId))
      }
    } finally {
      this.options.store.delete(bindingId)
      this.emitStatus(bindingId)
    }
  }

  status(bindingId: string): BindingStatus {
    const runtime = this.bindings.get(bindingId)
    if (runtime === undefined) return { bound: false, connected: false, ...DEFAULT_BINDING_SETTINGS, replyMaxChars: this.replyMaxChars }
    const { stored } = runtime
    const lastError = runtime.connectionError ?? runtime.sendError
    const window = this.adapters.get(stored.channel)?.replyWindowMs
    return {
      bound: true,
      user: stored.user,
      ...(stored.sessionId === undefined ? {} : { sessionId: stored.sessionId }),
      connected: runtime.connected,
      ...(lastError === undefined ? {} : { lastError }),
      sendMode: stored.options.sendMode,
      commands: stored.options.commands,
      enabled: stored.options.enabled,
      replyMaxChars: this.replyLimitOf(runtime),
      ...(stored.lastInboundAt === undefined ? {} : { lastInboundAt: stored.lastInboundAt }),
      ...(stored.lastOutboundAt === undefined ? {} : { lastOutboundAt: stored.lastOutboundAt }),
      ...(window === undefined || stored.lastInboundAt === undefined ? {} : { windowClosesAt: stored.lastInboundAt + window }),
    }
  }

  setBindingOptions(bindingId: string, options: BindingOptions): BindingStatus {
    assertBindingId(bindingId)
    const { sendMode, commands, enabled, replyMaxChars, mediaDir } = options ?? {}
    if (sendMode !== undefined && !SEND_MODES.includes(sendMode)) {
      throw new RangeError(`im-robot: sendMode must be ${SEND_MODES.map(mode => JSON.stringify(mode)).join(' or ')}`)
    }
    if (commands !== undefined && typeof commands !== 'boolean') throw new TypeError('im-robot: commands must be a boolean')
    assertSharedOptions({ enabled, replyMaxChars })
    if (mediaDir !== undefined && !isMediaDir(mediaDir)) throw new TypeError('im-robot: mediaDir must be an absolute path')
    const runtime = this.bindings.get(bindingId)
    if (runtime === undefined) throw new Error(NOTICE.notLoggedIn)
    const current = runtime.stored.options
    const limit = replyMaxChars ?? current.replyMaxChars
    const folder = mediaDir ?? current.mediaDir
    const next: BindingSettings = {
      sendMode: sendMode ?? current.sendMode,
      commands: commands ?? current.commands,
      enabled: enabled ?? current.enabled,
      ...(limit === undefined ? {} : { replyMaxChars: limit }),
      ...(folder === undefined ? {} : { mediaDir: folder }),
    }
    if (next.sendMode === current.sendMode && next.commands === current.commands && next.enabled === current.enabled
      && next.replyMaxChars === current.replyMaxChars && next.mediaDir === current.mediaDir) return this.status(bindingId)
    const before = this.statusKey(runtime)
    const stored = { ...runtime.stored, options: next }
    // Written before it takes effect, so a failed write leaves the binding as it was.
    this.options.store.write(stored)
    runtime.stored = stored
    if (next.enabled !== current.enabled) {
      if (next.enabled) this.startReceiving(runtime)
      else this.stopRuntime(runtime)
    }
    if (this.statusKey(runtime) !== before) this.emitStatus(bindingId)
    return this.status(bindingId)
  }

  send(bindingId: string, text: string, options?: { notBefore?: number; files?: readonly string[] }): void {
    const runtime = this.usable(bindingId)
    const notBefore = notBeforeOf(options?.notBefore)
    const files = filesOf(options?.files)
    const segments = this.segmentsOf(runtime, typeof text === 'string' ? text : '')
    if (segments.length === 0 && files.length === 0) throw new TypeError('im-robot: send needs some text or a file')
    this.turns.markSent(runtime.stored.sessionId!)
    this.enqueueReply(runtime, segments, notBefore, files)
  }

  route(bindingId: string, route: TurnRoute): boolean {
    if (typeof route !== 'object' || route === null || typeof route.chat !== 'boolean') throw new TypeError('im-robot: route needs { chat: boolean }')
    const runtime = this.usable(bindingId)
    const notBefore = notBeforeOf(route.notBefore)
    const files = filesOf(route.files)
    if (!route.chat && files.length > 0) throw new TypeError('im-robot: files go only with chat: true')
    return this.turns.setRoute(runtime.stored.sessionId!, {
      chat: route.chat, ...(notBefore === undefined ? {} : { notBefore }), ...(files.length === 0 ? {} : { files }),
    })
  }

  /** A binding that can send now: logged in, bound, and switched on; else a plain-Chinese error. */
  private usable(bindingId: string): Runtime {
    assertBindingId(bindingId)
    const runtime = this.bindings.get(bindingId)
    if (runtime === undefined) throw new Error(NOTICE.notLoggedIn)
    if (runtime.stored.sessionId === undefined) throw new Error(NOTICE.notBound)
    if (!this.isOn(runtime)) throw new Error(NOTICE.switchedOff)
    return runtime
  }

  async reconnect(bindingId: string): Promise<BindingStatus> {
    assertBindingId(bindingId)
    const runtime = this.bindings.get(bindingId)
    if (runtime === undefined) throw new Error(NOTICE.notLoggedIn)
    if (this.disposed || !this.isOn(runtime) || runtime.stored.sessionId === undefined) return this.status(bindingId)
    // A new loop starts with no failures counted, so the backoff starts over.
    runtime.receiving?.abort()
    runtime.receiving = undefined
    const reported = new Promise<void>(resolve => runtime.reportWaiters.push(resolve))
    this.startReceiving(runtime)
    let timer: ReturnType<typeof setTimeout> | undefined
    const waited = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.options.reconnectWaitMs ?? RECONNECT_WAIT_MS) })
    await Promise.race([reported, waited])
    clearTimeout(timer)
    return this.status(bindingId)
  }

  async diagnose(bindingId: string): Promise<Diagnosis> {
    assertBindingId(bindingId)
    const runtime = this.bindings.get(bindingId)
    if (runtime === undefined) return { ok: false, checks: [{ label: CHECK.credential, ok: false, detail: NOTICE.notLoggedIn }] }
    const { stored } = runtime
    const link = this.linkOf(runtime)
    const checks: DiagnosisCheck[] = []

    let token: string | undefined
    try {
      token = await link.token()
    } catch (error) {
      this.host.logger.warn(`im-robot: binding ${bindingId} credential could not be read: ${String(error)}`)
    }
    checks.push(token === undefined
      ? { label: CHECK.credential, ok: false, detail: '没有找到微信登录信息，请重新扫码' }
      : { label: CHECK.credential, ok: true })

    const probe = await this.adapterOf(stored.channel).probe(link, this.lifetime.signal)
    checks.push(probe.reachable
      ? { label: CHECK.server, ok: true }
      : { label: CHECK.server, ok: false, ...(probe.problem === undefined ? {} : { detail: probe.problem }) })

    // The server's answer decides; when it does not tell, a poll that just succeeded with this token does.
    const accepted = token === undefined ? false : probe.tokenAccepted ?? (runtime.connected ? true : undefined)
    if (accepted === true) checks.push({ label: CHECK.token, ok: true })
    else {
      const detail = token === undefined ? '没有登录信息，无法检查'
        : accepted === false ? probe.problem ?? '微信登录已失效，请重新绑定'
        : probe.reachable ? probe.problem ?? '微信服务器没有说明登录是否有效' : '连不上微信服务器，无法检查'
      checks.push({ label: CHECK.token, ok: false, detail })
    }

    let sessionProblem: string | undefined
    if (stored.sessionId === undefined) sessionProblem = '还没有绑定会话'
    else {
      try {
        sessionProblem = await this.sessionProblem(stored.sessionId, true)
      } catch (error) {
        sessionProblem = `检查会话时出错：${error instanceof Error ? error.message : String(error)}`
      }
    }
    checks.push(sessionProblem === undefined
      ? { label: CHECK.session, ok: true }
      : { label: CHECK.session, ok: false, detail: sessionProblem })

    const pending = runtime.stored.outbox.length
    const failed = runtime.stored.outbox.filter(entry => entry.failures > 0).length
    const failure = runtime.stored.lastSendFailure
    const said = failure === undefined ? '' : `（上次失败：${new Date(failure.at).toLocaleString('zh-CN', { hour12: false })}，${failure.error}）`
    checks.push(runtime.awaitingMessage && pending > 0
      ? { label: CHECK.outbox, ok: false, detail: `还有 ${pending} 条消息在等你在微信里说话：微信暂时不让助理先发，你回一句就会补发${said}` }
      : failed > 0
        ? { label: CHECK.outbox, ok: false, detail: `还有 ${pending} 条回复没发出去，其中 ${failed} 条发送失败过，会在连上后自动补发${said}` }
        : { label: CHECK.outbox, ok: true, ...(pending === 0 ? {} : { detail: `还有 ${pending} 条回复正在发送` }) })

    const ok = checks.every(check => check.ok)
    if (ok && this.bindings.get(bindingId) === runtime) {
      const before = this.statusKey(runtime)
      runtime.connectionError = undefined
      runtime.sendError = undefined
      if (this.statusKey(runtime) !== before) this.emitStatus(bindingId)
    }
    return { ok, checks }
  }

  setOptions(options: ImRobotOptions): void {
    const { replyMaxChars, enabled } = options ?? {}
    assertSharedOptions({ replyMaxChars, enabled })
    if (replyMaxChars !== undefined && replyMaxChars !== this.replyMaxChars) {
      this.replyMaxChars = replyMaxChars
      // `status` reports the limit in effect, which only moved for bindings without their own.
      for (const runtime of this.bindings.values()) {
        if (runtime.stored.options.replyMaxChars === undefined) this.emitStatus(runtime.stored.bindingId)
      }
    }
    if (enabled !== undefined && enabled !== this.enabled) {
      this.enabled = enabled
      for (const runtime of this.bindings.values()) {
        if (enabled) {
          this.startReceiving(runtime)
        } else {
          const before = this.statusKey(runtime)
          this.stopRuntime(runtime)
          if (this.statusKey(runtime) !== before) this.emitStatus(runtime.stored.bindingId)
        }
      }
    }
  }

  /**
   * `session/event` listener: follow turns of bound sessions. It runs inside
   * the host's dispatch for every session, so a failure here is logged and
   * goes no further.
   */
  observe(sessionId: string, event: SessionEventLike): void {
    try {
      if (this.disposed || !this.runtimesOf(sessionId).length) return
      const signal = this.turns.observe(sessionId, event)
      if (signal === undefined) return
      if (signal.kind === 'foreign-input') {
        for (const runtime of this.runtimesOf(sessionId)) this.setLastInput(runtime, false)
        return
      }
      this.onTurnEnd(signal)
    } catch (error) {
      this.host.logger.warn(`im-robot: could not follow session ${sessionId}: ${String(error)}`)
    }
  }

  /** The login generator behind {@link login}. */
  private async *runLogin(bindingId: string, adapter: ChannelAdapter, outer?: AbortSignal): AsyncGenerator<LoginState> {
    this.logins.get(bindingId)?.abort()
    const controller = new AbortController()
    this.logins.set(bindingId, controller)
    const follow = (): void => controller.abort()
    if (outer?.aborted === true) controller.abort()
    else outer?.addEventListener('abort', follow, { once: true })
    try {
      if (this.disposed) {
        yield { status: 'failed', reason: NOTICE.stopped }
        return
      }
      for await (const step of adapter.login(controller.signal)) {
        if (controller.signal.aborted) return
        if (step.status !== 'confirmed') {
          yield step
          if (step.status === 'expired' || step.status === 'failed') return
          continue
        }
        try {
          await this.saveAccount(bindingId, adapter.channel, step.account)
        } catch (error) {
          this.host.logger.warn(`im-robot: could not store the login of binding ${bindingId}: ${String(error)}`)
          yield { status: 'failed', reason: NOTICE.saveFailed }
          return
        }
        yield { status: 'bound', user: step.account.user }
        return
      }
    } finally {
      outer?.removeEventListener('abort', follow)
      if (this.logins.get(bindingId) === controller) this.logins.delete(bindingId)
      controller.abort()
    }
  }

  /** Keep a confirmed login: secret to credentials, the rest to the state file. */
  private async saveAccount(bindingId: string, channel: Channel, account: ChannelAccount): Promise<void> {
    const previous = this.bindings.get(bindingId)
    if (previous !== undefined) this.stopRuntime(previous)
    await this.host.credentials.set(this.refOf(channel, bindingId), account.token)
    const stored: StoredBinding = {
      version: 1,
      bindingId,
      channel,
      user: account.user,
      ...(previous?.stored.sessionId === undefined ? {} : { sessionId: previous.stored.sessionId }),
      lastInputFromChat: false,
      channelState: { ...account.state },
      // A new login is a new conversation context; old replies cannot be answered in it.
      outbox: [],
      boundAt: Date.now(),
      options: { ...(previous?.stored.options ?? DEFAULT_BINDING_SETTINGS) },
    }
    this.options.store.write(stored)
    const runtime = this.newRuntime(stored)
    this.bindings.set(bindingId, runtime)
    this.emitStatus(bindingId)
    this.startReceiving(runtime)
  }

  /**
   * Why a session cannot take a binding, in plain Chinese, or undefined when
   * it can: its preset must be configured, when presets are configured.
   * @param mustExist - also look the session up when no presets are configured.
   */
  private async sessionProblem(sessionId: string, mustExist: boolean): Promise<string | undefined> {
    const presets = this.options.presets
    if (presets.length === 0 && !mustExist) return undefined
    if (presets.length > 0 && this.host.agentPresets() === undefined && this.host.sessionProjections?.() === undefined) {
      return '宿主没有 agentPresets 服务，无法确认会话的类型，不能绑定。'
    }
    const resolved = await this.host.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) return `找不到会话 ${sessionId}：${resolved.error.message}`
    if (presets.length === 0) return undefined
    const preset = this.presetOf(resolved.agent.session)
    if (preset === undefined || !presets.includes(preset)) {
      return `会话 ${sessionId} 的类型是「${preset ?? '未设置'}」，只能绑定到 ${presets.join('、')} 的会话。`
    }
    return undefined
  }

  /**
   * A session's preset, or undefined when it has none or it cannot be read.
   * `agentPresets.presetForSession` only exists from dsh 0.2.2-alpha.2. Older
   * hosts such as 0.2.1-rc.5 read the projection instead, which newer hosts
   * deprecate with a warning, so the registry goes first.
   */
  private presetOf(session: SessionLike): string | undefined {
    try {
      const registry = this.host.agentPresets()
      const preset: unknown = typeof registry?.presetForSession === 'function'
        ? registry.presetForSession(session)
        : this.host.sessionProjections?.()?.stateOf(session, 'agentPreset')
      return typeof preset === 'string' ? preset : undefined
    } catch (error) {
      this.host.logger.warn(`im-robot: could not read the preset of session ${session.id}: ${String(error)}`)
      return undefined
    }
  }

  /** A runtime for a stored binding, not yet receiving. */
  private newRuntime(stored: StoredBinding): Runtime {
    return { stored, awaiting: 0, chain: Promise.resolve(), flushing: false, connected: false, reportWaiters: [], awaitingMessage: false }
  }

  /** Whether a binding may send and receive: the global switch and its own are both on. */
  private isOn(runtime: Runtime): boolean {
    return this.enabled && runtime.stored.options.enabled
  }

  /** A binding's longest reply segment: its own limit, or the global one. */
  private replyLimitOf(runtime: Runtime): number {
    return runtime.stored.options.replyMaxChars ?? this.replyMaxChars
  }

  /** Reply text as the plain-text segments a binding sends. */
  private segmentsOf(runtime: Runtime, text: string): string[] {
    return splitReply(stripMarkdown(text), this.replyLimitOf(runtime))
  }

  /** Start the receive loop of a bound, enabled binding. */
  private startReceiving(runtime: Runtime): void {
    if (this.disposed || !this.isOn(runtime) || runtime.receiving !== undefined || runtime.stored.sessionId === undefined) return
    if (this.bindings.get(runtime.stored.bindingId) !== runtime) return
    const controller = new AbortController()
    runtime.receiving = controller
    const adapter = this.adapterOf(runtime.stored.channel)
    // Only this loop's reports count: a loop that a reconnect replaced may still report once on its way out.
    const link = this.linkOf(runtime, (connected, problem) => {
      if (runtime.receiving !== controller) return
      this.setHealth(runtime, connected, problem)
      for (const resolve of runtime.reportWaiters.splice(0)) resolve()
    })
    void adapter.receive(link, message => this.deliver(runtime, message, controller.signal), controller.signal)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        this.host.logger.warn(`im-robot: binding ${runtime.stored.bindingId} stopped receiving: ${String(error)}`)
        this.setHealth(runtime, false, PROBLEM.receiveStopped)
      })
      .finally(() => {
        if (runtime.receiving === controller) runtime.receiving = undefined
      })
  }

  /** Stop a binding's receive loop and indicator; it counts as not connected, with no error. */
  private stopRuntime(runtime: Runtime): void {
    runtime.receiving?.abort()
    runtime.receiving = undefined
    runtime.stopTyping?.()
    runtime.stopTyping = undefined
    runtime.awaiting = 0
    runtime.connected = false
    runtime.connectionError = undefined
    for (const resolve of runtime.reportWaiters.splice(0)) resolve()
  }

  /**
   * Record the receive loop's health; emit `im-robot/status` when the status
   * changed; after a successful poll, retry whatever the outbox still holds.
   */
  private setHealth(runtime: Runtime, connected: boolean, problem?: string): void {
    if (this.bindings.get(runtime.stored.bindingId) !== runtime) return
    const before = this.statusKey(runtime)
    runtime.connected = connected
    runtime.connectionError = connected ? undefined : problem
    if (this.statusKey(runtime) !== before) this.emitStatus(runtime.stored.bindingId)
    if (connected && runtime.stored.outbox.length > 0 && !runtime.awaitingMessage) this.flushOutbox(runtime)
  }

  /** Hand one accepted chat message to the bound session. */
  private async deliver(runtime: Runtime, message: InboundMessage, signal: AbortSignal): Promise<void> {
    const { bindingId, sessionId, channel } = runtime.stored
    if (signal.aborted || !this.isOn(runtime) || sessionId === undefined) return
    runtime.stored = {
      ...runtime.stored,
      lastInboundAt: Date.now(),
      ...(message.kind === 'text' ? { lastInputFromChat: true } : {}),
    }
    this.writeQuietly(runtime)
    if (runtime.awaitingMessage) {
      // The adapter stored this message's reply context before handing it over;
      // what waited goes out in it, not in the context that was refused.
      runtime.awaitingMessage = false
      this.replaceOutbox(runtime, runtime.stored.outbox.map(({ context: _refused, ...entry }) => entry))
      this.flushOutbox(runtime)
    }
    if (message.kind === 'unsupported') {
      this.sendOnce(runtime, [NOTICE.unsupported], 'notice')
      return
    }
    try {
      await this.host.emitInbound(sessionId, channel)
    } catch (error) {
      this.host.logger.warn(`im-robot: an im-robot/inbound listener failed: ${String(error)}`)
    }
    if (signal.aborted) return
    const { sendMode, commands } = runtime.stored.options
    const line = message.text.trim()
    if (commands && line.startsWith('/') && await this.runCommand(runtime, sessionId, line, signal)) return
    if (signal.aborted) return
    runtime.awaiting += 1
    if (runtime.stopTyping === undefined) runtime.stopTyping = this.adapterOf(channel).startTyping(this.linkOf(runtime))
    try {
      const text: PromptPart = { type: 'text', text: message.text }
      const attached = message.files === undefined ? [] : await attachmentParts(message.files, sessionId, {
        attachments: this.host.attachments?.(),
        fileUploads: this.host.fileUploads?.(),
        warn: line => this.host.logger.warn(line),
      }, signal)
      if (signal.aborted) {
        this.settle(runtime, 1)
        return
      }
      const prompt = (content: PromptPart[]): Promise<unknown> => this.host.sessionController.prompt({
        requestId: requestIdFor(bindingId, randomUUID()),
        sessionId,
        // Steering an idle session would start a turn anyway; queueing it says so plainly.
        mode: sendMode === 'steer' && this.turns.running(sessionId) ? 'steer' : 'queue',
        content,
      }, signal)
      if (attached.length === 0) {
        await prompt([text])
      } else {
        try {
          await prompt([text, ...attached])
        } catch (error) {
          if (signal.aborted) throw error
          // A model without image input, or a refused attachment: the text alone still names every file.
          this.host.logger.warn(`im-robot: binding ${bindingId} sent the message without its attachments: ${String(error)}`)
          await prompt([text])
        }
      }
    } catch (error) {
      this.settle(runtime, 1)
      if (signal.aborted) return
      this.host.logger.warn(`im-robot: binding ${bindingId} could not prompt session ${sessionId}: ${String(error)}`)
      this.sendOnce(runtime, [NOTICE.promptFailed], 'notice')
    }
  }

  /**
   * Run a `/` line as a command of the bound session and reply with its
   * outcome through the outbox, as the web composer would run it.
   * @returns false when the host has no command registry or no command of
   *   that name, so the line is prompted as text (skills are invoked that way).
   */
  private async runCommand(runtime: Runtime, sessionId: string, line: string, signal: AbortSignal): Promise<boolean> {
    const registry = this.host.commands?.()
    if (registry === undefined) return false
    let resolved: Awaited<ReturnType<SessionControllerLike['resolveAgent']>>
    try {
      resolved = await this.host.sessionController.resolveAgent(sessionId)
    } catch {
      return false
    }
    if ('error' in resolved) return false
    const name = line.slice(1).split(/\s/u, 1)[0] ?? ''
    let text: string
    try {
      const execution = await registry.execute(resolved.agent, line, [], signal)
      if (execution === undefined) return false
      const { result } = execution
      text = result.kind === 'error' ? commandFailed(name, result.text) : result.text?.trim() ? result.text : commandDone(name)
    } catch (error) {
      if (signal.aborted) return true
      this.host.logger.warn(`im-robot: binding ${runtime.stored.bindingId} command /${name} failed: ${String(error)}`)
      text = commandFailed(name, error instanceof Error ? error.message : String(error))
    }
    if (signal.aborted) return true
    const segments = this.segmentsOf(runtime, text)
    this.enqueueReply(runtime, segments.length > 0 ? segments : [commandDone(name)])
    return true
  }

  /**
   * Reply to the chat messages a turn consumed, push a follow-up's or a
   * reminder's answer, or follow the caller's route for the turn.
   */
  private onTurnEnd(signal: Extract<TurnSignal, { kind: 'turn-end' }>): void {
    const answered = [...new Set(signal.bindings)]
    const { route } = signal
    // The caller's model said nothing on purpose: no reply, no routed text, no push, and no no-reply notice.
    const silent = this.isSilent(signal.text)
    // Files go whenever the turn was routed to the chat, whatever its text.
    const files = route?.chat === true ? [...route.files ?? []] : []
    for (const bindingId of answered) {
      const runtime = this.bindings.get(bindingId)
      if (runtime === undefined) continue
      this.settle(runtime, signal.bindings.filter(id => id === bindingId).length)
      if (runtime.stored.sessionId !== signal.sessionId) continue
      this.setLastInput(runtime, true)
      // Kept off the chat on purpose.
      if (route?.chat === false) continue
      // The caller answered through `send`, or said nothing on purpose: no text of this turn's own.
      const segments = signal.sent || silent ? [] : this.segmentsOf(runtime, signal.text)
      const notice = segments.length === 0 && files.length === 0 && !signal.sent && !silent ? [NOTICE.noReply] : []
      this.enqueueReply(runtime, [...segments, ...notice], route?.notBefore, files)
    }
    if (answered.length > 0 || route?.chat === false) return
    if (route?.chat === true) {
      for (const runtime of this.runtimesOf(signal.sessionId)) {
        if (!this.isOn(runtime)) continue
        // Routed on purpose: a turn that then wrote nothing sends nothing, not the no-reply notice.
        this.enqueueReply(runtime, silent ? [] : this.segmentsOf(runtime, signal.text), route.notBefore, files)
      }
      return
    }
    if (silent) return
    if (!(signal.followUp || signal.reminder) || this.options.autoPush === false) return
    for (const runtime of this.runtimesOf(signal.sessionId)) {
      if (!runtime.stored.lastInputFromChat) continue
      // A turn that stays silent on purpose sends nothing, not the no-reply notice.
      const segments = this.segmentsOf(runtime, signal.text)
      if (segments.length === 0) continue
      // A follow-up finishes what the account asked for earlier, so it is kept until sent, like a reply.
      if (signal.followUp) this.enqueueReply(runtime, segments)
      else this.sendOnce(runtime, segments, 'reminder')
    }
  }

  /** @returns whether a turn's text is the configured silent reply. */
  private isSilent(text: string): boolean {
    const marker = this.options.silentReply?.trim() ?? ''
    return marker !== '' && text.trim() === marker
  }

  /** Count `count` prompted messages as answered; clear "typing" when none is left. */
  private settle(runtime: Runtime, count: number): void {
    runtime.awaiting = Math.max(0, runtime.awaiting - count)
    if (runtime.awaiting === 0) {
      runtime.stopTyping?.()
      runtime.stopTyping = undefined
    }
  }

  /**
   * Write a reply's segments, then its files, to the outbox, not to go before
   * `notBefore` when given, then send what the outbox holds.
   */
  private enqueueReply(runtime: Runtime, segments: string[], notBefore?: number, files: readonly string[] = []): void {
    if (segments.length === 0 && files.length === 0) return
    const context = this.adapterOf(runtime.stored.channel).replyContext(this.linkOf(runtime))
    const createdAt = Date.now()
    const deferred = notBefore !== undefined && notBefore > createdAt ? { notBefore } : {}
    const entry = (text: string, file?: string): OutboxEntry => ({
      id: randomUUID(), text, ...(file === undefined ? {} : { file }), ...(context === undefined ? {} : { context }), createdAt, ...deferred, failures: 0,
    })
    const entries = [...segments.map(text => entry(text)), ...files.map(file => entry('', file))]
    runtime.stored = { ...runtime.stored, outbox: [...runtime.stored.outbox, ...entries] }
    this.writeQuietly(runtime)
    // While the account's next message is awaited, a try now would only be refused again.
    if (!runtime.awaitingMessage) this.flushOutbox(runtime)
  }

  /**
   * Send the outbox in order after anything already queued for the binding.
   * Entries older than {@link OUTBOX_MAX_AGE_MS} are dropped unsent; a failed
   * send counts against its entry and ends this flush, and an entry that has
   * failed more than {@link OUTBOX_MAX_FAILURES} times is dropped. Drops are
   * only logged.
   */
  private flushOutbox(runtime: Runtime): void {
    if (runtime.flushing) return
    runtime.flushing = true
    const adapter = this.adapterOf(runtime.stored.channel)
    const link = this.linkOf(runtime)
    const live = (): boolean => this.isOn(runtime) && !this.disposed && this.bindings.get(runtime.stored.bindingId) === runtime
    const label = `im-robot: binding ${runtime.stored.bindingId}`
    this.enqueue(runtime, async () => {
      try {
        while (live()) {
          const now = Date.now()
          const fresh = runtime.stored.outbox.filter(entry => now - (entry.notBefore ?? entry.createdAt) <= OUTBOX_MAX_AGE_MS)
          if (fresh.length < runtime.stored.outbox.length) {
            this.host.logger.warn(`${label} dropped ${runtime.stored.outbox.length - fresh.length} unsent reply segment(s) older than 24 h`)
            this.replaceOutbox(runtime, fresh)
          }
          // A held entry waits for its moment without holding back the ones behind it.
          const entry = fresh.find(item => item.notBefore === undefined || item.notBefore <= now)
          if (entry === undefined) {
            this.setSendError(runtime, undefined)
            return
          }
          try {
            if (entry.file === undefined) await adapter.send(link, entry.text, entry.context)
            else if (adapter.sendFile === undefined) throw new UnsendableFileError(`${adapter.channel} cannot send files`)
            else await adapter.sendFile(link, entry.file, entry.context)
          } catch (error) {
            if (!live()) return
            this.noteFailure(runtime, error)
            if (error instanceof UnsendableFileError) {
              // Trying again cannot help this file; the entries behind it go on.
              this.host.logger.warn(`${label} dropped a file it cannot send (${basename(entry.file ?? '')}): ${error.message}`)
              this.replaceOutbox(runtime, runtime.stored.outbox.filter(item => item.id !== entry.id))
              continue
            }
            if (entry.context === undefined && adapter.replyContext(link) === undefined) {
              // Nothing wrong with this entry: the account has not written yet, and its first message brings a context.
              this.host.logger.warn(`${label} has no reply context yet, so the outbox waits for the account's first message: ${String(error)}`)
              runtime.awaitingMessage = true
              return
            }
            if (this.refusedUntilMessage(runtime, error)) {
              // Retrying cannot help; the account's next message reopens the chat, and the outbox goes out then.
              this.host.logger.warn(`${label} was refused until the account writes again, so the outbox waits for its next message: ${String(error)}`)
              runtime.awaitingMessage = true
              this.setSendError(runtime, PROBLEM.waitingForMessage)
              return
            }
            const failures = entry.failures + 1
            if (failures > OUTBOX_MAX_FAILURES) {
              this.host.logger.warn(`${label} dropped a reply segment after ${failures} failed sends: ${String(error)}`)
              this.replaceOutbox(runtime, runtime.stored.outbox.filter(item => item.id !== entry.id))
              this.setSendError(runtime, PROBLEM.dropped)
            } else {
              this.host.logger.warn(`${label} reply send failed (${failures}/${OUTBOX_MAX_FAILURES + 1}), kept in the outbox: ${String(error)}`)
              this.replaceOutbox(runtime, runtime.stored.outbox.map(item => (item.id === entry.id ? { ...item, failures } : item)))
              this.setSendError(runtime, PROBLEM.sendFailed)
            }
            return
          }
          // It went out, so a binding switched off meanwhile must not send it again later.
          runtime.stored = { ...runtime.stored, lastOutboundAt: Date.now() }
          this.replaceOutbox(runtime, runtime.stored.outbox.filter(item => item.id !== entry.id))
        }
      } finally {
        runtime.flushing = false
      }
    })
  }

  /**
   * Whether a failed send can only go through after the account's next
   * message: the adapter said so, or the platform's reply window has closed
   * since the account last wrote.
   */
  private refusedUntilMessage(runtime: Runtime, error: unknown): boolean {
    if (error instanceof ChatRefusedError) return true
    const window = this.adapterOf(runtime.stored.channel).replyWindowMs
    const last = runtime.stored.lastInboundAt
    return window !== undefined && last !== undefined && Date.now() - last >= window
  }

  /** Keep the latest failed send in the state file, so it can be read after a restart. */
  private noteFailure(runtime: Runtime, error: unknown): void {
    const text = error instanceof Error ? error.message : String(error)
    runtime.stored = { ...runtime.stored, lastSendFailure: { at: Date.now(), error: text.slice(0, 300) } }
    this.writeQuietly(runtime)
  }

  /**
   * Queue outgoing work behind what the binding already has queued. A failure
   * that escapes is logged: it must neither block later messages nor reach
   * the host as an unhandled rejection.
   */
  private enqueue(runtime: Runtime, task: () => Promise<void>): void {
    runtime.chain = runtime.chain.then(task).catch((error: unknown) => {
      this.host.logger.warn(`im-robot: binding ${runtime.stored.bindingId} outgoing messages failed: ${String(error)}`)
    })
  }

  /** Replace the outbox and persist it. */
  private replaceOutbox(runtime: Runtime, outbox: OutboxEntry[]): void {
    runtime.stored = { ...runtime.stored, outbox }
    this.writeQuietly(runtime)
  }

  /** Set or clear the outbox problem, emitting a status change when it changed. */
  private setSendError(runtime: Runtime, problem: string | undefined): void {
    if (runtime.sendError === problem) return
    const before = this.statusKey(runtime)
    runtime.sendError = problem
    if (this.statusKey(runtime) !== before) this.emitStatus(runtime.stored.bindingId)
  }

  /**
   * Send segments once, in order after anything already queued for the
   * binding, without the outbox: notices and reminder pushes. A failure is
   * logged and ends the batch; nothing is retried.
   */
  private sendOnce(runtime: Runtime, segments: string[], purpose: 'reminder' | 'notice'): void {
    const adapter = this.adapterOf(runtime.stored.channel)
    const link = this.linkOf(runtime)
    this.enqueue(runtime, async () => {
      for (const segment of segments) {
        if (!this.isOn(runtime) || this.bindings.get(runtime.stored.bindingId) !== runtime) return
        try {
          await adapter.send(link, segment)
        } catch (error) {
          const what = purpose === 'reminder' ? 'reminder push (not retried)' : 'notice'
          this.host.logger.warn(`im-robot: binding ${runtime.stored.bindingId} ${what} failed: ${String(error)}`)
          return
        }
        runtime.stored = { ...runtime.stored, lastOutboundAt: Date.now() }
        this.writeQuietly(runtime)
      }
    })
  }

  /** Record whether the session's latest human input came from this chat account. */
  private setLastInput(runtime: Runtime, fromChat: boolean): void {
    if (runtime.stored.lastInputFromChat === fromChat) return
    if (this.bindings.get(runtime.stored.bindingId) !== runtime) return
    runtime.stored = { ...runtime.stored, lastInputFromChat: fromChat }
    this.writeQuietly(runtime)
  }

  /**
   * The adapter's view of one binding.
   * @param report - where health reports go; by default straight to {@link setHealth}.
   */
  private linkOf(runtime: Runtime, report?: ChannelLink['report']): ChannelLink {
    const { bindingId, channel } = runtime.stored
    const mediaFolder = join(this.options.store.directory, 'media', bindingId)
    return {
      bindingId,
      get state() { return runtime.stored.channelState },
      get mediaDir() { return runtime.stored.options.mediaDir ?? mediaFolder },
      update: async (patch) => {
        if (this.bindings.get(bindingId) !== runtime) return
        runtime.stored = { ...runtime.stored, channelState: { ...runtime.stored.channelState, ...patch } }
        this.options.store.write(runtime.stored)
      },
      token: async () => (await this.host.credentials.resolve(this.refOf(channel, bindingId)))?.value,
      report: report ?? ((connected, problem) => this.setHealth(runtime, connected, problem)),
      logger: this.host.logger,
    }
  }

  /** Persist a binding, logging instead of throwing. */
  private writeQuietly(runtime: Runtime): void {
    if (this.bindings.get(runtime.stored.bindingId) !== runtime) return
    try {
      this.options.store.write(runtime.stored)
    } catch (error) {
      this.host.logger.warn(`im-robot: could not save the state of binding ${runtime.stored.bindingId}: ${String(error)}`)
    }
  }

  /** Bindings currently bound to a session. */
  private runtimesOf(sessionId: string): Runtime[] {
    return [...this.bindings.values()].filter(runtime => runtime.stored.sessionId === sessionId)
  }

  private adapterOf(channel: Channel): ChannelAdapter {
    const adapter = this.adapters.get(channel)
    if (adapter === undefined) throw new TypeError(`im-robot: unsupported channel ${JSON.stringify(channel)}`)
    return adapter
  }

  private refOf(channel: Channel, bindingId: string): string {
    return this.host.credentialRef(credentialName(channel, bindingId))
  }

  /** A comparable snapshot of what `status()` would report for a runtime, without the message time stamps. */
  private statusKey(runtime: Runtime): string {
    const { lastInboundAt, lastOutboundAt, ...rest } = this.status(runtime.stored.bindingId)
    return JSON.stringify(rest)
  }

  private emitStatus(bindingId: string): void {
    try {
      this.host.emitStatus(bindingId, this.status(bindingId))
    } catch (error) {
      this.host.logger.warn(`im-robot: an im-robot/status listener failed: ${String(error)}`)
    }
  }
}
