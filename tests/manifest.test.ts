import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const manifest = JSON.parse(read('package.json')) as Record<string, any>

/** Every file below a folder, repository-relative. */
function files(folder: string): string[] {
  return readdirSync(join(ROOT, folder), { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(ROOT, join(entry.parentPath, entry.name)))
}

describe('package identity', () => {
  it('is im-robot 0.2.2, MIT, ESM, for DeepSeek Harness 0.2.1-rc.5 up to 0.3', () => {
    expect(manifest.name).toBe('@starsharryzhu/im-robot')
    expect(manifest.version).toBe('0.3.0')
    expect(manifest.license).toBe('MIT')
    expect(manifest.type).toBe('module')
    expect(manifest.engines.dsh).toBe('>=0.2.1-rc.5 <0.3.0-0')
  })

  it('peers on cordis, schemastery, and dsh-credentials, with no runtime dependency', () => {
    expect(Object.keys(manifest.peerDependencies).sort()).toEqual(['@deepseek-ai/cordis', '@deepseek-ai/dsh-credentials', '@deepseek-ai/schemastery'])
    expect(manifest.peerDependencies['@deepseek-ai/dsh-credentials']).toBe(manifest.engines.dsh)
    expect(manifest.dependencies).toEqual({})
  })

  it('is host-only and patches in one top-level row named after the package', () => {
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client).toBeUndefined()
    expect(read('cordis.patch.yml')).toMatch(/- insert:\n\s+- id: im-robot\n\s+name: '@starsharryzhu\/im-robot'\n/u)
  })

  it('shows a title on the Plugins page in both languages', () => {
    expect(JSON.parse(read('locale/en.json')).meta.title).toBe('IM Robot')
    expect(JSON.parse(read('locale/zh.json')).meta.title).toBe('IM 机器人')
  })

  it('ships the built host half and the notices', () => {
    expect(read('lib/index.js')).toContain("export const name = 'im-robot'")
    expect(read('lib/types.d.ts')).toContain("'im-robot/inbound'(sessionId: string, channel: Channel)")
    expect(manifest.files).toEqual(expect.arrayContaining(['lib', 'src', 'cordis.patch.yml', 'THIRD_PARTY_NOTICES.md']))
  })
})

describe('provenance', () => {
  const notices = read('THIRD_PARTY_NOTICES.md')

  it('carries both copyright lines and both MIT texts', () => {
    expect(notices).toContain('Copyright (C) 2026 Tencent.')
    expect(notices).toContain('Copyright (c) 2026 dsh-weixin contributors')
    expect(notices.match(/Permission is hereby granted, free of charge/gu)).toHaveLength(2)
  })

  it('names its source, license, and changes at the top of every adapted file', () => {
    const adapted = {
      'src/channels/wechat/api.ts': 'openclaw-weixin',
      'src/channels/wechat/login.ts': 'openclaw-weixin',
      'src/channels/wechat/monitor.ts': 'openclaw-weixin',
      'src/channels/wechat/send.ts': 'openclaw-weixin',
      'src/channels/wechat/typing.ts': 'openclaw-weixin',
      'src/channels/wechat/inbound.ts': 'dsh-weixin-ilink',
      'src/channels/wechat/media.ts': 'openclaw-weixin',
      'src/channels/wechat/upload.ts': 'openclaw-weixin',
      'src/reply.ts': 'openclaw-weixin',
      'src/turns.ts': 'dsh-weixin-ilink',
      'src/service.ts': 'dsh-weixin-ilink',
    }
    for (const [path, origin] of Object.entries(adapted)) {
      const header = read(path).slice(0, read(path).indexOf('*/'))
      expect(header, path).toContain(origin)
      expect(header, path).toContain('MIT License')
      expect(header, path).toMatch(/Changes:|written for this plugin|written for live events/u)
      expect(notices, path).toContain(path.replace(/^src\//u, 'src/'))
    }
  })

  it('takes nothing from the Apache-licensed IM-connect or the files dsh-weixin-ilink marks as derived', () => {
    for (const path of files('src')) {
      const text = read(path)
      expect(text, path).not.toMatch(/im-connect|dsh-plugin-weixin|persona\.js|life-state|human-pace|proactive\.js|quiet-hours/u)
    }
  })
})
