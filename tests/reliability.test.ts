import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { monitorUpdates, retryDelay } from '../src/channels/wechat/monitor.ts'
import type { MonitorHealth } from '../src/channels/wechat/monitor.ts'
import type { ChannelAdapter, ChannelLink } from '../src/channels/adapter.ts'
import { ImRobot } from '../src/service.ts'
import { BindingStore } from '../src/store.ts'
import type { OutboxEntry, StoredBinding } from '../src/store.ts'
import { OWNER, fakeHost, fakeIlink, loginAndBind, makeService, runTurn, sleep, tempDir, textFrom, until } from './helpers.ts'
import type { FakeHost, FakeIlink } from './helpers.ts'

const quiet = { info: () => undefined, warn: () => undefined }
const fromPrompt = (requestId: string) => ({ source: { kind: 'user', rpcId: requestId } })
const EXPIRED = '微信登录已失效，请重新绑定'

/** A local port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

describe('reconnecting', () => {
  it('backs off exponentially up to five minutes', () => {
    const timing = { retryDelayMs: 2_000, maxRetryDelayMs: 300_000 }
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1000].map(failures => retryDelay(failures, timing)))
      .toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000, 300_000])
  })

  it('keeps retrying an unreachable server instead of leaving the loop', async () => {
    const port = await closedPort()
    const health: MonitorHealth[] = []
    const controller = new AbortController()
    const loop = monitorUpdates({
      baseUrl: `http://127.0.0.1:${port}`,
      cursor: '',
      token: async () => 'token',
      saveCursor: async () => undefined,
      handle: async () => undefined,
      report: state => health.push(state),
      logger: quiet,
      label: 'spec',
      timing: { longPollMs: 500, retryDelayMs: 2, maxRetryDelayMs: 8, stalePauseMs: 50 },
      signal: controller.signal,
    })
    await until(() => health.length >= 5, 3000, 'five failed polls')
    expect(new Set(health)).toEqual(new Set(['network']))
    controller.abort()
    await loop
  })

  it('treats a missing token as expired and keeps waiting for one', async () => {
    const health: MonitorHealth[] = []
    let asked = 0
    const controller = new AbortController()
    const loop = monitorUpdates({
      baseUrl: 'http://127.0.0.1:9',
      cursor: '',
      token: async () => { asked += 1; return undefined },
      saveCursor: async () => undefined,
      handle: async () => undefined,
      report: state => health.push(state),
      logger: quiet,
      label: 'spec',
      timing: { longPollMs: 500, retryDelayMs: 2, maxRetryDelayMs: 8, stalePauseMs: 5 },
      signal: controller.signal,
    })
    await until(() => asked >= 3, 3000, 'three token checks')
    expect(new Set(health)).toEqual(new Set(['expired']))
    controller.abort()
    await loop
  })
})

describe('connection status', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
    ;({ service } = makeService(server, host))
    await loginAndBind(service, server, 'mom', 's1')
    await until(() => service.status('mom').connected, 3000, 'connected')
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('reports server errors in plain words, reconnects, and clears them', async () => {
    server.state.failUpdates = 3
    await until(() => service.status('mom').connected === false, 3000, 'disconnected')
    expect(service.status('mom')).toMatchObject({ bound: true, connected: false, lastError: '微信服务器暂时出错，正在自动重连' })
    expect(host.statuses.some(([, state]) => state.lastError === '微信服务器暂时出错，正在自动重连')).toBe(true)
    await until(() => service.status('mom').connected, 3000, 'reconnected')
    expect(service.status('mom').lastError).toBeUndefined()
    expect(host.statuses.at(-1)?.[1]).toEqual({ bound: true, user: 'own***56@im.wechat', sessionId: 's1', connected: true, sendMode: 'queue', commands: true, enabled: true, replyMaxChars: 100 })
  })

  it('marks an expired login with a plain reason and emits it, and recovers if the server accepts the token again', async () => {
    server.state.stale = 1
    await until(() => service.status('mom').lastError === EXPIRED, 3000, 'expired')
    expect(service.status('mom')).toMatchObject({ bound: true, connected: false, lastError: EXPIRED })
    expect(host.statuses.some(([id, state]) => id === 'mom' && state.connected === false && state.lastError === EXPIRED)).toBe(true)
    await until(() => service.status('mom').connected, 3000, 'reconnected after the pause')
  })

  it('emits a status change only when the status changes', async () => {
    const before = host.statuses.length
    await sleep(200)
    expect(host.statuses.length).toBe(before)
  })
})

describe('the outbox', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  let store: BindingStore
  let directory: string
  const outbox = (): OutboxEntry[] => JSON.parse(readFileSync(store.pathOf('mom'), 'utf8')).outbox
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
    ;({ service, store, directory } = makeService(server, host))
    await loginAndBind(service, server, 'mom', 's1')
    server.push(textFrom(OWNER, 'hi', 'ctx-9'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('is empty again once a reply is sent', async () => {
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId)], '好的')
    await until(() => server.sent().length === 1, 3000, 'reply')
    await until(() => outbox().length === 0, 3000, 'outbox emptied')
  })

  it('keeps a failed reply on disk with its context_token and sends it after the next successful poll', async () => {
    server.state.failSend = true
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId)], '明天见')
    await until(() => outbox()[0]?.failures === 1, 3000, 'first failure on disk')
    expect(outbox()).toEqual([{ id: expect.any(String), text: '明天见', context: 'ctx-9', createdAt: expect.any(Number), failures: 1 }])
    expect(service.status('mom')).toMatchObject({ connected: true, lastError: '回复没能发到微信，会自动重试' })

    // A newer message moves the latest context on; the retry keeps the reply's own.
    server.push(textFrom(OWNER, 'again', 'ctx-new'))
    await until(() => host.prompts.length === 2, 3000, 'second prompt')
    server.state.failSend = false
    await until(() => server.sent().filter(text => text === '明天见').length === 2, 3000, 'retried')
    const retried = server.to('sendmessage').filter(call => call.body.msg.item_list[0].text_item.text === '明天见').at(-1)
    expect(retried?.body.msg.context_token).toBe('ctx-9')
    await until(() => outbox().length === 0, 3000, 'outbox emptied')
    await until(() => service.status('mom').lastError === undefined, 3000, 'error cleared')
  })

  it('drops a reply after more than three failures and only logs it', async () => {
    server.state.failSend = true
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId)], '这条发不出去')
    await until(() => host.warnings.some(message => message.includes('dropped a reply segment after 4 failed sends')), 3000, 'dropped')
    expect(server.to('sendmessage')).toHaveLength(4)
    expect(outbox()).toEqual([])
    expect(service.status('mom').lastError).toBe('有回复多次没能发到微信，已经放弃')
    await sleep(120)
    expect(server.to('sendmessage')).toHaveLength(4)
  })

  it('retries after a restart only what is under 24 hours old, with each entry\'s own context_token', async () => {
    service.dispose()
    const now = Date.now()
    const stored = JSON.parse(readFileSync(store.pathOf('mom'), 'utf8'))
    stored.outbox = [
      { id: 'old', text: '昨天的回复', context: 'ctx-old', createdAt: now - 25 * 60 * 60_000, failures: 0 },
      { id: 'a', text: '第一段', context: 'ctx-a', createdAt: now - 60 * 60_000, failures: 2 },
      { id: 'b', text: '第二段', context: 'ctx-a', createdAt: now - 60 * 60_000, failures: 0 },
    ]
    store.write(stored)

    const restarted = makeService(server, host, { directory })
    service = restarted.service
    service.start()
    await until(() => server.sent().includes('第二段'), 3000, 'outbox flushed after restart')
    const sent = server.to('sendmessage').map(call => [call.body.msg.item_list[0].text_item.text, call.body.msg.context_token])
    expect(sent).toEqual([['第一段', 'ctx-a'], ['第二段', 'ctx-a']])
    // The fake server records a send before the client sees the answer.
    await until(() => outbox().length === 0, 3000, 'outbox emptied')
    expect(host.warnings.some(message => message.includes('older than 24 h'))).toBe(true)
  })
})

describe('containing failures', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
    ;({ service } = makeService(server, host))
    await loginAndBind(service, server, 'mom', 's1')
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('logs a failure while following a session instead of throwing into the host, and keeps following', async () => {
    const bad = { get type(): string { throw new Error('a malformed event') } }
    expect(() => service.observe('s1', bad)).not.toThrow()
    expect(host.warnings.some(message => message.includes('could not follow session s1') && message.includes('a malformed event'))).toBe(true)

    server.push(textFrom(OWNER, 'hi'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId)], '还在')
    await until(() => server.sent().length === 1, 3000, 'reply')
    expect(server.sent()).toEqual(['还在'])
  })

  it('keeps sending after a failure escapes the outgoing queue', async () => {
    const warn = host.host.logger.warn
    let throwOnce = true
    host.host.logger.warn = (message) => {
      if (throwOnce && message.includes('reply send failed')) {
        throwOnce = false
        throw new Error('the logger broke')
      }
      warn(message)
    }
    server.state.failSend = true
    server.push(textFrom(OWNER, 'hi'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId)], '第一条')
    await until(() => host.warnings.some(message => message.includes('outgoing messages failed') && message.includes('the logger broke')), 3000, 'the escaped failure logged')
    server.state.failSend = false
    runTurn(service, 's1', [{ source: { kind: 'schedule' } }], '第二条')
    await until(() => server.sent().filter(text => text === '第二条').length === 1, 3000, 'later message sent')
  })

  it('starts the other bindings when one cannot start, without failing the plugin', () => {
    const binding = (bindingId: string, sessionId: string): StoredBinding => ({
      version: 1, bindingId, channel: 'wechat', user: 'x', sessionId, lastInputFromChat: false,
      channelState: {}, outbox: [], boundAt: 1, options: { sendMode: 'queue', commands: true },
    })
    const store = new BindingStore(tempDir())
    store.write(binding('bad', 's1'))
    store.write(binding('good', 's2'))
    const started: string[] = []
    const adapter = {
      channel: 'wechat',
      receive: (link: ChannelLink) => {
        if (link.bindingId === 'bad') throw new Error('cannot start')
        started.push(link.bindingId)
        return new Promise<void>(() => undefined)
      },
    } as unknown as ChannelAdapter
    const robot = new ImRobot(host.host, { presets: [], replyMaxChars: 100, store, adapters: [adapter] })
    expect(() => robot.start()).not.toThrow()
    expect(started).toEqual(['good'])
    expect(host.warnings.some(message => message.includes('binding bad could not start receiving'))).toBe(true)
    robot.dispose()
  })
})
