/**
 * The seam between the service and one chat platform. The service owns
 * bindings, credentials, the state file, sessions, and turns; an adapter owns
 * the platform's wire protocol and whatever per-account state it needs, which
 * it keeps in {@link ChannelLink.state} and the service persists for it.
 * @module im-robot/channels/adapter
 */
export {};
