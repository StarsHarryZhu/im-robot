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
 * the text names saved files, in plain Chinese, and the saved files come back
 * too, for the service to attach to the prompt.
 * @module im-robot/channels/wechat/inbound
 */
import type { MessageItem, WeixinMessage } from './api.ts';
import type { InboundMessage } from '../adapter.ts';
import type { SavedMedia } from './media.ts';
/** Saves one item; the adapter binds it to the binding's folder. */
export type SaveItem = (item: MessageItem) => Promise<SavedMedia | undefined>;
/**
 * Read one message for the account whose scanner is `ownerId`.
 * @param message - one entry of getupdates `msgs`.
 * @param ownerId - `ilink_user_id` of the person who scanned the login code.
 * @param save - saves an item holding media.
 * @returns the message to act on, or undefined to skip it.
 */
export declare function readInbound(message: WeixinMessage, ownerId: string, save: SaveItem): Promise<InboundMessage | undefined>;
/**
 * Mask an iLink user id for display: a few leading and trailing characters of
 * the local part, and the domain.
 * @param userId - e.g. `o9cq80abcdefXy@im.wechat`.
 * @returns e.g. `o9c***Xy@im.wechat`.
 */
export declare function maskUserId(userId: string): string;
