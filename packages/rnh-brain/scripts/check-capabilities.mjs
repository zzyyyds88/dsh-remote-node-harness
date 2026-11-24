/**
 * Reconcile every place that declares "what a node can do" against `capabilities.mjs`.
 *
 * ## Why this file exists
 *
 * The capability inventory was spread over six unrelated declarations and nothing compared
 * them (`docs/refactor-node-side.zh.md` §三-1). `capabilities.mjs` is now the registry; this
 * script is the thing that keeps the six sites honest, because a registry nobody checks is
 * just a seventh copy.
 *
 * ## What it reconciles
 *
 *   1. `packages/rnh-brain/cordis.patch.yml` row ids          vs `composedRowIds()`
 *   2. `packages/rnh-brain/presets/*.patch.yml` row ids       vs `presetRowIds(preset)`
 *   3. `trim-fork-runtime.mjs` `RETAINED`                     vs `keptPackages()`
 *   4. `trim-fork-runtime.mjs` `DROP_RULES`                   vs the `never`/`office` records
 *   5. `provision.js` `COPIED_ROW_IDS` / `PROVIDER_ROW`       vs the model plane's record
 *   6. `rnh-brain/package.json` `dsh.bundle.patch`            vs the `presets/` directory
 *   7. the plugin's node bundle list                          vs `BUNDLE_NAMES` here
 *   8. `DEFAULT_PLATFORM`                                     vs `PUBLISHED_PLATFORMS[0]`
 *
 * ## Report-only by default
 *
 * This is the design doc's batch-1 item 10: the first run has to produce a **real diff
 * table**, not a red suite, or the first thing anyone does is paper over the differences to
 * get green. So the default mode prints `ok  `/`DIFF` lines and exits 0.
 *
 * `--strict` makes a `DIFF` exit 1, and that is how the offline suite registers it
 * (`test/run-all.mjs`, suite `capabilities`): the matrix must be able to fail, or the check
 * is decoration. The differences that remain after this batch are listed in the trailer and
 * are *known* — a run with `--strict` therefore reports them by name rather than with a
 * count, so nobody has to re-derive which ones are expected.
 *
 * Usage:
 *   node packages/rnh-brain/scripts/check-capabilities.mjs               # report
 *   node packages/rnh-brain/scripts/check-capabilities.mjs --strict      # gate
 *
 * @module @local/rnh-brain/scripts/check-capabilities
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BUNDLE_NAMES,
  CAPABILITIES,
  DEFAULT_PLATFORM,
  capabilityOfPackage,
  composedRowIds,
  credentialRefsOfCapabilities,
  declaredDropRules,
  isForeignEngine,
  keptPackages,
  presetNames,
  presetRowIds,
} from '../capabilities.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RNH = resolve(HERE, '..')
const REPO = resolve(RNH, '..', '..')
const PLUGIN = resolve(REPO, 'packages', 'dsh-remote-node-harness')

/**
 * The rows a **DeepSeek** desktop composes, as `configEditor.configuration()` reports them.
 *
 * Deliberately the case that works: the coverage check asks whether the whitelist *can* derive
 * a declared ref at all. The case that used to fail — a desktop on some other provider — is the
 * unit test's job (`test/provision-unit.mjs`), because it is about a desktop this project does
 * not run and must not be the shape the gate assumes.
 */
const SYNTHETIC_DESKTOP = {
  configuration: () => [
    {
      entry: { options: { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key' } },
      inherited: {},
      override: { baseURL: 'http://llm.invalid/v1', models: [{ id: 'm' }] },
    },
    {
      entry: { options: { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model' } },
      inherited: {},
      override: { model: 'm' },
    },
  ],
}

/**
 * Differences that are **known and deliberately left for a later batch**, keyed by the check
 * that reports them. An entry here turns a `DIFF` into `known`, which keeps the gate able to
 * fail on a *new* difference — the alternative, an allow-list that hides everything, is how
 * a reconciliation script becomes a green rubber stamp.
 *
 * Each one is a capability the registry records but no mechanism yet implements; the batch
 * that implements it deletes its line here.
 */
const KNOWN = Object.freeze({
  // §2.3 C9: six families are subtracted at the *row* layer and left on disk at the
  // *package* layer (4.8 MiB). Deleting them is a `DROP_RULES` rewrite, which changes what
  // the build produces and therefore needs a rebuilt artefact to accept (design doc §四
  // gate 3, listed under "后续项"). Batch 2 states the inventory; it does not delete.
  'never-package-with-no-rule': [
    '@deepseek-ai/dsh-client-hmr',
    '@deepseek-ai/dsh-client-modules',
    '@deepseek-ai/dsh-host-directory-picker*',
    '@deepseek-ai/dsh-host-open-in-app',
    '@deepseek-ai/dsh-session-log-export',
    '@deepseek-ai/dsh-client-product-analytics',
    '@deepseek-ai/dsh-host-product-telemetry-otel',
    '@deepseek-ai/dsh-harness-dev-context',
  ],
})

const strict = process.argv.includes('--strict')
const failures = []
const known = []
const notes = []
const log = message => process.stdout.write(`${message}\n`)

/**
 * Report one reconciliation line.
 *
 * `knownKey` names a documented difference: it is printed as `known` and never fails the
 * gate, but it is still printed, so the list cannot quietly grow.
 */
function check(ok, label, detail) {
  if (ok) log(`ok   ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  else {
    log(`DIFF ${label}${detail === undefined ? '' : ` — ${detail}`}`)
    failures.push(label)
  }
  return ok
}

/** A difference the registry states but no mechanism implements yet. */
function checkKnown(ok, label, key, detail) {
  if (ok) {
    log(`ok   ${label}${detail === undefined ? '' : ` — ${detail}`}`)
    return true
  }
  const expected = KNOWN[key] ?? []
  const isDocumented = expected.some(entry => (detail ?? '').includes(entry))
  if (isDocumented) {
    log(`known ${label}${detail === undefined ? '' : ` — ${detail}`}`)
    known.push(`${label}: ${String(detail)}`)
    return true
  }
  log(`DIFF ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  failures.push(label)
  return false
}

/** The text of a file with line endings normalised (this repo checks out CRLF on Windows). */
function readText(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/gu, '\n')
}

/** Every row id a patch file names, whether inserted, targeted or disabled. */
function rowIdsOf(text) {
  const ids = []
  for (const match of text.matchAll(/^\s*- id: ([a-z0-9-]+)$/gmu)) {
    if (!ids.includes(match[1])) ids.push(match[1])
  }
  return ids
}

/** Set difference as a sorted, printable list. */
const missingFrom = (expected, actual) => expected.filter(item => !actual.includes(item))
const extraIn = (expected, actual) => actual.filter(item => !expected.includes(item))
const setEqual = (a, b) => missingFrom(a, b).length === 0 && extraIn(a, b).length === 0

// ── 1. the composition ──────────────────────────────────────────────────────
log('1. composition: packages/rnh-brain/cordis.patch.yml vs composedRowIds()')
{
  const composed = rowIdsOf(readText(join(RNH, 'cordis.patch.yml')))
  const declared = composedRowIds()
  const absent = missingFrom(composed, declared)
  const invented = extraIn(composed, declared)
  const detail = [
    `${String(composed.length)} rows in the file, ${String(declared.length)} in the registry`,
    absent.length === 0 ? '' : `composed but no capability claims: ${absent.join(', ')}`,
    invented.length === 0 ? '' : `claimed but not composed: ${invented.join(', ')}`,
  ].filter(Boolean).join('; ')
  check(absent.length === 0 && invented.length === 0, 'every composed row belongs to a capability', detail)

  // A `replaces` pair must be honoured in both directions, because half of it is what would
  // break a node: the substitute has to be present, and the substituted row must be absent.
  for (const capability of CAPABILITIES) {
    for (const [upstreamRow, substitute] of Object.entries(capability.replaces)) {
      check(composed.includes(substitute) && !composed.includes(upstreamRow),
        `${capability.id}: '${upstreamRow}' is replaced by '${substitute}' in the composition`,
        composed.includes(upstreamRow) ? 'the upstream row is present as well' : undefined)
    }
  }
}

// ── 2. the presets ──────────────────────────────────────────────────────────
log('')
log('2. presets: packages/rnh-brain/presets/*.patch.yml vs presetRowIds(preset)')
const presetFiles = readdirSync(join(RNH, 'presets'))
  .filter(name => name.endsWith('.patch.yml'))
  .map(name => name.replace(/\.patch\.yml$/u, ''))
{
  const registered = presetNames()
  check(setEqual(presetFiles, registered), 'the registry knows exactly the presets on disk',
    `${String(presetFiles.length)} on disk, ${String(registered.length)} registered`)
  for (const preset of presetFiles.filter(name => registered.includes(name))) {
    const onDisk = rowIdsOf(readText(join(RNH, 'presets', `${preset}.patch.yml`)))
    const { rows, dropped } = presetRowIds(preset)
    const absent = missingFrom(onDisk, rows)
    const invented = extraIn(onDisk, rows)
    check(absent.length === 0 && invented.length === 0,
      `preset ${preset}: every row belongs to a capability`,
      [
        `${String(onDisk.length)} rows on disk, ${String(rows.length)} registered`,
        absent.length === 0 ? '' : `no capability claims: ${absent.join(', ')}`,
        invented.length === 0 ? '' : `claimed but absent: ${invented.join(', ')}`,
        dropped.length === 0 ? '' : `${String(dropped.length)} withheld by an off record`,
      ].filter(Boolean).join('; '))
  }
}

// ── 3. the trim keep list ───────────────────────────────────────────────────
log('')
log('3. packaging: RETAINED vs keptPackages()')
const trimSource = readText(join(PLUGIN, 'scripts', 'trim-fork-runtime.mjs'))
{
  // Imported, not regex-parsed: the constant is *supposed* to be the derived value, and
  // importing is the only way to notice that it stopped being one.
  const { RETAINED, DROP_RULES } = await import(
    new URL(`file://${join(PLUGIN, 'scripts', 'trim-fork-runtime.mjs').replaceAll('\\', '/')}`).href
  )
  const derived = keptPackages()
  const missing = missingFrom(derived, RETAINED)
  const extra = extraIn(derived, RETAINED)
  check(missing.length === 0 && extra.length === 0, 'the keep set is the registry\'s kept packages',
    [
      `${String(RETAINED.length)} retained, ${String(derived.length)} derived`,
      missing.length === 0 ? '' : `derived but not retained: ${missing.join(', ')}`,
      extra.length === 0 ? '' : `retained but not derived: ${extra.join(', ')}`,
    ].filter(Boolean).join('; '))

  // Every retained name must have a home in some capability. This is the check that would
  // have failed for `libreoffice-kit` before the Office record existed.
  const homeless = RETAINED.filter(name => capabilityOfPackage(name) === undefined)
  check(homeless.length === 0, 'every retained package belongs to a capability', homeless.join(', ') || undefined)

  // A retained package a drop rule matches *and* retention does not protect is the shape of
  // the shipped Office bug. `dropPackages` skips retained names first, so the protection is
  // real — but the two must not need to agree for the build to be correct.
  const colliding = RETAINED.filter(name => {
    const bare = name.slice(name.lastIndexOf('/') + 1)
    return DROP_RULES.some(([pattern]) => pattern.test(bare))
  })
  check(colliding.length === 0, 'no retained package itself matches a drop rule',
    `${String(colliding.length)} collide: ${colliding.join(', ')}`)

  // ---- 4. the drop rules --------------------------------------------------
  log('')
  log('4. packaging: DROP_RULES vs the records that declare them')
  const declared = declaredDropRules()
  const ruleSources = DROP_RULES.map(([pattern]) => pattern.source)
  const undeclared = missingFrom(ruleSources, declared.map(entry => entry.source))
  const unused = extraIn(ruleSources, declared.map(entry => entry.source))
  check(undeclared.length === 0 && unused.length === 0,
    'every drop rule names the capability it implements',
    [
      undeclared.length === 0 ? '' : `rule in trim but not registered: ${undeclared.join(', ')}`,
      unused.length === 0 ? '' : `registered but not in trim: ${unused.join(', ')}`,
    ].filter(Boolean).join('; ') || `${String(ruleSources.length)} rules`)

  check(DROP_RULES.every(([, reason]) => typeof reason === 'string' && reason.length > 10),
    'every drop rule states its reason')

  // The engine rule is the one rule whose owner is a `required` capability: it removes
  // *another platform's* copy of the engine, not the engine. Both halves are asserted,
  // because narrowing it to `^libreoffice-kit` is exactly how Office broke.
  const office = CAPABILITIES.find(entry => entry.id === 'office')
  const engineRule = declared.find(entry => entry.capability === 'office')
  check(engineRule !== undefined, 'the office engine rule is declared by the office record')
  if (engineRule !== undefined) {
    const pattern = new RegExp(engineRule.source, 'u')
    const foreign = Object.values(office.platformPackages).flat()
      .map(name => name.slice(name.lastIndexOf('/') + 1))
      .filter(bare => isForeignEngine(`@deepseek-ai/${bare}`, DEFAULT_PLATFORM))
    const own = (office.platformPackages.linux ?? []).map(name => name.slice(name.lastIndexOf('/') + 1))
    const hitsForeign = foreign.every(bare => pattern.test(bare))
    const sparesOwn = own.every(bare => !pattern.test(bare))
    const sparesDriver = !pattern.test('libreoffice-kit')
    check(hitsForeign && sparesOwn && sparesDriver,
      'the engine rule removes only another platform\'s engine',
      `foreign ${foreign.length > 0 ? 'matched' : 'none'}, own engine ${sparesOwn ? 'spared' : 'DROPPED'}, driver ${sparesDriver ? 'spared' : 'DROPPED'}`)
  }

  // ---- the reverse direction, which is where the real gaps are ------------
  // A `never` record states what must not be on the node, and today only some of those
  // families have a rule. The missing ones are the 4.8 MiB of §2.3 C9: they are named and
  // counted here instead of being silently believed.
  log('')
  log('4b. the other direction: `never` packages that no rule reaches')
  for (const capability of CAPABILITIES.filter(entry => entry.verdict === 'never')) {
    const bare = name => name.slice(name.lastIndexOf('/') + 1)
    const covered = capability.packages.filter(pattern => {
      const sample = pattern.includes('*') ? pattern.replaceAll('*', 'sample') : pattern
      return DROP_RULES.some(([re]) => re.test(bare(sample)))
    })
    const uncovered = capability.packages.filter(pattern => !covered.includes(pattern))
    const expected = KNOWN['never-package-with-no-rule'] ?? []
    const documented = uncovered.filter(pattern => expected.includes(pattern))
    const surprise = uncovered.filter(pattern => !expected.includes(pattern))
    // A family (`*`) is one entry here and many packages on disk; the check is about the
    // record's own list, not about enumerating upstream.
    checkKnown(surprise.length === 0,
      `${capability.id}: every package family has a rule that deletes it`,
      'never-package-with-no-rule',
      uncovered.length === 0
        ? `${String(covered.length)} families, all covered`
        : `${String(covered.length)} covered, ${String(uncovered.length)} not (${[...documented, ...surprise].join(', ')})`)
  }
}

// ── 5. the provisioning whitelist ───────────────────────────────────────────
log('')
log('5. provisioning: provision.js COPIED_ROW_IDS / PROVIDER_ROW vs the model-plane record')
{
  const provision = readText(join(PLUGIN, 'src', 'host', 'provision.js'))
  const copiedRaw = /const COPIED_ROW_IDS = Object\.freeze\(\[([^\]]*)\]\)/u.exec(provision)?.[1] ?? ''
  const copied = [...copiedRaw.matchAll(/'([^']+)'/gu)].map(match => match[1])
  const providerRaw = /const PROVIDER_ROW = \/(.+)\/u\n/u.exec(provision)?.[1] ?? ''
  // `RegExp.prototype.source` escapes `/`, so a literal read out of the source file spells
  // `\/` where the registry spells `/`. Comparing the two without this normalisation reports a
  // difference that is not there — measured: it did, on the first run of this script.
  const provider = providerRaw.replaceAll('\\/', '/')
  const plane = CAPABILITIES.find(entry => entry.id === 'model-plane')
  check(plane !== undefined, 'the model plane is a registered capability')
  if (plane !== undefined) {
    const expectedRows = plane.provisionRows?.copied ?? []
    check(setEqual(copied, expectedRows), 'the copied row ids are the model plane\'s rows',
      `provision.js ${JSON.stringify(copied)} vs registry ${JSON.stringify(expectedRows)}`)
    check(provider === (plane.provisionRows?.providerPattern ?? ''),
      'the provider row pattern is the registered one',
      `provision.js ${JSON.stringify(provider)} vs registry ${JSON.stringify(plane.provisionRows?.providerPattern ?? '')}`)
    // Those rows are base-layer rows, which is *why* they are not in `composedRowIds()`.
    // Stating it keeps a reader from "fixing" the mismatch by adding them to the patch.
    const inComposition = (plane.provisionRows?.copied ?? []).filter(row => composedRowIds().includes(row))
    check(inComposition.length === 0,
      'the model plane\'s rows come from the base bundle, not from this patch',
      inComposition.length === 0 ? undefined : `${inComposition.join(', ')} — one row would then have two owners`)
    // **The coverage half.** A capability that names a credential the provisioning whitelist
    // cannot derive is a node that advertises a tool nobody can authenticate. `web_search` was
    // exactly that: mounted by every preset, needing `DEEPSEEK_API_KEY`, and reachable only
    // through `llm-*` rows — so a desktop whose provider is not DeepSeek pushed nothing.
    // Measured before this check existed: `credentialRefsOf(copyableRows(nonDeepSeek))` is `[]`
    // while `tool-web` is composed, and no test could see it.
    //
    // Imported here rather than at module scope: `capabilities.mjs` must stay importable from a
    // tree with no plugin beside it (the trim script runs inside the fork build), while this
    // section is about the plugin. A dynamic import keeps that separation readable.
    const { credentialRefsOf, copyableRows } = await import(
      new URL(`file://${join(PLUGIN, 'src', 'host', 'provision.js').replaceAll('\\', '/')}`).href
    )
    const declared = credentialRefsOfCapabilities()
    const reachable = new Set(credentialRefsOf(copyableRows(SYNTHETIC_DESKTOP)))
    const unreachable = declared.filter(ref => !reachable.has(ref))
    check(unreachable.length === 0,
      'every credential a capability names is one the provisioning whitelist can derive',
      unreachable.length === 0
        ? `${declared.join(', ') || '(none declared)'}`
        : `${unreachable.join(', ')} — a node would advertise the tool and fail every call`)
    // The other direction: a whitelist that derives a ref no capability declares is a key
    // pushed to every node for no stated reason. Not fatal, but it has to be visible.
    const undeclared = [...reachable].filter(ref => !declared.includes(ref))
    check(undeclared.length === 0, 'and nothing is pushed that no capability asked for',
      undeclared.length === 0 ? undefined : `extra refs: ${undeclared.join(', ')}`)
  }
}

// ── 6. the bundle manifest ──────────────────────────────────────────────────
log('')
log('6. manifest: rnh-brain/package.json dsh.bundle.patch vs presets/')
{
  const manifest = JSON.parse(readText(join(RNH, 'package.json')))
  const declaredRaw = manifest.dsh?.bundle?.patch
  const declared = Array.isArray(declaredRaw) ? declaredRaw : typeof declaredRaw === 'string' ? [declaredRaw] : []
  // The brain *needs* an array (its composition plus four preset files), so the array shape is
  // correct here. What used to be wrong was the reader: `rowsOfBundle()` accepted only a string
  // and answered `[]` for every list-shaped bundle, which silently disabled both "what does this
  // switch bring" and "a switch that contributes nothing is refused" for exactly the two
  // bundles that matter. Both shapes are read now, and this asserts the reader kept that.
  const switchesSource = readText(join(PLUGIN, 'src', 'host', 'sync-switches.js'))
  const readsBothShapes = /typeof declared === 'string' \? \[declared\] : Array\.isArray\(declared\)/u.test(switchesSource)
  check(readsBothShapes, 'the row reader accepts both the string and the array manifest shape',
    readsBothShapes ? undefined : 'rowsOfBundle() still reads only one shape (§2.3 C8)')
  check(declared.length > 0, 'this bundle declares at least one patch file', JSON.stringify(declaredRaw))
  const presetFilesDeclared = declared.filter(file => file.includes('presets/')).map(file => file.replace(/^\.\/presets\//u, '').replace(/\.patch\.yml$/u, ''))
  check(setEqual(presetFilesDeclared, presetFiles), 'every preset on disk is declared, and nothing else is',
    `${JSON.stringify(presetFilesDeclared)} vs ${JSON.stringify(presetFiles)}`)
}

// ── 7. the node's bundle names ----------------------------------------------
log('')
log('7. bundle names: the plugin\'s fixed composition vs BUNDLE_NAMES')
{
  const pluginSync = readText(join(PLUGIN, 'src', 'core', 'plugin-sync.js'))
  const rnh = readText(join(PLUGIN, 'src', 'host', 'rnh.js'))
  const switches = readText(join(PLUGIN, 'src', 'host', 'sync-switches.js'))
  const daemon = readText(join(PLUGIN, 'src', 'remote', 'daemon.js'))
  const literal = (text, pattern) => pattern.exec(text)?.[1]

  const base = literal(pluginSync, /export const NODE_BUNDLE_BASE = '([^']+)'/u)
  const brain = literal(pluginSync, /export const BRAIN_PACKAGE = '([^']+)'/u)
  const webApp = literal(pluginSync, /export const NODE_BUNDLE_UPSTREAM_SURFACE = '([^']+)'/u)
  check(base === BUNDLE_NAMES.base, 'the node base bundle is the registered name', `${String(base)} vs ${BUNDLE_NAMES.base}`)
  check(brain === BUNDLE_NAMES.brain, 'the brain bundle is the registered name', `${String(brain)} vs ${BUNDLE_NAMES.brain}`)
  check(webApp === BUNDLE_NAMES.webApp, 'the upstream web bundle is the registered name', `${String(webApp)} vs ${BUNDLE_NAMES.webApp}`)

  // The node's own pair is derived from the two names above, so a rename can only be made in
  // one place; anything else would let a literal survive a rename and split the answer again.
  check(/export const NODE_BASE_BUNDLES = Object\.freeze\(\[NODE_BUNDLE_BASE, BRAIN_PACKAGE\]\)/u.test(pluginSync),
    'the node bundle pair is derived from the two named bundles, not spelled again')

  // The two lists that were separate answers to one question. They are compared **as text**,
  // because the point is that nobody has to keep them in sync by hand: both must now be the
  // same export.
  const importsShared = /import \{[^}]*NODE_BASE_BUNDLES[^}]*\} from '\.\.\/core\/plugin-sync\.js'/u.test(rnh)
    && /import \{[^}]*NODE_BASE_BUNDLES[^}]*\} from '\.\.\/core\/plugin-sync\.js'/u.test(switches)
  check(importsShared, 'rnh.js and sync-switches.js get the node bundle list from one export',
    importsShared ? undefined : 'one of them still spells its own list')
  check(!/Object\.freeze\(\['@deepseek-ai\/dsh-base', '@local\/rnh-brain'\]\)/u.test(switches),
    'sync-switches.js no longer hard-codes the pair as a string')
  check(!/'@deepseek-ai\/dsh-base'/u.test(rnh),
    'rnh.js names no bundle of its own either', /'@deepseek-ai\/dsh-base'/u.test(rnh) ? 'it still does' : undefined)
  // The third list is a different question (see the conclusion and `daemon.js`'s comment):
  // restoring upstream's untouched `web` profile template. It is reported so a reader can
  // see it was considered rather than missed.
  const webProfile = literal(daemon, /const WEB_PROFILE_BUNDLES = Object\.freeze\(\[([^\]]+)\]\)/u)
  notes.push(`daemon.js WEB_PROFILE_BUNDLES = [${String(webProfile)}] — a profile *template* to restore, deliberately not the node's list`)
  log(`note the third list answers a different question: ${notes.at(-1)}`)
}

// ── 8. the platform the registry assumes --------------------------------
log('')
log('8. platform: DEFAULT_PLATFORM vs PUBLISHED_PLATFORMS[0]')
{
  const { PUBLISHED_PLATFORMS } = await import(
    new URL(`file://${join(PLUGIN, 'src', 'remote', 'artefact.js').replaceAll('\\', '/')}`).href
  )
  check(DEFAULT_PLATFORM === PUBLISHED_PLATFORMS[0],
    'the registry builds for the platform the artefact publishes',
    `${DEFAULT_PLATFORM} vs ${PUBLISHED_PLATFORMS[0]}`)
}

// ── 9. third-party bundles: what a node is given, and what it needs to work ------
log('')
log('9. third-party bundles: the registry records, and the generated copy in the plugin')
{
  const { THIRD_PARTY_BUNDLES, isSafeHomeRelativePath, declaredConfigFiles } = await import(
    new URL('../capabilities.mjs', import.meta.url).href
  )
  check(THIRD_PARTY_BUNDLES.length > 0, 'at least one third-party bundle is registered',
    THIRD_PARTY_BUNDLES.map(entry => entry.bundle).join(', '))

  // Every record has to be complete, because a half record is worse than none: the supply
  // chain reads `configFiles` and would write `undefined` paths.
  for (const entry of THIRD_PARTY_BUNDLES) {
    const label = entry.bundle
    check(typeof entry.bundle === 'string' && entry.bundle.length > 0, `${label}: names a bundle`)
    check(typeof entry.summary === 'string' && entry.summary.length > 0, `${label}: says what it does`)
    check(typeof entry.offReason === 'string' && entry.offReason.length > 0,
      `${label}: says why the node may not get it`)
    check(Array.isArray(entry.configFiles) && entry.configFiles.length > 0,
      `${label}: declares the configuration it reads`)
    for (const file of entry.configFiles ?? []) {
      const where = `${label} ${String(file.path)}`
      // A path that escapes the home would write outside the directory this project owns on
      // the node — the one thing a config carrier must never be able to do.
      check(isSafeHomeRelativePath(file.path), `${where}: stays inside the node's home`)
      check(file.format === 'json', `${where}: a format this writer implements`, String(file.format))
      // Anything carrying a credential has to be unreadable to other users on that machine.
      check(file.mode === '0600', `${where}: is written 0600`, String(file.mode))
      check(Array.isArray(file.keys) && file.keys.length > 0, `${where}: whitelists at least one key`)
      check((file.keys ?? []).every(key => typeof key === 'string' && /^[A-Za-z][A-Za-z0-9]*$/u.test(key)),
        `${where}: every whitelisted key is a plain JSON key name`)
    }
  }

  // The generated copy in the plugin must be these records, not a second hand-written list.
  // `BRAIN_THIRD_PARTY_CONFIG` is written by `embed-into-rnh.mjs`; a record added here without
  // regenerating means the node silently keeps getting the old set.
  const embedded = readText(join(PLUGIN, 'src', 'host', 'brain-bundle.generated.js'))
  const expected = JSON.stringify(declaredConfigFiles())
  // The literal is indented by the generator (`Object.freeze([` … `\n  ])`), so the capture is
  // the whole argument and parsed rather than compared as text.
  const actual = /export const BRAIN_THIRD_PARTY_CONFIG = Object\.freeze\(([\s\S]*?)\)\n/u.exec(embedded)?.[1]
  check(actual !== undefined, 'the plugin embeds a third-party config registry', 'BRAIN_THIRD_PARTY_CONFIG')
  if (actual !== undefined) {
    let parsed
    try {
      parsed = JSON.parse(actual)
    } catch (error) {
      parsed = undefined
      check(false, 'the embedded registry is valid JSON', error.message)
    }
    check(parsed !== undefined && JSON.stringify(parsed) === expected,
      'the embedded registry is the one this module declares — regenerate after editing',
      parsed === undefined ? undefined : `${JSON.stringify(parsed)} vs ${expected}`)
  }
}

// ── the verdict ─────────────────────────────────────────────────────────────
log('')
const rows = CAPABILITIES.length
const composed = composedRowIds().length
log(`${String(rows)} capabilities, ${String(composed)} composed rows, ${String(keptPackages().length)} kept packages`)
if (known.length > 0) {
  log(`${String(known.length)} known difference(s), stated by the registry and left for a later batch:`)
  for (const line of known) log(`  · ${line}`)
}
if (failures.length > 0) {
  log(`${String(failures.length)} unexpected difference(s): ${failures.join(', ')}`)
  if (strict) {
    log('FAILED (--strict)')
    process.exitCode = 1
  } else {
    log('report-only: exit 0 — pass --strict to make these fail')
  }
} else {
  log('every declaration agrees with capabilities.mjs')
}

/**
 * The upstream package roster, when a source checkout is present.
 *
 * Not used above: it is here so the next batch can answer "does this rule reach a real
 * package?" without re-deriving the walk. Kept as a function rather than at module scope so
 * a checkout-less CI does not pay for it.
 */
export function upstreamPackageNames(root = join(REPO, 'reference', 'deepseek-harness')) {
  const names = new Set()
  const walk = (dir, depth) => {
    if (depth > 4 || !existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const manifest = join(full, 'package.json')
      if (existsSync(manifest)) {
        try {
          const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
          if (typeof parsed.name === 'string') names.add(parsed.name)
        } catch {
          // A fixture with a deliberately broken manifest: not this walk's business.
        }
        continue
      }
      walk(full, depth + 1)
    }
  }
  walk(join(root, 'packages'), 0)
  walk(join(root, 'apps'), 0)
  return [...names]
}
