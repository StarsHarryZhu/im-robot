/**
 * The seam between the service and one chat platform. The service owns
 * bindings, credentials, the state file, sessions, and turns; an adapter owns
 * the platform's wire protocol and whatever per-account state it needs, which
 * it keeps in {@link ChannelLink.state} and the service persists for it.
 * @module im-robot/channels/adapter
 */
import type { Channel, LoggerLike } from '../types.ts';
/** What a confirmed login hands the service. */
export interface ChannelAccount {
    /** The secret every call needs; the service keeps it in `ctx.credentials`, never on disk. */
    readonly token: string;
    /** Masked account id for display. */
    readonly user: string;
    /** Adapter-owned, non-secret state to persist (account ids, API host, cursors). */
    readonly state: Record<string, string>;
}
/** One login step as an adapter reports it; `confirmed` carries the account instead of `bound`. */
export type AdapterLoginState = {
    status: 'qr';
    qr: string;
    expiresAt: number;
} | {
    status: 'scanned';
} | {
    status: 'confirmed';
    account: ChannelAccount;
} | {
    status: 'expired' | 'failed';
    reason: string;
};
/**
 * One accepted inbound message: text to prompt, in which the adapter has named
 * any files it saved in `ChannelLink.mediaDir`, or a kind this version cannot read.
 */
export type InboundMessage = {
    kind: 'text';
    text: string;
} | {
    kind: 'unsupported';
};
/** What a quick, read-only check of an account found. */
export interface ChannelProbe {
    /** Whether the platform's server answered. */
    reachable: boolean;
    /** Whether it accepted the account's secret; undefined when its answer does not tell. */
    tokenAccepted?: boolean;
    /** Plain Chinese: why the server could not be reached, or what it objected to. */
    problem?: string;
}
/** One connected account as an adapter sees it. */
export interface ChannelLink {
    readonly bindingId: string;
    /** The adapter-owned state, as last persisted. */
    readonly state: Readonly<Record<string, string>>;
    /** The folder for what the person sends: images, files, voice, video. */
    readonly mediaDir: string;
    /** Merge into the adapter-owned state and persist it before resolving. */
    update(patch: Record<string, string>): Promise<void>;
    /** The account's secret, resolved per call; undefined once it is gone. */
    token(): Promise<string | undefined>;
    /**
     * Report the receive loop's health after every poll: connected, or not with
     * a plain-Chinese problem for the family member (the service emits a status
     * change only when this changes).
     */
    report(connected: boolean, problem?: string): void;
    readonly logger: LoggerLike;
}
/** One chat platform. */
export interface ChannelAdapter {
    readonly channel: Channel;
    /** Run one login; ends after `confirmed`, `expired`, `failed`, or an abort. */
    login(signal: AbortSignal): AsyncIterable<AdapterLoginState>;
    /**
     * Receive until `signal` aborts, handing each accepted message to `deliver`
     * in order, and reporting health through `link.report`. Errors reconnect
     * with backoff; the loop does not end on its own. Only the person who logged
     * in is accepted, in a private chat.
     */
    receive(link: ChannelLink, deliver: (message: InboundMessage) => Promise<void>, signal: AbortSignal): Promise<void>;
    /**
     * The platform's reply context at this moment (WeChat: the latest
     * `context_token`), kept with an outbox entry so a retry answers in the
     * same context.
     */
    replyContext(link: ChannelLink): string | undefined;
    /** Send one plain-text message to the person who logged in, in `context` when given, else the latest. */
    send(link: ChannelLink, text: string, context?: string): Promise<void>;
    /**
     * Ask the server one lightweight question with the account's secret,
     * changing nothing, to tell whether it answers and accepts the secret.
     * Never throws.
     */
    probe(link: ChannelLink, signal: AbortSignal): Promise<ChannelProbe>;
    /** Show "typing" until the returned function is called. Never throws. */
    startTyping(link: ChannelLink): () => void;
    /** Drop any per-account cache once a binding is removed. */
    forget?(bindingId: string): void;
}
