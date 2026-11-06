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
/** Prefix of every prompt request id this plugin mints. */
const REQUEST_PREFIX = 'im-robot:';
/**
 * Message sources, other than a person typing, whose turns the chat account
 * should hear about: a background worker settling, another agent's or a team
 * member's message, and a note a host plugin sends on its own, such as a daily
 * brief or a watchdog note.
 */
const FOLLOW_UP_SOURCES = new Set(['subagent-settled', 'agent-message', 'team-message', 'host-note']);
/** A request id that names its binding: `im-robot:<bindingId>:<uuid>`. */
export function requestIdFor(bindingId, unique) {
    return `${REQUEST_PREFIX}${bindingId}:${unique}`;
}
/** The binding a request id belongs to, or undefined when another client sent it. */
export function bindingOfRequest(requestId) {
    if (typeof requestId !== 'string' || !requestId.startsWith(REQUEST_PREFIX))
        return undefined;
    const rest = requestId.slice(REQUEST_PREFIX.length);
    const colon = rest.indexOf(':');
    return colon > 0 ? rest.slice(0, colon) : undefined;
}
/** The assistant-visible text of a message's content blocks. */
function textOf(message) {
    const content = message?.content;
    if (!Array.isArray(content))
        return '';
    let text = '';
    for (const block of content) {
        const part = block;
        if (part?.type === 'text' && typeof part.text === 'string')
            text += part.text;
    }
    return text;
}
/** Follows turns of the sessions it is told about. */
export class TurnTracker {
    turns = new Map();
    /**
     * Observe one committed event.
     * @param sessionId - the session the event belongs to.
     * @param event - the event.
     * @returns what the event means for the chat side, if anything.
     */
    observe(sessionId, event) {
        switch (event.type) {
            case 'turn/start':
                this.turns.set(sessionId, { bindings: [], reminder: false, followUp: false, text: '', sent: false });
                return undefined;
            case 'user/message': {
                const source = event.data?.source;
                if (source?.kind === 'schedule') {
                    this.open(sessionId).reminder = true;
                    return undefined;
                }
                if (FOLLOW_UP_SOURCES.has(source?.kind)) {
                    this.open(sessionId).followUp = true;
                    return undefined;
                }
                if (source?.kind !== 'user')
                    return undefined;
                const binding = bindingOfRequest(source.rpcId);
                if (binding === undefined)
                    return { kind: 'foreign-input', sessionId };
                this.open(sessionId).bindings.push(binding);
                return undefined;
            }
            case 'assistant/message': {
                const data = event.data;
                if (data?.interrupted === true)
                    return undefined;
                const text = textOf(data?.message);
                if (text.trim() !== '')
                    this.open(sessionId).text = text;
                return undefined;
            }
            case 'turn/end': {
                const turn = this.turns.get(sessionId);
                this.turns.delete(sessionId);
                if (turn === undefined)
                    return undefined;
                return {
                    kind: 'turn-end', sessionId, bindings: turn.bindings, reminder: turn.reminder, followUp: turn.followUp, text: turn.text, sent: turn.sent,
                    ...(turn.route === undefined ? {} : { route: turn.route }),
                };
            }
            default:
                return undefined;
        }
    }
    /** Whether a turn of the session has started and not ended. */
    running(sessionId) {
        return this.turns.has(sessionId);
    }
    /** Note that the service was asked to send to the chat during the session's open turn, if it has one. */
    markSent(sessionId) {
        const turn = this.turns.get(sessionId);
        if (turn !== undefined)
            turn.sent = true;
    }
    /**
     * Route the final text of the session's open turn; a later call replaces an earlier one.
     * @returns false when no turn of the session is open.
     */
    setRoute(sessionId, route) {
        const turn = this.turns.get(sessionId);
        if (turn === undefined)
            return false;
        turn.route = route;
        return true;
    }
    /** Forget a session's open turn. */
    forget(sessionId) {
        this.turns.delete(sessionId);
    }
    /** The open turn of a session, created when the plugin joined mid-turn. */
    open(sessionId) {
        let turn = this.turns.get(sessionId);
        if (turn === undefined) {
            turn = { bindings: [], reminder: false, followUp: false, text: '', sent: false };
            this.turns.set(sessionId, turn);
        }
        return turn;
    }
}
