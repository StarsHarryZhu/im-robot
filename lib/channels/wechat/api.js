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
 *
 * The stale-session retry in {@link sendTextMessage} follows
 * `dsh-weixin-ilink` 0.10.3, `src/outbound.js` (`isStaleSession`,
 * `sendWithStaleRetry`) (MIT License, Copyright (c) 2026 dsh-weixin
 * contributors; full text in THIRD_PARTY_NOTICES.md): after a quiet period
 * iLink answers `-2` with "prepare failed" or "unknown error" to a message
 * carrying the old `context_token`, and the same message without the token
 * goes through. Written here for this module's `post`. A `-2` that remains
 * is taken as iLink refusing the message until the person writes again (more
 * than a day after their last message, or too many messages since it, as
 * third-party bridges describe it; Tencent documents neither).
 * @module im-robot/channels/wechat/api
 */
import { randomBytes } from 'node:crypto';
import { ChatRefusedError } from "../adapter.js";
/** The fixed iLink API host; login always starts here. */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
/** iLink app id for bot channels, as openclaw-weixin declares it. */
const ILINK_APP_ID = 'bot';
/**
 * The openclaw-weixin release this protocol layer follows. It is what the
 * client-version header and `channel_version` report, since that is the
 * protocol the server should expect; `bot_agent` names this plugin.
 */
const PROTOCOL_VERSION = '2.4.10';
/** Self-declared caller identity, UA style; observability only on the server. */
const BOT_AGENT = 'im-robot/0.2.2';
/** `bot_type` for the QR endpoints, as openclaw-weixin sends it. */
export const BOT_TYPE = '3';
/** Default client-side timeout of the getupdates long poll. */
export const LONG_POLL_TIMEOUT_MS = 35_000;
/** Default timeout of the QR status long poll. */
export const QR_POLL_TIMEOUT_MS = 35_000;
/** Timeout of ordinary calls such as sendmessage. */
const API_TIMEOUT_MS = 15_000;
/** Timeout of light calls such as getconfig and sendtyping. */
const CONFIG_TIMEOUT_MS = 10_000;
/** iLink error code for a stale or revoked bot token. */
export const STALE_TOKEN_ERRCODE = -14;
/** `item_list[].type` values. */
export const ItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };
/** `message_type` values. */
export const MessageType = { USER: 1, BOT: 2 };
/** `message_state` value of a complete message. */
const MESSAGE_STATE_FINISH = 2;
/** `sendtyping` status values. */
export const TypingStatus = { TYPING: 1, CANCEL: 2 };
/** An HTTP failure, described without the body (which may echo secrets). */
export class IlinkHttpError extends Error {
    endpoint;
    status;
    constructor(endpoint, status) {
        super(`${endpoint} HTTP ${status}`);
        this.endpoint = endpoint;
        this.status = status;
        this.name = 'IlinkHttpError';
    }
}
/** Random uint32, as decimal text, base64 encoded; not the real WeChat UIN. */
function randomWechatUin() {
    return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
}
/** iLink-App-ClientVersion: 0x00MMNNPP. */
function clientVersion(version) {
    const [major = 0, minor = 0, patch = 0] = version.split('.').map(part => Number.parseInt(part, 10) || 0);
    return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}
/** Headers both GET and POST carry. */
function commonHeaders() {
    return {
        'iLink-App-Id': ILINK_APP_ID,
        'iLink-App-ClientVersion': String(clientVersion(PROTOCOL_VERSION)),
    };
}
/** `base_info` attached to every POST body. */
function baseInfo() {
    return { channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT };
}
/** `${baseUrl}/${endpoint}` with exactly one slash between. */
function urlOf(baseUrl, endpoint) {
    return `${baseUrl.replace(/\/+$/u, '')}/${endpoint}`;
}
/** A timeout controller that also follows an outer signal. */
function deadline(timeoutMs, outer) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const follow = () => controller.abort();
    if (outer?.aborted === true)
        controller.abort();
    else
        outer?.addEventListener('abort', follow, { once: true });
    return {
        signal: controller.signal,
        done: () => {
            clearTimeout(timer);
            outer?.removeEventListener('abort', follow);
        },
    };
}
/** Whether an error is the abort of a timed or cancelled request. */
export function isAbort(error) {
    return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
/** POST JSON and parse the JSON answer. */
async function post(endpoint, body, options) {
    const payload = JSON.stringify({ ...body, base_info: baseInfo() });
    const headers = {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': randomWechatUin(),
        ...commonHeaders(),
    };
    const token = options.token?.trim();
    if (token)
        headers.Authorization = `Bearer ${token}`;
    const timer = deadline(options.timeoutMs ?? API_TIMEOUT_MS, options.signal);
    try {
        const response = await fetch(urlOf(options.baseUrl, endpoint), { method: 'POST', headers, body: payload, signal: timer.signal });
        const text = await response.text();
        if (!response.ok)
            throw new IlinkHttpError(endpoint.split('?')[0] ?? endpoint, response.status);
        return JSON.parse(text);
    }
    finally {
        timer.done();
    }
}
/** GET a token-less endpoint and parse the JSON answer. */
async function get(endpoint, options) {
    const timer = deadline(options.timeoutMs ?? API_TIMEOUT_MS, options.signal);
    try {
        const response = await fetch(urlOf(options.baseUrl, endpoint), { method: 'GET', headers: commonHeaders(), signal: timer.signal });
        const text = await response.text();
        if (!response.ok)
            throw new IlinkHttpError(endpoint.split('?')[0] ?? endpoint, response.status);
        return JSON.parse(text);
    }
    finally {
        timer.done();
    }
}
/** Ask for a login QR code. */
export function fetchQrCode(options) {
    return post(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`, { local_token_list: [] }, options);
}
/** One long poll of a QR code's status. */
export function pollQrStatus(qrcode, options) {
    return get(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, { timeoutMs: QR_POLL_TIMEOUT_MS, ...options });
}
/**
 * One getupdates long poll. A client-side timeout is the normal end of a long
 * poll and comes back as an empty success with the cursor unchanged; an
 * outer abort is rethrown.
 */
export async function getUpdates(cursor, options) {
    try {
        return await post('ilink/bot/getupdates', { get_updates_buf: cursor }, { timeoutMs: LONG_POLL_TIMEOUT_MS, ...options });
    }
    catch (error) {
        if (isAbort(error) && options.signal?.aborted !== true)
            return { ret: 0, msgs: [], get_updates_buf: cursor };
        throw error;
    }
}
/** The code iLink answers when it will not take the message now: stale, out of time, or too many. */
const REFUSED_CODE = -2;
/** The two answers iLink gives once a quiet chat's session has gone stale. */
const STALE_SESSION_MESSAGES = new Set(['prepare failed', 'unknown error']);
/**
 * Whether `sendmessage` refused only because the chat's session went stale:
 * `-2` with one of {@link STALE_SESSION_MESSAGES}, not a real rate limit.
 * @param response - the server's answer.
 * @returns true for the stale-session answer.
 */
export function isStaleSession(response) {
    const code = response.ret ?? response.errcode;
    return code === -2 && STALE_SESSION_MESSAGES.has((response.errmsg ?? '').trim().toLowerCase());
}
/**
 * Send one text message; throws on an HTTP error or a non-zero `ret` or
 * `errcode`, a {@link ChatRefusedError} for `-2`. When the context token has
 * gone stale, the message goes once more without it. The error names the
 * code and the server's message, never the token.
 */
export async function sendTextMessage(message, options) {
    const attempt = (contextToken, clientId) => post('ilink/bot/sendmessage', {
        msg: {
            from_user_id: '',
            to_user_id: message.to,
            client_id: clientId,
            message_type: MessageType.BOT,
            message_state: MESSAGE_STATE_FINISH,
            item_list: [{ type: ItemType.TEXT, text_item: { text: message.text } }],
            ...(contextToken ? { context_token: contextToken } : {}),
        },
    }, options);
    let response = await attempt(message.contextToken, message.clientId);
    // A second message needs its own client id, as the reference sends it.
    if (message.contextToken && isStaleSession(response))
        response = await attempt(undefined, `${message.clientId}-r`);
    const code = response.ret !== undefined && response.ret !== 0 ? response.ret : response.errcode;
    if (code === undefined || code === 0)
        return;
    const said = (response.errmsg ?? '').trim().slice(0, 120);
    const text = `sendmessage ret=${code}${said === '' ? '' : ` errmsg=${JSON.stringify(said)}`}`;
    throw code === REFUSED_CODE ? new ChatRefusedError(text) : new Error(text);
}
/** Fetch the bot config for one user (its typing ticket). */
export function getConfig(userId, contextToken, options) {
    return post('ilink/bot/getconfig', {
        ilink_user_id: userId,
        ...(contextToken ? { context_token: contextToken } : {}),
    }, { timeoutMs: CONFIG_TIMEOUT_MS, ...options });
}
/** Set or clear the typing indicator. */
export async function sendTyping(userId, ticket, status, options) {
    await post('ilink/bot/sendtyping', { ilink_user_id: userId, typing_ticket: ticket, status }, { timeoutMs: CONFIG_TIMEOUT_MS, ...options });
}
/**
 * A server-supplied API host, accepted only as an https URL on a Tencent
 * domain, or when it is exactly the configured default; anything else falls
 * back to the default so a bot token is never sent elsewhere.
 * @param candidate - `baseurl` or `https://<redirect_host>` from the server.
 * @param fallback - the configured default base URL.
 * @returns the URL to use.
 */
export function trustedBaseUrl(candidate, fallback) {
    const value = candidate?.trim();
    if (!value)
        return fallback;
    try {
        const url = new URL(value);
        if (url.origin === new URL(fallback).origin)
            return fallback;
        if (url.protocol === 'https:' && (url.hostname === 'qq.com' || url.hostname.endsWith('.qq.com')))
            return url.origin;
    }
    catch {
        // Not a URL: use the default.
    }
    return fallback;
}
