/**
 * The `imRobot` service: logs chat accounts in, binds each to one session,
 * prompts the account owner's messages into that session, and sends the
 * session's answers back.
 *
 * Flow for one bound account:
 * 1. the channel adapter long-polls, reconnecting with backoff on errors, and
 *    hands over each message from the person who logged in;
 * 2. the service emits `im-robot/inbound(sessionId, channel)` and awaits its
 *    listeners; a `/` line runs as a session command when the binding allows
 *    commands and the command exists, and its outcome is the reply; anything
 *    else shows "typing" and is prompted into the session under a request id
 *    that names the binding, in `queue` mode, or `steer` mode while a turn is
 *    running if the binding asks for it;
 * 3. when the turn that consumed the message ends, the turn's final assistant
 *    text is stripped of Markdown, split by the binding's `replyMaxChars`,
 *    written to the binding's outbox on disk, and sent; a sent segment leaves the outbox, a
 *    failed one is retried after the next successful poll (so after a
 *    reconnect or a restart) while it is under 24 hours old and has failed at
 *    most three times; when only the account's next message can let it through
 *    (it never wrote, or the platform refused until it writes again, as WeChat
 *    does a day after its last message), the outbox waits for that message,
 *    uncounted, and then goes out in its context;
 * 4. when a turn without chat input ends and the session's latest human input
 *    came from the chat account, its answer is pushed too, unless `autoPush` is
 *    off: a follow-up's (a worker's report, an agent or team message, or a host
 *    note) through the outbox like a reply, a reminder's once without it; a turn
 *    with no text sends nothing;
 * 5. `send` reaches the account at any time, through the outbox; a turn running
 *    meanwhile sends no reply of its own.
 *
 * Bridging a chat account to a DSH session follows the idea of
 * `dsh-weixin-ilink` 0.9.1, `src/agent-bridge.js` (MIT License, Copyright (c)
 * 2026 dsh-weixin contributors; full text in THIRD_PARTY_NOTICES.md): one
 * durable session per conversation and the reply read back from the turn.
 * This module is written for this plugin: it prompts an existing session
 * through `sessionController.prompt` instead of creating agents, and replies
 * from live `session/event` turns instead of waiting for `whenIdle()`.
 * @module im-robot/service
 */
import type { ChannelAdapter } from './channels/adapter.ts';
import type { BindingStore } from './store.ts';
import type { TurnRoute } from './turns.ts';
import type { AgentPresetsLike, AttachmentsLike, BindingOptions, BindingStatus, Channel, CommandsLike, CredentialsLike, Diagnosis, FileUploadsLike, ImRobotOptions, ImRobotService, LoggerLike, LoginState, SessionControllerLike, SessionEventLike, SessionProjectionsLike } from './types.ts';
/** Default longest reply segment, in characters: one short chat message. */
export declare const DEFAULT_REPLY_MAX_CHARS = 100;
/** An outbox entry older than this is dropped instead of sent. */
export declare const OUTBOX_MAX_AGE_MS: number;
/** An outbox entry that has failed more often than this is dropped. */
export declare const OUTBOX_MAX_FAILURES = 3;
/** Longest wait of `reconnect` for the first poll to settle. */
export declare const RECONNECT_WAIT_MS = 15000;
/** Latest `notBefore` a caller may ask for: an entry waits at most this long. */
export declare const MAX_HOLD_MS: number;
/** Host services the service uses. */
export interface ServiceHost {
    credentials: CredentialsLike;
    sessionController: SessionControllerLike;
    /** `ctx.agentPresets` when the host has it. */
    agentPresets: () => AgentPresetsLike | undefined;
    logger: LoggerLike;
    /** Brand a credential reference name (`credentialRef` from dsh-credentials). */
    credentialRef: (name: string) => string;
    /** Emit `im-robot/status`. */
    emitStatus: (bindingId: string, state: BindingStatus) => void;
    /** Run the `im-robot/inbound` listeners and wait for them. */
    emitInbound: (sessionId: string, channel: Channel) => Promise<void>;
    /** `ctx.commands` when the host has it. */
    commands?: () => CommandsLike | undefined;
    /** `ctx.sessionProjections` when the host has it. */
    sessionProjections?: () => SessionProjectionsLike | undefined;
    /** `ctx.attachments` when the host has it: images then go into the prompt itself. */
    attachments?: () => AttachmentsLike | undefined;
    /** `ctx.fileUploads` when the host has it: files then go into the prompt by receipt. */
    fileUploads?: () => FileUploadsLike | undefined;
}
/** Service settings. */
export interface ServiceOptions {
    /** Presets a session may have to be bound; empty allows any. */
    presets: readonly string[];
    replyMaxChars: number;
    /** Whether turns no chat message started are answered on the chat by themselves; default true. */
    autoPush?: boolean;
    store: BindingStore;
    adapters: readonly ChannelAdapter[];
    /** Longest wait of `reconnect`; default {@link RECONNECT_WAIT_MS}. */
    reconnectWaitMs?: number;
}
/** The `imRobot` service implementation. */
export declare class ImRobot implements ImRobotService {
    private readonly host;
    private readonly options;
    private readonly bindings;
    private readonly logins;
    private readonly turns;
    private readonly adapters;
    /** The limit of bindings without their own. */
    private replyMaxChars;
    /** The global switch; each binding has its own as well. */
    private enabled;
    private disposed;
    /** Aborted on dispose; bounds `diagnose`. */
    private readonly lifetime;
    constructor(host: ServiceHost, options: ServiceOptions);
    /** Load stored bindings and resume receiving for the bound ones; their outboxes flush once connected. */
    start(): void;
    /** Stop every login, connection, and indicator. Outboxes stay on disk. */
    dispose(): void;
    login(bindingId: string, channel: Channel, signal?: AbortSignal): AsyncIterable<LoginState>;
    bind(bindingId: string, target: {
        sessionId: string;
    }): Promise<void>;
    unbind(bindingId: string): Promise<void>;
    status(bindingId: string): BindingStatus;
    setBindingOptions(bindingId: string, options: BindingOptions): BindingStatus;
    send(bindingId: string, text: string, options?: {
        notBefore?: number;
    }): void;
    route(bindingId: string, route: TurnRoute): boolean;
    /** A binding that can send now: logged in, bound, and switched on; else a plain-Chinese error. */
    private usable;
    reconnect(bindingId: string): Promise<BindingStatus>;
    diagnose(bindingId: string): Promise<Diagnosis>;
    setOptions(options: ImRobotOptions): void;
    /**
     * `session/event` listener: follow turns of bound sessions. It runs inside
     * the host's dispatch for every session, so a failure here is logged and
     * goes no further.
     */
    observe(sessionId: string, event: SessionEventLike): void;
    /** The login generator behind {@link login}. */
    private runLogin;
    /** Keep a confirmed login: secret to credentials, the rest to the state file. */
    private saveAccount;
    /**
     * Why a session cannot take a binding, in plain Chinese, or undefined when
     * it can: its preset must be configured, when presets are configured.
     * @param mustExist - also look the session up when no presets are configured.
     */
    private sessionProblem;
    /**
     * A session's preset, or undefined when it has none or it cannot be read.
     * `agentPresets.presetForSession` only exists from dsh 0.2.2-alpha.2. Older
     * hosts such as 0.2.1-rc.5 read the projection instead, which newer hosts
     * deprecate with a warning, so the registry goes first.
     */
    private presetOf;
    /** A runtime for a stored binding, not yet receiving. */
    private newRuntime;
    /** Whether a binding may send and receive: the global switch and its own are both on. */
    private isOn;
    /** A binding's longest reply segment: its own limit, or the global one. */
    private replyLimitOf;
    /** Reply text as the plain-text segments a binding sends. */
    private segmentsOf;
    /** Start the receive loop of a bound, enabled binding. */
    private startReceiving;
    /** Stop a binding's receive loop and indicator; it counts as not connected, with no error. */
    private stopRuntime;
    /**
     * Record the receive loop's health; emit `im-robot/status` when the status
     * changed; after a successful poll, retry whatever the outbox still holds.
     */
    private setHealth;
    /** Hand one accepted chat message to the bound session. */
    private deliver;
    /**
     * Run a `/` line as a command of the bound session and reply with its
     * outcome through the outbox, as the web composer would run it.
     * @returns false when the host has no command registry or no command of
     *   that name, so the line is prompted as text (skills are invoked that way).
     */
    private runCommand;
    /**
     * Reply to the chat messages a turn consumed, push a follow-up's or a
     * reminder's answer, or follow the caller's route for the turn.
     */
    private onTurnEnd;
    /** Count `count` prompted messages as answered; clear "typing" when none is left. */
    private settle;
    /** Write a reply's segments to the outbox, not to go before `notBefore` when given, then send what the outbox holds. */
    private enqueueReply;
    /**
     * Send the outbox in order after anything already queued for the binding.
     * Entries older than {@link OUTBOX_MAX_AGE_MS} are dropped unsent; a failed
     * send counts against its entry and ends this flush, and an entry that has
     * failed more than {@link OUTBOX_MAX_FAILURES} times is dropped. Drops are
     * only logged.
     */
    private flushOutbox;
    /**
     * Whether a failed send can only go through after the account's next
     * message: the adapter said so, or the platform's reply window has closed
     * since the account last wrote.
     */
    private refusedUntilMessage;
    /** Keep the latest failed send in the state file, so it can be read after a restart. */
    private noteFailure;
    /**
     * Queue outgoing work behind what the binding already has queued. A failure
     * that escapes is logged: it must neither block later messages nor reach
     * the host as an unhandled rejection.
     */
    private enqueue;
    /** Replace the outbox and persist it. */
    private replaceOutbox;
    /** Set or clear the outbox problem, emitting a status change when it changed. */
    private setSendError;
    /**
     * Send segments once, in order after anything already queued for the
     * binding, without the outbox: notices and reminder pushes. A failure is
     * logged and ends the batch; nothing is retried.
     */
    private sendOnce;
    /** Record whether the session's latest human input came from this chat account. */
    private setLastInput;
    /**
     * The adapter's view of one binding.
     * @param report - where health reports go; by default straight to {@link setHealth}.
     */
    private linkOf;
    /** Persist a binding, logging instead of throwing. */
    private writeQuietly;
    /** Bindings currently bound to a session. */
    private runtimesOf;
    private adapterOf;
    private refOf;
    /** A comparable snapshot of what `status()` would report for a runtime, without the message time stamps. */
    private statusKey;
    private emitStatus;
}
