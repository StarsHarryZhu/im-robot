/**
 * Binding state files: one JSON file per binding at
 * `$DSH_HOME/plugin-data/im-robot/<bindingId>.json` (DSH_HOME defaults to
 * `~/.dsh`), readable by the owner only. A file holds everything about a
 * binding except its secret, which lives in `ctx.credentials`.
 * @module im-robot/store
 */
import type { BindingOptions, Channel, SendMode } from './types.ts';
/** Send modes a stored binding may name. */
export declare const SEND_MODES: readonly SendMode[];
/** Whether a value is usable as a `mediaDir`. */
export declare function isMediaDir(value: unknown): value is string;
/** Smallest accepted `replyMaxChars`. */
export declare const MIN_REPLY_MAX_CHARS = 10;
/** Whether a value is usable as a `replyMaxChars`. */
export declare function isReplyMaxChars(value: unknown): value is number;
/** A binding's options with every default filled in; an unset `replyMaxChars` follows the global value. */
export type BindingSettings = Required<Omit<BindingOptions, 'replyMaxChars' | 'mediaDir'>> & Pick<BindingOptions, 'replyMaxChars' | 'mediaDir'>;
/** The options of a binding that never changed them. */
export declare const DEFAULT_BINDING_SETTINGS: Readonly<BindingSettings>;
/**
 * One reply waiting to be sent. It is written to disk before the first try
 * and removed once sent, so a restart or reconnect can retry it.
 */
export interface OutboxEntry {
    id: string;
    /** One plain-text segment, already stripped and split. */
    text: string;
    /** The reply context when the reply was made (WeChat: its `context_token`). */
    context?: string;
    /** When the reply was made, epoch milliseconds. */
    createdAt: number;
    /** Failed sends so far. */
    failures: number;
}
/** One binding as stored. */
export interface StoredBinding {
    version: 1;
    bindingId: string;
    channel: Channel;
    /** Masked account id for display. */
    user: string;
    /** The session messages go to; absent until `bind`. */
    sessionId?: string;
    /** Whether the session's latest human input came from this chat account. */
    lastInputFromChat: boolean;
    /** Adapter-owned state (WeChat: ilinkUserId, botId, baseUrl, syncBuf, contextToken). */
    channelState: Record<string, string>;
    /** Replies not yet sent, oldest first. Files written before the outbox existed read as empty. */
    outbox: OutboxEntry[];
    /** When the account was logged in, epoch milliseconds. */
    boundAt: number;
    /** Delivery options; files written before they existed, or with invalid values, read as the defaults. */
    options: BindingSettings;
    /** When the latest message from the account arrived, epoch milliseconds. */
    lastInboundAt?: number;
    /** When the latest message to the account was sent, epoch milliseconds. */
    lastOutboundAt?: number;
}
/** Throw unless `bindingId` is a valid binding id. */
export declare function assertBindingId(bindingId: unknown): asserts bindingId is string;
/**
 * The credential reference holding a binding's secret:
 * `IM_ROBOT_<CHANNEL>_<bindingId>`. A reference allows only letters, digits
 * and `_`, so `_` and `-` in the id are escaped as `_5F` and `_2D`, which
 * keeps distinct ids distinct; ids of letters and digits appear unchanged.
 */
export declare function credentialName(channel: Channel, bindingId: string): string;
/** `$DSH_HOME/plugin-data/im-robot`, read at call time. */
export declare function defaultDataDirectory(): string;
/** Reads and writes binding state files. */
export declare class BindingStore {
    readonly directory: string;
    constructor(directory: string);
    /** Every well-formed stored binding; malformed files are reported and skipped. */
    list(warn: (message: string) => void): StoredBinding[];
    /** One stored binding, or undefined when absent or malformed. */
    read(bindingId: string, warn: (message: string) => void): StoredBinding | undefined;
    /** Replace a binding's file atomically, owner-only. */
    write(binding: StoredBinding): void;
    /** Delete a binding's file; absent is fine. */
    delete(bindingId: string): void;
    /** The file of one binding. */
    pathOf(bindingId: string): string;
}
