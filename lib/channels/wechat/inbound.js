/**
 * Decide what one getupdates message means for a binding: text to prompt, with
 * whatever it carries saved in the binding's media folder and named in that
 * text; something this version cannot read; or nothing to act on.
 *
 * Source: the sender rule follows the idea of `normalizeInbound` in
 * `dsh-weixin-ilink` 0.9.1, `src/transport/ilink.js` (MIT License, Copyright (c)
 * 2026 dsh-weixin contributors): skip bot echoes and anything not from the
 * expected peer. A voice item counting as text through its transcript, and a
 * quote read from `ref_msg`'s title and item, follow
 * `@tencent-weixin/openclaw-weixin` 2.4.10, `src/messaging/inbound.ts` (MIT
 * License, Copyright (C) 2026 Tencent). Full license texts are in
 * THIRD_PARTY_NOTICES.md.
 * Changes: accept only the person who scanned the login code, only in a private
 * chat (no `group_id`); every item of a message counts rather than the first;
 * the text names saved files, in plain Chinese, since that is all a session gets.
 * @module im-robot/channels/wechat/inbound
 */
import { ItemType, MessageType } from "./api.js";
import { formatBytes, mediaLabel, mediaOf } from "./media.js";
/** @returns whether the message is one this binding acts on. */
function accepted(message, ownerId) {
    if (message.message_type === MessageType.BOT)
        return false;
    if ((message.group_id ?? '').trim() !== '')
        return false;
    return (message.from_user_id ?? '').trim() === ownerId;
}
/** @returns the text an item carries itself: its text, or a voice item's transcript. */
function textOf(item) {
    if (item.type === ItemType.TEXT && typeof item.text_item?.text === 'string')
        return item.text_item.text;
    if (item.type === ItemType.VOICE && typeof item.voice_item?.text === 'string')
        return item.voice_item.text;
    return undefined;
}
/** @returns the line naming a saved file, or saying why it could not be saved. */
function savedLine(saved, quoted) {
    const what = `${quoted ? '引用的' : '微信发来的'}${mediaLabel(saved.kind)}`;
    if (saved.ok)
        return `（${what}：${saved.path}，${formatBytes(saved.bytes)}）`;
    return `（${what}${saved.name === undefined ? '' : `「${saved.name}」`}没能保存：${saved.reason}）`;
}
/** @returns the lines of a quote: what it says, and where its file went. */
async function quoteLines(item, save) {
    const ref = item.ref_msg;
    if (ref === undefined)
        return [];
    const quoted = ref.message_item;
    const body = quoted === undefined ? undefined : textOf(quoted)?.trim();
    const parts = [...new Set([ref.title?.trim(), body].filter((part) => part !== undefined && part !== ''))];
    const lines = parts.length === 0 ? [] : [`（引用：${parts.join(' | ')}）`];
    const saved = quoted === undefined || mediaOf(quoted) === undefined ? undefined : await save(quoted);
    return saved === undefined ? lines : [...lines, savedLine(saved, true)];
}
/**
 * Read one message for the account whose scanner is `ownerId`.
 * @param message - one entry of getupdates `msgs`.
 * @param ownerId - `ilink_user_id` of the person who scanned the login code.
 * @param save - saves an item holding media.
 * @returns the message to act on, or undefined to skip it.
 */
export async function readInbound(message, ownerId, save) {
    if (!accepted(message, ownerId))
        return undefined;
    const items = message.item_list ?? [];
    const lines = [];
    let understood = false;
    for (const item of items) {
        lines.push(...await quoteLines(item, save));
        const text = textOf(item);
        if (text !== undefined && text.trim() !== '')
            lines.push(text);
        if (text !== undefined)
            understood = true;
        const saved = await save(item);
        if (saved === undefined)
            continue;
        understood = true;
        // A voice item that could not be fetched still counts by its transcript.
        if (saved.ok || text === undefined || text.trim() === '')
            lines.push(savedLine(saved, false));
    }
    if (lines.length > 0)
        return { kind: 'text', text: lines.join('\n') };
    return items.length > 0 && !understood ? { kind: 'unsupported' } : undefined;
}
/**
 * Mask an iLink user id for display: a few leading and trailing characters of
 * the local part, and the domain.
 * @param userId - e.g. `o9cq80abcdefXy@im.wechat`.
 * @returns e.g. `o9c***Xy@im.wechat`.
 */
export function maskUserId(userId) {
    const at = userId.indexOf('@');
    const local = at === -1 ? userId : userId.slice(0, at);
    const domain = at === -1 ? '' : userId.slice(at);
    const shown = local.length > 6 ? `${local.slice(0, 3)}***${local.slice(-2)}` : `${local.slice(0, 1)}***`;
    return `${shown}${domain}`;
}
