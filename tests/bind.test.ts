import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collect, confirmed, fakeHost, fakeIlink, makeService, until } from './helpers.ts'
import type { FakeHost, FakeIlink } from './helpers.ts'
import type { ImRobot } from '../src/service.ts'
import type { BindingStore } from '../src/store.ts'

describe('bind', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  let store: BindingStore
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ 's-home': 'dsh-assisstant', 's-std': 'standard', 's-none': null })
    ;({ service, store } = makeService(server, host, { presets: ['dsh-assisstant'] }))
    server.qrStatuses.push(confirmed())
    await collect(service.login('mom', 'wechat'))
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('rejects a session whose preset is not configured', async () => {
    await expect(service.bind('mom', { sessionId: 's-std' })).rejects.toThrow(/「standard」.*dsh-assisstant/u)
    await expect(service.bind('mom', { sessionId: 's-none' })).rejects.toThrow(/未设置/u)
    await expect(service.bind('mom', { sessionId: 's-gone' })).rejects.toThrow(/找不到会话/u)
    expect(service.status('mom').sessionId).toBeUndefined()
    expect(server.to('getupdates')).toHaveLength(0)
  })

  it('binds a session with a configured preset, persists it, and starts receiving', async () => {
    await service.bind('mom', { sessionId: 's-home' })
    expect(service.status('mom')).toEqual({ bound: true, user: 'own***56@im.wechat', sessionId: 's-home', connected: false, sendMode: 'queue', commands: true, enabled: true, replyMaxChars: 100 })
    expect(host.statuses.at(-1)).toEqual(['mom', { bound: true, user: 'own***56@im.wechat', sessionId: 's-home', connected: false, sendMode: 'queue', commands: true, enabled: true, replyMaxChars: 100 }])
    expect(JSON.parse(readFileSync(store.pathOf('mom'), 'utf8')).sessionId).toBe('s-home')
    await until(() => service.status('mom').connected, 3000, 'connected')
    expect(host.statuses.at(-1)).toEqual(['mom', { bound: true, user: 'own***56@im.wechat', sessionId: 's-home', connected: true, sendMode: 'queue', commands: true, enabled: true, replyMaxChars: 100 }])
    expect(server.to('getupdates')[0]?.headers.authorization).toBe('Bearer bot-token-1')
  })

  it('allows any session when no preset is configured', async () => {
    const open = makeService(server, host, { directory: store.directory })
    open.service.start()
    await open.service.bind('mom', { sessionId: 's-std' })
    expect(open.service.status('mom').sessionId).toBe('s-std')
    open.service.dispose()
  })

  it('refuses before a login, and without a session id', async () => {
    await expect(service.bind('dad', { sessionId: 's-home' })).rejects.toThrow(/扫码/u)
    await expect(service.bind('mom', { sessionId: '' })).rejects.toThrow(TypeError)
    await expect(service.bind('mom', {} as { sessionId: string })).rejects.toThrow(TypeError)
  })
})

describe('reading a session\'s preset across host versions', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ 's-home': 'dsh-assisstant', 's-std': 'standard', 's-none': null })
    ;({ service } = makeService(server, host, { presets: ['dsh-assisstant'] }))
    server.qrStatuses.push(confirmed())
    await collect(service.login('mom', 'wechat'))
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('asks the registry first when it has presetForSession, and never touches the deprecated projection', async () => {
    await service.bind('mom', { sessionId: 's-home' })
    expect(service.status('mom').sessionId).toBe('s-home')
    expect(host.projectionReads).toEqual([])
  })

  it('reads the agentPreset projection on a host like 0.2.1-rc.5, whose registry lacks the method', async () => {
    host.control.presetApi = 'projection'
    await service.bind('mom', { sessionId: 's-home' })
    expect(service.status('mom').sessionId).toBe('s-home')
    expect(host.projectionReads).toEqual(['agentPreset'])
    expect((await service.diagnose('mom')).checks.find(check => check.label === '绑定的会话')).toEqual({ label: '绑定的会话', ok: true })
  })

  it('still refuses the wrong preset there, and a session with none', async () => {
    host.control.presetApi = 'projection'
    await expect(service.bind('mom', { sessionId: 's-std' })).rejects.toThrow(/「standard」.*dsh-assisstant/u)
    await expect(service.bind('mom', { sessionId: 's-none' })).rejects.toThrow(/未设置/u)
    expect(service.status('mom').sessionId).toBeUndefined()
  })

  for (const presetApi of ['registry', 'projection'] as const) {
    it(`treats a failed ${presetApi} read as no preset, not as a TypeError`, async () => {
      host.control.presetApi = presetApi
      host.control.failPresetRead = true
      await expect(service.bind('mom', { sessionId: 's-home' })).rejects.toThrow(/未设置/u)
      expect(host.warnings.some(message => message.includes('could not read the preset of session s-home'))).toBe(true)
    })
  }

  it('says so when the host has neither way to read a preset', async () => {
    host.control.presetApi = 'none'
    await expect(service.bind('mom', { sessionId: 's-home' })).rejects.toThrow(/无法确认会话的类型/u)
  })
})
