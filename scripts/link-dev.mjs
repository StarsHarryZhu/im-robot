/**
 * Link the development toolchain from a sibling DeepSeek Harness checkout.
 *
 * The plugin publishes no runtime dependency, and installing a second copy of the
 * compiler, the test runner, or the host packages would only invite version drift
 * with the host that actually loads the plugin. Each package is therefore resolved
 * from the harness checkout and symlinked into this package's own `node_modules`.
 * Nothing is written outside that directory, nothing touches the network, and an
 * existing real directory is never replaced.
 *
 * Usage: `node scripts/link-dev.mjs`. Set `DSH_CHECKOUT` when the checkout is not at
 * `../../deepseek-harness` relative to this package.
 * @module im-robot/scripts/link-dev
 */

import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECKOUT = resolve(process.env.DSH_CHECKOUT ?? join(ROOT, '..', '..', 'deepseek-harness'))

/**
 * A directory junction on Windows, which needs neither Developer Mode nor an
 * administrator; an ordinary directory symlink everywhere else.
 */
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

/**
 * Packages to link and the checkout directories whose resolution finds them, in
 * preference order. An anchor is a directory holding a `package.json`; the package
 * is found the way Node would find it from there.
 */
const PACKAGES = [
  ['typescript', ['.']],
  ['vitest', ['.']],
  ['@types/node', ['.']],
  ['@deepseek-ai/cordis', ['apps/cli', 'vendor/cordis']],
  ['@deepseek-ai/schemastery', ['vendor/schemastery']],
  ['@deepseek-ai/dsh-credentials', ['packages/credentials/credentials']],
]

if (!existsSync(join(CHECKOUT, 'package.json'))) {
  console.error(`link-dev: no harness checkout at ${CHECKOUT}; set DSH_CHECKOUT`)
  process.exit(1)
}

let failed = false
for (const [name, anchors] of PACKAGES) {
  const target = locate(name, anchors)
  if (target === undefined) {
    console.error(`link-dev: ${name} was not found in the checkout`)
    failed = true
    continue
  }
  console.log(`${link(name, target)}  ${name} -> ${target}`)
}
process.exit(failed ? 1 : 0)

/**
 * Find one package directory from the checkout.
 * @param {string} name - package name.
 * @param {string[]} anchors - checkout-relative directories to resolve from.
 * @returns {string | undefined} the package's real directory.
 */
function locate(name, anchors) {
  for (const anchor of anchors) {
    const base = join(CHECKOUT, anchor)
    if (!existsSync(join(base, 'package.json'))) continue
    // A workspace package resolves to itself when the anchor is that package.
    if (readName(base) === name) return realpathSync(base)
    for (const searchPath of createRequire(join(base, 'package.json')).resolve.paths(name) ?? []) {
      const candidate = join(searchPath, name)
      if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    }
  }
  return undefined
}

/** Read a package directory's own name, or undefined when it has none. */
function readName(directory) {
  try {
    return createRequire(join(directory, 'package.json'))('./package.json').name
  } catch {
    return undefined
  }
}

/**
 * Point `node_modules/<name>` at the target, replacing only a stale symlink.
 * @param {string} name - package name.
 * @param {string} target - absolute package directory.
 * @returns {string} what happened, for the summary line.
 */
function link(name, target) {
  const path = join(ROOT, 'node_modules', name)
  mkdirSync(dirname(path), { recursive: true })
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    stat = undefined
  }
  if (stat !== undefined) {
    if (!stat.isSymbolicLink()) return 'kept  '
    if (realpathOrUndefined(path) === target) return 'ok    '
    unlinkSync(path)
    symlinkSync(target, path, LINK_TYPE)
    return 'moved '
  }
  symlinkSync(target, path, LINK_TYPE)
  return 'linked'
}

/** Resolve a symlink, or undefined when it dangles. */
function realpathOrUndefined(path) {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}
