import { readdirSync, readFileSync } from 'node:fs'

/**
 * Every test file on disk has to be reachable from `run-all.mjs`.
 *
 * A suite that exists but is not registered runs in nobody's sweep, and the number in the README
 * counts it as if it did. That is not hypothetical here: `registry-unit.mjs` sat unregistered for
 * a whole batch, so its 67 assertions about `nodes.json` — the file whose failure mode is "your
 * nodes disappear" — never ran in a full pass.
 *
 * The check is a set comparison, not a name match: `run-all` names suites (`registry`) while the
 * files are named (`registry-unit.mjs`), so the only reliable key is the file each entry runs.
 */
const TEST_DIR = 'packages/dsh-remote-node-harness/test'
/** Files in `test/` that are helpers, not suites. */
const HELPERS = new Set(['run-all.mjs', 'carrier.mjs', 'layout.mjs', 'node.mjs'])

const source = readFileSync(`${TEST_DIR}/run-all.mjs`, 'utf8')
const registered = new Set()
for (const m of source.matchAll(/file: \['packages', '([^']+)', (?:'[^']+', )*?'([a-z0-9-]+\.mjs)'\]/gu)) {
  // Two suites live in `rnh-brain/scripts/` (they are that package's own gates); the rest are
  // files in `test/`. Only the latter is this check's subject.
  if (m[1] !== 'dsh-remote-node-harness') continue
  registered.add(m[2])
}

const onDisk = readdirSync(TEST_DIR)
  .filter(name => name.endsWith('.mjs') && !HELPERS.has(name))
  .sort()

let failed = 0
const log = message => process.stdout.write(`[suite-registry-unit] ${message}\n`)
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

const unregistered = onDisk.filter(name => !registered.has(name))
check(unregistered.length === 0,
  'every test file on disk is scheduled by run-all.mjs',
  unregistered.length === 0 ? `${String(onDisk.length)} files` : `never runs: ${unregistered.join(', ')}`)

const phantom = [...registered].filter(name => !onDisk.includes(name)).sort()
check(phantom.length === 0,
  'and every file run-all names exists',
  phantom.length === 0 ? undefined : `missing on disk: ${phantom.join(', ')}`)

// Each entry also has to declare a layer: a suite with no layer belongs to no sweep, and
// `--layer` would silently never run it. Counted over **every** entry, including the two that
// live in `rnh-brain/scripts/` — this check is about the matrix's shape, not about which
// directory a file happens to be in.
const entries = [...source.matchAll(/\{\s*name: '([^']+)',/gu)].map(m => m[1])
const withLayer = [...source.matchAll(/\{\s*name: '[^']+',\s*layer: '([^']+)'/gu)].map(m => m[1])
check(entries.length === withLayer.length,
  'every suite entry declares its layer',
  `${String(entries.length)} entries, ${String(withLayer.length)} with a layer`)
const layers = new Set(withLayer)
check([...layers].every(layer => ['offline', 'contract', 'e2e'].includes(layer)),
  'and only the three known layers are used', [...layers].join(', '))

process.stdout.write(
  failed === 0
    ? `[suite-registry-unit] all checks passed (${String(onDisk.length)} suites)\n`
    : `[suite-registry-unit] FAILED: ${String(failed)} check(s)\n`,
)
process.exitCode = failed === 0 ? 0 : 1
