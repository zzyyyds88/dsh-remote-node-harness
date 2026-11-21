/**
 * Apply, verify and inspect this project's node-side source patches.
 *
 * A node runs a tree compiled from the upstream source. Trimming that tree by deleting files
 * is a packaging step (see `trim-fork-runtime.mjs`); changing what the source *does* is a
 * different act, and it needs a different mechanism, because the next upstream tag will
 * rewrite every line we touched.
 *
 * So every source-level change lives in `patches/node/NNNN-*.patch` as a plain unified diff,
 * applied to the fork's working tree before it is built:
 *
 * ```
 * git -C <fork> apply --3way patches/node/0001-....patch
 * ```
 *
 * Three properties come out of that, and each one is asserted by `test/node-patches-unit.mjs`:
 *
 * 1. **Replay is not silent.** `--3way` either applies or fails; it never half-applies. A
 *    failed apply stops the build and names the patch, so an upstream refactor cannot quietly
 *    drop a node optimisation.
 * 2. **Upstream's own fixes always arrive.** Patches stack on top of whatever tag is checked
 *    out. A bug upstream fixes is in the tree beneath our diff, without us re-importing it.
 * 3. **Every change is documented.** `docs/node-patches.zh.md` carries one row per patch: what
 *    it removes, why a node does not need it, and how it was verified. A patch with no row is
 *    a change nobody can review or retire.
 *
 * @module @greatbaby/dsh-remote-node-harness/scripts/node-patches
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** Where the patches live, relative to the package root. */
export const PATCH_DIR = 'patches/node'

/** The ledger that documents them. */
export const LEDGER = 'docs/node-patches.zh.md'

/** A patch file name: a four-digit ordinal, a slug, `.patch`. */
const PATCH_NAME = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.patch$/u

/**
 * Every patch, in application order.
 * @param {string} packageRoot - the plugin package root.
 * @returns {ReadonlyArray<{ name: string, ordinal: number, slug: string, path: string }>}
 */
export function listPatches(packageRoot) {
  const dir = join(packageRoot, PATCH_DIR)
  if (!existsSync(dir)) return []
  const patches = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.patch')) continue
    const match = PATCH_NAME.exec(name)
    if (match === null) {
      throw new Error(`${PATCH_DIR}/${name} is not NNNN-slug.patch; the ordinal is the apply order`)
    }
    patches.push({ name, ordinal: Number(match[1]), slug: match[2], path: join(dir, name) })
  }
  // Two patches with the same ordinal would apply in filesystem order, which is not an order.
  const seen = new Set()
  for (const patch of patches) {
    if (seen.has(patch.ordinal)) {
      throw new Error(`two patches share ordinal ${String(patch.ordinal)}; one of them must be renumbered`)
    }
    seen.add(patch.ordinal)
  }
  return patches
}

/**
 * Read the ledger's rows.
 *
 * The table is the contract, so it is parsed rather than trusted: one row per patch, six
 * fields, and a row that is missing a field fails the same way a missing row does.
 * @param {string} packageRoot - the plugin package root.
 * @returns {Map<string, Record<string, string>>} patch name → field → value.
 */
export function readLedger(packageRoot) {
  const file = join(packageRoot, LEDGER)
  if (!existsSync(file)) throw new Error(`${LEDGER} is missing; a patch with no ledger row is unreviewable`)
  const text = readFileSync(file, 'utf8')
  const rows = new Map()
  // Rows look like: | `0001-drop-x.patch` | what | removes | why | verified | if upstream |
  for (const line of text.split('\n')) {
    const cells = line.split('|').map(cell => cell.trim())
    if (cells.length < 8) continue
    const name = /^`(\d{4}-[a-z0-9-]+\.patch)`$/u.exec(cells[1] ?? '')
    if (name === null) continue
    rows.set(name[1], {
      change: cells[2] ?? '',
      removes: cells[3] ?? '',
      why: cells[4] ?? '',
      verified: cells[5] ?? '',
      upstream: cells[6] ?? '',
    })
  }
  return rows
}

/**
 * Check that the patches on disk and the ledger's rows are the same set, with no empty field.
 *
 * This is the rule that keeps the ledger from rotting: it is trivial to add a patch and forget
 * the row, and impossible to notice six months later.
 * @param {string} packageRoot - the plugin package root.
 * @returns {{ patches: number, problems: string[] }}
 */
export function checkPatches(packageRoot) {
  const patches = listPatches(packageRoot)
  const rows = readLedger(packageRoot)
  const problems = []
  for (const patch of patches) {
    const row = rows.get(patch.name)
    if (row === undefined) {
      problems.push(`${patch.name} has no row in ${LEDGER}`)
      continue
    }
    for (const [field, value] of Object.entries(row)) {
      if (value === '' || value === '-' || value === '—') {
        problems.push(`${patch.name}: the "${field}" field is empty`)
      }
    }
  }
  for (const name of rows.keys()) {
    if (!patches.some(patch => patch.name === name)) {
      problems.push(`${LEDGER} documents ${name}, which does not exist in ${PATCH_DIR}`)
    }
  }
  return { patches: patches.length, problems }
}

/**
 * Apply every patch to a checkout, skipping the ones already applied.
 *
 * `--3way` is deliberate: it uses the blob hashes in the diff to relocate a hunk that upstream
 * moved, and it refuses rather than guessing when the context genuinely changed. `--reject`
 * is not used anywhere — it would leave `.rej` files in a tree that then gets built and
 * shipped, which is the exact silent-drift failure this mechanism exists to prevent.
 *
 * "Already applied" has to be detected rather than assumed, because the fork is a long-lived
 * working tree: patch the source, build, iterate on the trim rules, build again. On the second
 * run the forward apply fails simply because the change is present, and that must not be
 * reported as drift. The test is a reverse `--check`: if the patch can be *un*-applied cleanly,
 * it is in.
 *
 * **Both probes are plain, without `--3way`, and that is not an accident.** `git apply --3way
 * --check` exits 0 for all three situations — the hunk applies as-is, the hunk relocates, and the
 * hunk conflicts — and only *prints* which one it was. A state machine built on its exit code
 * therefore calls a genuine conflict "fine". Measured 2026-11-21 against git 2.51, one patch,
 * three trees:
 *
 * ```
 * plain  --check            applied → 1   not applied → 0   conflict → 1
 * plain  --check --reverse  applied → 0   not applied → 1   conflict → 1
 * --3way --check            applied → 0   not applied → 0   conflict → 0
 * ```
 *
 * So the plain probes decide *which* state this is, and `--3way` is used only for the apply
 * itself, where relocating a hunk that upstream merely shifted is exactly what is wanted. A patch
 * that survives neither plain probe is either a relocation or a conflict; `--3way --check` says
 * which in its own output, and the conflict case throws before anything is written.
 * @param {string} packageRoot - the plugin package root.
 * @param {string} checkout - the fork's working tree.
 * @returns {ReadonlyArray<{ name: string, state: 'applied' | 'already' | 'would-apply' }>}
 */
export function applyPatches(packageRoot, checkout, options = {}) {
  const results = []
  const run = args => spawnSync('git', ['-C', checkout, 'apply', ...args], { encoding: 'utf8' })
  for (const patch of listPatches(packageRoot)) {
    const forward = run(['--check', patch.path])
    if (forward.status === 0) {
      if (options.dryRun === true) {
        results.push({ name: patch.name, state: 'would-apply' })
        continue
      }
      const applied = run(['--3way', patch.path])
      if (applied.status !== 0) throw driftError(patch, checkout, applied)
      results.push({ name: patch.name, state: 'applied' })
      continue
    }
    // The plain apply failed. Either the change is already in the tree, or upstream moved the
    // code underneath it — and those two must not be confused.
    const reverse = run(['--check', '--reverse', patch.path])
    if (reverse.status === 0) {
      results.push({ name: patch.name, state: 'already' })
      continue
    }
    // Neither direction applies as-is. `--3way` can still place the hunk if upstream only shifted
    // the surrounding code; it cannot if upstream rewrote the lines themselves.
    const merge = run(['--3way', '--check', patch.path])
    const conflicted = /with conflicts/u.test(`${merge.stdout ?? ''}${merge.stderr ?? ''}`)
    if (merge.status !== 0 || conflicted) throw driftError(patch, checkout, merge)
    if (options.dryRun === true) {
      results.push({ name: patch.name, state: 'would-apply' })
      continue
    }
    const applied = run(['--3way', patch.path])
    if (applied.status !== 0) throw driftError(patch, checkout, applied)
    results.push({ name: patch.name, state: 'applied' })
  }
  return results
}

/** The failure both the patch tool and a human need to see verbatim. */
function driftError(patch, checkout, result) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return new Error(
    `patch ${patch.name} did not apply to ${checkout}:\n${output}\n`
    + 'This is the drift alarm: an upstream change touched the same code. Resolve it by\n'
    + 'regenerating the patch against the new tag — do not drop it and do not use --reject.',
  )
}

/**
 * Commits in the fork that are ours but do **not** reach a node.
 *
 * The ledger above covers source that a node reads. A change to the release toolchain is not
 * source a node reads — `scripts/` is not in `@deepseek-ai/dsh`'s `files`, so the archive does
 * not contain it — and it cannot be expressed as a `patches/node/*.patch` either. Leaving it
 * unrecorded is how "the fork differs from the tag in exactly N places" stops being a checkable
 * statement, so those commits are listed here and `checkForkBase` accepts a fork HEAD only when
 * every commit above the tag is in this list.
 *
 * Each entry: the abbreviated hash, what it changed, and why it cannot be a patch.
 */
export const BUILD_SIDE_COMMITS = Object.freeze([
  Object.freeze({
    commit: '057ce8f3',
    what: 'scripts/release/verify-packed-install.ts drives npm through its JS entry on Windows',
    why: 'a npm.cmd batch shim cannot be spawned without a shell, so the packed-install check '
      + 'died with ENOENT/EINVAL before it installed anything; nothing here reaches the archive',
  }),
])

/**
 * Refuse to build from a fork whose state nobody recorded.
 *
 * Two things can make a build unreproducible: a commit above the pinned tag that is not in
 * {@link BUILD_SIDE_COMMITS}, and a working tree that differs from the tree the node patches
 * were cut from. The first is "改了不记"; the second is "someone edited the fork by hand".
 *
 * The working tree is allowed to be dirty **only** on paths a shipped patch touches — that is
 * exactly the state `applyPatches` leaves behind after a build, and a rebuild must not be
 * forced to revert first. Anything else fails with its own path named.
 * @param {string} packageRoot - the plugin package root.
 * @param {string} checkout - the fork's working tree.
 * @param {string} version - the DSH version the archive will claim.
 * @param {{ known?: ReadonlyArray<{ commit: string }> }} [options] - override the allow-list;
 *   only tests use it, because a scratch repository cannot reproduce the real commit hashes.
 * @returns {{ tag: string, base: string, head: string, extra: ReadonlyArray<string> }}
 */
export function checkForkBase(packageRoot, checkout, version, options = {}) {
  const git = args => spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8' })
  const tag = `dsh-v${version}`
  const allowed = options.known ?? BUILD_SIDE_COMMITS

  const base = git(['rev-parse', '--verify', `${tag}^{commit}`])
  if (base.status !== 0) {
    throw new Error(
      `the fork at ${checkout} has no tag ${tag}: check that tag out before building, because the `
      + 'node must run the release this project pinned to',
    )
  }
  const baseSha = String(base.stdout ?? '').trim()
  const headSha = String(git(['rev-parse', 'HEAD']).stdout ?? '').trim()
  if (headSha === '') throw new Error(`${checkout} is not a git checkout; cannot verify what is being built`)

  const known = new Set(allowed.map(entry => entry.commit))
  const extra = []
  if (headSha !== baseSha) {
    const listing = git(['rev-list', `${baseSha}..${headSha}`])
    if (listing.status !== 0) throw new Error(`cannot list the commits above ${tag}: ${String(listing.stderr ?? '')}`)
    for (const sha of String(listing.stdout ?? '').trim().split('\n').filter(Boolean)) {
      if (![...known].some(short => sha.startsWith(short))) {
        throw new Error(
          `the fork has commit ${sha.slice(0, 8)} above ${tag}, and it is not in BUILD_SIDE_COMMITS.\n`
          + 'Record it in docs/node-patches.zh.md (and in that list) if a node must run it as a\n'
          + 'patch, or add it to the list with why it cannot be one. An unrecorded commit is the one\n'
          + `thing this check exists to stop: nothing downstream can tell it apart from a stray edit.\n`
          + `  git -C ${checkout} show --stat ${sha}`,
        )
      }
      extra.push(sha.slice(0, 8))
    }
  }

  // A dirty tree is fine only where a patch made it dirty. `+++ b/<path>` is the diff's own
  // spelling of the file, which is why it is read from the patch rather than from `git status`.
  const patchPaths = new Set()
  for (const patch of listPatches(packageRoot)) {
    const text = readFileSync(patch.path, 'utf8')
    for (const line of text.split('\n')) {
      const match = /^\+\+\+ b\/(.+)$/u.exec(line)
      if (match !== null) patchPaths.add(match[1])
    }
  }
  const dirty = git(['status', '--porcelain'])
  if (dirty.status !== 0) throw new Error(`cannot read the fork's working tree: ${String(dirty.stderr ?? '')}`)
  for (const line of String(dirty.stdout ?? '').split('\n')) {
    if (line.trim() === '') continue
    const path = line.slice(3).trim().replace(/^"(.*)"$/u, '$1')
    if (patchPaths.has(path)) continue
    throw new Error(
      `${checkout} has unrecorded local change: "${path}".\n`
      + 'Only files a shipped patch touches may differ, because that is the state a previous\n'
      + 'build leaves behind. Either record the change as a patch or discard it — a stray edit in\n'
      + 'the fork is the second way an archive stops matching its ledger.',
    )
  }
  return { tag, base: baseSha.slice(0, 8), head: headSha.slice(0, 8), extra }
}
