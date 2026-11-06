/**
 * Build the published host half.
 *
 * 1. Type-check (`tsconfig.json`).
 * 2. Emit `src/` to `lib/` with `tsc` as plain ESM, which Node loads like any
 *    other package.
 * 3. Self-check: import the emitted entry, call `apply(ctx, config)` the way
 *    cordis does against a minimal fake host, and require the `imRobot`
 *    service with its whole interface to be provided and every effect to clean
 *    up on dispose.
 *
 * im-robot has no browser half, so nothing is bundled. The build has no
 * dependency beyond the TypeScript compiler. `lib/` is generated: edit `src/`,
 * never `lib/`.
 * @module im-robot/build
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const LIB = join(ROOT, 'lib')
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

/** The service methods the parent package calls; the self-check requires each. */
const SERVICE_METHODS = ['login', 'bind', 'unbind', 'status', 'setOptions', 'setBindingOptions', 'reconnect', 'diagnose']

if (!existsSync(TSC)) fail(`TypeScript is not linked; run "node scripts/link-dev.mjs" first (looked for ${TSC})`)
tsc(['--noEmit', '-p', join(ROOT, 'tsconfig.json')], 'typecheck')
rmSync(LIB, { recursive: true, force: true })
tsc(['-p', join(ROOT, 'tsconfig.build.json')], 'emit')
assertNoTsSpecifiers(LIB)
await selfCheck()
console.log(`build: lib/ (${walk(LIB).filter(file => file.endsWith('.js')).length} modules); self-check passed`)

/** Run the TypeScript compiler, failing the build with its output. */
function tsc(args, label) {
  try {
    execFileSync(process.execPath, [TSC, ...args], { cwd: ROOT, stdio: 'pipe' })
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim()
    fail(`${label} failed:\n${output}`)
  }
}

/** A module that still imports `./x.ts` would not load in Node. */
function assertNoTsSpecifiers(directory) {
  for (const file of walk(directory)) {
    if (!file.endsWith('.js')) continue
    const text = readFileSync(file, 'utf8')
    if (/from\s+['"]\.{1,2}\/[^'"]+\.tsx?['"]/u.test(text)) fail(`${relative(ROOT, file)} still imports a .ts specifier`)
  }
}

/**
 * Load the emitted entry and drive it through the activation contract with a
 * fake host whose plugin-data directory is empty, so no channel starts.
 */
async function selfCheck() {
  const home = mkdtempSync(join(tmpdir(), 'im-robot-build-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const entry = await import(pathToFileURL(join(LIB, 'index.js')).href)
    if (entry.name !== 'im-robot') fail(`the entry is named ${JSON.stringify(entry.name)}, not im-robot`)
    if (!Array.isArray(entry.inject) || !entry.inject.includes('credentials') || !entry.inject.includes('sessionController')) {
      fail('the entry must inject credentials and sessionController')
    }
    if (typeof entry.apply !== 'function' || entry.Config === undefined) fail('the entry exports no apply or Config')
    const provided = new Map()
    const disposers = []
    const listeners = []
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
      sessionController: { prompt: async () => ({ accepted: true }), resolveAgent: async () => ({ error: { message: 'none' } }) },
      get: () => undefined,
      on: (name) => { listeners.push(name); return () => {} },
      emit: () => {},
      parallel: async () => {},
      // Like cordis, the provided service is owned by the plugin fiber and leaves with it.
      provide: (name, value) => { provided.set(name, value); const dispose = () => provided.delete(name); disposers.push(dispose); return dispose },
      effect: (execute) => { const dispose = execute(); if (typeof dispose === 'function') disposers.push(dispose) },
    }
    entry.apply(ctx, entry.Config({}))
    const service = provided.get('imRobot')
    if (service === undefined) fail('apply(ctx) did not provide imRobot')
    for (const method of SERVICE_METHODS) {
      if (typeof service[method] !== 'function') fail(`imRobot.${method} is not a function`)
    }
    const status = service.status('self-check')
    if (status?.bound !== false || status?.connected !== false) fail('imRobot.status of an unknown binding is not { bound: false, connected: false }')
    if (!listeners.includes('session/event')) fail('apply(ctx) does not observe session/event')
    for (const dispose of disposers.reverse()) await dispose()
    if (provided.size !== 0) fail('disposing the plugin left the service behind')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
}

/** Every file below a directory, recursively. */
function walk(directory) {
  if (!existsSync(directory)) return []
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...walk(full))
    else found.push(full)
  }
  return found
}

/** Stop the build with a message. */
function fail(message) {
  console.error(`build: ${message}`)
  process.exit(1)
}
