/**
 * The `rnh://`-less path namespace that lets a node's filesystem live inside the
 * one path syntax a Remote caller already speaks.
 *
 * A phone using `ds-harness-remote` asks `directoryPicker/list` for an *absolute
 * path on the Host*. There is no field for "which machine", so the machine has to
 * be spelled in the path itself. Three shapes were considered and only one works:
 *
 *   `rnh://<nodeId>/root`  — rejected: win32 `isAbsolute('rnh://x')` is false,
 *     so the relay's own `ensureHostWorkspaceDirectory` refuses it *before* the
 *     call is dispatched and this Host never sees the request.
 *   bare `/root`             — rejected: it names the *desktop's* `/root` first, so
 *     a creation would land on this machine before any router could decide.
 *   `/@rnh/<nodeId>/root`  — chosen: absolute everywhere, decodable from the
 *     string alone, and it confines the relay's unavoidable `mkdir -p` to
 *     `<drive>:\@rnh\…`, one tree this plugin owns and can therefore clean up
 *     exactly.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/picker-paths
 */
import { rmdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { normalizePosix } from './posix-path.js'

/** The namespace marker. Reserved: nothing but a node may be addressed here. */
export const PICKER_PREFIX = '/@rnh'

/** The identity shape every node has: `n` plus twelve hex characters. */
const NODE_ID = /^n[0-9a-f]{12}$/u

/**
 * The one place a relay-side `mkdir` may land, as an absolute local path.
 *
 * On Windows `/@rnh/x` is drive-relative: `resolve()` turns it into
 * `<current drive>:\@rnh\x`. Comparing against this root is what makes
 * "is this path inside the namespace" a pure string test.
 * @returns {string}
 */
export function shadowRoot() {
  return resolve(PICKER_PREFIX)
}

/**
 * Normalise a path a Remote caller sent into the form this module parses.
 *
 * The wire round-trips through two normalisers (the relay's and the gateway's),
 * and a Windows client may echo separators back. Rewriting is safe because the
 * namespace itself is spelled with forward slashes only.
 *
 * @param {unknown} path
 * @returns {string | undefined} a forward-slash, absolute-looking path.
 */
export function normalizePickerPath(path) {
  if (typeof path !== 'string') return undefined
  let text = path.trim().replaceAll('\\', '/')
  if (text.length === 0) return undefined
  // A Windows client's own absolute form, e.g. `D:/@rnh/n1/root`.
  const drive = /^[A-Za-z]:(?=\/)/u.exec(text)
  if (drive !== null) text = text.slice(drive[0].length)
  if (!text.startsWith('/')) return undefined
  // Collapse runs of separators but keep a single leading one.
  text = text.replace(/\/{2,}/gu, '/')
  if (text.length > 1) text = text.replace(/\/+$/u, '')
  return text
}

/**
 * Whether a path addresses this plugin's namespace at all.
 * @param {unknown} path
 * @returns {boolean}
 */
export function isPickerPath(path) {
  return decodePickerPath(path) !== undefined
}

/**
 * Spell one node's absolute path for a Remote caller.
 *
 * @param {string} nodeId - `n` plus twelve hex characters.
 * @param {string} [remotePath] - absolute POSIX path on the node; a lone `/` (or
 *   nothing) is the node's filesystem root.
 * @returns {string}
 */
export function encodePickerPath(nodeId, remotePath) {
  if (!NODE_ID.test(nodeId)) throw new Error(`rnh: ${nodeId} is not a node identity`)
  const tail = typeof remotePath === 'string' ? remotePath.replace(/\/+$/u, '') : ''
  const trimmed = tail.startsWith('/') ? tail.slice(1) : tail
  return trimmed.length === 0 ? `${PICKER_PREFIX}/${nodeId}` : `${PICKER_PREFIX}/${nodeId}/${trimmed}`
}

/**
 * Split one path back into what it addresses.
 *
 * The remote half is **folded** (`.` dropped, `..` resolved) before it is returned, because the
 * caller hands it straight to `mkdir -p` on a node: a path that means `/home/x/../../etc` has to
 * arrive as `/etc`, or be refused. It is refused when `..` would rise above `/` — clamping
 * `/../../etc` to `/etc` would be a different path than the one asked for.
 *
 * @param {unknown} path
 * @returns {{ kind: 'nodes' } | { kind: 'node', nodeId: string, remotePath: string } | undefined}
 *   `{kind:'nodes'}` for the namespace itself, a node target otherwise, and
 *   `undefined` when the path is not in the namespace at all — **or** when it names a node but
 *   its tail escapes the root, which is a path no node can be asked about.
 */
export function decodePickerPath(path) {
  const text = normalizePickerPath(path)
  if (text === undefined) return undefined
  const lower = text.toLowerCase()
  const prefix = PICKER_PREFIX.toLowerCase()
  if (lower === prefix) return { kind: 'nodes' }
  if (!lower.startsWith(`${prefix}/`)) return undefined
  const rest = text.slice(PICKER_PREFIX.length + 1)
  const slash = rest.indexOf('/')
  const nodeId = slash === -1 ? rest : rest.slice(0, slash)
  if (!NODE_ID.test(nodeId)) return undefined
  const tail = slash === -1 ? '' : rest.slice(slash + 1)
  const folded = normalizePosix(tail.length === 0 ? '/' : `/${tail}`)
  // An escaping tail is not a path this namespace can spell: answering `undefined` keeps the
  // caller on "not a node path" instead of handing it a silently-clamped directory.
  if (!folded.ok) return undefined
  return { kind: 'node', nodeId, remotePath: folded.path }
}

/**
 * Where a relay-side `mkdir -p` of this path would land on *this* machine.
 *
 * The relay creates the workspace directory before it dispatches, and it does so
 * with the raw request string. `resolve` here therefore names the same directory
 * from the same process — no clock, no `mtime`, no "is it empty" guesswork. The two
 * calls agree because `ensureHostWorkspaceDirectory` and this function run in the
 * same Node process, against the same working directory: a drive-relative
 * `/@rnh/x` resolves to `<that drive>:\@rnh\x` for both.
 *
 * @param {unknown} path
 * @returns {string | undefined} `undefined` when the path is outside the namespace.
 */
export function localShadowOf(path) {
  if (!isPickerPath(path)) return undefined
  const normalized = normalizePickerPath(path)
  return normalized === undefined ? undefined : resolve(normalized)
}

/**
 * Remove the empty directory chain a relay-side `mkdir -p` created.
 *
 * @param {unknown} path - a path inside the namespace, as the request carried it.
 * @param {(message: string) => void} [log]
 * @returns {{ removed: string[], stoppedAt?: string, stoppedBecause?: string }}
 */
export function pruneShadow(path, log = () => {}) {
  const start = localShadowOf(path)
  if (start === undefined) return { removed: [] }
  return pruneShadowTree(start, shadowRoot(), log)
}

/**
 * Walk one directory chain upwards, removing each level while it is empty.
 *
 * `rmdir` without `recursive` fails on a non-empty directory, so the first level
 * that has anything in it stops the walk: the only directories this can ever remove
 * are the empty ones the just-completed `mkdir -p` made. Separated from
 * {@link pruneShadow} so the walk can be exercised against a temporary tree —
 * production always passes the reserved root, and a start path outside it is
 * refused before anything is removed.
 *
 * @param {string} start - deepest directory to consider.
 * @param {string} root - the highest directory this may remove.
 * @param {(message: string) => void} log
 * @returns {{ removed: string[], stoppedAt?: string, stoppedBecause?: string }}
 */
export function pruneShadowTree(start, root, log = () => {}) {
  const removed = []
  // A path outside the reserved tree is never this plugin's to delete.
  if (start !== root && !start.startsWith(`${root}\\`) && !start.startsWith(`${root}/`)) {
    return { removed }
  }
  let current = start
  for (;;) {
    let info
    try {
      info = statSync(current)
    } catch {
      // Already gone: keep walking, the parent may still be ours to remove.
      if (current === root) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
      continue
    }
    if (!info.isDirectory()) {
      return { removed, stoppedAt: current, stoppedBecause: 'not-a-directory' }
    }
    try {
      rmdirSync(current)
      removed.push(current)
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
        log(`rnh: could not remove the shadow directory ${current}: ${String(code ?? error)}`)
      }
      return { removed, stoppedAt: current, stoppedBecause: String(code ?? 'failed') }
    }
    if (current === root) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return { removed }
}
