/**
 * Make the installed `ds-harness-remote` let a routed Session read its own files.
 *
 * ## Why this exists
 *
 * The relay authorises every file read against **this** machine's filesystem before it
 * dispatches: `resolveWorkspaceRootForSession` takes the Session's `cwd` from
 * `session/list` and `realpath()`s it here, and `assertNativeWorkspaceFileCall` then
 * `lstat()`s the target path here. A remote Session's `cwd` is a path on the **node**
 * (`/root/proj`), so both steps throw `ENOENT` and the phone gets
 * `WORKSPACE_UNAVAILABLE` for `workspaceFiles/{read,readBytes,readAll,stat,search}`.
 *
 * There is no way to solve that from the outside:
 *
 *   - `HarnessRemoteBridge` is not in the relay's export list, so its prototype is
 *     unreachable;
 *   - the `dshRemote` service exposes the runtime, not the bridge;
 *   - `resolveWorkspaceRoot` is a constructor argument and
 *     `assertNativeWorkspaceFileCall` is a private method — neither can be replaced.
 *
 * And it cannot be solved by making this machine *look* right either: an empty shadow
 * directory satisfies `realpath(cwd)`, but `lstat(<here>/root/proj/a.txt)` still throws
 * unless a real copy of the project sits here — which is the mirror this project
 * refuses to build (see GOAL §七-5).
 *
 * So the fix is applied to the **installed artefact**: one predicate and two guards that
 * skip the local authorisation for a Session whose id is `rnh_<nodeId>_<remoteId>`. The
 * path boundary then rests where it already rests for every other routed endpoint — on
 * the node, which recomputes the scope from its own Session header. That is the same
 * trust model as `session/page` and `terminal/*`: this Host already proved it can reach
 * that node over SSH.
 *
 * ## The three rules this file keeps
 *
 * 1. **An anchor must match exactly once.** Zero or several hits means the bundle is not
 *    the one this patch was written for, and the answer is to change nothing and say
 *    why. A half-applied patch would be worse than none: some endpoints would read files
 *    and others would not, and the symptom would move between calls.
 * 2. **The file is replaced, never edited in place.** pnpm hard-links one `index.js`
 *    into every profile that depends on `ds-harness-remote` (measured: `nlink: 2`,
 *    identical inode). Writing into it would corrupt the other profile's copy; writing a
 *    new file and renaming over the name only changes which inode this profile sees.
 * 3. **It has to be reversible.** The pristine bytes are kept in `index.js.rnh-orig`
 *    (written once per apply, from a source that carries no marker) and a sidecar records
 *    both hashes, so {@link revertRelayPatch} is a file copy.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/relay-patch
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Bumped when the edits below change shape, so an old sidecar is not trusted. */
export const RELAY_PATCH_VERSION = 1

/** The relay package this patch knows how to edit. */
export const RELAY_PACKAGE = 'ds-harness-remote'

/** Present in a patched bundle; its presence is part of what "already applied" means. */
export const RELAY_MARKER = '/* rnh-relay-patch */'

/**
 * The one thing the patch teaches the relay: a routed Session id.
 *
 * Deliberately small. It does not parse the id apart or verify the node exists — the
 * decorator on this side does that, and a wrong id fails there with a better message
 * than "the workspace is unavailable".
 *
 * Written as a function declaration so it hoists: it can be inserted anywhere in the
 * module and both call sites below still see it.
 */
const SCOPE_HELPER = `${RELAY_MARKER}
function __rnhRemoteScope(id) {
  return typeof id === "string" && /^rnh_[a-z0-9]+_/.test(id);
}
`

/**
 * Every edit, applied in this order.
 *
 * `find` is written against identifiers that also exist in the relay's TypeScript source
 * (`WORKSPACE_FILE_READ_ENDPOINTS`, `resolveWorkspaceRootForSession`,
 * `workspaceFiles/search`), never against a minified local name or a byte offset, and is
 * matched with whitespace collapsed — the bundle is reformatted by its own build, and a
 * line break moving must not read as a semantic change.
 *
 * @typedef {{ id: string, find: string, replace: string }} Edit
 * @type {ReadonlyArray<Edit>}
 */
export const RELAY_EDITS = Object.freeze([
  {
    id: 'scope-helper',
    find: 'function requestArgs(payload) {',
    replace: `${SCOPE_HELPER}function requestArgs(payload) {`,
  },
  {
    id: 'search-branch',
    // `workspaceFiles/search` is handled before the read endpoints are considered, so it
    // needs its own guard: the two branches do not share a code path.
    find: 'if (!await this.resolveWorkspaceRootForSession(search.args.workspaceFileScopeId, signal)) {',
    replace: 'if (!__rnhRemoteScope(search.args.workspaceFileScopeId)'
      + ' && !await this.resolveWorkspaceRootForSession(search.args.workspaceFileScopeId, signal)) {',
  },
  {
    id: 'read-branch',
    // `read`, `readBytes`, `readAll`, `stat`. The scope id is unwrapped with the relay's own
    // helper, which understands `{ args }` and `{ args: { request } }` alike.
    find: '} else if (this.resolveWorkspaceRoot !== void 0 && WORKSPACE_FILE_READ_ENDPOINTS.has(params.endpoint)) {',
    replace: '} else if (this.resolveWorkspaceRoot !== void 0 && WORKSPACE_FILE_READ_ENDPOINTS.has(params.endpoint)'
      + ' && !__rnhRemoteScope(requestArgs(nativePayload).workspaceFileScopeId)) {',
  },
])

/**
 * Collapse every whitespace run to one space and trim, keeping a map back to the source.
 *
 * The map is what makes a line-break-tolerant match safe: the replacement is spliced into
 * the **original** text at the mapped offsets, so the rest of the bundle keeps its exact
 * bytes.
 *
 * @param {string} source
 * @returns {{ text: string, at: number[] }} `at[i]` is the source offset of `text[i]`;
 *   `at[text.length]` is one past the last matched character.
 */
function squeezeWithMap(source) {
  let text = ''
  const at = []
  let index = 0
  while (index < source.length && /\s/u.test(source[index])) index += 1
  while (index < source.length) {
    const char = source[index]
    if (!/\s/u.test(char)) {
      at.push(index)
      text += char
      index += 1
      continue
    }
    let next = index
    while (next < source.length && /\s/u.test(source[next])) next += 1
    if (next >= source.length) break
    at.push(index)
    text += ' '
    index = next
  }
  at.push(source.length)
  return { text, at }
}

/** Collapse whitespace in a needle the same way {@link squeezeWithMap} does. */
const squeeze = text => text.replace(/\s+/gu, ' ').trim()

/**
 * Decide what would happen to one bundle, without touching it.
 *
 * Each edit is matched against the **current** text, so an insertion above a later anchor
 * cannot shift it: the whitespace map is rebuilt after every splice.
 *
 * @param {string} source
 * @returns {{ patched: string, applied: string[], missing: Array<{ id: string, hits: number }> }}
 */
export function planPatch(source) {
  let patched = source
  const applied = []
  const missing = []
  for (const edit of RELAY_EDITS) {
    const needle = squeeze(edit.find)
    const { text, at } = squeezeWithMap(patched)
    let hits = 0
    let first = -1
    for (let found = text.indexOf(needle); found >= 0; found = text.indexOf(needle, found + needle.length)) {
      if (first < 0) first = found
      hits += 1
    }
    if (hits !== 1) {
      missing.push({ id: edit.id, hits })
      continue
    }
    // Offsets come from the map, so a match that spans a line break is spliced at the right
    // place and every byte outside it — including the whitespace after it — is preserved.
    const start = at[first]
    const end = at[first + needle.length - 1] + 1
    patched = `${patched.slice(0, start)}${squeeze(edit.replace)}${patched.slice(end)}`
    applied.push(edit.id)
  }
  return { patched, applied, missing }
}

/** `sha256` of a string, for the sidecar. */
const digest = text => createHash('sha256').update(text).digest('hex')

/** Paths this module owns beside one bundle. */
const origOf = file => `${file}.rnh-orig`
const sidecarOf = file => `${file}.rnh-patch.json`
/**
 * The candidate copy, spelled `.mjs` on purpose.
 *
 * `node --check` refuses a file whose extension it does not recognise, and the bundle is
 * called `index.js` only because that is what its own manifest says. A `.mjs` name is
 * always parsed as a module whatever the surrounding `package.json` declares, so the check
 * answers the question asked — "does this text parse" — instead of failing on the name.
 */
const tmpOf = (file, sha) => `${file}.rnh-${sha.slice(0, 8)}.tmp.mjs`

/** Read the sidecar, or `undefined` when it is absent or unreadable. */
function readSidecar(file) {
  try {
    const value = JSON.parse(readFileSync(sidecarOf(file), 'utf8'))
    return typeof value === 'object' && value !== null ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Locate the relay's entry file for one profile.
 *
 * @param {{ profileDir?: string }} [options]
 * @returns {{ file: string, profileDir: string } | { reason: string }}
 */
export function resolveRelayInstall(options = {}) {
  const profileDir = options.profileDir ?? process.env.DSH_PROFILE_DIR
  if (typeof profileDir !== 'string' || profileDir.trim().length === 0) {
    // Deliberately not guessed from `$DSH_HOME/profiles/*`: several profiles can hold the
    // relay, and patching the wrong one would report success for a Host that never loads it.
    return { reason: 'this Host does not expose its profile directory, so the relay cannot be located' }
  }
  const file = join(profileDir, 'node_modules', RELAY_PACKAGE, 'dist', 'index.js')
  if (!existsSync(file)) {
    return { reason: `${RELAY_PACKAGE} is not installed in this profile` }
  }
  return { file, profileDir }
}

/** The version the installed relay declares, or `undefined` when it cannot be read. */
export function relayVersion(file) {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(file), '..', 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Check a candidate bundle parses before it is allowed to replace the real one.
 *
 * `process.execPath` is the Electron binary when the desktop runs the Host, so the child
 * is started with `ELECTRON_RUN_AS_NODE` set: without it the binary would open a window
 * instead of checking a file.
 *
 * @param {string} file
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkParses(file) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 60_000,
  })
  if (result.status === 0) return { ok: true }
  const detail = `${result.stderr ?? ''}`.trim().split('\n').slice(0, 4).join(' ')
  return { ok: false, reason: `node --check failed: ${detail || `exit ${String(result.status)}`}` }
}

/**
 * Apply the patch to the relay this profile loads.
 *
 * Called once per Host start, so every branch below is written to be safe to repeat: a
 * bundle that already carries the marker and matches its sidecar is left completely
 * alone, which is the steady state after the first start.
 *
 * @param {{ profileDir?: string, log?: (message: string) => void }} [options]
 * @returns {{ installed: string | null, patched: boolean, anchors?: number, reason?: string }}
 */
export function applyRelayPatch(options = {}) {
  const log = options.log ?? (() => {})
  const located = resolveRelayInstall(options)
  if ('reason' in located) {
    log(`relay patch: ${located.reason}`)
    return { installed: null, patched: false, reason: located.reason }
  }
  const { file } = located
  const installed = relayVersion(file) ?? null
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch (error) {
    const reason = `the relay bundle could not be read: ${String(error?.message ?? error)}`
    log(`relay patch: ${reason}`)
    return { installed, patched: false, reason }
  }
  const sha = digest(source)
  const sidecar = readSidecar(file)

  if (source.includes(RELAY_MARKER)) {
    if (sidecar?.patchedSha256 === sha) {
      return { installed, patched: true, anchors: sidecar.anchors ?? RELAY_EDITS.length }
    }
    // The bundle carries the marker but the record disagrees (sidecar deleted, or the file
    // was edited by hand after patching). The bytes are the patched ones, so only the
    // record is refreshed — re-splicing would insert the helper a second time.
    writeFileSync(sidecarOf(file), `${JSON.stringify({
      version: RELAY_PATCH_VERSION,
      installed,
      originalSha256: sidecar?.originalSha256,
      patchedSha256: sha,
      anchors: RELAY_EDITS.length,
    }, null, 2)}\n`)
    return { installed, patched: true, anchors: RELAY_EDITS.length }
  }

  const plan = planPatch(source)
  if (plan.missing.length > 0) {
    const detail = plan.missing.map(entry => `${entry.id} matched ${String(entry.hits)} times`).join(', ')
    const reason = `${RELAY_PACKAGE} ${String(installed ?? '(unknown version)')} is not the bundle this patch`
      + ` was written for: ${detail}. Nothing was changed.`
    log(`relay patch: ${reason}`)
    return { installed, patched: false, reason }
  }

  // Keep the pristine bytes. This runs only on a source with no marker, so the backup
  // always matches a relay build that has not been patched — which is exactly what a
  // relay upgrade leaves behind.
  copyFileSync(file, origOf(file))

  const target = tmpOf(file, sha)
  writeFileSync(target, plan.patched)
  const parsed = checkParses(target)
  if (!parsed.ok) {
    rmSync(target, { force: true })
    const reason = `the patched bundle did not parse (${parsed.reason}). Nothing was changed.`
    log(`relay patch: ${reason}`)
    return { installed, patched: false, reason }
  }
  // Rename, not write: pnpm hard-links one `index.js` into every profile that installs the
  // relay, and only this profile's name should start pointing at the patched inode.
  renameSync(target, file)
  writeFileSync(sidecarOf(file), `${JSON.stringify({
    version: RELAY_PATCH_VERSION,
    installed,
    originalSha256: sha,
    patchedSha256: digest(plan.patched),
    anchors: plan.applied.length,
  }, null, 2)}\n`)
  log(
    `relay patch: ${RELAY_PACKAGE} ${String(installed ?? '')} patched`
    + ` (${String(plan.applied.length)} site(s): ${plan.applied.join(', ')})`,
  )
  return { installed, patched: true, anchors: plan.applied.length }
}

/**
 * Put the pristine bundle back.
 *
 * Equals copying `index.js.rnh-orig` over `index.js` and removing the sidecar. Kept as a
 * function so a refusal is one sentence rather than a missing-file stack trace.
 *
 * @param {{ profileDir?: string, log?: (message: string) => void }} [options]
 * @returns {{ reverted: boolean, reason?: string }}
 */
export function revertRelayPatch(options = {}) {
  const log = options.log ?? (() => {})
  const located = resolveRelayInstall(options)
  if ('reason' in located) return { reverted: false, reason: located.reason }
  const { file } = located
  const orig = origOf(file)
  if (!existsSync(orig)) return { reverted: false, reason: 'there is no pristine copy to restore' }
  copyFileSync(orig, file)
  rmSync(sidecarOf(file), { force: true })
  log(`relay patch: ${RELAY_PACKAGE} restored from ${orig}`)
  return { reverted: true }
}
