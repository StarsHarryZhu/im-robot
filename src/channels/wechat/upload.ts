/**
 * Put a file the bot sends on the WeChat CDN and build the message item that
 * shows it: ask iLink for an upload slot, encrypt the bytes with a fresh key,
 * post them to the CDN, and describe the result as an image, a video, or a
 * file to open.
 *
 * Source: adapted from `@tencent-weixin/openclaw-weixin` 2.4.10,
 * `src/cdn/upload.ts` (`uploadMediaToCdn`), `src/cdn/cdn-upload.ts`
 * (`uploadBufferToCdn`), `src/cdn/aes-ecb.ts`, `src/cdn/cdn-url.ts`
 * (`buildCdnUploadUrl`), and the items of `src/messaging/send.ts`
 * (`sendImageMessageWeixin`, `sendVideoMessageWeixin`, `sendFileMessageWeixin`)
 * (MIT License, Copyright (C) 2026 Tencent): the getuploadurl request (a random
 * `filekey`, the plain size and MD5, the padded size, no thumbnail, the key as
 * hex), AES-128-ECB with PKCS7 padding, the CDN's `x-encrypted-param` answer as
 * the download parameter, and each item's fields.
 * What dsh-weixin-ilink measured against a live account follows `dsh-weixin-ilink`
 * 0.10.3, `src/media.js` (`uploadMedia`, `mediaTypeFor`, `buildMediaItem`) (MIT
 * License, Copyright (c) 2026 dsh-weixin contributors): the upload type follows
 * the file's extension, so an image registers as an image (as a file, the
 * picture shows as expired); the CDN URL is built from `upload_param` when the
 * server gives one; the item's `aes_key` is base64 of the key's hex text (base64
 * of the raw key shows grey boxes); `upload_param` stands in when the CDN gives
 * no `x-encrypted-param`. Full license texts are in THIRD_PARTY_NOTICES.md.
 * Changes: one module; a full upload URL from the server is used only on an
 * https Tencent host or the configured CDN; video items only for the formats
 * WeChat plays (MP4 and QuickTime), other videos go as files; a file is checked
 * (a regular, non-empty file within the limit) before anything is asked of the
 * server, and fails with {@link UnsendableFileError}; one try per call, since the
 * service's outbox retries; errors name the step and the status, never a URL,
 * key, or body.
 * @module im-robot/channels/wechat/upload
 */

import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { UnsendableFileError } from '../adapter.ts'
import { ItemType, UploadMediaType, getUploadUrl } from './api.ts'
import type { MessageItem } from './api.ts'

/** Largest file sent: what the bot receives at most, too. */
export const MAX_SEND_FILE_BYTES = 100 * 1024 * 1024

/** Longest wait for one CDN upload. */
export const UPLOAD_TIMEOUT_MS = 300_000

/** How WeChat shows a file the bot sends. */
export type SendKind = 'image' | 'video' | 'file'

/** Extensions sent as pictures, which WeChat shows inline. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

/** Extensions sent as videos, which WeChat plays; any other video goes as a file. */
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(['.mp4', '.m4v', '.mov'])

/** @returns how a file is sent, by its extension. */
export function sendKindOf(path: string): SendKind {
  const extension = extname(path).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  return 'file'
}

/** getuploadurl's `media_type` for each kind. */
const UPLOAD_TYPE: Record<SendKind, number> = { image: UploadMediaType.IMAGE, video: UploadMediaType.VIDEO, file: UploadMediaType.FILE }

/**
 * Encrypt bytes for the CDN.
 * @param plaintext - the file.
 * @param key - the 16-byte key.
 * @returns the ciphertext.
 */
export function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/** Whether a URL is the configured CDN or an https Tencent host. */
function trustedUploadUrl(value: string, cdnBaseUrl: string): boolean {
  try {
    const url = new URL(value)
    if (url.origin === new URL(cdnBaseUrl).origin) return true
    return url.protocol === 'https:' && (url.hostname === 'qq.com' || url.hostname.endsWith('.qq.com'))
  } catch {
    return false
  }
}

/**
 * Where to post the encrypted bytes: built from `upload_param` on the
 * configured CDN when the server gives one, else its full URL on a trusted host.
 * @returns the URL.
 * @throws when the server gave neither, or only an untrusted full URL.
 */
export function uploadUrlOf(slot: { upload_param?: string; upload_full_url?: string }, cdnBaseUrl: string, filekey: string): string {
  const param = slot.upload_param?.trim()
  if (param) return `${cdnBaseUrl.replace(/\/+$/u, '')}/upload?encrypted_query_param=${encodeURIComponent(param)}&filekey=${encodeURIComponent(filekey)}`
  const full = slot.upload_full_url?.trim()
  if (full && trustedUploadUrl(full, cdnBaseUrl)) return full
  throw new Error(full ? 'getuploadurl gave an upload URL off the WeChat CDN' : 'getuploadurl gave no upload URL')
}

/** Read a file to send, or say why it cannot go. */
async function readSendable(path: string, maxBytes: number): Promise<Buffer> {
  let size: number
  try {
    const stats = await stat(path)
    if (!stats.isFile()) throw new UnsendableFileError(`not a regular file: ${basename(path)}`)
    size = stats.size
  } catch (error) {
    if (error instanceof UnsendableFileError) throw error
    throw new UnsendableFileError(`the file is gone: ${basename(path)}`)
  }
  if (size === 0) throw new UnsendableFileError(`the file is empty: ${basename(path)}`)
  if (size > maxBytes) throw new UnsendableFileError(`the file is over ${Math.round(maxBytes / 1024 / 1024)} MB: ${basename(path)}`)
  const data = await readFile(path)
  if (data.length > maxBytes) throw new UnsendableFileError(`the file is over ${Math.round(maxBytes / 1024 / 1024)} MB: ${basename(path)}`)
  return data
}

/** Post the encrypted bytes; @returns the download parameter. */
async function postToCdn(url: string, ciphertext: Buffer, fallback: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const follow = (): void => controller.abort()
  if (signal?.aborted === true) controller.abort()
  else signal?.addEventListener('abort', follow, { once: true })
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(ciphertext),
      signal: controller.signal,
    })
    await response.arrayBuffer().catch(() => undefined)
    if (response.status !== 200) throw new Error(`CDN upload HTTP ${response.status}`)
    const param = response.headers.get('x-encrypted-param')?.trim() || fallback?.trim()
    if (!param) throw new Error('CDN upload gave no download parameter')
    return param
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', follow)
  }
}

/** Where and as whom to upload. */
export interface UploadTarget {
  /** The account's API host. */
  baseUrl: string
  token: string
  /** The recipient's `ilink_user_id`. */
  to: string
  cdnBaseUrl: string
  timeoutMs?: number
  maxBytes?: number
  signal?: AbortSignal
}

/**
 * Upload one file and build the item that sends it.
 * @param path - the file.
 * @param target - the account, the recipient, the CDN, and the limits.
 * @returns the item for sendmessage.
 * @throws {@link UnsendableFileError} for a file that cannot go; an Error naming the step otherwise.
 */
export async function uploadFile(path: string, target: UploadTarget): Promise<MessageItem> {
  const plaintext = await readSendable(path, target.maxBytes ?? MAX_SEND_FILE_BYTES)
  const kind = sendKindOf(path)
  const key = randomBytes(16)
  const filekey = randomBytes(16).toString('hex')
  const ciphertext = encrypt(plaintext, key)
  const slot = await getUploadUrl({
    filekey,
    media_type: UPLOAD_TYPE[kind],
    to_user_id: target.to,
    rawsize: plaintext.length,
    rawfilemd5: createHash('md5').update(plaintext).digest('hex'),
    filesize: ciphertext.length,
    no_need_thumb: true,
    aeskey: key.toString('hex'),
  }, { baseUrl: target.baseUrl, token: target.token, ...(target.signal === undefined ? {} : { signal: target.signal }) })
  const url = uploadUrlOf(slot, target.cdnBaseUrl, filekey)
  const param = await postToCdn(url, ciphertext, slot.upload_param, target.timeoutMs ?? UPLOAD_TIMEOUT_MS, target.signal)
  const media = { encrypt_query_param: param, aes_key: Buffer.from(key.toString('hex'), 'utf8').toString('base64'), encrypt_type: 1 }
  switch (kind) {
    case 'image': return { type: ItemType.IMAGE, image_item: { media, mid_size: ciphertext.length } }
    case 'video': return { type: ItemType.VIDEO, video_item: { media, video_size: ciphertext.length } }
    default: return { type: ItemType.FILE, file_item: { media, file_name: basename(path), len: String(plaintext.length) } }
  }
}
