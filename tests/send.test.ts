import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OWNER, fakeHost, fakeIlink, loginAndBind, makeService, runTurn, sleep, textFrom, until } from './helpers.ts'
import type { FakeHost, FakeIlink } from './helpers.ts'
import type { ImRobot } from '../src/service.ts'
import type { BindingStore } from '../src/store.ts'

const fromPrompt = (requestId: string) => ({ source: { kind: 'user', rpcId: requestId } })

describe('send and autoPush', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  let store: BindingStore
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
    ;({ service, store } = makeService(server, host, { autoPush: false, replyMaxChars: 20 }))
    await loginAndBind(service, server, 'mom', 's1')
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('sends at any time, whoever spoke last, split and with <keep> whole', async () => {
    service.observe('s1', { type: 'user/message', data: { source: { kind: 'user', rpcId: 'web-1' } } })
    service.send('mom', '**今天**下午两点看牙医，别忘了带医保卡和病历本，路上小心。')
    await until(() => server.sent().length >= 2, 3000, 'segments')
    expect(server.sent().join('')).toBe('今天下午两点看牙医，别忘了带医保卡和病历本，路上小心。')
    const before = server.sent().length
    service.send('mom', '<keep>第一步打开冰箱，第二步放进大象，第三步关上门</keep>')
    await until(() => server.sent().length === before + 1, 3000, 'kept block')
    expect(server.sent().at(-1)).toBe('第一步打开冰箱，第二步放进大象，第三步关上门')
  })

  it('refuses when it cannot send, in words the caller can act on', async () => {
    expect(() => service.send('nobody', 'hi')).toThrow(/扫码/u)
    expect(() => service.send('mom', '  ')).toThrow(/text/u)
    service.setBindingOptions('mom', { enabled: false })
    expect(() => service.send('mom', 'hi')).toThrow(/关闭/u)
  })

  it('keeps what it could not send in the outbox and retries', async () => {
    server.push(textFrom(OWNER, 'hi', 'ctx-1'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId)], '好')
    await until(() => server.sent().length === 1, 3000, 'reply')
    server.state.failSend = true
    service.send('mom', '提醒')
    await until(() => store.read('mom', () => undefined)?.outbox[0]?.failures === 1, 3000, 'failure counted')
    server.state.failSend = false
    await until(() => server.sent().filter(text => text === '提醒').length >= 1 && store.read('mom', () => undefined)?.outbox.length === 0, 3000, 'retried')
  })

  it('with autoPush off, sends nothing by itself for turns no chat message started', async () => {
    server.push(textFrom(OWNER, 'hi'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId)], '好的')
    await until(() => server.sent().length === 1, 3000, 'reply')
    runTurn(service, 's1', [{ source: { kind: 'host-note', plugin: 'p' } }], '心跳的文字')
    runTurn(service, 's1', [{ source: { kind: 'subagent-settled' } }], '任务结果')
    runTurn(service, 's1', [{ source: { kind: 'schedule' } }], '提醒文字')
    await sleep(80)
    expect(server.sent()).toEqual(['好的'])
  })

  it('still answers a chat message with the turn\'s text by itself', async () => {
    server.push(textFrom(OWNER, 'hi'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId)], '好的')
    await until(() => server.sent().includes('好的'), 3000, 'reply')
  })

  it('does not answer twice when the caller sent during the turn', async () => {
    server.push(textFrom(OWNER, 'hi'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    service.observe('s1', { type: 'turn/start', data: { turn: 1 } })
    service.observe('s1', { type: 'user/message', data: { ...fromPrompt(host.prompts[0]!.requestId) } })
    service.send('mom', '发到微信的话')
    service.observe('s1', { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '留在网页的话' }] } } })
    service.observe('s1', { type: 'turn/end', data: { turn: 1 } })
    await until(() => server.sent().length === 1, 3000, 'one message')
    await sleep(60)
    expect(server.sent()).toEqual(['发到微信的话'])
  })

  it('sends no "no reply" notice when the caller answered and the turn has no text', async () => {
    server.push(textFrom(OWNER, 'hi'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    service.observe('s1', { type: 'turn/start', data: { turn: 1 } })
    service.observe('s1', { type: 'user/message', data: { ...fromPrompt(host.prompts[0]!.requestId) } })
    service.send('mom', '收到')
    service.observe('s1', { type: 'turn/end', data: { turn: 1 } })
    await until(() => server.sent().length === 1, 3000, 'one message')
    await sleep(60)
    expect(server.sent()).toEqual(['收到'])
  })
})

describe('sending before the account ever wrote', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  let store: BindingStore
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
    ;({ service, store } = makeService(server, host, { autoPush: false }))
    await loginAndBind(service, server, 'mom', 's1')
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('goes out without a context when the server takes it', async () => {
    service.send('mom', '你好，我是助理')
    await until(() => server.sent().length === 1, 3000, 'sent')
    expect(server.to('sendmessage')[0]?.body.msg.context_token).toBeUndefined()
  })

  it('waits for the first message when the server refuses it, without giving up', async () => {
    server.state.failSend = true
    service.send('mom', '你好，我是助理')
    await until(() => server.to('sendmessage').length === 1, 3000, 'first try')
    // Several polls succeed meanwhile: no retry, and no failure counted.
    await sleep(150)
    expect(server.to('sendmessage')).toHaveLength(1)
    expect(store.read('mom', () => undefined)?.outbox[0]?.failures).toBe(0)
    expect(service.status('mom').lastError).toBeUndefined()

    server.state.failSend = false
    server.push(textFrom(OWNER, 'hi', 'ctx-first'))
    await until(() => server.to('sendmessage').length === 2, 3000, 'sent after the first message')
    expect(server.to('sendmessage').at(-1)?.body.msg.context_token).toBe('ctx-first')
  })
})

describe('a chat whose session went stale', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  let store: BindingStore
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
    ;({ service, store } = makeService(server, host, { autoPush: false }))
    await loginAndBind(service, server, 'mom', 's1')
    server.push(textFrom(OWNER, 'hi', 'ctx-old'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId)], '好')
    await until(() => server.sent().length === 1, 3000, 'reply')
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('sends once more without the old context token, under a new client id', async () => {
    server.state.staleSend = 1
    service.send('mom', '一天后的提醒')
    await until(() => server.to('sendmessage').length === 3, 3000, 'retry')
    const [stale, retry] = server.to('sendmessage').slice(1)
    expect(stale!.body.msg.context_token).toBe('ctx-old')
    expect(retry!.body.msg.context_token).toBeUndefined()
    expect(retry!.body.msg.client_id).toBe(`${stale!.body.msg.client_id}-r`)
    await until(() => store.read('mom', () => undefined)?.outbox.length === 0, 3000, 'outbox emptied')
    expect(service.status('mom').lastError).toBeUndefined()
  })
})

describe('a chat that takes nothing until the account writes again', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  let store: BindingStore
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
    ;({ service, store } = makeService(server, host, { autoPush: false }))
    await loginAndBind(service, server, 'mom', 's1')
    server.push(textFrom(OWNER, 'hi', 'ctx-old'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId)], '好')
    await until(() => server.sent().length === 1, 3000, 'reply')
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    service.dispose()
    await server.close()
  })

  const stored = () => store.read('mom', () => undefined)

  it('keeps what iLink refused, uncounted, and sends it in the context of the next message', async () => {
    server.state.refuseSend = true
    service.send('mom', '早上好，今天没有安排')
    // The stale-session retry runs once, then the outbox waits.
    await until(() => server.to('sendmessage').length === 3, 3000, 'refused twice')
    await until(() => service.status('mom').lastError !== undefined, 3000, 'problem shown')
    expect(service.status('mom').lastError).toMatch(/回一句/u)
    expect(stored()?.lastSendFailure?.error).toBe('sendmessage ret=-2 errmsg="prepare failed"')
    // Polls go on and what comes later joins the queue, but nothing is tried while it waits.
    service.send('mom', '记得带伞')
    await sleep(150)
    expect(server.to('sendmessage')).toHaveLength(3)
    expect(stored()?.outbox.map(entry => [entry.text, entry.failures])).toEqual([['早上好，今天没有安排', 0], ['记得带伞', 0]])

    server.state.refuseSend = false
    server.push(textFrom(OWNER, '在吗', 'ctx-new'))
    await until(() => server.sent().length === 5, 3000, 'sent after the next message')
    expect(server.sent().slice(-2)).toEqual(['早上好，今天没有安排', '记得带伞'])
    expect(server.to('sendmessage').slice(-2).map(call => call.body.msg.context_token)).toEqual(['ctx-new', 'ctx-new'])
    await until(() => service.status('mom').lastError === undefined, 3000, 'problem cleared')
    expect(stored()?.outbox).toEqual([])
  })

  it('also waits when any send fails a day after the account last wrote, and says when the window closes', async () => {
    const lastInbound = service.status('mom').lastInboundAt!
    expect(service.status('mom').windowClosesAt).toBe(lastInbound + 24 * 3_600_000)
    const later = Date.now() + 25 * 3_600_000
    vi.spyOn(Date, 'now').mockImplementation(() => later)
    server.state.failSend = true
    service.send('mom', '一天多以后的提醒')
    await until(() => service.status('mom').lastError !== undefined, 3000, 'waiting')
    expect(service.status('mom').lastError).toMatch(/回一句/u)
    await sleep(150)
    expect(server.to('sendmessage')).toHaveLength(2)
    expect(stored()?.outbox[0]?.failures).toBe(0)
  })

  it('says in the diagnosis what waits and what the server said', async () => {
    server.state.refuseSend = true
    service.send('mom', '提醒')
    await until(() => service.status('mom').lastError !== undefined, 3000, 'waiting')
    const outbox = (await service.diagnose('mom')).checks.find(check => check.label === '待发的回复')
    expect(outbox).toMatchObject({ ok: false, detail: expect.stringContaining('还有 1 条消息在等你在微信里说话') })
    expect(outbox?.detail).toContain('ret=-2')
  })
})

describe('routing a turn', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  let store: BindingStore
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
    ;({ service, store } = makeService(server, host, { autoPush: false, replyMaxChars: 50 }))
    await loginAndBind(service, server, 'mom', 's1')
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  /** Run a turn some host note started, with `route` called in the middle. */
  const routedTurn = (reply: string, route?: Parameters<ImRobot['route']>[1]): boolean | undefined => {
    service.observe('s1', { type: 'turn/start', data: { turn: 1 } })
    service.observe('s1', { type: 'user/message', data: { source: { kind: 'host-note', plugin: 'p' } } })
    const routed = route === undefined ? undefined : service.route('mom', route)
    service.observe('s1', { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: reply }] } } })
    service.observe('s1', { type: 'turn/end', data: { turn: 1 } })
    return routed
  }

  it('sends a host note\'s answer to the chat when routed there, whoever spoke last', async () => {
    service.observe('s1', { type: 'user/message', data: { source: { kind: 'user', rpcId: 'web-1' } } })
    expect(routedTurn('该吃药了', { chat: true })).toBe(true)
    await until(() => server.sent().length === 1, 3000, 'routed')
    expect(server.sent()).toEqual(['该吃药了'])
    routedTurn('只留在网页')
    await sleep(80)
    expect(server.sent()).toEqual(['该吃药了'])
  })

  it('keeps the answer to a chat message off the chat when routed away, and clears typing', async () => {
    server.push(textFrom(OWNER, 'hi'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    service.observe('s1', { type: 'turn/start', data: { turn: 1 } })
    service.observe('s1', { type: 'user/message', data: { ...fromPrompt(host.prompts[0]!.requestId) } })
    expect(service.route('mom', { chat: false })).toBe(true)
    service.observe('s1', { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '很长的表格' }] } } })
    service.observe('s1', { type: 'turn/end', data: { turn: 1 } })
    await until(() => server.to('sendtyping').some(call => call.body.status === 2), 3000, 'typing cleared')
    await sleep(60)
    expect(server.sent()).toEqual([])
  })

  it('holds a routed answer until its moment, without holding back what comes after it', async () => {
    routedTurn('早上好', { chat: true, notBefore: Date.now() + 400 })
    await until(() => store.read('mom', () => undefined)?.outbox.length === 1, 3000, 'held')
    expect(store.read('mom', () => undefined)?.outbox[0]?.notBefore).toBeGreaterThan(Date.now())
    service.send('mom', '现在就发')
    await until(() => server.sent().length === 1, 3000, 'later one first')
    expect(server.sent()).toEqual(['现在就发'])
    await until(() => server.sent().length === 2, 3000, 'held one at its moment')
    expect(server.sent()).toEqual(['现在就发', '早上好'])
  })

  it('sends nothing for a routed turn without text, and routes nothing outside a turn', async () => {
    routedTurn('', { chat: true })
    expect(service.route('mom', { chat: true })).toBe(false)
    await sleep(80)
    expect(server.sent()).toEqual([])
  })

  it('refuses bad routes and holds longer than a day', () => {
    expect(() => service.route('mom', {} as never)).toThrow(/chat/u)
    expect(() => service.route('nobody', { chat: true })).toThrow(/扫码/u)
    expect(() => service.route('mom', { chat: true, notBefore: Date.now() + 25 * 3_600_000 })).toThrow(/24 hours/u)
    expect(() => service.send('mom', 'hi', { notBefore: Number.NaN })).toThrow(/epoch/u)
  })
})
