/**
 * Binding state files: one JSON file per binding at
 * `$DSH_HOME/plugin-data/im-robot/<bindingId>.json` (DSH_HOME defaults to
 * `~/.dsh`), readable by the owner only. A file holds everything about a
 * binding except its secret, which lives in `ctx.credentials`.
 * @module im-robot/store
 */

import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { BindingOptions, Channel, SendMode } from './types.ts'

/** Channels a stored binding may name. */
const CHANNELS: readonly Channel[] = ['wechat']

/** Binding ids: letters, digits, `_` and `-`, starting with a letter or digit. */
const BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u

/** Send modes a stored binding may name. */
export const SEND_MODES: readonly SendMode[] = ['queue', 'steer']

/** Whether a value is usable as a `mediaDir`. */
export function isMediaDir(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value)
}

/** Smallest accepted `replyMaxChars`. */
export const MIN_REPLY_MAX_CHARS = 10

/** Whether a value is usable as a `replyMaxChars`. */
export function isReplyMaxChars(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= MIN_REPLY_MAX_CHARS
}

/** A binding's options with every default filled in; an unset `replyMaxChars` follows the global value. */
export type BindingSettings = Required<Omit<BindingOptions, 'replyMaxChars' | 'mediaDir'>> & Pick<BindingOptions, 'replyMaxChars' | 'mediaDir'>

/** The options of a binding that never changed them. */
export const DEFAULT_BINDING_SETTINGS: Readonly<BindingSettings> = Object.freeze({ sendMode: 'queue', commands: true, enabled: true })

/**
 * One reply waiting to be sent. It is written to disk before the first try
 * and removed once sent, so a restart or reconnect can retry it.
 */
export interface OutboxEntry {
  id: string
  /** One plain-text segment, already stripped and split. */
  text: string
  /** The reply context when the reply was made (WeChat: its `context_token`). */
  context?: string
  /** When the reply was made, epoch milliseconds. */
  createdAt: number
  /** Not to be sent before this moment, epoch milliseconds (quiet hours); absent means at once. */
  notBefore?: number
  /** Failed sends so far. */
  failures: number
}

/** One binding as stored. */
export interface StoredBinding {
  version: 1
  bindingId: string
  channel: Channel
  /** Masked account id for display. */
  user: string
  /** The session messages go to; absent until `bind`. */
  sessionId?: string
  /** Whether the session's latest human input came from this chat account. */
  lastInputFromChat: boolean
  /** Adapter-owned state (WeChat: ilinkUserId, botId, baseUrl, syncBuf, contextToken). */
  channelState: Record<string, string>
  /** Replies not yet sent, oldest first. Files written before the outbox existed read as empty. */
  outbox: OutboxEntry[]
  /** When the account was logged in, epoch milliseconds. */
  boundAt: number
  /** Delivery options; files written before they existed, or with invalid values, read as the defaults. */
  options: BindingSettings
  /** When the latest message from the account arrived, epoch milliseconds. */
  lastInboundAt?: number
  /** When the latest message to the account was sent, epoch milliseconds. */
  lastOutboundAt?: number
}

/** Throw unless `bindingId` is a valid binding id. */
export function assertBindingId(bindingId: unknown): asserts bindingId is string {
  if (typeof bindingId !== 'string' || !BINDING_ID.test(bindingId)) {
    throw new TypeError(`im-robot: invalid bindingId ${JSON.stringify(bindingId)}; use 1-64 letters, digits, "_" or "-"`)
  }
}

/**
 * The credential reference holding a binding's secret:
 * `IM_ROBOT_<CHANNEL>_<bindingId>`. A reference allows only letters, digits
 * and `_`, so `_` and `-` in the id are escaped as `_5F` and `_2D`, which
 * keeps distinct ids distinct; ids of letters and digits appear unchanged.
 */
export function credentialName(channel: Channel, bindingId: string): string {
  const escaped = bindingId.replace(/[_-]/gu, char => `_${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `IM_ROBOT_${channel.toUpperCase()}_${escaped}`
}

/** `$DSH_HOME/plugin-data/im-robot`, read at call time. */
export function defaultDataDirectory(): string {
  // The same rules as the host's own DSH home: a blank value counts as unset, and `~` is expanded.
  const configured = process.env.DSH_HOME
  const home = configured === undefined || configured.trim() === '' ? join(homedir(), '.dsh') : configured
  const expanded = home === '~' ? homedir() : home.startsWith('~/') || home.startsWith('~\\') ? join(homedir(), home.slice(2)) : home
  return join(resolve(expanded), 'plugin-data', 'im-robot')
}

/** Whether a parsed value is a well-formed {@link OutboxEntry}. */
function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string' && typeof entry.text === 'string'
    && (entry.context === undefined || typeof entry.context === 'string')
    && typeof entry.createdAt === 'number' && Number.isInteger(entry.failures) && (entry.failures as number) >= 0
    && (entry.notBefore === undefined || (typeof entry.notBefore === 'number' && Number.isFinite(entry.notBefore)))
}

/** The fields {@link normalize} fills in or drops. */
type LenientFields = 'outbox' | 'options' | 'lastInboundAt' | 'lastOutboundAt'

/** A parsed state file that passed {@link isStoredBinding}. */
type ParsedBinding = Omit<StoredBinding, LenientFields> & Partial<Record<LenientFields, unknown>>

/** Whether a parsed value is a well-formed {@link StoredBinding}, apart from the lenient fields. */
function isStoredBinding(value: unknown): value is ParsedBinding {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const state = record.channelState
  return record.version === 1
    && typeof record.bindingId === 'string' && BINDING_ID.test(record.bindingId)
    && CHANNELS.includes(record.channel as Channel)
    && typeof record.user === 'string'
    && (record.sessionId === undefined || (typeof record.sessionId === 'string' && record.sessionId !== ''))
    && typeof record.lastInputFromChat === 'boolean'
    && typeof record.boundAt === 'number'
    && typeof state === 'object' && state !== null && !Array.isArray(state)
    && Object.values(state).every(entry => typeof entry === 'string')
    && (record.outbox === undefined || (Array.isArray(record.outbox) && record.outbox.every(isOutboxEntry)))
}

/** A time stamp field, kept only when it is a usable epoch millisecond count. */
function stamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** A stored binding with defaults for the fields older or hand-edited files lack or got wrong. */
function normalize(parsed: ParsedBinding): StoredBinding {
  const { outbox, options, lastInboundAt, lastOutboundAt, ...rest } = parsed
  const given = (typeof options === 'object' && options !== null ? options : {}) as Record<string, unknown>
  const inbound = stamp(lastInboundAt)
  const outbound = stamp(lastOutboundAt)
  return {
    ...rest,
    outbox: Array.isArray(outbox) ? outbox as OutboxEntry[] : [],
    options: {
      sendMode: SEND_MODES.includes(given.sendMode as SendMode) ? given.sendMode as SendMode : DEFAULT_BINDING_SETTINGS.sendMode,
      commands: typeof given.commands === 'boolean' ? given.commands : DEFAULT_BINDING_SETTINGS.commands,
      enabled: typeof given.enabled === 'boolean' ? given.enabled : DEFAULT_BINDING_SETTINGS.enabled,
      ...(isReplyMaxChars(given.replyMaxChars) ? { replyMaxChars: given.replyMaxChars } : {}),
      ...(isMediaDir(given.mediaDir) ? { mediaDir: given.mediaDir } : {}),
    },
    ...(inbound === undefined ? {} : { lastInboundAt: inbound }),
    ...(outbound === undefined ? {} : { lastOutboundAt: outbound }),
  }
}

/** Reads and writes binding state files. */
export class BindingStore {
  constructor(readonly directory: string) {}

  /** Every well-formed stored binding; malformed files are reported and skipped. */
  list(warn: (message: string) => void): StoredBinding[] {
    let names: string[]
    try {
      names = readdirSync(this.directory)
    } catch {
      return []
    }
    const found: StoredBinding[] = []
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const binding = this.read(name.slice(0, -'.json'.length), warn)
      if (binding !== undefined) found.push(binding)
    }
    return found
  }

  /** One stored binding, or undefined when absent or malformed. */
  read(bindingId: string, warn: (message: string) => void): StoredBinding | undefined {
    if (!BINDING_ID.test(bindingId)) return undefined
    let text: string
    try {
      text = readFileSync(this.pathOf(bindingId), 'utf8')
    } catch {
      return undefined
    }
    try {
      const value: unknown = JSON.parse(text)
      if (isStoredBinding(value) && value.bindingId === bindingId) return normalize(value)
    } catch {
      // Reported below.
    }
    warn(`im-robot: ignoring the malformed state file of binding ${bindingId}`)
    return undefined
  }

  /** Replace a binding's file atomically, owner-only. */
  write(binding: StoredBinding): void {
    assertBindingId(binding.bindingId)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const target = this.pathOf(binding.bindingId)
    const temporary = `${target}.${randomBytes(4).toString('hex')}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600 })
      chmodSync(temporary, 0o600)
      renameSync(temporary, target)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }

  /** Delete a binding's file; absent is fine. */
  delete(bindingId: string): void {
    assertBindingId(bindingId)
    rmSync(this.pathOf(bindingId), { force: true })
  }

  /** The file of one binding. */
  pathOf(bindingId: string): string {
    return join(this.directory, `${bindingId}.json`)
  }
}
