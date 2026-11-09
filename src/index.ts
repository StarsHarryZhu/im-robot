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

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WechatAdapter } from './channels/wechat/index.ts'
import { DEFAULT_REPLY_MAX_CHARS, ImRobot } from './service.ts'
import { BindingStore, MIN_REPLY_MAX_CHARS, defaultDataDirectory } from './store.ts'
import type {
  AgentPresetsLike, AttachmentsLike, BindingStatus, Channel, CommandsLike, CredentialsLike, FileUploadsLike, ImRobotService,
  SessionControllerLike, SessionEventLike, SessionLike, SessionProjectionsLike,
} from './types.ts'

export type {
  BindingOptions, BindingStatus, Channel, Diagnosis, DiagnosisCheck, ImRobotOptions, ImRobotService, LoginState, SendMode,
} from './types.ts'
/** The markers a prompt can ask the model to wrap around a block that must arrive in one message. */
export { KEEP_CLOSE, KEEP_MAX_CHARS, KEEP_OPEN } from './reply.ts'

export const name = 'im-robot'
export const inject = ['credentials', 'sessionController']

export interface Config {
  /** Presets a bound session must have; empty allows any session. */
  presets: string[]
  /** Longest reply segment, in characters. */
  replyMaxChars: number
  /** Whether turns no chat message started are answered on the chat by themselves. */
  autoPush: boolean
  /** A reply that is exactly this text, its surrounding blank space aside, is never sent; empty sends every reply. */
  silentReply: string
}

export const Config: z<Config> = z.object({
  presets: z.array(z.string().min(1)).default([])
    .description('Agent presets a session must have to be bound; empty allows any session'),
  replyMaxChars: z.natural().min(MIN_REPLY_MAX_CHARS).default(DEFAULT_REPLY_MAX_CHARS)
    .description('Longest reply segment in characters; longer replies are split at sentence ends, then commas, into several messages'),
  autoPush: z.boolean().default(true)
    .description('Answer turns no chat message started (a worker report, a host note, a reminder) on the chat by themselves, while its input was the latest; off when the caller sends with `imRobot.send`'),
  silentReply: z.string().default('')
    .description('A turn whose whole reply is exactly this text sends nothing to the chat, not even the no-reply notice; for a caller whose model answers a turn with nothing to say with a fixed marker. Empty sends every reply'),
}) as unknown as z<Config>

/** The services and events this plugin uses, beyond what cordis types. */
interface HostContext {
  readonly credentials: CredentialsLike
  readonly sessionController: SessionControllerLike
  readonly logger: { info(message: string): void; warn(message: string): void }
  get(name: 'agentPresets'): AgentPresetsLike | undefined
  get(name: 'commands'): CommandsLike | undefined
  get(name: 'sessionProjections'): SessionProjectionsLike | undefined
  get(name: 'attachments'): AttachmentsLike | undefined
  get(name: 'fileUploads'): FileUploadsLike | undefined
  provide(name: 'imRobot', value: ImRobotService): () => void
  effect(execute: () => () => void): void
  emit(name: 'im-robot/status', bindingId: string, state: BindingStatus): void
  parallel(name: 'im-robot/inbound', sessionId: string, channel: Channel): Promise<void>
  on(name: 'session/event', listener: (session: SessionLike, event: SessionEventLike) => void, options: { global: true }): () => void
}

/**
 * Provide the service, follow bound sessions' turns, and resume stored
 * bindings.
 * @param ctx - the plugin context; the services in {@link inject} are present.
 * @param config - loaded settings.
 */
export function apply(ctx: Context, config: Config): void {
  const host = ctx as unknown as HostContext
  const service = new ImRobot({
    credentials: host.credentials,
    sessionController: host.sessionController,
    agentPresets: () => host.get('agentPresets'),
    logger: host.logger,
    credentialRef: value => credentialRef(value),
    emitStatus: (bindingId, state) => host.emit('im-robot/status', bindingId, state),
    emitInbound: (sessionId, channel) => host.parallel('im-robot/inbound', sessionId, channel),
    commands: () => host.get('commands'),
    sessionProjections: () => host.get('sessionProjections'),
    attachments: () => host.get('attachments'),
    fileUploads: () => host.get('fileUploads'),
  }, {
    presets: config?.presets ?? [],
    replyMaxChars: config?.replyMaxChars ?? DEFAULT_REPLY_MAX_CHARS,
    autoPush: config?.autoPush ?? true,
    silentReply: config?.silentReply ?? '',
    store: new BindingStore(defaultDataDirectory()),
    adapters: [new WechatAdapter()],
  })
  host.effect(() => () => service.dispose())
  host.on('session/event', (session, event) => service.observe(session.id, event), { global: true })
  host.provide('imRobot', service)
  service.start()
}
