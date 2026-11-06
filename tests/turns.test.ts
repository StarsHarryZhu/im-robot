import { describe, expect, it } from 'vitest'
import { TurnTracker, bindingOfRequest, requestIdFor } from '../src/turns.ts'
import { trustedBaseUrl } from '../src/channels/wechat/api.ts'
import { maskUserId, readInbound } from '../src/channels/wechat/inbound.ts'

const user = (rpcId?: string) => ({ type: 'user/message', data: { source: { kind: 'user', ...(rpcId === undefined ? {} : { rpcId }) } } })
const assistant = (text: string, interrupted = false) => ({
  type: 'assistant/message',
  data: { message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text }] }, ...(interrupted ? { interrupted: true } : {}) },
})

describe('request ids', () => {
  it('name their binding', () => {
    const id = requestIdFor('mom', 'u-1')
    expect(id).toBe('im-robot:mom:u-1')
    expect(bindingOfRequest(id)).toBe('mom')
    expect(bindingOfRequest('web-uuid')).toBeUndefined()
    expect(bindingOfRequest('im-robot::x')).toBeUndefined()
    expect(bindingOfRequest(undefined)).toBeUndefined()
  })
})

describe('the turn tracker', () => {
  it('reports the bindings a turn consumed and its last settled text', () => {
    const tracker = new TurnTracker()
    expect(tracker.observe('s1', { type: 'turn/start' })).toBeUndefined()
    tracker.observe('s1', user(requestIdFor('mom', 'a')))
    tracker.observe('s1', user(requestIdFor('mom', 'b')))
    tracker.observe('s1', assistant('first step'))
    tracker.observe('s1', assistant(''))
    tracker.observe('s1', assistant('final answer'))
    tracker.observe('s1', assistant('cut off', true))
    expect(tracker.observe('s1', { type: 'turn/end', data: { reason: { kind: 'completed' } } })).toEqual({
      kind: 'turn-end', sessionId: 's1', bindings: ['mom', 'mom'], reminder: false, followUp: false, text: 'final answer', sent: false,
    })
    expect(tracker.observe('s1', { type: 'turn/end' })).toBeUndefined()
  })

  it('reports foreign input and reminders, and keeps sessions apart', () => {
    const tracker = new TurnTracker()
    tracker.observe('s1', { type: 'turn/start' })
    tracker.observe('s2', { type: 'turn/start' })
    expect(tracker.observe('s1', user('web-1'))).toEqual({ kind: 'foreign-input', sessionId: 's1' })
    expect(tracker.observe('s1', user())).toEqual({ kind: 'foreign-input', sessionId: 's1' })
    expect(tracker.observe('s2', { type: 'user/message', data: { source: { kind: 'schedule' } } })).toBeUndefined()
    expect(tracker.observe('s2', { type: 'user/message', data: { source: { kind: 'skill' } } })).toBeUndefined()
    tracker.observe('s2', assistant('reminder answer'))
    expect(tracker.observe('s2', { type: 'turn/end' })).toMatchObject({ reminder: true, bindings: [], text: 'reminder answer' })
    expect(tracker.observe('s1', { type: 'turn/end' })).toMatchObject({ reminder: false, bindings: [], text: '' })
  })

  it('reports follow-ups: worker reports, agent and team messages, and host notes', () => {
    const tracker = new TurnTracker()
    const sources = [
      { kind: 'subagent-settled', form: 'notice', summary: 'done', senderSessionId: 'w1' },
      { kind: 'agent-message', form: 'relay', senderSessionId: 'w1' },
      { kind: 'team-message' },
      { kind: 'host-note', plugin: 'dsh-assisstant' },
    ]
    for (const source of sources) {
      tracker.observe('s1', { type: 'turn/start' })
      expect(tracker.observe('s1', { type: 'user/message', data: { source } }), source.kind).toBeUndefined()
      tracker.observe('s1', assistant('记好了'))
      expect(tracker.observe('s1', { type: 'turn/end' }), source.kind).toMatchObject({ followUp: true, reminder: false, bindings: [], text: '记好了' })
    }
    tracker.observe('s1', { type: 'turn/start' })
    tracker.observe('s1', { type: 'user/message', data: { source: { kind: 'skill-invocation' } } })
    expect(tracker.observe('s1', { type: 'turn/end' })).toMatchObject({ followUp: false, reminder: false })
  })

  it('counts a host note as a follow-up, not as foreign input', () => {
    const tracker = new TurnTracker()
    tracker.observe('s1', { type: 'turn/start' })
    const note = { type: 'user/message', data: { source: { kind: 'host-note', plugin: 'dsh-assisstant' } } }
    expect(tracker.observe('s1', note)).toBeUndefined()
    tracker.observe('s1', assistant('今天有一件事：看牙医。'))
    expect(tracker.observe('s1', { type: 'turn/end' })).toEqual({
      kind: 'turn-end', sessionId: 's1', bindings: [], reminder: false, followUp: true, text: '今天有一件事：看牙医。', sent: false,
    })
  })

  it('joins a turn already running', () => {
    const tracker = new TurnTracker()
    tracker.observe('s1', assistant('mid-turn'))
    expect(tracker.observe('s1', { type: 'turn/end' })).toMatchObject({ text: 'mid-turn' })
  })
})

describe('wechat helpers', () => {
  it('accepts server hosts only on Tencent domains over https', () => {
    const fallback = 'https://ilinkai.weixin.qq.com'
    expect(trustedBaseUrl(undefined, fallback)).toBe(fallback)
    expect(trustedBaseUrl('https://sh.ilinkai.weixin.qq.com/', fallback)).toBe('https://sh.ilinkai.weixin.qq.com')
    expect(trustedBaseUrl('http://sh.ilinkai.weixin.qq.com', fallback)).toBe(fallback)
    expect(trustedBaseUrl('https://evil.example', fallback)).toBe(fallback)
    expect(trustedBaseUrl('https://qq.com.evil.example', fallback)).toBe(fallback)
    expect(trustedBaseUrl('not a url', fallback)).toBe(fallback)
    expect(trustedBaseUrl('http://127.0.0.1:9/', 'http://127.0.0.1:9')).toBe('http://127.0.0.1:9')
  })

  it('reads every item in order and skips empty messages', async () => {
    const owner = 'o@im.wechat'
    const save = async () => undefined
    expect(await readInbound({ from_user_id: owner, item_list: [{ type: 3, voice_item: { text: 'v' } }, { type: 1, text_item: { text: 't' } }] }, owner, save))
      .toEqual({ kind: 'text', text: 'v\nt' })
    expect(await readInbound({ from_user_id: owner, item_list: [{ type: 11 }] }, owner, save)).toEqual({ kind: 'unsupported' })
    expect(await readInbound({ from_user_id: owner, item_list: [] }, owner, save)).toBeUndefined()
    expect(await readInbound({ from_user_id: ` ${owner} `, item_list: [{ type: 1, text_item: { text: 'x' } }] }, owner, save)).toEqual({ kind: 'text', text: 'x' })
  })

  it('masks user ids', () => {
    expect(maskUserId('owner123456@im.wechat')).toBe('own***56@im.wechat')
    expect(maskUserId('short@im.wechat')).toBe('s***@im.wechat')
    expect(maskUserId('noatsignatall')).toBe('noa***ll')
  })
})
