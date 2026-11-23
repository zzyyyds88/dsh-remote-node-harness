/**
 * The gate's own test: introduce real drift and prove the reconciliation goes red.
 *
 * A gate nobody has seen fail is a green rubber stamp. `capabilities` (the offline suite that
 * runs `check-capabilities --strict`) can only be trusted if a single-site change actually
 * breaks it — otherwise every future "it passes" means nothing. This file copies the minimum
 * tree the reconciliation reads into a temp directory, introduces one realistic drift at a
 * time, and asserts a non-zero exit with a message naming the drift.
 *
 * **The mutation happens on a copy, never on the working tree.** An earlier draft edited
 * `capabilities.mjs` in place and restored it in a `finally`; that leaves the repository mutated
 * if the process is killed between the two, and a test that can corrupt the source it is
 * guarding is not worth having.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')

let failed = 0
const log = message => process.stderr.write(`[gate-mutation-unit] ${message}\n`)
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

/**
 * The smallest tree `check-capabilities.mjs` can run in.
 *
 * It resolves `RNH` from its own location, then `PLUGIN` as a sibling package, and reads and
 * dynamically imports several files out of the plugin — the exact set has grown with every
 * batch, and a hand-written list of them is the same "declared in two places" mistake this whole
 * rewrite is about. So the plugin package is copied whole (minus `node_modules` and `dist`): a
 * few hundred kilobytes, and the copy stays correct when a later check reads one more file.
 */
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'rnh-gate-'))
  cpSync(join(REPO, 'packages', 'rnh-brain'), join(root, 'packages', 'rnh-brain'), {
    recursive: true,
    filter: source => !source.includes('node_modules'),
  })
  cpSync(
    join(REPO, 'packages', 'dsh-remote-node-harness'),
    join(root, 'packages', 'dsh-remote-node-harness'),
    {
      recursive: true,
      filter: source => !source.includes('node_modules') && !source.includes(`${sep}dist${sep}`),
    },
  )
  return root
}

function reconcile(root) {
  const run = spawnSync(
    process.execPath,
    [join(root, 'packages', 'rnh-brain', 'scripts', 'check-capabilities.mjs'), '--strict'],
    { cwd: root, encoding: 'utf8' },
  )
  return { code: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

/**
 * Each case is a literal replacement in a copied source file, paired with the words the gate
 * must answer with. The expected wording is part of the assertion: a gate that fails for the
 * wrong reason is as untrustworthy as one that passes.
 */
const CASES = [
  {
    name: 'a capability drops a row the composition still composes',
    file: ['packages', 'rnh-brain', 'capabilities.mjs'],
    from: "      'tool-jobs',\n      'tool-todo',\n      'tool-goal',",
    to: "      'tool-todo',\n      'tool-goal',",
    expect: 'composed but no capability claims: tool-jobs',
  },
  {
    name: 'a preset claims a row that does not exist',
    file: ['packages', 'rnh-brain', 'capabilities.mjs'],
    from: "      minimal: ['tool-fs'],",
    to: "      minimal: ['tool-fs', 'tool-nonexistent'],",
    expect: 'tool-nonexistent',
  },
  {
    name: 'a bundle name drifts from the one the plugin uses',
    file: ['packages', 'rnh-brain', 'capabilities.mjs'],
    from: "  brain: '@local/rnh-brain',",
    to: "  brain: '@local/rnh-brain-old',",
    expect: '@local/rnh-brain-old',
  },
  {
    name: 'a capability declares a credential the provisioning whitelist cannot derive',
    file: ['packages', 'rnh-brain', 'capabilities.mjs'],
    from: "    credentials: Object.freeze(['DEEPSEEK_API_KEY']),",
    to: "    credentials: Object.freeze(['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY']),",
    expect: 'ANTHROPIC_API_KEY',
  },
  {
    name: 'a drop rule names a capability that no longer exists',
    file: ['packages', 'rnh-brain', 'capabilities.mjs'],
    from: "    dropRules: ['^libreoffice-kit-(?:win32|darwin)-'],",
    to: "    dropRules: ['^libreoffice-kit-(?:win32|darwin)-', '^nobody-declares-this-'],",
    expect: 'nobody-declares-this',
  },
]

const root = makeTree()
try {
  const baseline = reconcile(root)
  check(baseline.code === 0, 'the copied tree reconciles clean before anything is changed',
    baseline.code === 0 ? undefined : baseline.output.split('\n').filter(line => line.includes('DIFF')).join(' | '))

  for (const testCase of CASES) {
    const path = join(root, ...testCase.file)
    const original = readFileSync(path, 'utf8')
    if (!original.includes(testCase.from)) {
      check(false, testCase.name, 'anchor not found — this case needs updating')
      continue
    }
    try {
      writeFileSync(path, original.replace(testCase.from, testCase.to), 'utf8')
      const run = reconcile(root)
      const named = run.output.includes(testCase.expect)
      check(run.code !== 0 && named, testCase.name,
        run.code === 0
          ? 'the gate passed a tree that is wrong'
          : named ? undefined : `failed without saying '${testCase.expect}'`)
    } finally {
      writeFileSync(path, original, 'utf8')
    }
  }

  const restored = reconcile(root)
  check(restored.code === 0, 'and the tree reconciles clean again once each case is restored')
} finally {
  rmSync(root, { recursive: true, force: true })
}

process.stdout.write(
  failed === 0
    ? `[gate-mutation-unit] all ${String(CASES.length)} drifts were caught by the offline gate\n`
    : `[gate-mutation-unit] FAILED: ${String(failed)} check(s)\n`,
)
process.exitCode = failed === 0 ? 0 : 1
