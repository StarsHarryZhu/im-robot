/**
 * The `imRobot` service contract the parent package codes against, the events
 * it observes, and structural mirrors of the host services this plugin reads.
 * Host types are mirrored rather than imported so the plugin needs no host
 * package beyond cordis, schemastery, and dsh-credentials.
 * @module im-robot/types
 */
/** Chat platforms the service can connect. The first version has WeChat only. */
export type Channel = 'wechat';
/**
 * One step of a login, in order: a code to show, the code was scanned, and the
 * account is connected; or the attempt ended with a reason in plain Chinese.
 */
export type LoginState = {
    status: 'qr';
    qr: string;
    expiresAt: number;
} | {
    status: 'scanned';
} | {
    status: 'bound';
    user: string;
} | {
    status: 'expired' | 'failed';
    reason: string;
};
/**
 * How a chat message enters a session that is running a turn: `queue` waits
 * for the next turn; `steer` joins the running turn. An idle session gets a
 * new turn either way.
 */
export type SendMode = 'queue' | 'steer';
/** Per-binding options, kept in the binding's state file. */
export interface BindingOptions {
    /** Default `queue`. */
    sendMode?: SendMode;
    /** Whether a message starting with `/` runs as a session command; default true. */
    commands?: boolean;
    /** `false` stops this binding's messages both ways until set back to `true`; default true. */
    enabled?: boolean;
    /** Longest reply segment of this binding, in characters; while never set, the global value applies. */
    replyMaxChars?: number;
    /** Absolute folder for what the account sends (images, files, voice, video); while never set, the plugin's data folder. */
    mediaDir?: string;
}
/**
 * What `status()` reports for one binding. `user` is a masked account id;
 * `connected` is true while the binding receives messages; `lastError` is the
 * latest unresolved problem in plain Chinese, such as an expired login.
 * `sendMode`, `commands`, and `enabled` are the binding's own options (the
 * defaults while it is not logged in), so `enabled` stays true while only the
 * global switch is off; `replyMaxChars` is the limit in effect, its own or the
 * global one; `lastInboundAt` and `lastOutboundAt` are epoch milliseconds of
 * the latest message from and to the account, and changing only them does not
 * emit `im-robot/status`.
 */
export interface BindingStatus {
    bound: boolean;
    user?: string;
    sessionId?: string;
    connected: boolean;
    lastError?: string;
    sendMode: SendMode;
    commands: boolean;
    enabled: boolean;
    replyMaxChars: number;
    lastInboundAt?: number;
    lastOutboundAt?: number;
}
/** One line of a {@link Diagnosis}, in plain Chinese. */
export interface DiagnosisCheck {
    label: string;
    ok: boolean;
    detail?: string;
}
/** The result of `diagnose()`: `ok` when every check passed. */
export interface Diagnosis {
    ok: boolean;
    checks: DiagnosisCheck[];
}
/** Runtime options the parent package may change at any time. */
export interface ImRobotOptions {
    /** Longest reply segment, in characters, of bindings without their own; longer replies go out as several messages. */
    replyMaxChars?: number;
    /** `false` stops every connection until set back to `true`; a binding runs only while this and its own `enabled` are both on. */
    enabled?: boolean;
}
/** The `imRobot` service. */
export interface ImRobotService {
    /** Log a chat account in for `bindingId`, yielding each step; a new call supersedes a running one. */
    login(bindingId: string, channel: Channel, signal?: AbortSignal): AsyncIterable<LoginState>;
    /** Deliver the binding's messages to `sessionId`; rejects a session outside the configured presets. */
    bind(bindingId: string, target: {
        sessionId: string;
    }): Promise<void>;
    /** Disconnect and delete the binding's credential and state file. */
    unbind(bindingId: string): Promise<void>;
    /** The binding's current state. */
    status(bindingId: string): BindingStatus;
    /**
     * Send text to the account on the caller's own initiative, through the outbox
     * like a reply, split by the binding's limit, with any `<keep>` block whole.
     * A turn of the bound session that is running when this is called sends no
     * automatic reply of its own: the caller has answered. With `notBefore`, it
     * waits in the outbox until then (at most 24 hours ahead).
     * @throws when the binding is not logged in, not bound, switched off, or the text is empty.
     */
    send(bindingId: string, text: string, options?: {
        notBefore?: number;
    }): void;
    /**
     * Route the final text of the bound session's running turn: `chat: true`
     * sends it to the account whatever started the turn (a reply to a chat
     * message as well as a heartbeat or a host note), not before `notBefore`
     * when given; `chat: false` keeps it off the chat, even as the answer to a
     * chat message. A later call in the same turn replaces an earlier one.
     * Routed text goes through the outbox like a reply; an empty one sends
     * nothing.
     * @returns false when no turn of the session is running, so nothing was routed.
     * @throws like {@link send}, and when `notBefore` lies more than 24 hours ahead.
     */
    route(bindingId: string, route: {
        chat: boolean;
        notBefore?: number;
    }): boolean;
    /** Change runtime options. */
    setOptions(options: ImRobotOptions): void;
    /** Change one logged-in binding's options, persist them, and return its new status. */
    setBindingOptions(bindingId: string, options: BindingOptions): BindingStatus;
    /**
     * Drop the binding's current poll, reset the backoff, poll again now, and
     * resolve with the status once that first poll settled. Never logs in again.
     */
    reconnect(bindingId: string): Promise<BindingStatus>;
    /** Check the binding without changing it; only a fully passing check clears `lastError`. */
    diagnose(bindingId: string): Promise<Diagnosis>;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        imRobot: ImRobotService;
    }
    interface Events {
        /** A chat message is about to be prompted into `sessionId`, or run there as a command; listeners are awaited first. */
        'im-robot/inbound'(sessionId: string, channel: Channel): void | Promise<void>;
        /** A binding's state changed. */
        'im-robot/status'(bindingId: string, state: BindingStatus): void;
    }
}
/** The host logger surface used here. */
export interface LoggerLike {
    info(message: string): void;
    warn(message: string): void;
}
/** `ctx.credentials`, reference half only. */
export interface CredentialsLike {
    resolve(ref: string): Promise<{
        value: string;
    } | undefined>;
    set(ref: string, value: string): Promise<void>;
    unset(ref: string): Promise<void>;
}
/** A Session as far as this plugin reads one. */
export interface SessionLike {
    readonly id: string;
}
/** One committed Session event; `data` is read defensively per type. */
export interface SessionEventLike {
    readonly type: string;
    readonly data?: unknown;
}
/** One text part of a prompt. */
export interface PromptTextPart {
    type: 'text';
    text: string;
}
/** An image a prompt carries itself: base64 bytes the host stores and normalizes on admission. */
export interface PromptImagePart {
    type: 'image';
    data: string;
    mediaType: string;
    name?: string;
}
/** A file a prompt carries by the receipt of an earlier upload to the same session. */
export interface PromptFilePart {
    type: 'file';
    receiptId: string;
}
/** One part of a prompt. */
export type PromptPart = PromptTextPart | PromptImagePart | PromptFilePart;
/** `ctx.attachments`, the one field used here: what images a prompt may carry. */
export interface AttachmentsLike {
    readonly imageLimits: {
        readonly maxImageBytes: number;
        readonly maxImagesPerMessage: number;
        readonly maxMessageImageBytes: number;
        readonly mediaTypes: readonly string[];
    };
}
/** `ctx.fileUploads`, the one method used here: store a file for one session and get its receipt. */
export interface FileUploadsLike {
    uploadStream(request: {
        sessionId: string;
        data: AsyncIterable<Uint8Array>;
        name?: string;
        signal?: AbortSignal;
    }): Promise<{
        receiptId: string;
    }>;
}
/** An Agent as far as this plugin reads one. */
export interface AgentLike {
    readonly session: SessionLike;
}
/** `ctx.sessionController`, the two methods used here. */
export interface SessionControllerLike {
    prompt(request: {
        requestId: string;
        sessionId: string;
        mode: SendMode;
        content: PromptPart[];
    }, signal: AbortSignal): Promise<unknown>;
    resolveAgent(sessionId: string): Promise<{
        agent: AgentLike;
    } | {
        error: {
            message: string;
        };
    }>;
}
/** A settled command, as `ctx.commands.execute` returns it. */
export interface CommandExecutionLike {
    readonly result: {
        readonly kind: 'success';
        readonly text?: string;
    } | {
        readonly kind: 'error';
        readonly text: string;
    };
}
/** `ctx.commands` (dsh-commands), the one method used here. */
export interface CommandsLike {
    /** Run a slash-command line for `agent`; undefined when no command of that name exists. */
    execute(agent: AgentLike, line: string, attachments: readonly never[], signal: AbortSignal): Promise<CommandExecutionLike | undefined>;
}
/** `ctx.agentPresets`, the one method used here, which hosts before dsh 0.2.2-alpha.2 do not have. */
export interface AgentPresetsLike {
    presetForSession?(session: SessionLike): string | null | undefined;
}
/** `ctx.sessionProjections`, the one method used here: how a host without `presetForSession` reads a session's preset. */
export interface SessionProjectionsLike {
    stateOf(session: SessionLike, key: string): unknown;
}
