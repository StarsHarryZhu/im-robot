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
import type { MessageItem } from './api.ts';
/** Largest file sent: what the bot receives at most, too. */
export declare const MAX_SEND_FILE_BYTES: number;
/** Longest wait for one CDN upload. */
export declare const UPLOAD_TIMEOUT_MS = 300000;
/** How WeChat shows a file the bot sends. */
export type SendKind = 'image' | 'video' | 'file';
/** @returns how a file is sent, by its extension. */
export declare function sendKindOf(path: string): SendKind;
/**
 * Encrypt bytes for the CDN.
 * @param plaintext - the file.
 * @param key - the 16-byte key.
 * @returns the ciphertext.
 */
export declare function encrypt(plaintext: Buffer, key: Buffer): Buffer;
/**
 * Where to post the encrypted bytes: built from `upload_param` on the
 * configured CDN when the server gives one, else its full URL on a trusted host.
 * @returns the URL.
 * @throws when the server gave neither, or only an untrusted full URL.
 */
export declare function uploadUrlOf(slot: {
    upload_param?: string;
    upload_full_url?: string;
}, cdnBaseUrl: string, filekey: string): string;
/** Where and as whom to upload. */
export interface UploadTarget {
    /** The account's API host. */
    baseUrl: string;
    token: string;
    /** The recipient's `ilink_user_id`. */
    to: string;
    cdnBaseUrl: string;
    timeoutMs?: number;
    maxBytes?: number;
    signal?: AbortSignal;
}
/**
 * Upload one file and build the item that sends it.
 * @param path - the file.
 * @param target - the account, the recipient, the CDN, and the limits.
 * @returns the item for sendmessage.
 * @throws {@link UnsendableFileError} for a file that cannot go; an Error naming the step otherwise.
 */
export declare function uploadFile(path: string, target: UploadTarget): Promise<MessageItem>;
