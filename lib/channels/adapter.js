/**
 * The seam between the service and one chat platform. The service owns
 * bindings, credentials, the state file, sessions, and turns; an adapter owns
 * the platform's wire protocol and whatever per-account state it needs, which
 * it keeps in {@link ChannelLink.state} and the service persists for it.
 * @module im-robot/channels/adapter
 */
/**
 * The platform refused a message until the person writes again (WeChat: their
 * chat went quiet too long, or too much was sent since their last message).
 * The service keeps the message and sends it after their next one.
 */
export class ChatRefusedError extends Error {
    name = 'ChatRefusedError';
}
/**
 * A file cannot be sent as it is now: it is gone, not a regular file, empty,
 * or over the platform's limit. Retrying cannot help, so the service drops it.
 */
export class UnsendableFileError extends Error {
    name = 'UnsendableFileError';
}
