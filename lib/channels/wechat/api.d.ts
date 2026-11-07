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
/** The fixed iLink API host; login always starts here. */
export declare const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
/** `bot_type` for the QR endpoints, as openclaw-weixin sends it. */
export declare const BOT_TYPE = "3";
/** Default client-side timeout of the getupdates long poll. */
export declare const LONG_POLL_TIMEOUT_MS = 35000;
/** Default timeout of the QR status long poll. */
export declare const QR_POLL_TIMEOUT_MS = 35000;
/** iLink error code for a stale or revoked bot token. */
export declare const STALE_TOKEN_ERRCODE = -14;
/** `item_list[].type` values. */
export declare const ItemType: {
    readonly TEXT: 1;
    readonly IMAGE: 2;
    readonly VOICE: 3;
    readonly FILE: 4;
    readonly VIDEO: 5;
};
/** `message_type` values. */
export declare const MessageType: {
    readonly USER: 1;
    readonly BOT: 2;
};
/** `sendtyping` status values. */
export declare const TypingStatus: {
    readonly TYPING: 1;
    readonly CANCEL: 2;
};
/** Where an item's bytes are on the CDN; `aes_key` is base64 in JSON. */
export interface CdnMedia {
    encrypt_query_param?: string;
    aes_key?: string;
    full_url?: string;
}
/** A quoted message. */
export interface RefMessage {
    /** A summary of what is quoted. */
    title?: string;
    message_item?: MessageItem;
}
/** One entry of a message's item list (only the fields read here). */
export interface MessageItem {
    type?: number;
    ref_msg?: RefMessage;
    text_item?: {
        text?: string;
    };
    /** `aeskey` is the raw key as hex, which goes before `media.aes_key`. */
    image_item?: {
        media?: CdnMedia;
        aeskey?: string;
    };
    /** `text` is iLink's transcript. */
    voice_item?: {
        media?: CdnMedia;
        text?: string;
        playtime?: number;
    };
    file_item?: {
        media?: CdnMedia;
        file_name?: string;
    };
    video_item?: {
        media?: CdnMedia;
    };
}
/** One message as getupdates returns it (only the fields read here). */
export interface WeixinMessage {
    from_user_id?: string;
    to_user_id?: string;
    group_id?: string;
    message_type?: number;
    item_list?: MessageItem[];
    context_token?: string;
}
/** getupdates response. */
export interface GetUpdatesResponse {
    ret?: number;
    errcode?: number;
    errmsg?: string;
    msgs?: WeixinMessage[];
    /** Cursor to store and send back on the next poll. */
    get_updates_buf?: string;
    /** Server-suggested timeout for the next poll. */
    longpolling_timeout_ms?: number;
}
/** get_bot_qrcode response. */
export interface QrCodeResponse {
    /** Opaque id to poll the status with. */
    qrcode?: string;
    /** The content to encode as the QR image. */
    qrcode_img_content?: string;
}
/** get_qrcode_status response. */
export interface QrStatusResponse {
    status?: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect' | 'need_verifycode' | 'verify_code_blocked' | 'binded_redirect';
    bot_token?: string;
    ilink_bot_id?: string;
    /** API host for this bot from now on. */
    baseurl?: string;
    /** The person who scanned. */
    ilink_user_id?: string;
    /** Host to keep polling on after an IDC redirect. */
    redirect_host?: string;
}
/** getconfig response. */
export interface GetConfigResponse {
    ret?: number;
    errcode?: number;
    errmsg?: string;
    typing_ticket?: string;
}
/** An HTTP failure, described without the body (which may echo secrets). */
export declare class IlinkHttpError extends Error {
    readonly endpoint: string;
    readonly status: number;
    constructor(endpoint: string, status: number);
}
/** Common call options. */
interface CallOptions {
    baseUrl: string;
    token?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}
/** Whether an error is the abort of a timed or cancelled request. */
export declare function isAbort(error: unknown): boolean;
/** Ask for a login QR code. */
export declare function fetchQrCode(options: CallOptions): Promise<QrCodeResponse>;
/** One long poll of a QR code's status. */
export declare function pollQrStatus(qrcode: string, options: CallOptions): Promise<QrStatusResponse>;
/**
 * One getupdates long poll. A client-side timeout is the normal end of a long
 * poll and comes back as an empty success with the cursor unchanged; an
 * outer abort is rethrown.
 */
export declare function getUpdates(cursor: string, options: CallOptions): Promise<GetUpdatesResponse>;
/** What `sendmessage` answers. */
interface SendMessageResponse {
    ret?: number;
    errcode?: number;
    errmsg?: string;
}
/**
 * Whether `sendmessage` refused only because the chat's session went stale:
 * `-2` with one of {@link STALE_SESSION_MESSAGES}, not a real rate limit.
 * @param response - the server's answer.
 * @returns true for the stale-session answer.
 */
export declare function isStaleSession(response: SendMessageResponse): boolean;
/**
 * Send one text message; throws on an HTTP error or a non-zero `ret` or
 * `errcode`, a {@link ChatRefusedError} for `-2`. When the context token has
 * gone stale, the message goes once more without it. The error names the
 * code and the server's message, never the token.
 */
export declare function sendTextMessage(message: {
    to: string;
    text: string;
    contextToken?: string;
    clientId: string;
}, options: CallOptions): Promise<void>;
/** Fetch the bot config for one user (its typing ticket). */
export declare function getConfig(userId: string, contextToken: string | undefined, options: CallOptions): Promise<GetConfigResponse>;
/** Set or clear the typing indicator. */
export declare function sendTyping(userId: string, ticket: string, status: number, options: CallOptions): Promise<void>;
/**
 * A server-supplied API host, accepted only as an https URL on a Tencent
 * domain, or when it is exactly the configured default; anything else falls
 * back to the default so a bot token is never sent elsewhere.
 * @param candidate - `baseurl` or `https://<redirect_host>` from the server.
 * @param fallback - the configured default base URL.
 * @returns the URL to use.
 */
export declare function trustedBaseUrl(candidate: string | undefined, fallback: string): string;
export {};
