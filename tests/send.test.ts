import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
