import { statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { BindingStore, assertBindingId, credentialName, defaultDataDirectory } from '../src/store.ts'
import type { StoredBinding } from '../src/store.ts'
import { tempDir } from './helpers.ts'

const binding = (bindingId: string): StoredBinding => ({
  version: 1,
  bindingId,
  channel: 'wechat',
  user: 'own***56@im.wechat',
  sessionId: 's1',
  lastInputFromChat: false,
  channelState: { ilinkUserId: 'owner@im.wechat', syncBuf: 'buf' },
  outbox: [],
  boundAt: 1,
  options: { sendMode: 'queue', commands: true, enabled: true },
})

describe('binding ids and credential names', () => {
  it('accepts letters, digits, "_" and "-", and nothing that could escape the folder', () => {
    for (const ok of ['mom', 'Person_1', '3f2b8c1e-9d4a-4b7e-8f00-1a2b3c4d5e6f']) expect(() => assertBindingId(ok)).not.toThrow()
    for (const bad of ['', '-x', '../x', 'a/b', 'a:b', 'a.b', 'x'.repeat(65), 42]) expect(() => assertBindingId(bad)).toThrow(TypeError)
  })

  it('names credentials IM_ROBOT_WECHAT_<id>, escaping "_" and "-" so distinct ids stay distinct', () => {
    expect(credentialName('wechat', 'mom')).toBe('IM_ROBOT_WECHAT_mom')
    expect(credentialName('wechat', 'a-b_c')).toBe('IM_ROBOT_WECHAT_a_2Db_5Fc')
    expect(credentialName('wechat', 'a_b')).not.toBe(credentialName('wechat', 'a-b'))
    const uuid = '3f2b8c1e-9d4a-4b7e-8f00-1a2b3c4d5e6f'
    expect(() => credentialRef(credentialName('wechat', uuid))).not.toThrow()
  })
})

describe('the store', () => {
  let previousHome: string | undefined
  beforeEach(() => {
    previousHome = process.env.DSH_HOME
  })
  afterEach(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  it('lives under $DSH_HOME/plugin-data/im-robot', () => {
    process.env.DSH_HOME = '/tmp/dsh-home'
    expect(defaultDataDirectory()).toBe(join('/tmp/dsh-home', 'plugin-data', 'im-robot'))
    delete process.env.DSH_HOME
    expect(defaultDataDirectory()).toMatch(/\.dsh[/\\]plugin-data[/\\]im-robot$/u)
  })

  it('reads $DSH_HOME by the same rules as the host', () => {
    const under = (home: string): string => join(home, 'plugin-data', 'im-robot')
    const cases: [string, string][] = [
      ['~', under(homedir())],
      ['~/people', under(join(homedir(), 'people'))],
      ['relative/home', under(resolve('relative/home'))],
      ['   ', under(join(homedir(), '.dsh'))],
      ['', under(join(homedir(), '.dsh'))],
    ]
    for (const [value, expected] of cases) {
      process.env.DSH_HOME = value
      expect(defaultDataDirectory(), JSON.stringify(value)).toBe(expected)
    }
  })

  it('writes owner-only files and reads them back', () => {
    const directory = join(tempDir(), 'nested')
    const store = new BindingStore(directory)
    store.write(binding('mom'))
    expect(statSync(store.pathOf('mom')).mode & 0o777).toBe(0o600)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(store.read('mom', () => undefined)).toEqual(binding('mom'))
    store.write({ ...binding('mom'), sessionId: 's2' })
    expect(store.list(() => undefined).map(entry => entry.sessionId)).toEqual(['s2'])
    store.delete('mom')
    store.delete('mom')
    expect(store.list(() => undefined)).toEqual([])
  })

  it('reads older or hand-edited files with default options and drops unusable time stamps', () => {
    const directory = tempDir()
    const store = new BindingStore(directory)
    const { options: _options, outbox: _outbox, ...legacy } = binding('old')
    writeFileSync(join(directory, 'old.json'), JSON.stringify(legacy))
    expect(store.read('old', () => undefined)).toEqual({ ...legacy, outbox: [], options: { sendMode: 'queue', commands: true, enabled: true } })
    writeFileSync(join(directory, 'odd.json'), JSON.stringify({
      ...binding('odd'), options: { sendMode: 'shout', commands: 'yes', enabled: 'no', replyMaxChars: 3 }, lastInboundAt: -1, lastOutboundAt: 'later',
    }))
    expect(store.read('odd', () => undefined)).toEqual(binding('odd'))
    const options = { sendMode: 'steer', commands: false, enabled: false, replyMaxChars: 40 } as const
    store.write({ ...binding('kept'), options, lastInboundAt: 5, lastOutboundAt: 6 })
    expect(store.read('kept', () => undefined)).toMatchObject({ options, lastInboundAt: 5, lastOutboundAt: 6 })
  })

  it('skips malformed files with a warning', () => {
    const directory = tempDir()
    const store = new BindingStore(directory)
    store.write(binding('good'))
    writeFileSync(join(directory, 'broken.json'), '{nope')
    writeFileSync(join(directory, 'wrong.json'), JSON.stringify({ ...binding('other') }))
    writeFileSync(join(directory, 'shape.json'), JSON.stringify({ ...binding('shape'), channelState: { n: 1 } }))
    writeFileSync(join(directory, 'notes.txt'), 'ignored')
    const warnings: string[] = []
    expect(store.list(message => warnings.push(message)).map(entry => entry.bindingId)).toEqual(['good'])
    expect(warnings).toHaveLength(3)
    expect(new BindingStore(join(directory, 'missing')).list(() => undefined)).toEqual([])
  })
})
