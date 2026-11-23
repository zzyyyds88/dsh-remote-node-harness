/**
 * Browsing a directory tree — locally, and on a node.
 *
 * The workspace picker needs to answer one question: "which folders can I make a
 * workspace from?" On this machine that is the Host's own filesystem; on a node it is
 * the node's, reached over the SSH connection this plugin already holds.
 *
 * Two implementations, not one with a branch: a local `readdir` and a remote `find` have
 * nothing in common but their answer, and pretending otherwise is how a path separator
 * or a permission error ends up handled wrongly on one of the two sides.
 *
 * The remote half speaks a **record protocol**, not prose. Its predecessor glued stdout and
 * stderr together and read the result with unanchored regexes, which meant a directory named
 * `RNH_BROWSE_HOME=x` could forge the answer, a name containing a newline became two phantom
 * entries, and `find` failing behind a pipe reported `head`'s exit status — a directory that
 * existed but was empty. Every one of those is a parsing bug, so the fix is to stop parsing:
 * each fact is a `type\0value\0` pair, and names travel NUL-delimited (base64-wrapped so a
 * non-UTF-8 name is reported instead of being silently replaced with U+FFFD).
 *
 * @module @greatbaby/dsh-remote-node-harness/host/browse
 */
import { mkdir, readdir, stat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  checkedSegment,
  normalizePosix,
  posixCrumbs,
  posixJoin,
  posixParent,
} from './posix-path.js'

// Re-exported because the picker decorators have always imported them from here; a second
// definition of "is this a node path" is exactly the split this module removed.
export { isPosixAbsolute, posixCrumbs } from './posix-path.js'

/** How many folders one listing returns; a directory with more is still usable. */
const MAX_ENTRIES = 500

/**
 * The byte ceiling for the name block one listing may return.
 *
 * Enforced in the shell (before base64) rather than by the SSH capture cap: the capture cap
 * would cut a base64 quantum in half and produce a corrupt tail, while a byte ceiling on the
 * raw `find` output can be cut only at a record boundary and then checked for exactly that.
 */
const MAX_NAME_BYTES = 512 * 1024

/**
 * The drive letters this machine has, as roots a picker can jump to.
 *
 * A workspace on `D:\` was unreachable from the picker: every listing starts at the
 * user's home and "up" stops at that drive's root, so `C:\` was the only tree there
 * was. Asking the filesystem which letters answer is the only honest source.
 *
 * @returns {Promise<string[]>}
 */
async function localRoots() {
  if (process.platform !== 'win32') return ['/']
  const roots = []
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')) {
    const root = `${letter}:\\`
    try {
      await stat(root)
      roots.push(root)
    } catch {
      // A letter with no mounted volume: not offered.
    }
  }
  // `A:`/`B:` are floppy-era letters that can legitimately be mounted; they are rare
  // enough that probing them would only add a slow stat on every listing.
  return roots
}

/**
 * Create one child directory and return its absolute path.
 *
 * The name is a single path segment on purpose: the picker asks for a folder name, not
 * a path, so a caller cannot walk out of the directory it is looking at. The check runs
 * here rather than only in the browser, because this function is reachable over HTTP.
 *
 * @param {string} parent - existing absolute directory.
 * @param {string} name
 * @returns {Promise<string>}
 */
export async function makeLocalDirectory(parent, name) {
  const segment = checkedSegment(name)
  const target = join(normalizeLocal(parent), segment)
  await mkdir(target)
  return target
}

/**
 * The ancestor chain of one directory, root first and the directory itself last.
 *
 * The picker's breadcrumbs are a list of jump targets the Host computes — a client
 * never joins segments itself, and a Windows client cannot even spell a `D:\` root the
 * way this machine does.
 *
 * @param {string} path - an absolute, already-resolved local directory.
 * @returns {Array<{ name: string, path: string, hidden: false }>}
 */
export function localCrumbs(path) {
  const drive = /^[A-Za-z]:[\\/]/u.exec(path)
  if (drive !== null) {
    // `D:\` is the crumb's own path *and* its label: that is what a Windows folder
    // chooser shows at the top of a drive's tree.
    const root = drive[0]
    const crumbs = [{ name: root, path: root, hidden: false }]
    let current = root
    for (const segment of path.slice(root.length).split(/[\\/]+/u)) {
      if (segment.length === 0) continue
      current = join(current, segment)
      crumbs.push({ name: segment, path: current, hidden: false })
    }
    return crumbs
  }
  return posixCrumbs(path)
}

/**
 * Normalise a path the user typed or a parent link produced.
 *
 * An empty path means "start where the user lives", which is the only useful default:
 * both the local home and a node's home are where their projects are.
 *
 * @param {string} path
 * @returns {string}
 */
export function normalizeLocal(path) {
  const trimmed = typeof path === 'string' ? path.trim() : ''
  if (trimmed.length === 0) return homedir()
  return resolve(trimmed)
}

/**
 * The parent of a path, or `undefined` at a root.
 *
 * `dirname('D:\\')` returns `'D:\\'`, so comparing is the only way to know the walk is
 * over — otherwise the UI offers a "go up" that goes nowhere.
 * @param {string} path
 * @returns {string | undefined}
 */
export function parentOfLocal(path) {
  const parent = dirname(path)
  return parent === path ? undefined : parent
}

/**
 * List the folders in one local directory.
 *
 * Files are filtered out rather than marked: a workspace is a directory, so showing files
 * would only add rows nobody can pick.
 *
 * @param {string} [path]
 * @returns {Promise<{ path: string, home: string, parent?: string, entries: Array<{ name: string, path: string }>, truncated: boolean }>}
 */
export async function listLocal(path) {
  const wanted = normalizeLocal(path)
  // Resolve symlinks so "up" behaves: a link into another tree would otherwise walk back
  // through the link and look like it went nowhere.
  let target = wanted
  try {
    target = await realpath(wanted)
  } catch {
    // A path that does not resolve is reported by the `stat` below, with its message.
  }
  const info = await stat(target)
  if (!info.isDirectory()) {
    throw Object.assign(new Error(`${target} is not a directory`), { code: 'not-a-directory' })
  }
  const dirents = await readdir(target, { withFileTypes: true })
  const entries = []
  let truncated = false
  for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
    // A hidden directory is not offered, but it is still reachable by typing its path:
    // `.git` and `.cache` are noise in a picker, and a project never lives in one.
    if (dirent.name.startsWith('.')) continue
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
    if (entries.length >= MAX_ENTRIES) { truncated = true; break }
    entries.push({ name: dirent.name, path: join(target, dirent.name) })
  }
  const parent = parentOfLocal(target)
  return {
    path: target,
    home: homedir(),
    ...(parent === undefined ? {} : { parent }),
    roots: await localRoots(),
    // `crumbs` is additive: `/rnh/api/browse` and the plugin's own dialog read the
    // fields above, while a Remote caller's in-app browser renders the ancestor row
    // from this one.
    crumbs: localCrumbs(target),
    entries,
    truncated,
    // This machine's levels always exist: `stat` above proved it, so a caller can branch on
    // one field for both sides instead of on which side it is talking to.
    exists: true,
  }
}

/**
 * The script one remote listing runs.
 *
 * Written as one self-contained POSIX shell program because it must work on a node with
 * nothing installed but a shell, `find` and `coreutils`. Four properties are deliberate:
 *
 * 1. **The target arrives as `$1`, never interpolated.** A path with spaces, quotes or a
 *    newline cannot become part of the program text.
 * 2. **Every fact is a `type\0value\0` record.** No prose, no unanchored regex, no way for a
 *    directory name to be mistaken for a fact: a name is only ever a record's *payload*.
 * 3. **`find`'s exit status is checked directly.** Its predecessor piped `find` into
 *    `head`, so a missing `find` or an unreadable directory produced `head`'s status 0 and a
 *    listing that looked like "this directory is empty" — the most expensive kind of wrong.
 * 4. **Names leave as bytes.** They are NUL-separated by `find` and base64-wrapped, so a name
 *    that is not valid UTF-8 is reported as such instead of being decoded into U+FFFD (which
 *    would be a different, plausible-looking folder).
 */
const LIST_SCRIPT = String.raw`
set -u
target=${'$'}{1:-}
if [ -z "$target" ]; then target="$HOME"; fi
printf 'home\0%s\0' "$HOME"
if [ ! -e "$target" ]; then
  printf 'missing\0%s\0' "$target"
  exit 0
fi
if ! cd "$target" 2>/dev/null; then
  reason=$(cd "$target" 2>&1 | tail -n 1)
  printf 'error\0%s\0' "$reason"
  exit 0
fi
printf 'path\0%s\0' "$(pwd -P)"
if ! command -v find >/dev/null 2>&1; then
  printf 'error\0find is not installed on this node\0'
  exit 0
fi
tmp=$(mktemp 2>/dev/null)
if [ -z "$tmp" ]; then
  printf 'error\0mktemp is not available on this node\0'
  exit 0
fi
trap 'rm -f "$tmp" "$tmp.cut"' EXIT INT TERM HUP
if ! find . -mindepth 1 -maxdepth 1 -type d ! -name '.*' -print0 > "$tmp" 2>/dev/null; then
  printf 'error\0find could not read this directory\0'
  exit 0
fi
bytes=$(wc -c < "$tmp" | tr -d ' ')
if [ "$bytes" -gt ${String(MAX_NAME_BYTES)} ]; then
  printf 'more\0\0'
  head -c ${String(MAX_NAME_BYTES)} "$tmp" > "$tmp.cut" 2>/dev/null && mv "$tmp.cut" "$tmp"
fi
if command -v base64 >/dev/null 2>&1; then
  printf 'encoding\0base64\0'
  base64 < "$tmp" 2>/dev/null | tr -d '\n'
else
  printf 'encoding\0raw\0'
  cat "$tmp"
fi
printf '\0'
`.trim()

/** Where the record stream stops and the name block begins. */
const NAME_BLOCK_MARKER = '\u0000encoding\u0000'

/**
 * Split the leading `type\0value\0` record stream.
 *
 * A trailing partial pair is dropped and reported: a half-record is not a fact, and the shell
 * is allowed to cut the *name block* at a byte ceiling but never a record.
 *
 * @param {string} text
 * @returns {{ facts: Map<string, string>, cutMidRecord: boolean }}
 */
function parseRecords(text) {
  const parts = text.split('\u0000')
  const facts = new Map()
  let complete = 0
  for (let index = 0; index + 1 < parts.length; index += 2) {
    facts.set(parts[index], parts[index + 1])
    complete = index + 2
  }
  // A well-formed stream ends with the separator, so the split leaves one empty tail part.
  const cutMidRecord = parts.length > 0 && parts[parts.length - 1] !== ''
  return { facts, cutMidRecord: cutMidRecord && complete < parts.length }
}

/**
 * Decode the name block into folder names.
 *
 * The block is NUL-separated `find -print0` output, each entry spelled `./name`. Base64 is used
 * when the node has it so that a name which is not valid UTF-8 survives as bytes instead of
 * being replaced by U+FFFD on the way through the transport's UTF-8 decoding.
 *
 * @param {string} text - base64 text, or raw bytes read as a latin-1-ish string.
 * @param {'base64' | 'raw'} encoding
 * @returns {{ names: Buffer[], cutMidName: boolean }}
 */
function parseNameBlock(text, encoding) {
  const block = encoding === 'base64'
    // `Buffer.from` ignores whitespace and padding noise; the stream is one line by design.
    ? Buffer.from(text.replace(/[^A-Za-z0-9+/=]/gu, ''), 'base64')
    : Buffer.from(text, 'binary')
  const names = []
  let start = 0
  for (;;) {
    const end = block.indexOf(0, start)
    if (end === -1) break
    names.push(block.subarray(start, end))
    start = end + 1
  }
  return { names, cutMidName: start < block.length }
}

/**
 * Decode one folder name, keeping the fact that it is not UTF-8.
 *
 * The picker has to show *something* for such a folder, and the something must not be a
 * plausible different name: U+FFFD in place of the offending bytes, plus a flag the caller can
 * use to say "this name is not representable here".
 *
 * @param {Buffer} bytes
 * @returns {{ name: string, unrepresentable: boolean }}
 */
function decodeName(bytes) {
  // `./name` is how `find -print0` spells a child; the prefix is not part of the name.
  const raw = bytes.length >= 2 && bytes[0] === 0x2e && bytes[1] === 0x2f ? bytes.subarray(2) : bytes
  try {
    return { name: new TextDecoder('utf-8', { fatal: true }).decode(raw), unrepresentable: false }
  } catch {
    return { name: new TextDecoder('utf-8').decode(raw), unrepresentable: true }
  }
}

/**
 * List the folders on a node.
 *
 * Runs through the SSH connection this plugin already has, not through the node's Harness:
 * browsing a directory is a filesystem question, and asking a running Host would mean the
 * node had to be up before its own folders could be chosen. It also keeps a permission
 * error reported as one, instead of surfacing as a missing RPC endpoint.
 *
 * @param {import('../ssh/connection.js').SshConnection} connection
 * @param {string} [path] - absolute POSIX path; empty means the node's home directory.
 * @returns {Promise<{ path: string, home: string, parent?: string, entries: Array<{ name: string, path: string, unrepresentable?: boolean }>, truncated: boolean, exists: boolean }>}
 *   `exists: false` is a legal absolute path the node does not have yet: the level is
 *   empty and confirmable, and `workspace/create` makes it. A path that could never be a
 *   directory, or one this process may not read, still throws.
 */
export async function listRemote(connection, path) {
  const raw = typeof path === 'string' && path.trim().length > 0 ? path.trim() : ''
  // **The path policy lives here, once.** Its predecessor checked `..` only in the MISSING
  // branch, so `listRemote(conn, '/../../etc')` was answered as `/etc` — the shell's `cd`
  // happily folds it and `pwd -P` reports the folded result, which is a different directory
  // than the caller asked about. A relative path is refused for the same reason: the answer
  // would name a directory this Host could never spell back, so "somewhere on the node" must
  // not silently become "somewhere specific on the node".
  let wanted = ''
  if (raw.length > 0) {
    const normalized = normalizePosix(raw)
    if (!normalized.ok) {
      throw Object.assign(
        new Error(`${raw.slice(0, 120)}: not an absolute path this node can be asked about`),
        { code: 'path-invalid' },
      )
    }
    wanted = normalized.path
  }
  const result = await connection.exec({
    argv: ['sh', '-c', LIST_SCRIPT, 'sh', wanted],
    timeoutMs: 30_000,
    maxBytes: 2 * MAX_NAME_BYTES,
  })
  // A truncated capture is a broken answer, not a short one: the ceiling exists to keep a
  // pathological directory from exhausting the desktop's memory, and a caller that got a
  // prefix has no way to tell which folders are missing.
  if (result.truncated === true) {
    throw Object.assign(
      new Error(`${wanted === '' ? '~' : wanted}: the listing was too large to read in one answer`),
      { code: 'browse-too-large' },
    )
  }
  // The name block is separated from the facts by a marker rather than being one more record,
  // because the block is bytes (base64 text, no NULs of its own) while the facts are UTF-8 text.
  // Splitting the whole stream by NUL would work for the facts and destroy nothing here, but
  // keeping the two apart is what lets a non-UTF-8 name survive at all.
  const marker = result.stdout.indexOf(NAME_BLOCK_MARKER)
  const headerText = marker === -1 ? result.stdout : result.stdout.slice(0, marker)
  const { facts, cutMidRecord: cutRecord } = parseRecords(headerText)
  let cutMidRecord = cutRecord
  const home = facts.get('home') ?? '/'

  const failure = facts.get('error')
  if (failure !== undefined) {
    throw Object.assign(new Error(`${wanted === '' ? '~' : wanted}: ${failure.trim()}`), {
      code: 'browse-failed',
    })
  }
  // A path that is not there is answered as an **empty level**, and only when it could
  // become a directory: absolute, no `..` that escapes, and not the root itself. Anything else
  // keeps failing — a picker that silently accepted `../../etc` or `/` would be worse than one
  // that refuses, because the next step creates it on the node.
  const missing = facts.get('missing')
  if (missing !== undefined) {
    const normalized = normalizePosix(missing)
    if (!normalized.ok) {
      throw Object.assign(
        new Error(`${missing}: not a directory this node can be asked to create`),
        { code: 'path-invalid' },
      )
    }
    if (normalized.path === '/') {
      throw Object.assign(
        new Error(`${missing}: the root always exists, so it cannot be created`),
        { code: 'path-invalid' },
      )
    }
    return {
      path: normalized.path,
      home,
      roots: ['/'],
      crumbs: posixCrumbs(normalized.path),
      entries: [],
      truncated: false,
      // The one field that tells "an empty folder" from "a folder that is not there yet".
      // A caller that ignores it sees an empty level either way, which is what the phone's
      // picker needs; a caller that reads it can say what confirming will do.
      exists: false,
    }
  }
  const resolved = facts.get('path')
  if (resolved === undefined) {
    throw Object.assign(
      new Error(`reading ${wanted === '' ? '~' : wanted} failed: ${result.stdout.trim().slice(-300)}`),
      { code: 'browse-failed' },
    )
  }

  // The name block follows the marker: `…\0encoding\0<enc>\0<block>`. `base64` is preferred
  // because the transport decodes stdout as UTF-8, so a raw name that is not valid UTF-8 would
  // already be U+FFFD by the time it reached this process — the one loss base64 prevents.
  let names = []
  if (marker !== -1) {
    const afterMarker = marker + NAME_BLOCK_MARKER.length
    const encodingEnd = result.stdout.indexOf('\u0000', afterMarker)
    const encoding = encodingEnd === -1 ? 'raw' : result.stdout.slice(afterMarker, encodingEnd)
    const blockText = encodingEnd === -1 ? '' : result.stdout.slice(encodingEnd + 1)
    const parsed = parseNameBlock(blockText, encoding === 'base64' ? 'base64' : 'raw')
    names = parsed.names
    cutMidRecord = cutMidRecord || parsed.cutMidName
  }

  // Sort here rather than in the shell: `sort -z` is a GNU extension, and the order a picker
  // shows must not depend on which `find` the node happens to have.
  const decoded = names.map(decodeName)
  decoded.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const truncated = decoded.length > MAX_ENTRIES || cutMidRecord || facts.has('more')
  const entries = decoded.slice(0, MAX_ENTRIES).map(entry => ({
    name: entry.name,
    // POSIX joining, on purpose: this path belongs to the node, not to this machine.
    path: posixJoin(resolved, entry.name),
    ...(entry.unrepresentable ? { unrepresentable: true } : {}),
  }))
  const parent = posixParent(resolved)
  return {
    path: resolved,
    home,
    ...(parent === undefined ? {} : { parent }),
    // A node has one tree, so the only root is `/`; the picker still needs to know so
    // it can offer the same "jump to a root" affordance on both sides.
    roots: ['/'],
    crumbs: posixCrumbs(resolved),
    entries,
    truncated,
    // Present on every answer so a caller can branch on one field instead of on whether
    // the key happens to be there.
    exists: true,
  }
}

/**
 * Create one directory on a node.
 *
 * Over SSH for the same reason listing is: a folder is a filesystem question, and asking
 * the node's Harness would keep the picker unusable while that Host restarts. `mkdir`
 * without `-p` is deliberate — an existing name must fail loudly instead of silently
 * selecting a directory the user did not choose.
 *
 * @param {import('../ssh/connection.js').SshConnection} connection
 * @param {string} parent - absolute POSIX path.
 * @param {string} name
 * @returns {Promise<string>}
 */
export async function makeRemoteDirectory(connection, parent, name) {
  const segment = checkedSegment(name)
  const normalized = normalizePosix(parent)
  if (!normalized.ok) {
    throw Object.assign(
      new Error(`${String(parent).slice(0, 120)}: not an absolute path this node can own`),
      { code: 'path-invalid' },
    )
  }
  const target = posixJoin(normalized.path, segment)
  const result = await connection.exec({
    argv: ['sh', '-c', 'mkdir -- "$1"', 'sh', target],
    timeoutMs: 20_000,
    maxBytes: 64 * 1024,
  })
  if (result.code !== 0) {
    const reason = `${result.stderr}`.trim() || `mkdir exited ${String(result.code)}`
    throw Object.assign(new Error(`${target}: ${reason.slice(0, 300)}`), { code: 'create-failed' })
  }
  return target
}

/**
 * Make sure one directory exists on a node, creating missing parents.
 *
 * `workspace/create` resolves its folder with `realpath` and fails before creating
 * anything, so a folder the caller has not made yet has to be made here. `mkdir -p` and
 * not `mkdir`: this path exists to make "open a project that is not there yet" work, and
 * the picker's own "new folder" affordance is unavailable to a Remote caller
 * (`directoryPicker/createDirectory` is not in the phone client's allowlist).
 *
 * The comment here used to claim that `..` could not escape while the code checked nothing at
 * all. It is now checked, in the one place that folds POSIX paths for every caller.
 *
 * @param {import('../ssh/connection.js').SshConnection} connection
 * @param {string} path - absolute POSIX path.
 * @returns {Promise<void>}
 */
export async function ensureRemoteDirectory(connection, path) {
  const normalized = normalizePosix(path)
  if (!normalized.ok) {
    throw Object.assign(
      new Error(`${String(path).slice(0, 120)}: not an absolute path this node can own`),
      { code: 'path-invalid' },
    )
  }
  // `cd -P` is not needed: `mkdir -p` already treats the argument as a path, and
  // resolving symlinks here would create the target of a link instead of the link.
  const result = await connection.exec({
    argv: ['sh', '-c', 'mkdir -p -- "$1"', 'sh', normalized.path],
    timeoutMs: 30_000,
    maxBytes: 64 * 1024,
  })
  if (result.code !== 0) {
    const reason = `${result.stderr}`.trim() || `mkdir exited ${String(result.code)}`
    throw Object.assign(new Error(`${normalized.path}: ${reason.slice(0, 300)}`), { code: 'create-failed' })
  }
}
