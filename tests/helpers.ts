import { mkdtempSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WechatAdapter } from '../src/channels/wechat/index.ts'
import type { QrStatusResponse, WeixinMessage } from '../src/channels/wechat/api.ts'
import type { MonitorTiming } from '../src/channels/wechat/monitor.ts'
import { DEFAULT_REPLY_MAX_CHARS, ImRobot } from '../src/service.ts'
import type { ServiceHost } from '../src/service.ts'
import { BindingStore } from '../src/store.ts'
import type { BindingStatus, CommandExecutionLike, PromptPart, SessionEventLike } from '../src/types.ts'

/** A fresh canonical temporary directory. */
export function tempDir(prefix = 'im-robot-'): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
}

/** Resolve once `check` holds, polling every few milliseconds. */
export async function until(check: () => boolean, timeoutMs = 3000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(5)
  }
}

/** Wait a fixed time. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The scanner's iLink user id in every spec. */
export const OWNER = 'owner123456@im.wechat'
/** Someone else. */
export const STRANGER = 'stranger999@im.wechat'
/** The bot token the fake server issues. */
export const TOKEN = 'bot-token-1'

/** One request the fake server received. */
export interface Call {
  endpoint: string
  query: URLSearchParams
  headers: IncomingHttpHeaders
  body: any
}

/**
 * A fake iLink server on 127.0.0.1. Login status answers come from a queue
 * (`wait` once empty); getupdates holds briefly for queued batches and hands
 * out cursors `buf-1`, `buf-2`, ...; sendmessage can be told to fail, to
 * refuse a stale context token, or to refuse everything; getconfig
 * answers `ok`, a stale token, or HTTP 500.
 */
export async function fakeIlink() {
  const calls: Call[] = []
  const qrStatuses: QrStatusResponse[] = []
  const batches: WeixinMessage[][] = []
  /** What the fake CDN serves, by `encrypted_query_param`. */
  const cdn = new Map<string, Buffer>()
  const state = {
    codes: 0, cursor: 0, failQr: false, failSend: false, stale: 0, failUpdates: 0,
    /** How many sendmessage calls carrying a context token answer that the chat's session went stale. */
    staleSend: 0,
    /** Answer every sendmessage `-2`, with a context token or without: the chat takes nothing until the person writes. */
    refuseSend: false,
    /** How long an empty getupdates is held. */
    holdMs: 40,
    /** How long a sendmessage is held after it was recorded. */
    sendHoldMs: 0,
    config: 'ok' as 'ok' | 'stale' | 'error',
  }
  let wake: (() => void) | undefined

  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://fake')
        const endpoint = url.pathname.slice(1)
        const body = raw === '' ? undefined : JSON.parse(raw)
        calls.push({ endpoint, query: url.searchParams, headers: request.headers, body })
        const reply = (status: number, value: unknown) => {
          response.writeHead(status, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify(value))
        }
        switch (endpoint) {
          case 'ilink/bot/get_bot_qrcode':
            if (state.failQr) return reply(500, { error: 'down' })
            state.codes += 1
            return reply(200, { qrcode: `code-${state.codes}`, qrcode_img_content: `https://liteapp.weixin.qq.com/q/${state.codes}` })
          case 'ilink/bot/get_qrcode_status':
            return reply(200, qrStatuses.shift() ?? { status: 'wait' })
          case 'ilink/bot/getupdates': {
            if (state.failUpdates > 0) {
              state.failUpdates -= 1
              return reply(502, { error: 'bad gateway' })
            }
            if (state.stale > 0) {
              state.stale -= 1
              return reply(200, { ret: -14, errcode: -14, errmsg: 'session timeout' })
            }
            if (batches.length === 0) {
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, state.holdMs)
                wake = () => { clearTimeout(timer); resolve() }
              })
              wake = undefined
            }
            const msgs = batches.shift()
            if (msgs === undefined) return reply(200, { ret: 0, msgs: [], get_updates_buf: body?.get_updates_buf ?? '' })
            state.cursor += 1
            return reply(200, { ret: 0, msgs, get_updates_buf: `buf-${state.cursor}` })
          }
          case 'ilink/bot/sendmessage':
            if (state.sendHoldMs > 0) await sleep(state.sendHoldMs)
            if (state.failSend) return reply(500, { error: 'send failed' })
            if (state.refuseSend) return reply(200, { ret: -2, errmsg: 'prepare failed' })
            if (state.staleSend > 0 && body?.msg?.context_token !== undefined) {
              state.staleSend -= 1
              return reply(200, { ret: -2, errmsg: 'prepare failed' })
            }
            return reply(200, { ret: 0 })
          case 'ilink/bot/getconfig':
            if (state.config === 'error') return reply(500, { error: 'down' })
            if (state.config === 'stale') return reply(200, { ret: -14, errcode: -14, errmsg: 'session timeout' })
            return reply(200, { ret: 0, typing_ticket: 'ticket-1' })
          case 'ilink/bot/sendtyping':
            return reply(200, { ret: 0 })
          case 'c2c/download': {
            const bytes = cdn.get(url.searchParams.get('encrypted_query_param') ?? '')
            if (bytes === undefined) return reply(404, {})
            response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
            response.end(bytes)
            return undefined
          }
          default:
            return reply(404, {})
        }
      })()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    cdnBaseUrl: `http://127.0.0.1:${port}/c2c`,
    cdn,
    calls,
    qrStatuses,
    state,
    /** Queue one getupdates batch. */
    push(...msgs: WeixinMessage[]) {
      batches.push(msgs)
      wake?.()
    },
    /** Requests to one endpoint. */
    to(endpoint: string): Call[] {
      return calls.filter(call => call.endpoint === `ilink/bot/${endpoint}`)
    },
    /** Texts sent with sendmessage, in order. */
    sent(): string[] {
      return calls.filter(call => call.endpoint === 'ilink/bot/sendmessage').map(call => call.body.msg.item_list[0].text_item.text as string)
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

export type FakeIlink = Awaited<ReturnType<typeof fakeIlink>>

/** A login confirmation for {@link OWNER}. */
export function confirmed(): QrStatusResponse {
  return { status: 'confirmed', bot_token: TOKEN, ilink_bot_id: 'bot-1@im.bot', ilink_user_id: OWNER }
}

/** A private text message from `from`. */
export function textFrom(from: string, text: string, contextToken = 'ctx-1'): WeixinMessage {
  return { from_user_id: from, to_user_id: 'bot-1@im.bot', message_type: 1, item_list: [{ type: 1, text_item: { text } }], context_token: contextToken }
}

/** A fake command handler: a result, or a throw. */
export type FakeCommand = (rawInput: string) => CommandExecutionLike['result']

/**
 * A fake host: in-memory credentials, a recording session controller, presets
 * per session, and a command registry whose commands a spec puts in
 * `control.commands` (`control.noRegistry` hides the registry). Presets read
 * like the current host by default, through `agentPresets.presetForSession`;
 * `control.presetApi` switches to a host like 0.2.1-rc.5, whose registry lacks
 * that method and which reads the `agentPreset` projection, or to neither.
 */
export function fakeHost(presets: Record<string, string | null> = {}) {
  const secrets = new Map<string, string>()
  const prompts: { requestId: string; sessionId: string; mode: string; content: (PromptPart & { text?: string; data?: string; mediaType?: string; name?: string; receiptId?: string })[] }[] = []
  /** Files uploaded through the fake `fileUploads`, with the bytes read from each stream. */
  const uploads: { sessionId: string; name?: string; bytes: Buffer; receiptId: string }[] = []
  const order: string[] = []
  const warnings: string[] = []
  const statuses: [string, BindingStatus][] = []
  const control = {
    inboundDelayMs: 0,
    failPrompt: false,
    commands: {} as Record<string, FakeCommand>,
    noRegistry: false,
    presetApi: 'registry' as 'registry' | 'projection' | 'none',
    failPresetRead: false,
    /** Offer `attachments` and `fileUploads`, as hosts since 0.2.2 do. */
    attachments: false,
    /** Refuse a prompt carrying anything but text, as for a model without image input. */
    refuseAttachments: false,
  }
  const projectionReads: string[] = []
  const readPreset = (session: { id: string }): string | null => {
    if (control.failPresetRead) throw new Error('preset read failed')
    return presets[session.id] ?? null
  }
  const commandRuns: { sessionId: string; line: string }[] = []
  const host: ServiceHost = {
    credentials: {
      resolve: async ref => (secrets.has(ref) ? { value: secrets.get(ref) as string } : undefined),
      set: async (ref, value) => { secrets.set(ref, value) },
      unset: async (ref) => { secrets.delete(ref) },
    },
    sessionController: {
      prompt: async (request) => {
        order.push(`prompt:${request.sessionId}`)
        if (control.failPrompt) throw new Error('agent busy')
        if (control.refuseAttachments && request.content.some(part => part.type !== 'text')) throw new Error('model does not support image input')
        prompts.push(request)
        return { accepted: true }
      },
      resolveAgent: async sessionId => (sessionId in presets ? { agent: { session: { id: sessionId } } } : { error: { message: 'no such session' } }),
    },
    agentPresets: () => {
      if (control.presetApi === 'none') return undefined
      return control.presetApi === 'registry' ? { presetForSession: readPreset } : {}
    },
    sessionProjections: () => (control.presetApi === 'none' ? undefined : {
      stateOf: (session, key) => {
        projectionReads.push(key)
        return key === 'agentPreset' ? readPreset(session) : undefined
      },
    }),
    attachments: () => (control.attachments ? {
      imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 2, maxMessageImageBytes: 4096, mediaTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] },
    } : undefined),
    fileUploads: () => (control.attachments ? {
      uploadStream: async (request) => {
        const chunks: Buffer[] = []
        for await (const chunk of request.data) chunks.push(Buffer.from(chunk))
        const receiptId = `receipt-${uploads.length + 1}`
        uploads.push({ sessionId: request.sessionId, ...(request.name === undefined ? {} : { name: request.name }), bytes: Buffer.concat(chunks), receiptId })
        return { receiptId }
      },
    } : undefined),
    logger: { info: () => undefined, warn: message => { warnings.push(message) } },
    credentialRef: value => credentialRef(value),
    emitStatus: (bindingId, state) => { statuses.push([bindingId, state]) },
    emitInbound: async (sessionId, channel) => {
      order.push(`inbound-start:${sessionId}:${channel}`)
      if (control.inboundDelayMs > 0) await sleep(control.inboundDelayMs)
      order.push(`inbound-end:${sessionId}`)
    },
    commands: () => (control.noRegistry ? undefined : {
      execute: async (agent, line) => {
        const match = /^\/([a-z][a-z0-9_-]*)(?=$|\s)/u.exec(line)
        const command = match === null ? undefined : control.commands[match[1]!]
        if (match === null || command === undefined) return undefined
        commandRuns.push({ sessionId: agent.session.id, line })
        order.push(`command:${line}`)
        return { result: command(line.slice(match[0].length)) }
      },
    }),
  }
  return { host, secrets, prompts, uploads, order, warnings, statuses, control, commandRuns, presets, projectionReads }
}

export type FakeHost = ReturnType<typeof fakeHost>

/** A service wired to the fake server with short timings. */
export function makeService(server: FakeIlink, host: FakeHost, options: {
  directory?: string
  presets?: string[]
  replyMaxChars?: number
  monitor?: Partial<MonitorTiming>
  reconnectWaitMs?: number
  autoPush?: boolean
  silentReply?: string
  mediaMaxBytes?: number
} = {}) {
  const directory = options.directory ?? tempDir()
  const store = new BindingStore(directory)
  const service = new ImRobot(host.host, {
    presets: options.presets ?? [],
    replyMaxChars: options.replyMaxChars ?? DEFAULT_REPLY_MAX_CHARS,
    store,
    adapters: [new WechatAdapter({
      baseUrl: server.baseUrl,
      login: { pollDelayMs: 2 },
      monitor: { longPollMs: 2000, retryDelayMs: 10, maxRetryDelayMs: 40, stalePauseMs: 50, ...options.monitor },
      typing: { keepaliveMs: 30 },
      probeTimeoutMs: 500,
      cdnBaseUrl: server.cdnBaseUrl,
      ...(options.mediaMaxBytes === undefined ? {} : { mediaMaxBytes: options.mediaMaxBytes }),
    })],
    ...(options.autoPush === undefined ? {} : { autoPush: options.autoPush }),
    ...(options.silentReply === undefined ? {} : { silentReply: options.silentReply }),
    ...(options.reconnectWaitMs === undefined ? {} : { reconnectWaitMs: options.reconnectWaitMs }),
  })
  return { service, store, directory }
}

/** Run a whole login and collect its states. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const states: T[] = []
  for await (const state of iterable) states.push(state)
  return states
}

/** Log in `bindingId` against the fake server and bind it to `sessionId`. */
export async function loginAndBind(service: ImRobot, server: FakeIlink, bindingId: string, sessionId: string): Promise<void> {
  server.qrStatuses.push({ status: 'scaned' }, confirmed())
  const states = await collect(service.login(bindingId, 'wechat'))
  if (states.at(-1)?.status !== 'bound') throw new Error(`login ended with ${JSON.stringify(states.at(-1))}`)
  await service.bind(bindingId, { sessionId })
}

/** Feed one complete turn into the service, as the host would emit it. */
export function runTurn(service: ImRobot, sessionId: string, input: { source: Record<string, unknown> }[], reply: string, reason = 'completed'): void {
  const events: SessionEventLike[] = [
    { type: 'turn/start', data: { turn: 1 } },
    ...input.map(message => ({ type: 'user/message', data: { id: 'm', role: 'user', content: [], ...message } })),
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: reason } } },
  ]
  for (const event of events) service.observe(sessionId, event)
}
