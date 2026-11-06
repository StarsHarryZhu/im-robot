/**
 * Download what a WeChat message carries (images, files, voice, video) from
 * the CDN, decrypt it, and save it in the binding's media folder.
 *
 * Source: adapted from `@tencent-weixin/openclaw-weixin` 2.4.10,
 * `src/cdn/pic-decrypt.ts`, `src/cdn/aes-ecb.ts`, `src/cdn/cdn-url.ts`, and
 * `src/media/media-download.ts` (MIT License, Copyright (C) 2026 Tencent; full
 * text in THIRD_PARTY_NOTICES.md): AES-128-ECB over the CDN bytes, the two
 * encodings of `aes_key`, `image_item.aeskey` as hex taking precedence, an image
 * without a key being plain, and the 100 MB limit.
 * Changes: one module writing to a folder the caller names instead of the
 * OpenClaw media store; every type follows one path; a download URL from the
 * server is used only on Tencent hosts, so nothing reads from elsewhere; a
 * download stops at the limit and at a timeout instead of buffering everything;
 * file names from the sender are cleaned so a save never leaves the folder; the
 * image type is read from the bytes; voice stays raw SILK, with no transcoding
 * and no native dependency; failures come back as plain-Chinese reasons without
 * URLs or keys.
 * @module im-robot/channels/wechat/media
 */
import type { CdnMedia, MessageItem } from './api.ts';
/** The CDN host when the server gives no full URL. */
export declare const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
/** Largest file saved, as upstream limits it. */
export declare const MAX_MEDIA_BYTES: number;
/** Longest wait for one download. */
export declare const MEDIA_TIMEOUT_MS = 120000;
/** What kind of content an item holds. */
export type MediaKind = 'image' | 'file' | 'voice' | 'video';
/** @returns the kind's name in Chinese. */
export declare function mediaLabel(kind: MediaKind): string;
/** One item after trying to save it. */
export type SavedMedia = {
    readonly ok: true;
    readonly kind: MediaKind;
    readonly path: string;
    readonly bytes: number;
} | {
    readonly ok: false;
    readonly kind: MediaKind;
    readonly name?: string;
    readonly reason: string;
};
/** Where to save and fetch. */
export interface MediaOptions {
    /** The folder to save in; created when missing. */
    readonly directory: string;
    readonly cdnBaseUrl: string;
    /** The time in the file name. */
    readonly now: Date;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
}
/** @returns the item's kind and its CDN reference, or undefined when it holds no media. */
export declare function mediaOf(item: MessageItem): {
    kind: MediaKind;
    media?: CdnMedia;
} | undefined;
/**
 * The 16-byte key of an `aes_key`: base64 of the raw key on images, base64 of
 * its hex text on files, voice, and video.
 * @param encoded - `aes_key` from the message.
 * @returns the key.
 */
export declare function parseAesKey(encoded: string): Buffer;
/**
 * Where to fetch an item from: the server's full URL only on an https Tencent
 * host or the configured CDN, else one built from `encrypt_query_param`.
 * @param media - the item's CDN reference.
 * @param cdnBaseUrl - the configured CDN.
 * @returns the URL.
 */
export declare function downloadUrl(media: CdnMedia, cdnBaseUrl: string): string;
/**
 * Decrypt CDN bytes.
 * @param ciphertext - what the CDN returned.
 * @param key - the 16-byte key.
 * @returns the plain bytes.
 */
export declare function decrypt(ciphertext: Buffer, key: Buffer): Buffer;
/**
 * A name a file can be saved under: the last path part of what the sender
 * chose, with separators, control characters, and leading dots gone.
 * @param name - the sender's name for the file, if any.
 * @param fallback - the name to use when nothing is left.
 * @returns one path segment.
 */
export declare function cleanFileName(name: string | undefined, fallback: string): string;
/** @returns a size as "1.2 MB". */
export declare function formatBytes(bytes: number): string;
/**
 * Download, decrypt, and save one item. Never throws: a failure comes back with
 * a reason the person can read.
 * @param item - an image, file, voice, or video item.
 * @param options - the folder, the CDN, and the limits.
 * @returns where it went, or why it did not, or undefined when the item holds no media.
 */
export declare function saveMedia(item: MessageItem, options: MediaOptions): Promise<SavedMedia | undefined>;
