import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OWNER, collect, confirmed, fakeHost, fakeIlink, loginAndBind, makeService, runTurn, sleep, textFrom, until } from './helpers.ts'
import type { FakeHost, FakeIlink } from './helpers.ts'
import type { ImRobot } from '../src/service.ts'
import type { BindingStore } from '../src/store.ts'

const fromPrompt = (requestId: string) => ({ type: 'user/message', data: { source: { kind: 'user', rpcId: requestId } } })
const answer = (text: string) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })

describe('per-binding options', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  let store: BindingStore
  const stored = () => JSON.parse(readFileSync(store.pathOf('mom'), 'utf8'))
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
    ;({ service, store } = makeService(server, host))
    await loginAndBind(service, server, 'mom', 's1')
    await until(() => service.status('mom').connected, 3000, 'connected')
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('default to queue and commands, and are reported for unknown bindings too', () => {
    expect(service.status('mom')).toMatchObject({ sendMode: 'queue', commands: true, enabled: true, replyMaxChars: 100 })
    expect(service.status('nobody')).toEqual({ bound: false, connected: false, sendMode: 'queue', commands: true, enabled: true, replyMaxChars: 100 })
    expect(stored().options).toEqual({ sendMode: 'queue', commands: true, enabled: true })
  })

  it('are persisted, reported, and emitted once per change', () => {
    const before = host.statuses.length
    expect(service.setBindingOptions('mom', { sendMode: 'steer' })).toMatchObject({ sendMode: 'steer', commands: true })
    expect(service.setBindingOptions('mom', { commands: false })).toMatchObject({ sendMode: 'steer', commands: false })
    service.setBindingOptions('mom', { sendMode: 'steer', commands: false })
    service.setBindingOptions('mom', {})
    expect(stored().options).toEqual({ sendMode: 'steer', commands: false, enabled: true })
    expect(host.statuses.slice(before).map(([, state]) => [state.sendMode, state.commands])).toEqual([['steer', true], ['steer', false]])
  })

  it('keep enabled and replyMaxChars the same way', () => {
    const before = host.statuses.length
    expect(service.setBindingOptions('mom', { replyMaxChars: 40 })).toMatchObject({ enabled: true, replyMaxChars: 40 })
    expect(service.setBindingOptions('mom', { enabled: false })).toMatchObject({ enabled: false, replyMaxChars: 40 })
    expect(stored().options).toEqual({ sendMode: 'queue', commands: true, enabled: false, replyMaxChars: 40 })
    // The switch stops the connection, and that lands in the same status change.
    expect(host.statuses.slice(before).map(([, state]) => [state.enabled, state.replyMaxChars, state.connected]))
      .toEqual([[true, 40, true], [false, 40, false]])
  })

  it('write nothing and emit nothing when nothing changed, so a caller answering a status cannot loop', () => {
    service.setBindingOptions('mom', { sendMode: 'steer', commands: false, enabled: true, replyMaxChars: 40 })
    const write = vi.spyOn(store, 'write')
    const before = host.statuses.length
    const status = service.status('mom')
    expect(service.setBindingOptions('mom', { sendMode: 'steer', commands: false, enabled: true, replyMaxChars: 40 })).toEqual(status)
    expect(service.setBindingOptions('mom', {})).toEqual(status)
    expect(service.setBindingOptions('mom', { replyMaxChars: 40 })).toEqual(status)
    expect(write).not.toHaveBeenCalled()
    expect(host.statuses.length).toBe(before)
  })

  it('pin a limit equal to the global one once, without a status change, and stop following the global one', () => {
    const write = vi.spyOn(store, 'write')
    const before = host.statuses.length
    service.setBindingOptions('mom', { replyMaxChars: 100 })
    service.setBindingOptions('mom', { replyMaxChars: 100 })
    expect(write).toHaveBeenCalledTimes(1)
    expect(stored().options.replyMaxChars).toBe(100)
    expect(host.statuses.length).toBe(before)
    service.setOptions({ replyMaxChars: 50 })
    expect(service.status('mom').replyMaxChars).toBe(100)
  })

  it('reject bad enabled and replyMaxChars values by the same rules as the global ones', () => {
    for (const replyMaxChars of [9, 20.5, Number.NaN, '100', 0, -20]) {
      expect(() => service.setBindingOptions('mom', { replyMaxChars: replyMaxChars as never }), String(replyMaxChars)).toThrow(RangeError)
      expect(() => service.setOptions({ replyMaxChars: replyMaxChars as never }), String(replyMaxChars)).toThrow(RangeError)
    }
    for (const enabled of ['no', 0, 1, null]) {
      expect(() => service.setBindingOptions('mom', { enabled: enabled as never }), String(enabled)).toThrow(TypeError)
      expect(() => service.setOptions({ enabled: enabled as never }), String(enabled)).toThrow(TypeError)
    }
    expect(service.setBindingOptions('mom', { replyMaxChars: 10 }).replyMaxChars).toBe(10)
    // A bad value in the same call changes nothing else.
    expect(() => service.setBindingOptions('mom', { commands: false, enabled: 'no' as never })).toThrow(TypeError)
    expect(() => service.setBindingOptions('dad', { enabled: false })).toThrow('还没有扫码')
    expect(service.status('mom')).toMatchObject({ commands: true, enabled: true, replyMaxChars: 10 })
  })

  it('reject bad values and bindings that never logged in', () => {
    expect(() => service.setBindingOptions('mom', { sendMode: 'loud' as never })).toThrow(RangeError)
    expect(() => service.setBindingOptions('mom', { commands: 'yes' as never })).toThrow(TypeError)
    expect(() => service.setBindingOptions('dad', { sendMode: 'steer' })).toThrow('还没有扫码')
    expect(() => service.setBindingOptions('../x', {})).toThrow(TypeError)
    expect(service.status('mom')).toMatchObject({ sendMode: 'queue', commands: true })
  })

  it('survive a new login and a restart, and go away with unbind', async () => {
    const options = { sendMode: 'steer', commands: false, enabled: false, replyMaxChars: 40 } as const
    service.setBindingOptions('mom', options)
    server.qrStatuses.push(confirmed())
    await collect(service.login('mom', 'wechat'))
    expect(service.status('mom')).toMatchObject(options)
    service.dispose()
    const restarted = makeService(server, host, { directory: store.directory })
    service = restarted.service
    service.start()
    expect(service.status('mom')).toMatchObject(options)
    await service.unbind('mom')
    expect(service.status('mom')).toMatchObject({ sendMode: 'queue', commands: true, enabled: true, replyMaxChars: 100 })
  })

  it('report message times without emitting a status change for them', async () => {
    const before = host.statuses.length
    const start = Date.now()
    server.push(textFrom(OWNER, '你好'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    expect(service.status('mom').lastInboundAt).toBeGreaterThanOrEqual(start)
    expect(service.status('mom').lastOutboundAt).toBeUndefined()
    service.observe('s1', { type: 'turn/start' })
    service.observe('s1', fromPrompt(host.prompts[0]!.requestId))
    service.observe('s1', answer('你好呀'))
    service.observe('s1', { type: 'turn/end' })
    await until(() => service.status('mom').lastOutboundAt !== undefined, 3000, 'sent')
    expect(service.status('mom').lastOutboundAt).toBeGreaterThanOrEqual(service.status('mom').lastInboundAt!)
    expect(stored()).toMatchObject({ lastInboundAt: expect.any(Number), lastOutboundAt: expect.any(Number) })
    expect(host.statuses.length).toBe(before)
  })
})

describe('switching one binding off', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  let store: BindingStore
  /** Let a poll the server is still holding for a stopped loop finish, so it cannot swallow the next batch. */
  const drain = () => sleep(60)
  const outbox = () => JSON.parse(readFileSync(store.pathOf('mom'), 'utf8')).outbox as unknown[]
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null, s2: null })
    ;({ service, store } = makeService(server, host))
    await loginAndBind(service, server, 'mom', 's1')
    await until(() => service.status('mom').connected, 3000, 'connected')
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('stops polling and prompting, then resumes when set back on', async () => {
    expect(service.setBindingOptions('mom', { enabled: false })).toMatchObject({ enabled: false, connected: false })
    await drain()
    const polls = server.to('getupdates').length
    server.push(textFrom(OWNER, '关着的时候发的'))
    await sleep(120)
    expect(server.to('getupdates').length).toBe(polls)
    expect(host.prompts).toEqual([])

    expect(service.setBindingOptions('mom', { enabled: true })).toMatchObject({ enabled: true })
    await until(() => host.prompts.length === 1, 3000, 'prompt after switching on')
    expect(host.prompts[0]!.content[0]!.text).toBe('关着的时候发的')
    expect(service.status('mom').connected).toBe(true)
  })

  it('leaves other bindings running', async () => {
    await loginAndBind(service, server, 'dad', 's2')
    await until(() => service.status('dad').connected, 3000, 'second binding connected')
    service.setBindingOptions('mom', { enabled: false })
    await drain()
    expect(service.status('dad')).toMatchObject({ enabled: true, connected: true })
    server.push(textFrom(OWNER, '给爸爸的'))
    await until(() => host.prompts.length === 1, 3000, 'prompt on the other binding')
    expect(host.prompts[0]!.sessionId).toBe('s2')
    runTurn(service, 's2', [fromPrompt(host.prompts[0]!.requestId).data], '好的。')
    await until(() => server.sent().length === 1, 3000, 'reply on the other binding')
  })

  it('makes reconnect a no-op and leaves the binding off', async () => {
    service.setBindingOptions('mom', { enabled: false })
    await drain()
    const polls = server.to('getupdates').length
    expect(await service.reconnect('mom')).toMatchObject({ bound: true, enabled: false, connected: false })
    await sleep(60)
    expect(server.to('getupdates').length).toBe(polls)
  })

  it('stays off across a new binding of the session, a new login, and a restart', async () => {
    service.setBindingOptions('mom', { enabled: false })
    await drain()
    const polls = server.to('getupdates').length
    await service.bind('mom', { sessionId: 's2' })
    server.qrStatuses.push(confirmed())
    await collect(service.login('mom', 'wechat'))
    service.dispose()
    ;({ service } = makeService(server, host, { directory: store.directory }))
    service.start()
    await sleep(60)
    expect(server.to('getupdates').length).toBe(polls)
    expect(service.status('mom')).toMatchObject({ sessionId: 's2', enabled: false, connected: false })
    service.setBindingOptions('mom', { enabled: true })
    await until(() => service.status('mom').connected, 3000, 'connected after switching on')
  })

  it('drops a message caught between the inbound listeners and the prompt, and clears typing', async () => {
    server.push(textFrom(OWNER, '第一条'))
    await until(() => host.prompts.length === 1, 3000, 'first prompt')
    await until(() => server.to('sendtyping').some(call => call.body.status === 1), 3000, 'typing')
    service.setBindingOptions('mom', { enabled: false })
    await until(() => server.to('sendtyping').some(call => call.body.status === 2), 3000, 'typing cleared')
    service.setBindingOptions('mom', { enabled: true })
    await until(() => service.status('mom').connected, 3000, 'connected again')
    host.control.inboundDelayMs = 80
    server.push(textFrom(OWNER, '第二条'))
    await until(() => host.order.filter(step => step === 'inbound-start:s1:wechat').length === 2, 3000, 'second inbound')
    service.setBindingOptions('mom', { enabled: false })
    await sleep(150)
    expect(host.prompts).toHaveLength(1)
  })

  it('keeps replies in the outbox while off and sends them once back on', async () => {
    server.push(textFrom(OWNER, '在吗'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    service.setBindingOptions('mom', { enabled: false })
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId).data], '在的。')
    await sleep(60)
    expect(server.sent()).toEqual([])
    expect(outbox()).toHaveLength(1)
    service.setBindingOptions('mom', { enabled: true })
    await until(() => server.sent().length === 1, 3000, 'reply after switching on')
    await until(() => outbox().length === 0, 3000, 'empty outbox')
    expect(server.sent()).toEqual(['在的。'])
  })

  it('sends no reminder while off, and does not save it for later', async () => {
    server.push(textFrom(OWNER, '在吗'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId).data], '在的。')
    await until(() => server.sent().length === 1, 3000, 'reply')
    service.setBindingOptions('mom', { enabled: false })
    runTurn(service, 's1', [{ source: { kind: 'schedule' } }], '该吃药了。')
    await sleep(60)
    service.setBindingOptions('mom', { enabled: true })
    await until(() => service.status('mom').connected, 3000, 'connected again')
    await sleep(60)
    expect(server.sent()).toEqual(['在的。'])
  })

  it('does not send a segment twice when switched off during its send', async () => {
    server.state.sendHoldMs = 80
    server.push(textFrom(OWNER, '在吗'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId).data], '在的。')
    await until(() => server.sent().length === 1, 3000, 'send under way')
    service.setBindingOptions('mom', { enabled: false })
    await until(() => outbox().length === 0, 3000, 'empty outbox')
    expect(service.status('mom').lastOutboundAt).toEqual(expect.any(Number))
    server.state.sendHoldMs = 0
    service.setBindingOptions('mom', { enabled: true })
    await until(() => service.status('mom').connected, 3000, 'connected again')
    await sleep(60)
    expect(server.sent()).toEqual(['在的。'])
  })

  it('runs only while the global switch and its own are both on', async () => {
    await loginAndBind(service, server, 'dad', 's2')
    await until(() => service.status('dad').connected, 3000, 'second binding connected')
    service.setBindingOptions('mom', { enabled: false })
    const before = host.statuses.filter(([id]) => id === 'mom').length

    service.setOptions({ enabled: false })
    // Only the global switch is off for dad: his own option still reads on, and he reports it did stop.
    expect(service.status('dad')).toMatchObject({ enabled: true, connected: false })
    expect(host.statuses.filter(([id]) => id === 'mom').length).toBe(before)
    await drain()
    const polls = server.to('getupdates').length

    service.setBindingOptions('mom', { enabled: true })
    expect(await service.reconnect('mom')).toMatchObject({ enabled: true, connected: false })
    await sleep(60)
    expect(server.to('getupdates').length).toBe(polls)
    service.setBindingOptions('mom', { enabled: false })

    service.setOptions({ enabled: true })
    await until(() => service.status('dad').connected, 3000, 'dad back on')
    await sleep(60)
    expect(service.status('mom')).toMatchObject({ enabled: false, connected: false })

    service.setBindingOptions('mom', { enabled: true })
    await until(() => service.status('mom').connected, 3000, 'mom back on')
  })
})

describe('a binding\'s own reply length', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  const TEXT = '第一句话说完了。第二句话也说完了。'
  const SPLIT = ['第一句话说完了。', '第二句话也说完了。']
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
    host.control.commands = { ddl: () => ({ kind: 'success', text: TEXT }) }
    ;({ service } = makeService(server, host))
    await loginAndBind(service, server, 'mom', 's1')
    await until(() => service.status('mom').connected, 3000, 'connected')
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('splits a reply by the binding\'s limit, not the global one', async () => {
    service.setBindingOptions('mom', { replyMaxChars: 12 })
    server.push(textFrom(OWNER, '说吧'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId).data], TEXT)
    await until(() => server.sent().length === 2, 3000, 'split reply')
    expect(server.sent()).toEqual(SPLIT)
  })

  it('splits a command\'s result by the binding\'s limit', async () => {
    service.setBindingOptions('mom', { replyMaxChars: 12 })
    server.push(textFrom(OWNER, '/ddl'))
    await until(() => server.sent().length === 2, 3000, 'split command result')
    expect(server.sent()).toEqual(SPLIT)
  })

  it('gives each binding of a session its own split of a follow-up', async () => {
    await loginAndBind(service, server, 'dad', 's1')
    await until(() => service.status('dad').connected, 3000, 'second binding connected')
    service.setBindingOptions('mom', { replyMaxChars: 12 })
    // One binding off at a time, so each receives a message and counts as the latest input.
    service.setBindingOptions('dad', { enabled: false })
    await sleep(60)
    server.push(textFrom(OWNER, '妈妈'))
    await until(() => host.prompts.length === 1, 3000, 'first prompt')
    service.setBindingOptions('mom', { enabled: false })
    service.setBindingOptions('dad', { enabled: true })
    await sleep(60)
    server.push(textFrom(OWNER, '爸爸'))
    await until(() => host.prompts.length === 2, 3000, 'second prompt')
    service.setBindingOptions('mom', { enabled: true })
    await until(() => service.status('mom').connected, 3000, 'first binding back on')
    runTurn(service, 's1', [{ source: { kind: 'subagent-settled' } }], TEXT)
    await until(() => server.sent().length === 3, 3000, 'three messages')
    expect([...server.sent()].sort()).toEqual([...SPLIT, TEXT].sort())
  })

  it('follows a global change only without a limit of its own, emitting only when the value moved', async () => {
    await loginAndBind(service, server, 'dad', 's1')
    service.setBindingOptions('mom', { replyMaxChars: 40 })
    const before = host.statuses.length
    service.setOptions({ replyMaxChars: 100 })
    expect(host.statuses.length).toBe(before)
    service.setOptions({ replyMaxChars: 50 })
    expect(host.statuses.slice(before).map(([id, state]) => [id, state.replyMaxChars])).toEqual([['dad', 50]])
    expect(service.status('mom').replyMaxChars).toBe(40)
    expect(service.status('nobody').replyMaxChars).toBe(50)
  })
})

describe('steering', () => {
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

  it('queues by default, even while a turn is running', async () => {
    service.observe('s1', { type: 'turn/start' })
    server.push(textFrom(OWNER, '还有一件事'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    expect(host.prompts[0]!.mode).toBe('queue')
  })

  it('steers a running turn, which then answers on the chat', async () => {
    service.setBindingOptions('mom', { sendMode: 'steer' })
    service.observe('s1', { type: 'turn/start' })
    server.push(textFrom(OWNER, '改成下午三点'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    expect(host.prompts[0]!.mode).toBe('steer')
    service.observe('s1', fromPrompt(host.prompts[0]!.requestId))
    service.observe('s1', answer('好，改成下午三点了。'))
    service.observe('s1', { type: 'turn/end' })
    await until(() => server.sent().length === 1, 3000, 'reply')
    expect(server.sent()).toEqual(['好，改成下午三点了。'])
  })

  it('queues while the session is idle', async () => {
    service.setBindingOptions('mom', { sendMode: 'steer' })
    service.observe('s1', { type: 'turn/start' })
    service.observe('s1', { type: 'turn/end' })
    server.push(textFrom(OWNER, '在吗'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    expect(host.prompts[0]!.mode).toBe('queue')
  })
})

describe('commands from the chat', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
    host.control.commands = {
      ddl: () => ({ kind: 'success', text: '**本周**\n- 周四 14:00 看牙医' }),
      compact: () => ({ kind: 'success' }),
      broken: () => ({ kind: 'error', text: '现在不能整理' }),
      boom: () => { throw new Error('handler crashed') },
    }
    ;({ service } = makeService(server, host))
    await loginAndBind(service, server, 'mom', 's1')
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('runs a known command instead of prompting, after the inbound event, and replies with its result', async () => {
    server.push(textFrom(OWNER, ' /ddl '))
    await until(() => server.sent().length === 1, 3000, 'command reply')
    expect(host.commandRuns).toEqual([{ sessionId: 's1', line: '/ddl' }])
    expect(host.prompts).toEqual([])
    expect(host.order).toEqual(['inbound-start:s1:wechat', 'inbound-end:s1', 'command:/ddl'])
    expect(server.sent()).toEqual(['本周\n· 周四 14:00 看牙医'])
    expect(server.to('sendmessage')[0]!.body.msg.context_token).toBe('ctx-1')
  })

  it('confirms a command without text and explains a failed one', async () => {
    server.push(textFrom(OWNER, '/compact'), textFrom(OWNER, '/broken now'), textFrom(OWNER, '/boom'))
    await until(() => server.sent().length === 3, 3000, 'command replies')
    expect(server.sent()).toEqual(['（已执行 /compact。）', '（/broken 没有执行成功：现在不能整理）', '（/boom 没有执行成功：handler crashed）'])
    expect(host.commandRuns.map(run => run.line)).toEqual(['/compact', '/broken now', '/boom'])
  })

  it('prompts unknown commands, which may be skills, as text', async () => {
    server.push(textFrom(OWNER, '/weekly-plan 下周'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    expect(host.prompts[0]!.content).toEqual([{ type: 'text', text: '/weekly-plan 下周' }])
    expect(host.commandRuns).toEqual([])
  })

  it('prompts every line as text when commands are off, or the host has no command registry', async () => {
    service.setBindingOptions('mom', { commands: false })
    server.push(textFrom(OWNER, '/ddl'))
    await until(() => host.prompts.length === 1, 3000, 'prompt with commands off')
    service.setBindingOptions('mom', { commands: true })
    host.control.noRegistry = true
    server.push(textFrom(OWNER, '/ddl'))
    await until(() => host.prompts.length === 2, 3000, 'prompt without a registry')
    expect(host.prompts.map(prompt => prompt.content[0]!.text)).toEqual(['/ddl', '/ddl'])
    expect(host.commandRuns).toEqual([])
  })

  it('counts a command as the latest input from the chat', async () => {
    server.push(textFrom(OWNER, '/ddl'))
    await until(() => server.sent().length === 1, 3000, 'command reply')
    service.observe('s1', { type: 'turn/start' })
    service.observe('s1', { type: 'user/message', data: { source: { kind: 'schedule' } } })
    service.observe('s1', answer('该出发了。'))
    service.observe('s1', { type: 'turn/end' })
    await until(() => server.sent().length === 2, 3000, 'reminder')
  })
})

describe('reconnect', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('restarts the poll at once with the backoff reset, and resolves after the first poll', async () => {
    ;({ service } = makeService(server, host, { monitor: { retryDelayMs: 60_000, maxRetryDelayMs: 60_000 } }))
    await loginAndBind(service, server, 'mom', 's1')
    await until(() => service.status('mom').connected, 3000, 'connected')
    server.state.failUpdates = 1
    await until(() => service.status('mom').lastError !== undefined, 3000, 'server error')
    // The loop now waits a minute before its next try.
    const polls = server.to('getupdates').length
    const status = await service.reconnect('mom')
    expect(status).toMatchObject({ bound: true, connected: true })
    expect(status.lastError).toBeUndefined()
    expect(server.to('getupdates').length).toBeGreaterThan(polls)
  })

  it('answers within the short first poll while the server holds a long one', async () => {
    server.state.holdMs = 5_000
    ;({ service } = makeService(server, host, { monitor: { firstPollMs: 100 } }))
    await loginAndBind(service, server, 'mom', 's1')
    const started = Date.now()
    expect(await service.reconnect('mom')).toMatchObject({ connected: true })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('keeps an expired login expired and never shows a new code', async () => {
    ;({ service } = makeService(server, host, { monitor: { stalePauseMs: 60_000 } }))
    await loginAndBind(service, server, 'mom', 's1')
    server.state.stale = 1_000
    await until(() => service.status('mom').lastError !== undefined, 3000, 'expired')
    const codes = server.to('get_bot_qrcode').length
    expect(await service.reconnect('mom')).toMatchObject({ connected: false, lastError: '微信登录已失效，请重新绑定' })
    expect(server.to('get_bot_qrcode')).toHaveLength(codes)
  })

  it('returns the status at once when there is nothing to poll, and rejects unknown bindings', async () => {
    ;({ service } = makeService(server, host))
    server.qrStatuses.push(confirmed())
    await collect(service.login('mom', 'wechat'))
    expect(await service.reconnect('mom')).toMatchObject({ bound: true, connected: false })
    expect(server.to('getupdates')).toHaveLength(0)
    await expect(service.reconnect('dad')).rejects.toThrow('还没有扫码')
  })

  it('gives up waiting after the configured time', async () => {
    server.state.holdMs = 5_000
    ;({ service } = makeService(server, host, { monitor: { firstPollMs: 4_000 }, reconnectWaitMs: 100 }))
    await loginAndBind(service, server, 'mom', 's1')
    const started = Date.now()
    expect(await service.reconnect('mom')).toMatchObject({ bound: true, connected: false })
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('diagnose', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  let store: BindingStore
  const labels = ['微信登录信息', '连接微信服务器', '微信登录状态', '绑定的会话', '待发的回复']
  const check = async (label: string) => (await service.diagnose('mom')).checks.find(item => item.label === label)
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: 'dsh-assisstant' })
    ;({ service, store } = makeService(server, host, { presets: ['dsh-assisstant'] }))
    await loginAndBind(service, server, 'mom', 's1')
    await until(() => service.status('mom').connected, 3000, 'connected')
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('passes a healthy binding with five plain-Chinese checks', async () => {
    const result = await service.diagnose('mom')
    expect(result).toEqual({ ok: true, checks: labels.map(label => ({ label, ok: true })) })
    expect(server.to('getconfig').at(-1)!.headers.authorization).toBe('Bearer bot-token-1')
  })

  it('clears lastError only when everything passes', async () => {
    service.dispose()
    ;({ service, store } = makeService(server, host, { presets: ['dsh-assisstant'], monitor: { retryDelayMs: 60_000, maxRetryDelayMs: 60_000 }, directory: store.directory }))
    service.start()
    await until(() => service.status('mom').connected, 3000, 'connected again')
    server.state.failUpdates = 1
    await until(() => service.status('mom').lastError !== undefined, 3000, 'server error')
    server.state.config = 'error'
    expect((await service.diagnose('mom')).ok).toBe(false)
    expect(service.status('mom').lastError).toBe('微信服务器暂时出错，正在自动重连')
    server.state.config = 'ok'
    const before = host.statuses.length
    expect((await service.diagnose('mom')).ok).toBe(true)
    expect(service.status('mom').lastError).toBeUndefined()
    expect(host.statuses.length).toBe(before + 1)
  })

  it('reports a stale token and a server error', async () => {
    server.state.config = 'stale'
    expect(await check('微信登录状态')).toEqual({ label: '微信登录状态', ok: false, detail: '微信登录已失效，请重新绑定' })
    server.state.config = 'error'
    expect(await check('连接微信服务器')).toEqual({ label: '连接微信服务器', ok: false, detail: '微信服务器出错（HTTP 500）' })
  })

  it('reports an unreachable server', async () => {
    await server.close()
    const result = await service.diagnose('mom')
    expect(result.ok).toBe(false)
    expect(result.checks[1]).toEqual({ label: '连接微信服务器', ok: false, detail: '连不上微信服务器' })
  })

  it('reports a missing credential', async () => {
    host.secrets.clear()
    const result = await service.diagnose('mom')
    expect(result.checks.slice(0, 3)).toEqual([
      { label: '微信登录信息', ok: false, detail: '没有找到微信登录信息，请重新扫码' },
      { label: '连接微信服务器', ok: true },
      { label: '微信登录状态', ok: false, detail: '没有登录信息，无法检查' },
    ])
  })

  it('reports a session that is gone or no longer allowed', async () => {
    host.presets.s1 = 'other'
    expect((await check('绑定的会话'))?.detail).toBe('会话 s1 的类型是「other」，只能绑定到 dsh-assisstant 的会话。')
    delete host.presets.s1
    expect((await check('绑定的会话'))?.detail).toContain('找不到会话 s1')
  })

  it('reports replies stuck in the outbox', async () => {
    server.state.holdMs = 1_000
    server.state.failSend = true
    server.push(textFrom(OWNER, '在吗'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    service.observe('s1', { type: 'turn/start' })
    service.observe('s1', fromPrompt(host.prompts[0]!.requestId))
    service.observe('s1', answer('在的'))
    service.observe('s1', { type: 'turn/end' })
    await until(() => server.to('sendmessage').length === 1, 3000, 'failed send')
    await sleep(20)
    expect(await check('待发的回复')).toEqual({
      label: '待发的回复', ok: false, detail: expect.stringMatching(/^还有 1 条回复没发出去，其中 1 条发送失败过，会在连上后自动补发（上次失败：.+，ilink\/bot\/sendmessage HTTP 500）$/u),
    })
  })

  it('changes nothing on disk', async () => {
    const before = readFileSync(store.pathOf('mom'), 'utf8')
    server.state.config = 'stale'
    await service.diagnose('mom')
    expect(readFileSync(store.pathOf('mom'), 'utf8')).toBe(before)
  })

  it('answers for a binding that is not logged in or not bound', async () => {
    expect(await service.diagnose('dad')).toEqual({ ok: false, checks: [{ label: '微信登录信息', ok: false, detail: '这个微信号还没有扫码连接，请先扫码。' }] })
    server.qrStatuses.push(confirmed())
    await collect(service.login('dad', 'wechat'))
    expect((await service.diagnose('dad')).checks[3]).toEqual({ label: '绑定的会话', ok: false, detail: '还没有绑定会话' })
  })
})
