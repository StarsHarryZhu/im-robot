/**
 * The WeChat adapter: Tencent iLink behind the {@link ChannelAdapter} seam.
 *
 * Adapter-owned state kept in the binding's state file:
 * - `ilinkUserId` — the person who scanned; the only sender accepted and the reply target;
 * - `botId` — the bot account iLink created for this login;
 * - `baseUrl` — the API host iLink assigned;
 * - `syncBuf` — the getupdates cursor;
 * - `contextToken` — the latest `context_token`, echoed on every reply.
 * The bot token itself lives in `ctx.credentials`.
 * @module im-robot/channels/wechat
 */
import type { ChannelAdapter, ChannelLink, ChannelProbe, InboundMessage, AdapterLoginState } from '../adapter.ts';
import type { LoginTiming } from './login.ts';
import type { MonitorHealth, MonitorTiming } from './monitor.ts';
import type { TypingTiming } from './typing.ts';
export { DEFAULT_BASE_URL } from './api.ts';
/** What a user reads as `lastError` while the loop is not connected. */
export declare const CONNECTION_PROBLEM: Record<Exclude<MonitorHealth, 'connected'>, string>;
/** Construction options; tests point `baseUrl` at a fake server and shorten timings. */
export interface WechatOptions {
    baseUrl?: string;
    login?: Partial<LoginTiming>;
    monitor?: Partial<MonitorTiming>;
    typing?: Partial<TypingTiming>;
    /** Timeout of the getconfig call behind `probe`. */
    probeTimeoutMs?: number;
    /** Where media comes from when the server gives no full URL. */
    cdnBaseUrl?: string;
    /** Timeout and size limit of one media download. */
    mediaTimeoutMs?: number;
    mediaMaxBytes?: number;
}
/** WeChat over iLink. */
export declare class WechatAdapter implements ChannelAdapter {
    readonly channel: "wechat";
    private readonly baseUrl;
    private readonly loginTiming;
    private readonly monitorTiming;
    private readonly typingTiming;
    private readonly probeTimeoutMs;
    private readonly cdnBaseUrl;
    private readonly mediaLimits;
    private readonly tickets;
    constructor(options?: WechatOptions);
    login(signal: AbortSignal): AsyncGenerator<AdapterLoginState>;
    receive(link: ChannelLink, deliver: (message: InboundMessage) => Promise<void>, signal: AbortSignal): Promise<void>;
    replyContext(link: ChannelLink): string | undefined;
    send(link: ChannelLink, text: string, context?: string): Promise<void>;
    /** One getconfig call: it needs the bot token and only reads the account's typing ticket. */
    probe(link: ChannelLink, signal: AbortSignal): Promise<ChannelProbe>;
    startTyping(link: ChannelLink): () => void;
    /** Forget per-account caches when a binding goes away. */
    forget(bindingId: string): void;
    /** The account's API host: the one iLink assigned at login, else the default. */
    private apiBase;
}
