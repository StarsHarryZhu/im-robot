/**
 * Follow the turns of bound sessions through `session/event` and report what
 * each one means for the chat side: whose chat message it answered, whether a
 * reminder or a follow-up (a worker's report, an agent message, or a host
 * note) started it, and its final assistant text.
 *
 * The approach (settled `assistant/message` text, `turn/end` as the moment to
 * reply, the error reason when there is no text) follows the idea of
 * `dsh-weixin-ilink` 0.9.1, `src/session-reader.js` and `src/agent-bridge.js`
 * (MIT License, Copyright (c) 2026 dsh-weixin contributors; full text in
 * THIRD_PARTY_NOTICES.md); this module is written for live events rather than
 * re-reading the log after `whenIdle()`.
 * @module im-robot/turns
 */
import type { SessionEventLike } from './types.ts';
/** A request id that names its binding: `im-robot:<bindingId>:<uuid>`. */
export declare function requestIdFor(bindingId: string, unique: string): string;
/** The binding a request id belongs to, or undefined when another client sent it. */
export declare function bindingOfRequest(requestId: unknown): string | undefined;
/** What the tracker reports. */
export type TurnSignal = 
/** A human message from somewhere other than this plugin entered the session. */
{
    kind: 'foreign-input';
    sessionId: string;
}
/** A turn ended. */
 | {
    kind: 'turn-end';
    sessionId: string;
    /** The binding of each chat message this turn consumed, one entry per message, in order. */
    bindings: string[];
    /** Whether a scheduled reminder entered this turn. */
    reminder: boolean;
    /** Whether a worker's report, an agent or team message, or a host note entered this turn. */
    followUp: boolean;
    /** The turn's final assistant text; empty when it produced none. */
    text: string;
    /** Whether the service was asked to send to the chat during this turn. */
    sent: boolean;
    /** Where the caller routed this turn's final text, if it did: see {@link TurnRoute}. */
    route?: TurnRoute;
};
/**
 * A caller's choice for one turn's final text: `chat: true` sends it to the
 * chat whatever started the turn, not before `notBefore` when given;
 * `chat: false` keeps it off the chat even when a chat message started the turn.
 */
export interface TurnRoute {
    chat: boolean;
    notBefore?: number;
}
/** Follows turns of the sessions it is told about. */
export declare class TurnTracker {
    private readonly turns;
    /**
     * Observe one committed event.
     * @param sessionId - the session the event belongs to.
     * @param event - the event.
     * @returns what the event means for the chat side, if anything.
     */
    observe(sessionId: string, event: SessionEventLike): TurnSignal | undefined;
    /** Whether a turn of the session has started and not ended. */
    running(sessionId: string): boolean;
    /** Note that the service was asked to send to the chat during the session's open turn, if it has one. */
    markSent(sessionId: string): void;
    /**
     * Route the final text of the session's open turn; a later call replaces an earlier one.
     * @returns false when no turn of the session is open.
     */
    setRoute(sessionId: string, route: TurnRoute): boolean;
    /** Forget a session's open turn. */
    forget(sessionId: string): void;
    /** The open turn of a session, created when the plugin joined mid-turn. */
    private open;
}
