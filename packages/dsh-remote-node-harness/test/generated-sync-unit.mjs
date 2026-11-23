/**
 * The embedded brain bundle must be the files on disk — every file, and no others.
 *
 * `packages/rnh-brain` is the source of truth for the node-side composition, and
 * `src/host/brain-bundle.generated.js` is a copy of it that travels inside the plugin.
 * Nothing else re-reads that copy: `scripts/check-composition.mjs` inspects the source
 * files, `scripts/embed-into-rnh.mjs` writes without verifying what it wrote, and
 * `run-all.mjs` only ran the former. So a source edit whose rebuild was skipped ships
 * the old composition while every check stays green.
 *
 * Measured before this gate existed: commit e5a741b (the project rename) hand-restored
 * one upstream comment in `cordis.patch.yml` (`# One shared MCP server fleet:`) but did
 * not re-run the generator, so the embedded copy kept the renamed text
 * (`# One shared MCP server rnh:`). Seven files, one stale line, all checks passed.
 *
 * The five things asserted here are the five ways that can happen again:
 *
 *   1. the embedded file set equals the source file set (a new preset with no rebuild),
 *   2. each entry is non-empty (a generator that silently read nothing),
 *   3. each entry equals its source file after line-ending normalisation (an edit whose
 *      rebuild was skipped — the case above),
 *   4. `package.json` still parses (a mangled template literal still "looks" embedded),
 *   5. the header banner's own source manifest equals the entries (a header that describes
 *      a different generation than the one in the file).
 *
 * Run: `node test/generated-sync-unit.mjs`
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RNH = resolve(HERE, '..', '..', 'rnh-brain')
const GENERATED = resolve(HERE, '..', 'src', 'host', 'brain-bundle.generated.js')

const log = message => process.stdout.write(`[generated-sync-unit] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/**
 * A file's text as it travels inside the bundle: line endings normalised to `\n`.
 *
 * Two things make raw bytes the wrong thing to compare. The module embeds each source
 * into a JS template literal, and a template literal's cooked value maps `<CR><LF>` to
 * `\n` — so the embedded copy is LF even when the file on disk is not. And this
 * repository sets `core.autocrlf=true` for Windows contributors, so a fresh clone checks
 * `cordis.patch.yml` out with CRLF. Comparing raw bytes would report six files as stale
 * on a clean checkout of an unchanged commit, which is exactly the line-ending artefact
 * `check-composition.mjs:32-43` documents. Normalising both sides leaves the real drift.
 */
const carried = text => text.replace(/\r\n/gu, '\n')

// ---- the generated module ---------------------------------------------------
// Imported rather than parsed, because the node really imports it too: a fix that only
// makes the file *text* match (a hand edit that the generator would undo) is not a fix.
const { BRAIN_FILES, BRAIN_PACKAGE } = await import(`file://${GENERATED.replaceAll('\\', '/')}`)

check(typeof BRAIN_FILES === 'object' && BRAIN_FILES !== null,
  'the bundle exports a file table (BRAIN_FILES)')
check(typeof BRAIN_PACKAGE === 'string' && BRAIN_PACKAGE.length > 0,
  'the bundle names the package a node profile lists', BRAIN_PACKAGE)

const embedded = Object.keys(BRAIN_FILES)
log(`embedded entries: ${String(embedded.length)}`)

/**
 * What `scripts/embed-into-rnh.mjs` is supposed to embed, read from disk.
 *
 * Deliberately re-derived from the directory rather than hard-coded to the generated
 * keys: a preset added to `presets/` without a rebuild then shows up as a set
 * difference instead of being silently accepted.
 */
const sources = [
  'package.json',
  'cordis.patch.yml',
  ...readdirSync(join(RNH, 'presets')).filter(name => name.endsWith('.yml')).map(name => `presets/${name}`),
  'src/runtime.js',
]

// ---- 1. the set -------------------------------------------------------------
{
  const inBundle = new Set(embedded)
  const onDisk = new Set(sources)
  const missing = sources.filter(path => !inBundle.has(path))
  const stale = embedded.filter(path => !onDisk.has(path))
  const detail = []
  if (missing.length > 0) detail.push(`not embedded: ${missing.join(', ')} (run node packages/rnh-brain/scripts/embed-into-rnh.mjs)`)
  if (stale.length > 0) detail.push(`embedded but not a source: ${stale.join(', ')}`)
  check(missing.length === 0 && stale.length === 0,
    'the bundle carries exactly the files that are on disk', detail.join('; ') || undefined)
}

// ---- 2/3. every entry, against its source ----------------------------------
for (const path of sources) {
  const entry = BRAIN_FILES[path]
  if (typeof entry !== 'string') {
    check(false, `entry exists: ${path}`, `got ${typeof entry} — see the set check above`)
    continue
  }
  check(entry.length > 0, `entry is not empty: ${path}`,
    entry.length === 0 ? 'the generator embedded an empty file' : undefined)

  const onDisk = carried(readFileSync(join(RNH, path), 'utf8'))
  const inBundle = carried(entry)
  if (onDisk === inBundle) {
    check(true, `entry matches its source exactly (line endings normalised): ${path}`)
    continue
  }
  const a = onDisk.split('\n')
  const b = inBundle.split('\n')
  const differing = []
  for (let at = 0; at < Math.max(a.length, b.length) && differing.length < 3; at += 1) {
    if (a[at] !== b[at]) differing.push(at)
  }
  const detail = differing.length === 0
    ? `source has ${String(a.length)} lines, bundle has ${String(b.length)}`
    : differing.map(at => `line ${String(at + 1)}: source ${JSON.stringify(a[at] ?? '<missing>')} / bundle ${JSON.stringify(b[at] ?? '<missing>')}`).join('; ')
  check(false, `entry matches its source exactly (line endings normalised): ${path}`,
    `${detail} — regenerate with node packages/rnh-brain/scripts/embed-into-rnh.mjs`)
}

// ---- 4. the manifest still parses ------------------------------------------
{
  let manifest
  try {
    manifest = JSON.parse(carried(BRAIN_FILES['package.json'] ?? ''))
    check(true, 'the embedded package.json is JSON')
  } catch (error) {
    check(false, 'the embedded package.json is JSON', error.message.split('\n')[0])
  }
  if (manifest !== undefined) {
    check(manifest.name === BRAIN_PACKAGE,
      'the embedded manifest names the same package BRAIN_PACKAGE does',
      `${String(manifest.name)} vs ${BRAIN_PACKAGE}`)
  }
}

// ---- 5. the header says what it embedded -----------------------------------
{
  // The module is checked out through `core.autocrlf=true` like every other file here, so
  // the banner is normalised the same way the entries are — otherwise a fresh clone would
  // report "no source list in the banner" for a header that is present.
  const lines = carried(readFileSync(GENERATED, 'utf8')).split('\n')
  const marked = lines.findIndex(line => /^ \* Embedded sources \(\d+\):$/u.test(line))
  if (marked < 0) {
    check(false, 'the header records the sources it embedded',
      'no " * Embedded sources (N):" line in the banner — the generator does not record its own input list')
  } else {
    const stated = Number(/\((\d+)\)/u.exec(lines[marked])[1])
    const listed = []
    for (let at = marked + 1; at < lines.length; at += 1) {
      const match = /^ \* {3}(\S+)$/u.exec(lines[at])
      if (match === null) break
      listed.push(match[1])
    }
    check(stated === listed.length, 'the header\'s count agrees with the list it printed',
      `${String(stated)} stated, ${String(listed.length)} listed`)
    const manifest = new Set(listed)
    const keys = new Set(embedded)
    const unlisted = embedded.filter(path => !manifest.has(path))
    const ghosts = listed.filter(path => !keys.has(path))
    const detail = []
    if (unlisted.length > 0) detail.push(`carried but not recorded: ${unlisted.join(', ')}`)
    if (ghosts.length > 0) detail.push(`recorded but not carried: ${ghosts.join(', ')}`)
    check(unlisted.length === 0 && ghosts.length === 0,
      'the header lists exactly the files the bundle carries', detail.join('; ') || undefined)
  }
  // The banner is where a reader learns what to do with this file; if it stopped naming
  // the generator, the next person edits by hand (AGENTS §6 forbids exactly that).
  check(lines.some(line => line.includes('scripts/embed-into-rnh.mjs')),
    'the header still tells the reader to regenerate with embed-into-rnh.mjs')
}

// ---- verdict ----------------------------------------------------------------
if (failures.length > 0) {
  log(`${String(failures.length)} failed: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all assertions passed')
}
