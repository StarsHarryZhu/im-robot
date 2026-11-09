/**
 * im-robot host plugin.
 *
 * Connects chat accounts to DeepSeek Harness sessions and provides the
 * `imRobot` service: `login` a WeChat account by QR code, `bind` it to a
 * session, and from then on the account owner's private messages are prompted
 * into that session, with what they carry (images, files, voice, video) saved in
 * the binding's media folder and named in the text, and the turn's final answer
 * goes back as plain text; `send` reaches the account at any other time. Per binding, `setBindingOptions` chooses whether a
 * message steers a running turn, whether a `/` line runs as a session command,
 * whether the binding runs at all, and how long a reply segment may be;
 * `reconnect` restarts the connection and `diagnose` checks it. The plugin
 * registers no tool, no prompt, and no command, so sessions without a binding
 * behave exactly as before.
 *
 * Events: `im-robot/inbound(sessionId, channel)` before each message is
 * prompted (listeners are awaited), and `im-robot/status(bindingId, state)`
 * whenever a binding changes.
 *
 * A host plugin that sends a bound session a note of its own (a daily brief,
 * a watchdog note) uses a message whose source kind is `host-note`: it does
 * not count as web input, and its turn's answer reaches the chat account unless
 * `autoPush` is off.
 * @module im-robot
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export type { BindingOptions, BindingStatus, Channel, Diagnosis, DiagnosisCheck, ImRobotOptions, ImRobotService, LoginState, SendMode, } from './types.ts';
/** The markers a prompt can ask the model to wrap around a block that must arrive in one message. */
export { KEEP_CLOSE, KEEP_MAX_CHARS, KEEP_OPEN } from './reply.ts';
export declare const name = "im-robot";
export declare const inject: string[];
export interface Config {
    /** Presets a bound session must have; empty allows any session. */
    presets: string[];
    /** Longest reply segment, in characters. */
    replyMaxChars: number;
    /** Whether turns no chat message started are answered on the chat by themselves. */
    autoPush: boolean;
    /** A reply that is exactly this text, its surrounding blank space aside, is never sent; empty sends every reply. */
    silentReply: string;
}
export declare const Config: z<Config>;
/**
 * Provide the service, follow bound sessions' turns, and resume stored
 * bindings.
 * @param ctx - the plugin context; the services in {@link inject} are present.
 * @param config - loaded settings.
 */
export declare function apply(ctx: Context, config: Config): void;
