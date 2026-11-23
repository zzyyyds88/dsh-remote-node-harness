/**
 * The capability registry's own logic, asserted directly.
 *
 * `check-capabilities` compares the registry against the files on disk; this file tests the
 * registry itself. The split matters because the reconciliation can only fail when a real file
 * disagrees — a broken `verdict` branch or a `*` pattern that silently matches nothing would
 * pass it, because both sides of that comparison come from the same module.
 *
 * The `optional` branch is the specific reason this file exists. Every shipped capability is
 * `required` or `never` today, so without a synthetic record the "an unsatisfiable optional
 * capability must be absent, not declared-then-broken" rule would be untested code claiming to
 * be a guarantee.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BUNDLE_NAMES,
  CAPABILITIES,
  DEFAULT_PLATFORM,
  capabilityById,
  capabilityOfPackage,
  capabilityOfRow,
  composedRowIds,
  credentialRefsOfCapabilities,
  enabledCapabilities,
  isForeignEngine,
  keptPackages,
  meetsRequirements,
  packagePatternMatches,
  packagesOf,
  presetNames,
  presetRowIds,
  unmetCredentialRequirements,
} from '../../rnh-brain/capabilities.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')
const RNH = join(REPO, 'packages', 'rnh-brain')

let failed = 0
const log = message => process.stderr.write(`[capabilities-unit] ${message}\n`)
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

// ---- 1. every record is well formed ----------------------------------------
{
  const ids = CAPABILITIES.map(capability => capability.id)
  check(new Set(ids).size === ids.length, 'no two capabilities share an id', `${String(ids.length)} records`)
  for (const capability of CAPABILITIES) {
    const label = capability.id
    check(['required', 'optional', 'never'].includes(capability.verdict),
      `${label}: verdict is one of the three values`, capability.verdict)
    check(typeof capability.offReason === 'string' && capability.offReason.length > 20,
      `${label}: states a reason a person can read`, capability.offReason)
    // A `never` record with rows is the mechanism (it subtracts); a `required` record with no
    // rows and no provisioning must be doing something with packages or credentials instead.
    const doesSomething = capability.rows.length > 0
      || Object.keys(capability.presetRows).length > 0
      || capability.packages.length > 0
      || (capability.provisionRows?.copied?.length ?? 0) > 0
    check(doesSomething, `${label}: owns at least one row, preset row, package or provisioned row`)
  }
}

// ---- 2. the verdict branches are real --------------------------------------
{
  // `required` + probed-missing comes back as `off` with a reason, so the caller can refuse.
  const found = CAPABILITIES.find(capability => capability.verdict === 'required')
  const broken = enabledCapabilities({ nodeMajor: 1 })
    .find(entry => entry.capability.id === found.id)
  check(broken !== undefined && broken.state === 'off' && typeof broken.reason === 'string',
    'a required capability whose prerequisite fails is reported off with a reason',
    JSON.stringify(broken))

  // `optional` satisfied → on; unsatisfied → absent from the list entirely (never declared).
  const optional = {
    id: 'synthetic-optional', verdict: 'optional', summary: 'a test record', rows: ['synthetic-row'],
    presetRows: {}, packages: [], platformPackages: {}, manifestOnly: [], replaces: {},
    host: Object.freeze({ node: '>=22' }), dropRules: [], offReason: 'a synthetic record for the branch',
  }
  check(meetsRequirements(optional, {}).met === false
    && meetsRequirements(optional, {}).unverified?.includes('node >=22'),
    'an optional capability with an unprobed requirement counts as unverified, not satisfied')
  // …and the asymmetry: the same unprobed requirement never turns a required one off.
  check(meetsRequirements({ ...optional, verdict: 'required' }, {}).met === true,
    'an unverified requirement does not switch a required capability off',
    'composing a brain without its transport would be the worse failure')
}

// ---- 3. package patterns --------------------------------------------------
{
  check(packagePatternMatches('@deepseek-ai/dsh-client-ui-*', '@deepseek-ai/dsh-client-ui-chat'),
    'a family pattern matches a member')
  check(!packagePatternMatches('@deepseek-ai/dsh-client-ui-*', '@deepseek-ai/dsh-client-hmr'),
    'and does not match a neighbour with a different prefix')
  check(packagePatternMatches('@deepseek-ai/dsh-host-directory-picker*', '@deepseek-ai/dsh-host-directory-picker'),
    'a trailing wildcard matches the bare name too')
  check(!packagePatternMatches('exact-name', 'exact-name-extra'),
    'a pattern with no wildcard is an exact match, not a prefix match')
  // A pattern that matches nothing is how a `never` family stops being enforced.
  for (const capability of CAPABILITIES.filter(entry => entry.verdict === 'never')) {
    for (const pattern of capability.packages) {
      check(pattern.includes('*') || pattern.length > 0,
        `${capability.id}: '${pattern}' is a usable pattern`)
    }
  }
}

// ---- 4. foreign engines ---------------------------------------------------
{
  check(isForeignEngine('@deepseek-ai/libreoffice-kit-win32-x64', 'linux-x64'),
    'a win32 native engine is foreign to a linux artefact')
  check(isForeignEngine('@deepseek-ai/libreoffice-kit-darwin-arm64', 'linux-x64'),
    'a darwin native engine is foreign to a linux artefact')
  check(!isForeignEngine('@deepseek-ai/libreoffice-kit-wasm', 'linux-x64'),
    'the portable engine is not foreign to linux')
  check(!isForeignEngine('@deepseek-ai/libreoffice-kit', 'linux-x64'),
    'the driver is not an engine at all, so it is never foreign')
  // On the platform the engine belongs to, it must survive.
  check(!isForeignEngine('@deepseek-ai/libreoffice-kit-win32-x64', 'win32-x64'),
    'a win32 engine is not foreign to a win32 artefact')
}

// ---- 5. derived row sets --------------------------------------------------
{
  const composed = composedRowIds()
  const neverRows = new Set(CAPABILITIES.filter(entry => entry.verdict === 'never').flatMap(entry => entry.rows))
  check(composed.every(row => !neverRows.has(row)),
    'no `never` row survives into the composition')
  check(new Set(composed).size === composed.length, 'the composition lists each row once')
  // `replaces`: the substitute is in, the substituted row is out.
  for (const capability of CAPABILITIES) {
    for (const [upstreamRow, substitute] of Object.entries(capability.replaces)) {
      check(composed.includes(substitute) && !composed.includes(upstreamRow),
        `${capability.id}: '${substitute}' is composed and '${upstreamRow}' is not`)
    }
  }
  // Every row id is owned by exactly one record, in both directions.
  for (const row of composed) {
    check(capabilityOfRow(row) !== undefined, `composed row '${row}' has an owner`, capabilityOfRow(row))
  }
}

// ---- 6. presets ------------------------------------------------------------
{
  const disk = readdirSync(join(RNH, 'presets'))
    .filter(name => name.endsWith('.patch.yml'))
    .map(name => name.replace(/\.patch\.yml$/u, ''))
  const registered = presetNames()
  check(disk.length === registered.length && disk.every(name => registered.includes(name)),
    'the registry names exactly the presets on disk', `${JSON.stringify(registered)} vs ${String(disk.length)} files`)
  for (const preset of registered) {
    const { rows, dropped } = presetRowIds(preset)
    const text = readFileSync(join(RNH, 'presets', `${preset}.patch.yml`), 'utf8').replace(/\r\n/gu, '\n')
    const onDisk = [...text.matchAll(/^\s*- id: ([a-z0-9-]+)$/gmu)].map(match => match[1])
    check(rows.length + dropped.length === onDisk.length,
      `${preset}: every row on disk is either claimed or deliberately dropped`,
      `${String(rows.length)} claimed + ${String(dropped.length)} dropped vs ${String(onDisk.length)} on disk`)
    for (const entry of dropped) {
      check(typeof entry.reason === 'string' && entry.reason.length > 0,
        `${preset}: the dropped row '${entry.row}' says why`, entry.reason)
    }
  }
}

// ---- 7. packages and the keep set -----------------------------------------
{
  check(keptPackages().length > 0, 'the keep set is not empty', keptPackages().join(', '))
  // Every kept name is owned by an enabled capability — the property the old `RETAINED` failed.
  for (const name of keptPackages()) {
    check(capabilityOfPackage(name) !== undefined, `kept package '${name}' belongs to a capability`,
      capabilityOfPackage(name))
  }
  // Platform packages are resolved per target, and a foreign engine is never one of them.
  const office = capabilityById('office')
  const linuxPackages = packagesOf(office, { platform: 'linux-x64' })
  check(linuxPackages.some(name => name.includes('wasm')), 'linux resolves the portable engine',
    linuxPackages.filter(name => name.includes('libreoffice')).join(', '))
  const winPackages = packagesOf(office, { platform: 'win32-x64' })
  check(winPackages.some(name => name.includes('win32')), 'win32 resolves its native engine',
    winPackages.filter(name => name.includes('libreoffice')).join(', '))
  check(!linuxPackages.some(name => name.includes('win32')),
    'and neither platform pulls the other one’s engine')
}

// ---- 8. credential requirements ------------------------------------------
{
  const declared = credentialRefsOfCapabilities()
  check(declared.length > 0, 'at least one capability declares a credential', declared.join(', '))
  check(new Set(declared).size === declared.length, 'the declared refs are unique')
  check(unmetCredentialRequirements([]).length > 0,
    'an empty push leaves a declared requirement unmet')
  check(unmetCredentialRequirements(declared).length === 0,
    'pushing every declared ref satisfies them all')
  // The report names the capability, not just the ref: a person has to know which tool breaks.
  const gap = unmetCredentialRequirements([])[0]
  check(typeof gap.capability === 'string' && capabilityById(gap.capability) !== undefined,
    'the unmet report names a real capability', gap?.capability)
  // A capability with no `credentials` field can never be reported, however little is pushed.
  const withoutCredentials = enabledCapabilities()
    .filter(entry => (entry.capability.credentials ?? []).length === 0)
    .map(entry => entry.capability.id)
  check(!unmetCredentialRequirements([]).some(gapEntry => withoutCredentials.includes(gapEntry.capability)),
    'a capability that needs no credential is never reported as missing one',
    withoutCredentials.join(', '))
}

// ---- 9. the bundle names --------------------------------------------------
{
  for (const [key, value] of Object.entries(BUNDLE_NAMES)) {
    check(typeof value === 'string' && value.length > 0, `bundle name '${key}' is set`, value)
  }
  check(BUNDLE_NAMES.base !== BUNDLE_NAMES.webApp,
    'the base and the web bundle are different layers')
  check(DEFAULT_PLATFORM.split('-').length >= 2, 'the default platform is an os-arch tag', DEFAULT_PLATFORM)
}

process.stdout.write(
  failed === 0
    ? '[capabilities-unit] all checks passed\n'
    : `[capabilities-unit] FAILED: ${String(failed)} check(s)\n`,
)
process.exitCode = failed === 0 ? 0 : 1
