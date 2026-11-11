import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decrypt } from '../src/channels/wechat/media.ts'
import { encrypt, sendKindOf, uploadUrlOf } from '../src/channels/wechat/upload.ts'
import { OWNER, fakeHost, fakeIlink, loginAndBind, makeService, runTurn, sleep, tempDir, textFrom, until } from './helpers.ts'
import type { FakeHost, FakeIlink } from './helpers.ts'
import type { ImRobot } from '../src/service.ts'
import type { BindingStore } from '../src/store.ts'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('a small picture')])
const PDF = Buffer.from('%PDF-1.4 a short report, longer than one AES block')
const MP4 = Buffer.from('....ftypisom a tiny video')

/** The key an item carries: `aes_key` is base64 of the key's hex text. */
function keyOf(media: { aes_key: string }): Buffer {
  const hex = Buffer.from(media.aes_key, 'base64').toString('utf8')
  expect(hex).toMatch(/^[0-9a-f]{32}$/u)
  return Buffer.from(hex, 'hex')
}

describe('the pieces of an upload', () => {
  it('sends pictures and playable videos as such, and everything else as a file', () => {
    expect(['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.bmp'].map(sendKindOf)).toEqual(Array(6).fill('image'))
    expect(['a.mp4', 'b.MOV', 'c.m4v'].map(sendKindOf)).toEqual(Array(3).fill('video'))
    expect(['a.mkv', 'b.avi', 'c.pdf', 'd.silk', 'e.mp3', 'noext'].map(sendKindOf)).toEqual(Array(6).fill('file'))
  })

  it('encrypts so that the download side decrypts it', () => {
    const key = Buffer.from('0123456789abcdef')
    expect(decrypt(encrypt(PDF, key), key).equals(PDF)).toBe(true)
    expect(encrypt(Buffer.alloc(16), key)).toHaveLength(32)
  })

  it('posts to the configured CDN or an https Tencent host only', () => {
    const cdn = 'https://novac2c.cdn.weixin.qq.com/c2c'
    expect(uploadUrlOf({ upload_param: 'p q', upload_full_url: 'https://up.weixin.qq.com/x' }, cdn, 'k1'))
      .toBe(`${cdn}/upload?encrypted_query_param=p%20q&filekey=k1`)
    expect(uploadUrlOf({ upload_full_url: 'https://up.weixin.qq.com/x?a=1' }, cdn, 'k1')).toBe('https://up.weixin.qq.com/x?a=1')
    expect(() => uploadUrlOf({ upload_full_url: 'https://qq.com.evil.example/x' }, cdn, 'k1')).toThrow(/off the WeChat CDN/u)
    expect(() => uploadUrlOf({ upload_full_url: 'http://up.weixin.qq.com/x' }, cdn, 'k1')).toThrow(/off the WeChat CDN/u)
    expect(() => uploadUrlOf({}, cdn, 'k1')).toThrow(/no upload URL/u)
  })
})

describe('sending files', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  let store: BindingStore
  let folder: string
  const file = (name: string, data: Buffer): string => {
    const path = join(folder, name)
    writeFileSync(path, data)
    return path
  }
  const stored = () => store.read('mom', () => undefined)
  const fromPrompt = (requestId: string) => ({ source: { kind: 'user', rpcId: requestId } })

  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
    ;({ service, store } = makeService(server, host, { autoPush: false, replyMaxChars: 50, silentReply: '[silent]', sendMaxBytes: 1024 }))
    await loginAndBind(service, server, 'mom', 's1')
    // The account writes once, so the chat has a context token, and its answer goes out; then the record starts clean.
    server.push(textFrom(OWNER, 'hi', 'ctx-1'))
    await until(() => host.prompts.length === 1, 3000, 'first prompt')
    runTurn(service, 's1', [fromPrompt(host.prompts[0]!.requestId)], '好')
    await until(() => server.sent().length === 1 && stored()?.outbox.length === 0, 3000, 'first reply')
    server.calls.length = 0
    folder = tempDir('im-robot-send-')
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
    rmSync(folder, { recursive: true, force: true })
  })

  it('uploads each file encrypted and sends it as its kind, after the text', async () => {
    const paths = [file('photo.png', PNG), file('report.pdf', PDF), file('clip.mp4', MP4)]
    service.send('mom', '这是你要的东西', { files: paths })
    await until(() => server.items().length === 4, 3000, 'text and three files')
    const [text, image, document, video] = server.items()
    expect(text.text_item.text).toBe('这是你要的东西')
    expect([image.type, document.type, video.type]).toEqual([2, 4, 5])

    const slots = server.to('getuploadurl').map(call => call.body)
    expect(slots.map(slot => slot.media_type)).toEqual([1, 3, 2])
    for (const [index, data] of [PNG, PDF, MP4].entries()) {
      const slot = slots[index]
      const upload = server.uploads[index]!
      const media = [image.image_item, document.file_item, video.video_item][index].media
      const key = keyOf(media)
      // The upload slot and the CDN agree, and the CDN's answer is what the item points at.
      expect(slot).toMatchObject({
        to_user_id: OWNER, rawsize: data.length, rawfilemd5: createHash('md5').update(data).digest('hex'),
        filesize: upload.bytes.length, no_need_thumb: true, aeskey: key.toString('hex'),
      })
      expect(upload).toMatchObject({ param: `up-${index + 1}`, filekey: slot.filekey })
      expect(media).toMatchObject({ encrypt_query_param: `down-up-${index + 1}`, encrypt_type: 1 })
      expect(decrypt(upload.bytes, key).equals(data)).toBe(true)
    }
    expect(image.image_item.mid_size).toBe(server.uploads[0]!.bytes.length)
    expect(document.file_item).toMatchObject({ file_name: 'report.pdf', len: String(PDF.length) })
    expect(video.video_item.video_size).toBe(server.uploads[2]!.bytes.length)
    expect(server.to('sendmessage').every(call => call.body.msg.context_token === 'ctx-1')).toBe(true)
    await until(() => stored()?.outbox.length === 0, 3000, 'outbox emptied')
  })

  it('sends files without text, and other videos as files', async () => {
    service.send('mom', '', { files: [file('movie.mkv', MP4)] })
    await until(() => server.items().length === 1, 3000, 'file')
    expect(server.items()[0]).toMatchObject({ type: 4, file_item: { file_name: 'movie.mkv' } })
  })

  it('refuses what it could not send, in words the caller can act on', () => {
    mkdirSync(join(folder, 'sub'))
    const empty = file('empty.txt', Buffer.alloc(0))
    expect(() => service.send('mom', '', {})).toThrow(/text or a file/u)
    expect(() => service.send('mom', 'x', { files: 'a.png' as never })).toThrow(/array/u)
    expect(() => service.send('mom', 'x', { files: ['photo.png'] })).toThrow(/absolute/u)
    expect(() => service.send('mom', 'x', { files: [join(folder, 'missing.png')] })).toThrow(/no file/u)
    expect(() => service.send('mom', 'x', { files: [join(folder, 'sub')] })).toThrow(/regular file/u)
    expect(() => service.send('mom', 'x', { files: [empty] })).toThrow(/empty/u)
    expect(() => service.route('mom', { chat: false, files: [file('a.png', PNG)] })).toThrow(/chat: true/u)
    expect(stored()?.outbox).toEqual([])
  })

  it('sends routed files after the reply to a chat message', async () => {
    server.push(textFrom(OWNER, '把照片发我'))
    await until(() => host.prompts.length === 2, 3000, 'prompt')
    service.observe('s1', { type: 'turn/start', data: { turn: 1 } })
    service.observe('s1', { type: 'user/message', data: fromPrompt(host.prompts[1]!.requestId) })
    expect(service.route('mom', { chat: true, files: [file('photo.png', PNG)] })).toBe(true)
    service.observe('s1', { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '照片在这里' }] } } })
    service.observe('s1', { type: 'turn/end', data: { reason: 'completed' } })
    await until(() => server.items().length === 2, 3000, 'reply and photo')
    expect(server.items().map(item => item.type)).toEqual([1, 2])
    expect(server.sent()).toEqual(['照片在这里'])
  })

  it('sends routed files from a turn no chat message started, even when its text is the silent reply', async () => {
    service.observe('s1', { type: 'turn/start', data: { turn: 2 } })
    service.observe('s1', { type: 'user/message', data: { source: { kind: 'host-note', plugin: 'p' } } })
    expect(service.route('mom', { chat: true, files: [file('report.pdf', PDF)] })).toBe(true)
    service.observe('s1', { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '[silent]' }] } } })
    service.observe('s1', { type: 'turn/end', data: { reason: 'completed' } })
    await until(() => server.items().length === 1, 3000, 'file only')
    expect(server.items()[0].type).toBe(4)
    await sleep(60)
    expect(server.sent()).toEqual([])
  })

  it('sends a file again without a stale context token', async () => {
    server.state.staleSend = 1
    service.send('mom', '', { files: [file('photo.png', PNG)] })
    await until(() => server.to('sendmessage').length === 2, 3000, 'retried')
    expect(server.to('sendmessage').map(call => call.body.msg.context_token)).toEqual(['ctx-1', undefined])
    await until(() => stored()?.outbox.length === 0, 3000, 'sent')
  })

  it('keeps a refused file on disk and sends it after the next message', async () => {
    server.state.refuseSend = true
    const photo = file('photo.png', PNG)
    service.send('mom', '', { files: [photo] })
    await until(() => service.status('mom').lastError !== undefined, 3000, 'waiting')
    expect(stored()?.outbox).toMatchObject([{ text: '', file: photo, failures: 0 }])
    server.state.refuseSend = false
    server.push(textFrom(OWNER, '在吗', 'ctx-new'))
    await until(() => stored()?.outbox.length === 0, 3000, 'sent after the next message')
    expect(server.to('sendmessage').at(-1)?.body.msg).toMatchObject({ context_token: 'ctx-new', item_list: [{ type: 2 }] })
  })

  it('drops a file that is gone or too large by the time it goes, and sends what follows', async () => {
    server.state.refuseSend = true
    const gone = file('gone.pdf', PDF)
    const large = file('large.pdf', Buffer.alloc(2048, 1))
    service.send('mom', '', { files: [gone, large] })
    service.send('mom', '后面的话')
    await until(() => service.status('mom').lastError !== undefined, 3000, 'waiting')
    rmSync(gone)
    // The refused try uploaded the first file once; nothing is uploaded after this.
    const slots = server.to('getuploadurl').length
    server.state.refuseSend = false
    server.push(textFrom(OWNER, '在吗', 'ctx-new'))
    // The fake server records a send before the client sees the answer.
    await until(() => server.sent().includes('后面的话') && stored()?.outbox.length === 0, 3000, 'text after the dropped files')
    expect(server.to('getuploadurl')).toHaveLength(slots)
    expect(host.warnings.filter(message => message.includes('dropped a file'))).toHaveLength(2)
    expect(stored()?.lastSendFailure?.error).toMatch(/large\.pdf/u)
  })

  it('retries a file whose upload failed', async () => {
    server.state.failUploads = 1
    service.send('mom', '', { files: [file('photo.png', PNG)] })
    await until(() => stored()?.outbox[0]?.failures === 1, 3000, 'failure counted')
    expect(stored()?.lastSendFailure?.error).toMatch(/CDN upload HTTP 500/u)
    await until(() => server.items().length === 1, 3000, 'sent on retry')
    // Each try asks for a fresh slot.
    expect(server.to('getuploadurl')).toHaveLength(2)
  })

  it('falls back to the upload parameter when the CDN names no download parameter', async () => {
    server.state.noDownloadParam = true
    service.send('mom', '', { files: [file('photo.png', PNG)] })
    await until(() => server.items().length === 1, 3000, 'sent')
    expect(server.items()[0].image_item.media.encrypt_query_param).toBe('up-1')
  })

  it('does not post to a full upload URL off the WeChat CDN', async () => {
    server.state.uploadUrl = 'foreign'
    service.send('mom', '', { files: [file('photo.png', PNG)] })
    await until(() => stored()?.outbox[0]?.failures === 1, 3000, 'failure counted')
    expect(server.uploads).toEqual([])
    expect(stored()?.lastSendFailure?.error).toMatch(/off the WeChat CDN/u)
  })
})
