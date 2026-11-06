import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Repository root: this spec lives one level below it. */
const ROOT = join(import.meta.dirname, '..')

/** Directories that hold code or documentation and therefore need this file. */
const DOCUMENTED_PREFIXES = ['src', 'tests', 'scripts', 'locale']

/** Directories that exist only to hold generated or vendored files. */
const SKIPPED = new Set(['node_modules', 'lib', '.git', '.claude', '.github'])

/** The four sections every file must carry, in this order. */
const SECTIONS = ['## 1. Role', '## 2. Constraints', '## 3. Contents', '## 4. Progress']

/** Every directory below `root`, excluding skipped names, as repository-relative paths. */
function directories(root: string, prefix = ''): string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIPPED.has(entry.name)) continue
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    found.push(path, ...directories(root, path))
  }
  return found
}

/** Read one repository file. */
function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

/** The directory a repository-relative path lives in, or '' for the root. */
function folderOf(path: string): string {
  const parent = dirname(path)
  return parent === '.' ? '' : parent
}

/** Directories that must carry the file: the root, plus code and documentation folders. */
const documented = ['', ...directories(ROOT).filter(path =>
  DOCUMENTED_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`)))]

describe('every folder documents itself', () => {
  it('has an AGENTS.md in the root and in every code or documentation folder', () => {
    expect(documented.length).toBeGreaterThanOrEqual(6)
    for (const folder of documented) {
      const path = folder === '' ? 'AGENTS.md' : `${folder}/AGENTS.md`
      expect(() => statSync(join(ROOT, path)), `missing ${path}`).not.toThrow()
    }
  })

  it('finds no documented folder that this spec forgot to walk', () => {
    // Guards the walk itself: a new top-level folder that holds code would show up
    // here as an unclassified directory rather than as a silent gap.
    const top = readdirSync(ROOT, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !SKIPPED.has(entry.name))
      .map(entry => entry.name)
    expect(top.sort()).toEqual(['locale', 'scripts', 'src', 'tests'])
  })
})

describe('the four sections', () => {
  it('carries exactly the four headings, in order', () => {
    for (const folder of documented) {
      const path = folder === '' ? 'AGENTS.md' : `${folder}/AGENTS.md`
      const headings = read(path).split('\n').filter(line => line.startsWith('## '))
      expect(headings, `${path} headings`).toEqual(SECTIONS)
    }
  })

  it('opens with a title and a Role section that says what the folder is for', () => {
    for (const folder of documented) {
      const path = folder === '' ? 'AGENTS.md' : `${folder}/AGENTS.md`
      const text = read(path)
      expect(text.startsWith('# AGENTS.md\n'), `${path} title`).toBe(true)
      const role = text.slice(text.indexOf('## 1. Role'), text.indexOf('## 2. Constraints'))
      expect(role.length, `${path} Role section is empty`).toBeGreaterThan(200)
    }
  })

  it('keeps every section non-empty', () => {
    for (const folder of documented) {
      const path = folder === '' ? 'AGENTS.md' : `${folder}/AGENTS.md`
      const text = read(path)
      for (const [index, heading] of SECTIONS.entries()) {
        const start = text.indexOf(heading) + heading.length
        const next = SECTIONS[index + 1]
        const end = next === undefined ? text.length : text.indexOf(next)
        expect(text.slice(start, end).trim().length, `${path} ${heading} is empty`).toBeGreaterThan(40)
      }
    }
  })
})

describe('the Contents list is true', () => {
  it('names only entries that exist in that folder', () => {
    for (const folder of documented) {
      const path = folder === '' ? 'AGENTS.md' : `${folder}/AGENTS.md`
      const text = read(path)
      const contents = text.slice(text.indexOf('## 3. Contents'), text.indexOf('## 4. Progress'))
      const entries = [...contents.matchAll(/^- `([^`]+)`/gmu)].map(match => match[1] as string)
      expect(entries.length, `${path} lists nothing`).toBeGreaterThan(0)
      for (const entry of entries) {
        // A backticked entry may be a file, a folder, or a file inside a folder.
        const candidates = [entry, entry.split(' ')[0] as string]
        const exists = candidates.some((candidate) => {
          const target = join(ROOT, folder, candidate)
          try {
            statSync(target)
            return true
          } catch {
            return false
          }
        })
        expect(exists, `${path} lists "${entry}", which does not exist in ${folder === '' ? '.' : folder}`).toBe(true)
      }
    }
  })

  it('names every source file the folder holds', () => {
    // The Contents list is the folder's contract; a file that appears nowhere in it
    // is a file the next reader will not find.
    for (const folder of documented.filter(path => path !== '')) {
      const text = read(`${folder}/AGENTS.md`)
      for (const entry of readdirSync(join(ROOT, folder), { withFileTypes: true })) {
        const name = entry.name
        if (name === 'AGENTS.md' || name === 'node_modules') continue
        if (entry.isDirectory()) {
          expect(text.includes(name), `${folder}/AGENTS.md does not mention ${name}/`).toBe(true)
          continue
        }
        const described = name.split('.').map((_, index, parts) => parts.slice(0, index + 1).join('.'))
        expect(described.some(candidate => text.includes(candidate)), `${folder}/AGENTS.md does not mention ${name}`).toBe(true)
      }
    }
  })

  it('does not describe a folder it does not own', () => {
    for (const folder of documented) {
      const path = folder === '' ? 'AGENTS.md' : `${folder}/AGENTS.md`
      // A relative link or a path that escapes the folder would point a reader at
      // another folder's contract.
      expect(read(path)).not.toContain('../')
    }
  })
})

describe('the documentation set', () => {
  it('keeps this file in the tests folder it describes', () => {
    expect(folderOf('tests/agents-md.test.ts')).toBe('tests')
    expect(read('tests/AGENTS.md')).toContain('agents-md.test.ts')
  })

  it('is written in English', () => {
    for (const folder of documented) {
      const path = folder === '' ? 'AGENTS.md' : `${folder}/AGENTS.md`
      // No CJK codepoints: the package's Chinese documentation lives in README.md.
      expect(/[\u4E00-\u9FFF]/u.test(read(path)), `${path} contains non-English text`).toBe(false)
    }
  })
})

/** Kept so a future walk can report a path relative to the root. */
void relative
