/**
 * Tencent iLink bot API over HTTP: the wire types and one function per endpoint
 * a text channel needs.
 *
 * Source: adapted from `@tencent-weixin/openclaw-weixin` 2.4.10,
 * `src/api/api.ts` and `src/api/types.ts` (MIT License, Copyright (C) 2026
 * Tencent; full text in THIRD_PARTY_NOTICES.md). The request shapes, headers,
 * endpoints, and timeouts follow that release; the per-request `X-WECHAT-UIN`
 * is random there and here.
 * Changes: merged into one module; kept only getupdates, sendmessage,
 * getconfig, sendtyping, get_bot_qrcode, and get_qrcode_status (no media
 * upload, no notifystart/notifystop; media.ts downloads what is received); dropped package.json discovery, the
 * OpenClaw config (bot agent, route tag), and debug logging; the identity
 * values are constants; errors carry the endpoint and status only, never a
 * body or token; base URLs from the server are accepted only on Tencent hosts.
 * @module im-robot/channels/wechat/api
 */

import { randomBytes } from 'node:crypto'

/** The fixed iLink API host; login always starts here. */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** iLink app id for bot channels, as openclaw-weixin declares it. */
const ILINK_APP_ID = 'bot'

/**
 * The openclaw-weixin release this protocol layer follows. It is what the
 * client-version header and `channel_version` report, since that is the
 * protocol the server should expect; `bot_agent` names this plugin.
 */
const PROTOCOL_VERSION = '2.4.10'

/** Self-declared caller identity, UA style; observability only on the server. */
const BOT_AGENT = 'im-robot/0.2.0'

/** `bot_type` for the QR endpoints, as openclaw-weixin sends it. */
export const BOT_TYPE = '3'

/** Default client-side timeout of the getupdates long poll. */
export const LONG_POLL_TIMEOUT_MS = 35_000
/** Default timeout of the QR status long poll. */
export const QR_POLL_TIMEOUT_MS = 35_000
/** Timeout of ordinary calls such as sendmessage. */
const API_TIMEOUT_MS = 15_000
/** Timeout of light calls such as getconfig and sendtyping. */
const CONFIG_TIMEOUT_MS = 10_000

/** iLink error code for a stale or revoked bot token. */
export const STALE_TOKEN_ERRCODE = -14

/** `item_list[].type` values. */
export const ItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const
/** `message_type` values. */
export const MessageType = { USER: 1, BOT: 2 } as const
/** `message_state` value of a complete message. */
const MESSAGE_STATE_FINISH = 2
/** `sendtyping` status values. */
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const

/** Where an item's bytes are on the CDN; `aes_key` is base64 in JSON. */
export interface CdnMedia {
  encrypt_query_param?: string
  aes_key?: string
  full_url?: string
}

/** A quoted message. */
export interface RefMessage {
  /** A summary of what is quoted. */
  title?: string
  message_item?: MessageItem
}

/** One entry of a message's item list (only the fields read here). */
export interface MessageItem {
  type?: number
  ref_msg?: RefMessage
  text_item?: { text?: string }
  /** `aeskey` is the raw key as hex, which goes before `media.aes_key`. */
  image_item?: { media?: CdnMedia; aeskey?: string }
  /** `text` is iLink's transcript. */
  voice_item?: { media?: CdnMedia; text?: string; playtime?: number }
  file_item?: { media?: CdnMedia; file_name?: string }
  video_item?: { media?: CdnMedia }
}

/** One message as getupdates returns it (only the fields read here). */
export interface WeixinMessage {
  from_user_id?: string
  to_user_id?: string
  group_id?: string
  message_type?: number
  item_list?: MessageItem[]
  context_token?: string
}

/** getupdates response. */
export interface GetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  /** Cursor to store and send back on the next poll. */
  get_updates_buf?: string
  /** Server-suggested timeout for the next poll. */
  longpolling_timeout_ms?: number
}

/** get_bot_qrcode response. */
export interface QrCodeResponse {
  /** Opaque id to poll the status with. */
  qrcode?: string
  /** The content to encode as the QR image. */
  qrcode_img_content?: string
}

/** get_qrcode_status response. */
export interface QrStatusResponse {
  status?:
    | 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect'
    | 'need_verifycode' | 'verify_code_blocked' | 'binded_redirect'
  bot_token?: string
  ilink_bot_id?: string
  /** API host for this bot from now on. */
  baseurl?: string
  /** The person who scanned. */
  ilink_user_id?: string
  /** Host to keep polling on after an IDC redirect. */
  redirect_host?: string
}

/** getconfig response. */
export interface GetConfigResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  typing_ticket?: string
}

/** An HTTP failure, described without the body (which may echo secrets). */
export class IlinkHttpError extends Error {
  constructor(readonly endpoint: string, readonly status: number) {
    super(`${endpoint} HTTP ${status}`)
    this.name = 'IlinkHttpError'
  }
}

/** Common call options. */
interface CallOptions {
  baseUrl: string
  token?: string
  timeoutMs?: number
  signal?: AbortSignal
}

/** Random uint32, as decimal text, base64 encoded; not the real WeChat UIN. */
function randomWechatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
}

/** iLink-App-ClientVersion: 0x00MMNNPP. */
function clientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(part => Number.parseInt(part, 10) || 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

/** Headers both GET and POST carry. */
function commonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(clientVersion(PROTOCOL_VERSION)),
  }
}

/** `base_info` attached to every POST body. */
function baseInfo(): { channel_version: string; bot_agent: string } {
  return { channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT }
}

/** `${baseUrl}/${endpoint}` with exactly one slash between. */
function urlOf(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}/${endpoint}`
}

/** A timeout controller that also follows an outer signal. */
function deadline(timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const follow = (): void => controller.abort()
  if (outer?.aborted === true) controller.abort()
  else outer?.addEventListener('abort', follow, { once: true })
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', follow)
    },
  }
}

/** Whether an error is the abort of a timed or cancelled request. */
export function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/** POST JSON and parse the JSON answer. */
async function post<T>(endpoint: string, body: Record<string, unknown>, options: CallOptions): Promise<T> {
  const payload = JSON.stringify({ ...body, base_info: baseInfo() })
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...commonHeaders(),
  }
  const token = options.token?.trim()
  if (token) headers.Authorization = `Bearer ${token}`
  const timer = deadline(options.timeoutMs ?? API_TIMEOUT_MS, options.signal)
  try {
    const response = await fetch(urlOf(options.baseUrl, endpoint), { method: 'POST', headers, body: payload, signal: timer.signal })
    const text = await response.text()
    if (!response.ok) throw new IlinkHttpError(endpoint.split('?')[0] ?? endpoint, response.status)
    return JSON.parse(text) as T
  } finally {
    timer.done()
  }
}

/** GET a token-less endpoint and parse the JSON answer. */
async function get<T>(endpoint: string, options: CallOptions): Promise<T> {
  const timer = deadline(options.timeoutMs ?? API_TIMEOUT_MS, options.signal)
  try {
    const response = await fetch(urlOf(options.baseUrl, endpoint), { method: 'GET', headers: commonHeaders(), signal: timer.signal })
    const text = await response.text()
    if (!response.ok) throw new IlinkHttpError(endpoint.split('?')[0] ?? endpoint, response.status)
    return JSON.parse(text) as T
  } finally {
    timer.done()
  }
}

/** Ask for a login QR code. */
export function fetchQrCode(options: CallOptions): Promise<QrCodeResponse> {
  return post<QrCodeResponse>(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`, { local_token_list: [] }, options)
}

/** One long poll of a QR code's status. */
export function pollQrStatus(qrcode: string, options: CallOptions): Promise<QrStatusResponse> {
  return get<QrStatusResponse>(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, { timeoutMs: QR_POLL_TIMEOUT_MS, ...options })
}

/**
 * One getupdates long poll. A client-side timeout is the normal end of a long
 * poll and comes back as an empty success with the cursor unchanged; an
 * outer abort is rethrown.
 */
export async function getUpdates(cursor: string, options: CallOptions): Promise<GetUpdatesResponse> {
  try {
    return await post<GetUpdatesResponse>('ilink/bot/getupdates', { get_updates_buf: cursor }, { timeoutMs: LONG_POLL_TIMEOUT_MS, ...options })
  } catch (error) {
    if (isAbort(error) && options.signal?.aborted !== true) return { ret: 0, msgs: [], get_updates_buf: cursor }
    throw error
  }
}

/** Send one text message; throws on an HTTP error or a non-zero `ret`. */
export async function sendTextMessage(
  message: { to: string; text: string; contextToken?: string; clientId: string },
  options: CallOptions,
): Promise<void> {
  const response = await post<{ ret?: number; errmsg?: string }>('ilink/bot/sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: message.to,
      client_id: message.clientId,
      message_type: MessageType.BOT,
      message_state: MESSAGE_STATE_FINISH,
      item_list: [{ type: ItemType.TEXT, text_item: { text: message.text } }],
      ...(message.contextToken ? { context_token: message.contextToken } : {}),
    },
  }, options)
  if (response.ret !== undefined && response.ret !== 0) throw new Error(`sendmessage ret=${response.ret}`)
}

/** Fetch the bot config for one user (its typing ticket). */
export function getConfig(userId: string, contextToken: string | undefined, options: CallOptions): Promise<GetConfigResponse> {
  return post<GetConfigResponse>('ilink/bot/getconfig', {
    ilink_user_id: userId,
    ...(contextToken ? { context_token: contextToken } : {}),
  }, { timeoutMs: CONFIG_TIMEOUT_MS, ...options })
}

/** Set or clear the typing indicator. */
export async function sendTyping(userId: string, ticket: string, status: number, options: CallOptions): Promise<void> {
  await post<unknown>('ilink/bot/sendtyping', { ilink_user_id: userId, typing_ticket: ticket, status }, { timeoutMs: CONFIG_TIMEOUT_MS, ...options })
}

/**
 * A server-supplied API host, accepted only as an https URL on a Tencent
 * domain, or when it is exactly the configured default; anything else falls
 * back to the default so a bot token is never sent elsewhere.
 * @param candidate - `baseurl` or `https://<redirect_host>` from the server.
 * @param fallback - the configured default base URL.
 * @returns the URL to use.
 */
export function trustedBaseUrl(candidate: string | undefined, fallback: string): string {
  const value = candidate?.trim()
  if (!value) return fallback
  try {
    const url = new URL(value)
    if (url.origin === new URL(fallback).origin) return fallback
    if (url.protocol === 'https:' && (url.hostname === 'qq.com' || url.hostname.endsWith('.qq.com'))) return url.origin
  } catch {
    // Not a URL: use the default.
  }
  return fallback
}
