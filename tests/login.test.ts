import { existsSync, readFileSync, statSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OWNER, TOKEN, collect, confirmed, fakeHost, fakeIlink, loginAndBind, makeService, until } from './helpers.ts'
import type { FakeHost, FakeIlink } from './helpers.ts'
import type { ImRobot } from '../src/service.ts'
import type { BindingStore } from '../src/store.ts'

describe('login', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  let store: BindingStore
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
    ;({ service, store } = makeService(server, host))
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('yields qr, scanned, then bound with a masked user', async () => {
    server.qrStatuses.push({ status: 'wait' }, { status: 'scaned' }, { status: 'scaned' }, confirmed())
    const before = Date.now()
    const states = await collect(service.login('mom', 'wechat'))
    expect(states).toEqual([
      { status: 'qr', qr: 'https://liteapp.weixin.qq.com/q/1', expiresAt: expect.any(Number) },
      { status: 'scanned' },
      { status: 'bound', user: 'own***56@im.wechat' },
    ])
    expect((states[0] as { expiresAt: number }).expiresAt).toBeGreaterThan(before)
    expect(server.to('get_bot_qrcode')[0]?.query.get('bot_type')).toBe('3')
    expect(server.to('get_qrcode_status').every(call => call.query.get('qrcode') === 'code-1')).toBe(true)
    expect(service.status('mom')).toEqual({ bound: true, user: 'own***56@im.wechat', connected: false, sendMode: 'queue', commands: true, enabled: true, replyMaxChars: 100 })
    expect(host.statuses).toEqual([['mom', { bound: true, user: 'own***56@im.wechat', connected: false, sendMode: 'queue', commands: true, enabled: true, replyMaxChars: 100 }]])
  })

  it('stores the token in credentials and the rest in an owner-only state file', async () => {
    await collect((server.qrStatuses.push(confirmed()), service.login('mom', 'wechat')))
    expect(host.secrets.get('IM_ROBOT_WECHAT_mom')).toBe(TOKEN)
    const path = store.pathOf('mom')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const text = readFileSync(path, 'utf8')
    expect(text).not.toContain(TOKEN)
    expect(JSON.parse(text)).toMatchObject({
      version: 1,
      bindingId: 'mom',
      channel: 'wechat',
      channelState: { ilinkUserId: OWNER, botId: 'bot-1@im.bot', baseUrl: server.baseUrl },
    })
  })

  it('refreshes an expired code twice, then reports expired', async () => {
    server.qrStatuses.push({ status: 'expired' }, { status: 'expired' }, { status: 'expired' })
    const states = await collect(service.login('mom', 'wechat'))
    expect(states.map(state => state.status)).toEqual(['qr', 'qr', 'qr', 'expired'])
    expect(states.slice(0, 3).map(state => (state as { qr: string }).qr)).toEqual([1, 2, 3].map(n => `https://liteapp.weixin.qq.com/q/${n}`))
    expect((states[3] as { reason: string }).reason).toMatch(/二维码过期/u)
    expect(service.status('mom')).toEqual({ bound: false, connected: false, sendMode: 'queue', commands: true, enabled: true, replyMaxChars: 100 })
    expect(host.secrets.size).toBe(0)
  })

  it('fails in plain words when the server is down or wants a verify code', async () => {
    server.state.failQr = true
    const down = await collect(service.login('mom', 'wechat'))
    expect(down).toEqual([{ status: 'failed', reason: expect.stringMatching(/连不上微信/u) }])
    server.state.failQr = false
    server.qrStatuses.push({ status: 'need_verifycode' })
    const verify = await collect(service.login('mom', 'wechat'))
    expect(verify.map(state => state.status)).toEqual(['qr', 'failed'])
    expect((verify[1] as { reason: string }).reason).toMatch(/[一-鿿]/u)
  })

  it('fails when the confirmation carries no token', async () => {
    server.qrStatuses.push({ status: 'confirmed', ilink_bot_id: 'bot-1@im.bot', ilink_user_id: OWNER })
    const states = await collect(service.login('mom', 'wechat'))
    expect(states.at(-1)).toEqual({ status: 'failed', reason: expect.stringMatching(/凭据/u) })
    expect(service.status('mom').bound).toBe(false)
  })

  it('stops quietly when its signal aborts, and a new login supersedes a running one', async () => {
    const controller = new AbortController()
    const first = service.login('mom', 'wechat', controller.signal)[Symbol.asyncIterator]()
    expect((await first.next()).value).toMatchObject({ status: 'qr' })
    controller.abort()
    expect(await first.next()).toEqual({ done: true, value: undefined })

    const second = service.login('mom', 'wechat')[Symbol.asyncIterator]()
    expect((await second.next()).value).toMatchObject({ status: 'qr' })
    const third = service.login('mom', 'wechat')[Symbol.asyncIterator]()
    expect((await third.next()).value).toMatchObject({ status: 'qr' })
    expect((await second.next()).done).toBe(true)
    await third.return?.()
  })

  it('rejects an invalid binding id or channel up front', () => {
    expect(() => service.login('../x', 'wechat')).toThrow(TypeError)
    expect(() => service.login('a:b', 'wechat')).toThrow(TypeError)
    expect(() => service.login('mom', 'telegram' as 'wechat')).toThrow(/unsupported channel/u)
  })
})

describe('unbind', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  let store: BindingStore
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
    ;({ service, store } = makeService(server, host))
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('deletes the credential and the state file and stops receiving', async () => {
    await loginAndBind(service, server, 'mom', 's1')
    await until(() => server.to('getupdates').length > 0, 3000, 'polling')
    expect(host.secrets.has('IM_ROBOT_WECHAT_mom')).toBe(true)
    expect(existsSync(store.pathOf('mom'))).toBe(true)

    await service.unbind('mom')
    expect(host.secrets.has('IM_ROBOT_WECHAT_mom')).toBe(false)
    expect(existsSync(store.pathOf('mom'))).toBe(false)
    expect(service.status('mom')).toEqual({ bound: false, connected: false, sendMode: 'queue', commands: true, enabled: true, replyMaxChars: 100 })
    expect(host.statuses.at(-1)).toEqual(['mom', { bound: false, connected: false, sendMode: 'queue', commands: true, enabled: true, replyMaxChars: 100 }])

    await new Promise(resolve => setTimeout(resolve, 80))
    const polls = server.to('getupdates').length
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(server.to('getupdates').length).toBe(polls)
  })

  it('escapes ids that a credential reference cannot hold', async () => {
    server.qrStatuses.push(confirmed())
    await collect(service.login('a-b_c', 'wechat'))
    expect([...host.secrets.keys()]).toEqual(['IM_ROBOT_WECHAT_a_2Db_5Fc'])
    await service.unbind('a-b_c')
    expect(host.secrets.size).toBe(0)
  })
})
