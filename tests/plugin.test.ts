import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import { BindingStore, defaultDataDirectory } from '../src/store.ts'
import type { BindingStatus, ImRobotService } from '../src/types.ts'
import { sleep, tempDir, until } from './helpers.ts'

/** Host services the plugin injects, as plain fakes. */
function services(presets: Record<string, string>) {
  const unset: string[] = []
  return {
    unset,
    credentials: { resolve: async () => undefined, set: async () => undefined, unset: async (ref: string) => { unset.push(ref) } },
    sessionController: {
      prompt: async () => ({ accepted: true }),
      resolveAgent: async (sessionId: string) => ({ agent: { session: { id: sessionId } } }),
    },
    agentPresets: { presetForSession: (session: { id: string }) => presets[session.id] ?? null },
  }
}

describe('the plugin under real cordis', () => {
  let previousHome: string | undefined
  beforeEach(() => {
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = tempDir()
  })
  afterEach(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  it('declares its name, injections, and config defaults', () => {
    expect(plugin.name).toBe('im-robot')
    expect(plugin.inject).toEqual(['credentials', 'sessionController'])
    expect(plugin.Config({})).toEqual({ presets: [], replyMaxChars: 100, autoPush: true, silentReply: '' })
    expect(plugin.Config({ presets: ['dsh-assisstant'], replyMaxChars: 800, autoPush: false, silentReply: '[silent]' }))
      .toEqual({ presets: ['dsh-assisstant'], replyMaxChars: 800, autoPush: false, silentReply: '[silent]' })
    expect(() => plugin.Config({ replyMaxChars: 2 })).toThrow()
  })

  it('exports the keep markers', () => {
    expect([plugin.KEEP_OPEN, plugin.KEEP_CLOSE, plugin.KEEP_MAX_CHARS]).toEqual(['<keep>', '</keep>', 2000])
  })

  it('provides imRobot, emits status through cordis, follows session/event, and leaves on dispose', async () => {
    // A logged-in binding that is not bound yet, so nothing reaches the network.
    const store = new BindingStore(defaultDataDirectory())
    store.write({
      version: 1, bindingId: 'mom', channel: 'wechat', user: 'own***56@im.wechat', lastInputFromChat: true,
      channelState: { ilinkUserId: 'owner123456@im.wechat' }, outbox: [], boundAt: 1,
    })
    const fakes = services({ 's-home': 'dsh-assisstant', 's-std': 'standard' })
    const root = new Context()
    root.provide('credentials', fakes.credentials)
    root.provide('sessionController', fakes.sessionController)
    root.provide('agentPresets', fakes.agentPresets)
    const statuses: [string, BindingStatus][] = []
    root.on('im-robot/status' as never, ((bindingId: string, state: BindingStatus) => { statuses.push([bindingId, state]) }) as never)
    const fiber = root.plugin(plugin, { presets: ['dsh-assisstant'] })
    let service: ImRobotService | undefined
    root.inject(['imRobot'], (ctx) => { service = (ctx as unknown as { imRobot: ImRobotService }).imRobot })
    await until(() => service !== undefined, 2000, 'the service')
    expect(service!.status('mom')).toEqual({ bound: true, user: 'own***56@im.wechat', connected: false, sendMode: 'queue', commands: true, enabled: true, replyMaxChars: 100 })

    service!.setOptions({ enabled: false })
    await expect(service!.bind('mom', { sessionId: 's-std' })).rejects.toThrow(/dsh-assisstant/u)
    await service!.bind('mom', { sessionId: 's-home' })
    expect(statuses.at(-1)).toEqual(['mom', { bound: true, user: 'own***56@im.wechat', sessionId: 's-home', connected: false, sendMode: 'queue', commands: true, enabled: true, replyMaxChars: 100 }])

    // Web input lands in the bound session: the plugin hears it without any scope.
    root.emit('session/event' as never, { id: 's-home' } as never, { type: 'user/message', data: { source: { kind: 'user', rpcId: 'web' } } } as never)
    expect(JSON.parse(readFileSync(store.pathOf('mom'), 'utf8')).lastInputFromChat).toBe(false)

    await service!.unbind('mom')
    expect(fakes.unset).toEqual(['IM_ROBOT_WECHAT_mom'])
    expect(statuses.at(-1)).toEqual(['mom', { bound: false, connected: false, sendMode: 'queue', commands: true, enabled: true, replyMaxChars: 100 }])

    await fiber.dispose()
    await sleep(10)
    expect(root.get('imRobot')).toBeUndefined()
  })

  it('binds on a host shaped like 0.2.1-rc.5, and a bad session event stays inside the plugin', async () => {
    new BindingStore(defaultDataDirectory()).write({
      version: 1, bindingId: 'mom', channel: 'wechat', user: 'own***56@im.wechat', lastInputFromChat: true,
      channelState: { ilinkUserId: 'owner123456@im.wechat' }, outbox: [], boundAt: 1, options: { sendMode: 'queue', commands: true },
    })
    const presets: Record<string, string | null> = { 's-home': 'dsh-assisstant', 's-std': 'standard' }
    const reads: string[] = []
    // Real services, so the registry is reached through cordis' tracing proxy as it is on the real host.
    class Registry extends Service {
      constructor(ctx: Context) { super(ctx, 'agentPresets' as never) }
    }
    class Projections extends Service {
      constructor(ctx: Context) { super(ctx, 'sessionProjections' as never) }
      stateOf(session: { id: string }, key: string): string | null | undefined {
        reads.push(key)
        return key === 'agentPreset' ? presets[session.id] ?? null : undefined
      }
    }
    const fakes = services({})
    const root = new Context()
    root.provide('credentials', fakes.credentials)
    root.provide('sessionController', fakes.sessionController)
    root.plugin(Registry)
    root.plugin(Projections)
    await until(() => root.get('agentPresets' as never) !== undefined && root.get('sessionProjections' as never) !== undefined, 2000, 'the host services')
    const fiber = root.plugin(plugin, { presets: ['dsh-assisstant'] })
    let service: ImRobotService | undefined
    root.inject(['imRobot'], (ctx) => { service = (ctx as unknown as { imRobot: ImRobotService }).imRobot })
    await until(() => service !== undefined, 2000, 'the service')

    service!.setOptions({ enabled: false })
    await expect(service!.bind('mom', { sessionId: 's-std' })).rejects.toThrow(/「standard」/u)
    await service!.bind('mom', { sessionId: 's-home' })
    expect(service!.status('mom').sessionId).toBe('s-home')
    expect(reads).toEqual(['agentPreset', 'agentPreset'])

    const bad = { get type(): string { throw new Error('a malformed event') } }
    expect(() => root.emit('session/event' as never, { id: 's-home' } as never, bad as never)).not.toThrow()

    await service!.unbind('mom')
    await fiber.dispose()
  })
})
