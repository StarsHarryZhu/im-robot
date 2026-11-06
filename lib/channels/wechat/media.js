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
import { createDecipheriv } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ItemType } from "./api.js";
/** The CDN host when the server gives no full URL. */
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
/** Largest file saved, as upstream limits it. */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
/** Longest wait for one download. */
export const MEDIA_TIMEOUT_MS = 120_000;
/** Longest file name kept, in characters. */
const MAX_NAME_CHARS = 120;
/** How each kind reads in the text the session gets, and its file when the item names none. */
const KINDS = {
    image: { label: '图片', fallback: 'image.jpg' },
    file: { label: '文件', fallback: 'file.bin' },
    voice: { label: '语音', fallback: 'voice.silk' },
    video: { label: '视频', fallback: 'video.mp4' },
};
/** @returns the kind's name in Chinese. */
export function mediaLabel(kind) {
    return KINDS[kind].label;
}
/** A failure whose message may be shown to the person. */
class MediaError extends Error {
}
/** @returns the item's kind and its CDN reference, or undefined when it holds no media. */
export function mediaOf(item) {
    switch (item.type) {
        case ItemType.IMAGE: return { kind: 'image', ...optionalMedia(item.image_item?.media) };
        case ItemType.FILE: return { kind: 'file', ...optionalMedia(item.file_item?.media) };
        case ItemType.VOICE: return { kind: 'voice', ...optionalMedia(item.voice_item?.media) };
        case ItemType.VIDEO: return { kind: 'video', ...optionalMedia(item.video_item?.media) };
        default: return undefined;
    }
}
/** @returns the media field, left out when absent. */
function optionalMedia(media) {
    return media === undefined ? {} : { media };
}
/**
 * The 16-byte key of an `aes_key`: base64 of the raw key on images, base64 of
 * its hex text on files, voice, and video.
 * @param encoded - `aes_key` from the message.
 * @returns the key.
 */
export function parseAesKey(encoded) {
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.length === 16)
        return decoded;
    const text = decoded.toString('ascii');
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/u.test(text))
        return Buffer.from(text, 'hex');
    throw new MediaError('文件的密钥看不懂');
}
/** @returns the key to decrypt an item with, or undefined for a plain image. */
function keyOf(item, kind, media) {
    if (kind === 'image' && item.image_item?.aeskey)
        return Buffer.from(item.image_item.aeskey, 'hex');
    if (media.aes_key)
        return parseAesKey(media.aes_key);
    if (kind === 'image')
        return undefined;
    throw new MediaError('这条消息没有带文件的密钥');
}
/**
 * Where to fetch an item from: the server's full URL only on an https Tencent
 * host or the configured CDN, else one built from `encrypt_query_param`.
 * @param media - the item's CDN reference.
 * @param cdnBaseUrl - the configured CDN.
 * @returns the URL.
 */
export function downloadUrl(media, cdnBaseUrl) {
    const full = media.full_url?.trim();
    if (full) {
        try {
            const url = new URL(full);
            if (url.origin === new URL(cdnBaseUrl).origin)
                return url.href;
            if (url.protocol === 'https:' && (url.hostname === 'qq.com' || url.hostname.endsWith('.qq.com')))
                return url.href;
        }
        catch {
            // Not a URL: fall through to the configured CDN.
        }
    }
    if (media.encrypt_query_param)
        return `${cdnBaseUrl.replace(/\/+$/u, '')}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
    throw new MediaError('这条消息没有可用的下载地址');
}
/** Fetch at most `maxBytes`, stopping at the timeout or the caller's signal. */
async function fetchBytes(url, options, maxBytes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? MEDIA_TIMEOUT_MS);
    const follow = () => controller.abort();
    if (options.signal?.aborted === true)
        controller.abort();
    else
        options.signal?.addEventListener('abort', follow, { once: true });
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok || response.body === null)
            throw new MediaError(`微信服务器没有给出文件（HTTP ${response.status}）`);
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes)
            throw new MediaError(tooLarge(maxBytes));
        const chunks = [];
        let total = 0;
        for await (const chunk of response.body) {
            total += chunk.byteLength;
            if (total > maxBytes)
                throw new MediaError(tooLarge(maxBytes));
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }
    finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', follow);
        controller.abort();
    }
}
/** @returns the reason for a file over the limit. */
function tooLarge(maxBytes) {
    return `文件超过 ${formatBytes(maxBytes)}，没有保存`;
}
/**
 * Decrypt CDN bytes.
 * @param ciphertext - what the CDN returned.
 * @param key - the 16-byte key.
 * @returns the plain bytes.
 */
export function decrypt(ciphertext, key) {
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
/** @returns an image's extension, read from its first bytes; JPEG when they say nothing. */
function imageExtension(data) {
    if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        return '.png';
    if (data.subarray(0, 3).toString('ascii') === 'GIF')
        return '.gif';
    if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP')
        return '.webp';
    if (data.subarray(0, 2).toString('ascii') === 'BM')
        return '.bmp';
    return '.jpg';
}
/**
 * A name a file can be saved under: the last path part of what the sender
 * chose, with separators, control characters, and leading dots gone.
 * @param name - the sender's name for the file, if any.
 * @param fallback - the name to use when nothing is left.
 * @returns one path segment.
 */
export function cleanFileName(name, fallback) {
    const last = (name ?? '').split(/[/\\]/u).at(-1) ?? '';
    const cleaned = last.replace(/[:*?"<>|\u0000-\u001F\u007F]/gu, '-').replace(/^[.\s]+/u, '').trim();
    if (cleaned === '')
        return fallback;
    const chars = [...cleaned];
    if (chars.length <= MAX_NAME_CHARS)
        return cleaned;
    const dot = cleaned.lastIndexOf('.');
    const extension = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : '';
    return `${chars.slice(0, MAX_NAME_CHARS - [...extension].length).join('')}${extension}`;
}
/** @returns the time as "20261105-143000". */
function stamp(now) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
/** @returns a path in the folder no file has yet: the name, then with a number. */
function freePath(directory, name) {
    const dot = name.lastIndexOf('.');
    const [base, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    let candidate = join(directory, name);
    for (let index = 1; existsSync(candidate); index += 1)
        candidate = join(directory, `${base}-${index}${extension}`);
    return candidate;
}
/** Write without ever leaving half a file under the final name. */
function saveFile(path, data) {
    const temporary = `${path}.part`;
    try {
        writeFileSync(temporary, data);
        renameSync(temporary, path);
    }
    catch (error) {
        rmSync(temporary, { force: true });
        throw error;
    }
}
/** @returns a size as "1.2 MB". */
export function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
/**
 * Download, decrypt, and save one item. Never throws: a failure comes back with
 * a reason the person can read.
 * @param item - an image, file, voice, or video item.
 * @param options - the folder, the CDN, and the limits.
 * @returns where it went, or why it did not, or undefined when the item holds no media.
 */
export async function saveMedia(item, options) {
    const found = mediaOf(item);
    if (found === undefined)
        return undefined;
    const { kind, media } = found;
    const name = kind === 'file' ? item.file_item?.file_name : undefined;
    const failed = (reason) => ({ ok: false, kind, ...(name === undefined ? {} : { name }), reason });
    try {
        if (media === undefined)
            return failed('这条消息没有可用的下载地址');
        const key = keyOf(item, kind, media);
        const url = downloadUrl(media, options.cdnBaseUrl);
        // AES-128-ECB pads by at most one block, so the limit on the ciphertext follows the limit on the file.
        const maxBytes = options.maxBytes ?? MAX_MEDIA_BYTES;
        const downloaded = await fetchBytes(url, options, maxBytes + 16);
        const data = key === undefined ? downloaded : decrypt(downloaded, key);
        if (data.length > maxBytes)
            throw new MediaError(tooLarge(maxBytes));
        const base = kind === 'image' ? `image${imageExtension(data)}` : cleanFileName(name, KINDS[kind].fallback);
        mkdirSync(options.directory, { recursive: true });
        const path = freePath(options.directory, `${stamp(options.now)}-${base}`);
        saveFile(path, data);
        return { ok: true, kind, path, bytes: data.length };
    }
    catch (error) {
        if (error instanceof MediaError)
            return failed(error.message);
        if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
            return failed('下载超时了');
        return failed(error instanceof Error && /bad decrypt|wrong final block|invalid key/iu.test(error.message) ? '文件解不开' : '下载失败了');
    }
}
