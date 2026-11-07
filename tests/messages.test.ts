import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OWNER, STRANGER, fakeHost, fakeIlink, loginAndBind, makeService, runTurn, sleep, textFrom, until } from './helpers.ts'
import type { FakeHost, FakeIlink } from './helpers.ts'
import type { ImRobot } from '../src/service.ts'
import type { BindingStore } from '../src/store.ts'

/** The user/message source the host records for a prompt this plugin sent. */
const fromPrompt = (requestId: string) => ({ source: { kind: 'user', rpcId: requestId } })

describe('messages from the chat account', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  let store: BindingStore
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
    ;({ service, store } = makeService(server, host))
    await loginAndBind(service, server, 'mom', 's1')
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('accepts only the scanner, in a private chat, and not bot echoes', async () => {
    server.push(
      textFrom(STRANGER, 'not me'),
      { ...textFrom(OWNER, 'in a group'), group_id: 'g1' },
      { ...textFrom(OWNER, 'echo'), message_type: 2 },
      textFrom(OWNER, '  '),
      textFrom(OWNER, '今天天气怎么样'),
    )
    await until(() => host.prompts.length === 1, 3000, 'one prompt')
    server.push(textFrom(STRANGER, 'later stranger'))
    await until(() => server.state.cursor === 2, 3000, 'second batch')
    await sleep(60)
    expect(host.prompts).toHaveLength(1)
    expect(host.prompts[0]).toMatchObject({ sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: '今天天气怎么样' }] })
    expect(host.prompts[0]?.requestId).toMatch(/^im-robot:mom:[0-9a-f-]{36}$/u)
  })

  it('prompts a voice message by its transcript and answers an unknown item with a notice', async () => {
    server.push(
      { from_user_id: OWNER, message_type: 1, item_list: [{ type: 3, voice_item: { text: '提醒我吃药' } }] },
      { from_user_id: OWNER, message_type: 1, item_list: [{ type: 11 }] },
    )
    await until(() => host.prompts.length === 1 && server.sent().length === 1, 3000, 'prompt and notice')
    expect(host.prompts[0]?.content[0]?.text).toBe('提醒我吃药')
    expect(server.sent()[0]).toMatch(/看不了/u)
  })

  it('emits im-robot/inbound and waits for its listeners before prompting', async () => {
    host.control.inboundDelayMs = 40
    server.push(textFrom(OWNER, 'hi'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    expect(host.order).toEqual(['inbound-start:s1:wechat', 'inbound-end:s1', 'prompt:s1'])
  })

  it('replies when the turn ends: Markdown stripped, split, with the latest context_token', async () => {
    server.push(textFrom(OWNER, 'hi', 'ctx-9'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    await until(() => server.to('sendtyping').some(call => call.body.status === 1), 3000, 'typing')
    expect(server.to('getconfig')[0]?.body).toMatchObject({ ilink_user_id: OWNER, context_token: 'ctx-9' })
    expect(server.to('sendtyping')[0]?.body).toMatchObject({ ilink_user_id: OWNER, typing_ticket: 'ticket-1', status: 1 })

    const markdown = '## 今天的安排\n\n**上午**去医院，记得带`医保卡`。\n\n- 下午休息\n- 晚上 [看新闻](https://news.example)'
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId)], markdown)
    await until(() => server.sent().length === 1, 3000, 'reply')
    expect(server.sent()[0]).toBe('今天的安排\n\n上午去医院，记得带医保卡。\n\n· 下午休息\n· 晚上 看新闻 (https://news.example)')
    const message = server.to('sendmessage')[0]!.body.msg
    expect(message).toMatchObject({ to_user_id: OWNER, context_token: 'ctx-9', message_type: 2, message_state: 2 })
    expect(message.client_id).toMatch(/^im-robot:\d+-[0-9a-f]{8}$/u)
    expect(server.to('sendmessage')[0]!.headers.authorization).toBe('Bearer bot-token-1')
    await until(() => server.to('sendtyping').some(call => call.body.status === 2), 3000, 'typing cleared')

    service.setOptions({ replyMaxChars: 12 })
    server.push(textFrom(OWNER, 'more'))
    await until(() => host.prompts.length === 2, 3000, 'second prompt')
    runTurn(service, 's1', [fromPrompt(host.prompts[1]!.requestId)], '第一句话说完了。第二句话也说完了。第三句。')
    await until(() => server.sent().length === 4, 3000, 'split reply')
    const segments = server.sent().slice(1)
    expect(segments).toEqual(['第一句话说完了。', '第二句话也说完了。', '第三句。'])
    expect(segments.every(segment => segment.length <= 12)).toBe(true)
  })

  it('keeps typing until every queued chat message has been answered', async () => {
    server.push(textFrom(OWNER, 'first'), textFrom(OWNER, 'second'))
    await until(() => host.prompts.length === 2, 3000, 'two prompts')
    const [first, second] = host.prompts
    runTurn(service, 's1', [fromPrompt(first!.requestId)], 'answer one')
    await until(() => server.sent().length === 1, 3000, 'first reply')
    await sleep(60)
    expect(server.to('sendtyping').some(call => call.body.status === 2)).toBe(false)
    runTurn(service, 's1', [fromPrompt(second!.requestId)], 'answer two')
    await until(() => server.to('sendtyping').some(call => call.body.status === 2), 3000, 'typing cleared')
    expect(server.sent()).toEqual(['answer one', 'answer two'])
  })

  it('pauses on a stale token instead of polling again at once', async () => {
    const before = server.to('getupdates').length
    server.state.stale = 1
    await until(() => host.warnings.some(message => message.includes('token is stale')), 3000, 'stale warning')
    server.push(textFrom(OWNER, 'after the pause'))
    await until(() => host.prompts.length === 1, 3000, 'prompt after the pause')
    expect(server.to('getupdates').length).toBeGreaterThan(before)
  })

  it('sends a marked block whole and never shows the markers', async () => {
    service.setOptions({ replyMaxChars: 10 })
    server.push(textFrom(OWNER, '今天怎么安排'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId)], '说明：<keep>\n- 早上吃药\n- 中午散步\n- 晚上早睡\n</keep>好的。')
    await until(() => server.sent().length === 3, 3000, 'three messages')
    expect(server.sent()).toEqual(['说明：', '· 早上吃药\n· 中午散步\n· 晚上早睡', '好的。'])
  })

  it('sends a notice when the turn produced no text, and ignores turns of other sessions', async () => {
    server.push(textFrom(OWNER, 'hi'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    runTurn(service, 's2', [fromPrompt(host.prompts[0]!.requestId)], 'wrong session')
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId)], '', 'error')
    await until(() => server.sent().length === 1, 3000, 'notice')
    await sleep(40)
    expect(server.sent()).toEqual([expect.stringMatching(/没有得到回复/u)])
  })

  it('tells the person when the prompt is refused', async () => {
    host.control.failPrompt = true
    server.push(textFrom(OWNER, 'hi'))
    await until(() => server.sent().length === 1, 3000, 'notice')
    expect(server.sent()[0]).toMatch(/没能交给助理/u)
    expect(host.warnings.some(message => message.includes('could not prompt'))).toBe(true)
  })

  it('stores the latest context_token and the cursor', async () => {
    server.push(textFrom(OWNER, 'hi', 'ctx-latest'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    const stored = JSON.parse(readFileSync(store.pathOf('mom'), 'utf8'))
    expect(stored.channelState).toMatchObject({ contextToken: 'ctx-latest', syncBuf: 'buf-1', ilinkUserId: OWNER })
    expect(stored.lastInputFromChat).toBe(true)
  })
})

describe('reminders', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
    ;({ service } = makeService(server, host))
    await loginAndBind(service, server, 'mom', 's1')
    server.push(textFrom(OWNER, '明早八点提醒我吃药'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId)], '好的，明早八点提醒你。')
    await until(() => server.sent().length === 1, 3000, 'reply')
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('pushes the answer to a reminder when the latest input came from the chat', async () => {
    runTurn(service, 's1', [{ source: { kind: 'schedule' } }], '**提醒**：该吃药了。')
    await until(() => server.sent().length === 2, 3000, 'push')
    expect(server.sent()[1]).toBe('提醒：该吃药了。')
  })

  it('tries a failed reminder push once and never again', async () => {
    server.state.failSend = true
    runTurn(service, 's1', [{ source: { kind: 'schedule' } }], '该吃药了。')
    await until(() => server.to('sendmessage').length === 2, 3000, 'one attempt')
    await sleep(150)
    expect(server.to('sendmessage')).toHaveLength(2)
    expect(host.warnings.some(message => message.includes('reminder push (not retried) failed'))).toBe(true)
  })

  it('does not push when the latest input came from somewhere else', async () => {
    runTurn(service, 's1', [{ source: { kind: 'user', rpcId: 'web-request' } }], '网页上的回答')
    runTurn(service, 's1', [{ source: { kind: 'schedule' } }], '该吃药了。')
    await sleep(80)
    expect(server.sent()).toHaveLength(1)
  })
})

describe('follow-ups', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  let store: BindingStore
  const lastInputFromChat = (): boolean => JSON.parse(readFileSync(store.pathOf('mom'), 'utf8')).lastInputFromChat
  const settled = { source: { kind: 'subagent-settled', form: 'notice', summary: '子代理完成', senderSessionId: 'worker-1' } }
  const hostNote = { source: { kind: 'host-note', plugin: 'dsh-assisstant' } }
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
    ;({ service, store } = makeService(server, host))
    await loginAndBind(service, server, 'mom', 's1')
    server.push(textFrom(OWNER, '周四下午两点看牙医，记一下', 'ctx-ask'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId)], '好，我这就记下来。')
    await until(() => server.sent().length === 1, 3000, 'acknowledgement')
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('pushes the answer to a worker\'s report, stripped and split like a reply', async () => {
    const long = `**记好了**：周四 14:00 看牙医。${'记得带上医保卡和上次的病历，'.repeat(6)}到时候我会提前提醒你。`
    runTurn(service, 's1', [settled], long)
    await until(() => server.sent().slice(1).join('') === long.replace(/\*\*/g, ''), 3000, 'follow-up')
    const pushed = server.sent().slice(1)
    expect(pushed.length).toBeGreaterThan(1)
    expect(pushed.every(segment => [...segment].length <= 100)).toBe(true)
    expect(server.to('sendmessage').at(-1)!.body.msg.context_token).toBe('ctx-ask')
  })

  it('pushes the answer to another agent\'s or a team member\'s message', async () => {
    runTurn(service, 's1', [{ source: { kind: 'agent-message', form: 'relay', senderSessionId: 'worker-1' } }], '查好了，明天晴。')
    runTurn(service, 's1', [{ source: { kind: 'team-message' } }], '买菜的事安排好了。')
    await until(() => server.sent().length === 3, 3000, 'follow-ups')
    expect(server.sent().slice(1)).toEqual(['查好了，明天晴。', '买菜的事安排好了。'])
  })

  it('sends nothing when the follow-up turn has no text', async () => {
    runTurn(service, 's1', [settled], '')
    runTurn(service, 's1', [settled], '<keep></keep>')
    await sleep(100)
    expect(server.sent()).toEqual(['好，我这就记下来。'])
  })

  it('keeps a follow-up in the outbox until it is sent', async () => {
    server.state.failSend = true
    runTurn(service, 's1', [settled], '记好了，周四 14:00 看牙医。')
    await until(() => server.to('sendmessage').length === 2, 3000, 'failed attempt')
    server.state.failSend = false
    await until(() => server.sent().length === 3, 3000, 'retried after the next poll')
    expect(server.sent()[2]).toBe('记好了，周四 14:00 看牙医。')
  })

  it('treats a host note as neither web input nor a reason to stay quiet', async () => {
    runTurn(service, 's1', [hostNote, { source: { kind: 'time-context' } }], '早上好，今天有一件事：看牙医。')
    await until(() => server.sent().length === 2, 3000, 'daily brief')
    expect(server.sent()[1]).toBe('早上好，今天有一件事：看牙医。')
    expect(lastInputFromChat()).toBe(true)
    runTurn(service, 's1', [{ source: { kind: 'schedule' } }], '该出发去看牙医了。')
    await until(() => server.sent().length === 3, 3000, 'reminder after the brief')
  })

  it('sends nothing for a host note whose turn has no text', async () => {
    runTurn(service, 's1', [hostNote], '')
    await sleep(100)
    expect(server.sent()).toEqual(['好，我这就记下来。'])
    expect(lastInputFromChat()).toBe(true)
  })

  it('keeps the answer to a host note in the outbox until it is sent', async () => {
    server.state.failSend = true
    runTurn(service, 's1', [hostNote], '今天的简报。')
    await until(() => server.to('sendmessage').length === 2, 3000, 'failed attempt')
    server.state.failSend = false
    await until(() => server.sent().length === 3, 3000, 'retried after the next poll')
    expect(server.sent()[2]).toBe('今天的简报。')
  })

  it('stays quiet after web input, and still treats other user requests as web input', async () => {
    runTurn(service, 's1', [{ source: { kind: 'user', rpcId: 'web-request' } }], '网页上的回答')
    expect(lastInputFromChat()).toBe(false)
    runTurn(service, 's1', [settled], '记好了。')
    runTurn(service, 's1', [hostNote], '今天的简报。')
    await sleep(100)
    expect(server.sent()).toEqual(['好，我这就记下来。'])
    expect(lastInputFromChat()).toBe(false)
  })

  it('answers a turn that mixes a chat message and a worker\'s report once, as a reply', async () => {
    server.push(textFrom(OWNER, '还有周五呢？'))
    await until(() => host.prompts.length === 2, 3000, 'second prompt')
    runTurn(service, 's1', [settled, fromPrompt(host.prompts[1]!.requestId)], '周四看牙医，周五没有安排。')
    await until(() => server.sent().length === 2, 3000, 'reply')
    await sleep(80)
    expect(server.sent()).toEqual(['好，我这就记下来。', '周四看牙医，周五没有安排。'])
  })
})

describe('the cursor and options', () => {
  let server: FakeIlink
  let host: FakeHost
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
  })
  afterEach(async () => {
    await server.close()
  })

  it('resumes from the stored sync buf after a restart', async () => {
    const first = makeService(server, host)
    await loginAndBind(first.service, server, 'mom', 's1')
    server.push(textFrom(OWNER, 'one'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    expect(JSON.parse(readFileSync(first.store.pathOf('mom'), 'utf8')).channelState.syncBuf).toBe('buf-1')
    first.service.dispose()

    const before = server.to('getupdates').length
    const second = makeService(server, host, { directory: first.directory })
    second.service.start()
    expect(second.service.status('mom')).toEqual({ bound: true, user: 'own***56@im.wechat', sessionId: 's1', connected: false, sendMode: 'queue', commands: true, enabled: true, replyMaxChars: 100, lastInboundAt: expect.any(Number), windowClosesAt: expect.any(Number) })
    await until(() => server.to('getupdates').length > before, 3000, 'resumed polling')
    expect(server.to('getupdates')[before]?.body.get_updates_buf).toBe('buf-1')
    server.push(textFrom(OWNER, 'two'))
    await until(() => host.prompts.length === 2, 3000, 'prompt after restart')
    second.service.dispose()
  })

  it('stops and resumes receiving with enabled, and validates replyMaxChars', async () => {
    const { service } = makeService(server, host)
    await loginAndBind(service, server, 'mom', 's1')
    await until(() => server.to('getupdates').length > 0, 3000, 'polling')
    service.setOptions({ enabled: false })
    await sleep(60)
    const polls = server.to('getupdates').length
    server.push(textFrom(OWNER, 'while off'))
    await sleep(120)
    expect(server.to('getupdates').length).toBe(polls)
    expect(host.prompts).toHaveLength(0)

    service.setOptions({ enabled: true })
    await until(() => host.prompts.length === 1, 3000, 'prompt after enabling')
    expect(host.prompts[0]?.content[0]?.text).toBe('while off')

    expect(() => service.setOptions({ replyMaxChars: 3 })).toThrow(RangeError)
    expect(() => service.setOptions({ replyMaxChars: 20.5 })).toThrow(RangeError)
    service.dispose()
  })
})
