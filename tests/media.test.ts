import { createCipheriv } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanFileName, decrypt, downloadUrl, formatBytes, parseAesKey, saveMedia } from '../src/channels/wechat/media.ts'
import { OWNER, fakeHost, fakeIlink, loginAndBind, makeService, tempDir, until } from './helpers.ts'
import type { FakeHost, FakeIlink } from './helpers.ts'
import type { ImRobot } from '../src/service.ts'

const KEY = Buffer.from('0123456789abcdef', 'ascii')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('picture')])

/** What the CDN holds for a plain file. */
function encrypted(data: Buffer, key = KEY): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

/** `aes_key` as it comes on files, voice, and video: base64 of the hex text. */
const hexKey = Buffer.from(KEY.toString('hex'), 'ascii').toString('base64')
/** `aes_key` as it comes on images: base64 of the raw key. */
const rawKey = KEY.toString('base64')

describe('the pieces of a download', () => {
  it('reads both encodings of the key and decrypts', () => {
    expect(parseAesKey(rawKey).equals(KEY)).toBe(true)
    expect(parseAesKey(hexKey).equals(KEY)).toBe(true)
    expect(() => parseAesKey(Buffer.from('short').toString('base64'))).toThrow(/密钥/u)
    expect(decrypt(encrypted(PNG), KEY).equals(PNG)).toBe(true)
  })

  it('fetches only from Tencent or the configured CDN', () => {
    const cdn = 'https://novac2c.cdn.weixin.qq.com/c2c'
    expect(downloadUrl({ full_url: 'https://other.cdn.weixin.qq.com/x?a=1' }, cdn)).toBe('https://other.cdn.weixin.qq.com/x?a=1')
    expect(downloadUrl({ full_url: 'https://evil.example/x', encrypt_query_param: 'p q' }, cdn)).toBe(`${cdn}/download?encrypted_query_param=p%20q`)
    expect(downloadUrl({ full_url: 'https://qq.com.evil.example/x', encrypt_query_param: 'p' }, cdn)).toBe(`${cdn}/download?encrypted_query_param=p`)
    expect(downloadUrl({ full_url: 'http://x.weixin.qq.com/x', encrypt_query_param: 'p' }, cdn)).toBe(`${cdn}/download?encrypted_query_param=p`)
    expect(() => downloadUrl({ full_url: 'https://evil.example/x' }, cdn)).toThrow(/下载地址/u)
  })

  it('keeps a sender\'s file name inside the folder', () => {
    expect(cleanFileName('../../etc/passwd', 'f')).toBe('passwd')
    expect(cleanFileName('..\\..\\boot.ini', 'f')).toBe('boot.ini')
    expect(cleanFileName('..', 'f')).toBe('f')
    expect(cleanFileName('.ssh', 'f')).toBe('ssh')
    expect(cleanFileName('a:b*c?.txt', 'f')).toBe('a-b-c-.txt')
    expect(cleanFileName(undefined, 'f')).toBe('f')
    const long = cleanFileName(`${'长'.repeat(200)}.pdf`, 'f')
    expect([...long]).toHaveLength(120)
    expect(long.endsWith('.pdf')).toBe(true)
  })

  it('writes sizes plainly', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(1_258_291)).toBe('1.2 MB')
  })

  it('reports a file over the limit and saves nothing', async () => {
    const server = await fakeIlink()
    const directory = join(tempDir(), 'temp')
    server.cdn.set('big', encrypted(Buffer.alloc(2048)))
    const saved = await saveMedia({ type: 4, file_item: { file_name: 'big.bin', media: { encrypt_query_param: 'big', aes_key: hexKey } } }, {
      directory, cdnBaseUrl: server.cdnBaseUrl, now: new Date(), maxBytes: 1024,
    })
    expect(saved).toMatchObject({ ok: false, kind: 'file', name: 'big.bin', reason: expect.stringContaining('超过') })
    expect(existsSync(directory)).toBe(false)
    await server.close()
  })

  it('reports bytes that do not decrypt, without the key', async () => {
    const server = await fakeIlink()
    server.cdn.set('bad', Buffer.from('not encrypted at all'))
    const saved = await saveMedia({ type: 5, video_item: { media: { encrypt_query_param: 'bad', aes_key: hexKey } } }, {
      directory: tempDir(), cdnBaseUrl: server.cdnBaseUrl, now: new Date(),
    })
    expect(saved).toMatchObject({ ok: false, kind: 'video' })
    expect(JSON.stringify(saved)).not.toContain(hexKey)
    await server.close()
  })
})

describe('media from the chat account', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  let directory: string
  const promptText = (index: number): string => host.prompts[index]?.content[0]?.text ?? ''
  /** The path the text names: a line's text between "：" and "，". */
  const pathIn = (text: string): string => /：(\/[^，]+)，/u.exec(text)?.[1] ?? ''

  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
    ;({ service, directory } = makeService(server, host))
    await loginAndBind(service, server, 'mom', 's1')
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  it('saves an image and names it in the prompt, in the plugin\'s folder by default', async () => {
    server.cdn.set('img', encrypted(PNG))
    server.push({ from_user_id: OWNER, message_type: 1, context_token: 'c', item_list: [{ type: 2, image_item: { aeskey: KEY.toString('hex'), media: { encrypt_query_param: 'img' } } }] })
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    const path = pathIn(promptText(0))
    expect(promptText(0)).toContain('微信发来的图片')
    expect(path.startsWith(join(directory, 'media', 'mom'))).toBe(true)
    expect(path.endsWith('-image.png')).toBe(true)
    expect(readFileSync(path).equals(PNG)).toBe(true)
  })

  it('saves in the folder the binding names, with the words sent alongside', async () => {
    const folder = join(tempDir(), 'workspace', 'temp')
    service.setBindingOptions('mom', { mediaDir: folder })
    const content = Buffer.from('季度报告')
    server.cdn.set('doc', encrypted(content))
    server.push({
      from_user_id: OWNER,
      message_type: 1,
      item_list: [
        { type: 1, text_item: { text: '帮我看看这个' } },
        { type: 4, file_item: { file_name: '../报告.pdf', media: { encrypt_query_param: 'doc', aes_key: hexKey } } },
      ],
    })
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    const [words, line] = promptText(0).split('\n')
    expect(words).toBe('帮我看看这个')
    expect(line).toContain('微信发来的文件')
    expect(line).toContain('12 B')
    const path = pathIn(promptText(0))
    expect(dirname(path)).toBe(folder)
    expect(path.endsWith('-报告.pdf')).toBe(true)
    expect(readFileSync(path).equals(content)).toBe(true)
  })

  it('refuses a relative media folder and writes nothing when the folder is unchanged', async () => {
    expect(() => service.setBindingOptions('mom', { mediaDir: 'temp' })).toThrow(/absolute/u)
    const folder = join(tempDir(), 'temp')
    service.setBindingOptions('mom', { mediaDir: folder })
    const stat = readFileSync(join(directory, 'mom.json'), 'utf8')
    service.setBindingOptions('mom', { mediaDir: folder })
    expect(readFileSync(join(directory, 'mom.json'), 'utf8')).toBe(stat)
    expect(JSON.parse(stat).options.mediaDir).toBe(folder)
  })

  it('keeps two files of one name in one second apart', async () => {
    server.cdn.set('a', encrypted(Buffer.from('first')))
    server.cdn.set('b', encrypted(Buffer.from('second')))
    const file = (query: string) => ({ type: 4, file_item: { file_name: 'same.txt', media: { encrypt_query_param: query, aes_key: hexKey } } })
    server.push({ from_user_id: OWNER, message_type: 1, item_list: [file('a'), file('b')] })
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    const lines = promptText(0).split('\n')
    expect(lines).toHaveLength(2)
    expect(readFileSync(pathIn(lines[0]!), 'utf8')).toBe('first')
    expect(readFileSync(pathIn(lines[1]!), 'utf8')).toBe('second')
    expect(readdirSync(dirname(pathIn(lines[0]!))).filter(name => name.endsWith('.part'))).toEqual([])
  })

  it('takes a voice message by its transcript and keeps the audio', async () => {
    server.cdn.set('v', encrypted(Buffer.from('silk bytes')))
    server.push({ from_user_id: OWNER, message_type: 1, item_list: [{ type: 3, voice_item: { text: '提醒我吃药', media: { encrypt_query_param: 'v', aes_key: hexKey } } }] })
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    expect(promptText(0).split('\n')[0]).toBe('提醒我吃药')
    expect(promptText(0)).toContain('微信发来的语音')
    expect(pathIn(promptText(0)).endsWith('-voice.silk')).toBe(true)
  })

  it('still takes a voice message by its transcript when its audio cannot be fetched', async () => {
    server.push({ from_user_id: OWNER, message_type: 1, item_list: [{ type: 3, voice_item: { text: '提醒我吃药', media: { encrypt_query_param: 'gone', aes_key: hexKey } } }] })
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    expect(promptText(0)).toBe('提醒我吃药')
  })

  it('saves a video', async () => {
    server.cdn.set('m', encrypted(Buffer.from('mp4 bytes')))
    server.push({ from_user_id: OWNER, message_type: 1, item_list: [{ type: 5, video_item: { media: { encrypt_query_param: 'm', aes_key: hexKey } } }] })
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    expect(promptText(0)).toContain('微信发来的视频')
    expect(readFileSync(pathIn(promptText(0)), 'utf8')).toBe('mp4 bytes')
  })

  it('tells the session when a file could not be saved, so it can tell the person', async () => {
    server.push({ from_user_id: OWNER, message_type: 1, item_list: [{ type: 4, file_item: { file_name: '合同.pdf', media: { encrypt_query_param: 'gone', aes_key: hexKey } } }] })
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    expect(promptText(0)).toMatch(/微信发来的文件「合同\.pdf」没能保存/u)
    expect(server.sent()).toEqual([])
  })

  it('reads a quote: its words, and the file it points to', async () => {
    server.cdn.set('q', encrypted(PNG, KEY))
    server.push({
      from_user_id: OWNER,
      message_type: 1,
      item_list: [{
        type: 1,
        text_item: { text: '这张是哪天的' },
        ref_msg: { title: '一张照片', message_item: { type: 2, image_item: { media: { encrypt_query_param: 'q', aes_key: rawKey } } } },
      }],
    })
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    const lines = promptText(0).split('\n')
    expect(lines[0]).toBe('（引用：一张照片）')
    expect(lines[1]).toContain('引用的图片')
    expect(readFileSync(pathIn(lines[1]!)).equals(PNG)).toBe(true)
    expect(lines[2]).toBe('这张是哪天的')
  })
})

describe('files the conversation shows', () => {
  let server: FakeIlink
  let host: FakeHost
  let service: ImRobot
  beforeEach(async () => {
    server = await fakeIlink()
    host = fakeHost({ s1: null })
    host.control.attachments = true
    ;({ service } = makeService(server, host))
    await loginAndBind(service, server, 'mom', 's1')
  })
  afterEach(async () => {
    service.dispose()
    await server.close()
  })

  const imageMessage = (query: string) => ({ from_user_id: OWNER, message_type: 1, context_token: 'c', item_list: [{ type: 2, image_item: { aeskey: KEY.toString('hex'), media: { encrypt_query_param: query } } }] })

  it('puts an image into the prompt itself, after the text that names its file', async () => {
    server.cdn.set('img', encrypted(PNG))
    server.push(imageMessage('img'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    const [text, image] = host.prompts[0]!.content
    expect(text!.text).toContain('微信发来的图片')
    expect(image).toMatchObject({ type: 'image', mediaType: 'image/png', name: 'image.png' })
    expect(Buffer.from(image!.data!, 'base64').equals(PNG)).toBe(true)
  })

  it('uploads any other file to the session and attaches it by receipt, under its own name', async () => {
    const content = Buffer.from('季度报告')
    server.cdn.set('doc', encrypted(content))
    server.push({ from_user_id: OWNER, message_type: 1, item_list: [{ type: 4, file_item: { file_name: '报告.pdf', media: { encrypt_query_param: 'doc', aes_key: hexKey } } }] })
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    expect(host.uploads).toHaveLength(1)
    expect(host.uploads[0]).toMatchObject({ sessionId: 's1', name: '报告.pdf', receiptId: 'receipt-1' })
    expect(host.uploads[0]!.bytes.equals(content)).toBe(true)
    expect(host.prompts[0]!.content[1]).toEqual({ type: 'file', receiptId: 'receipt-1' })
  })

  it('leaves out an image over the host\'s limit, keeping it named in the text', async () => {
    server.cdn.set('big', encrypted(Buffer.concat([PNG, Buffer.alloc(2048)])))
    server.push(imageMessage('big'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    expect(host.prompts[0]!.content).toHaveLength(1)
    expect(host.prompts[0]!.content[0]!.text).toContain('微信发来的图片')
  })

  it('sends the text alone when the session refuses the attachments', async () => {
    host.control.refuseAttachments = true
    server.cdn.set('img', encrypted(PNG))
    server.push(imageMessage('img'))
    await until(() => host.prompts.length === 1, 3000, 'text-only prompt')
    expect(host.prompts[0]!.content).toHaveLength(1)
    expect(host.warnings.some(line => line.includes('without its attachments'))).toBe(true)
  })

  it('attaches nothing on a host without the services', async () => {
    host.control.attachments = false
    server.cdn.set('img', encrypted(PNG))
    server.push(imageMessage('img'))
    await until(() => host.prompts.length === 1, 3000, 'prompt')
    expect(host.prompts[0]!.content).toHaveLength(1)
  })
})
