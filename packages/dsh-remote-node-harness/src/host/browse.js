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
 * @module @greatbaby/dsh-remote-node-harness/host/browse
 */
import { mkdir, readdir, stat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** How many folders one listing returns; a directory with more is still usable. */
const MAX_ENTRIES = 500

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
  const crumbs = [{ name: '/', path: '/', hidden: false }]
  let current = '/'
  for (const segment of path.split('/')) {
    if (segment.length === 0) continue
    current = current === '/' ? `/${segment}` : `${current}/${segment}`
    crumbs.push({ name: segment, path: current, hidden: false })
  }
  return crumbs
}

/**
 * Reject a name that is not one usable directory segment.
 * @param {unknown} name
 * @returns {string}
 */
function checkedSegment(name) {
  const segment = typeof name === 'string' ? name.trim() : ''
  if (segment.length === 0 || segment === '.' || segment === '..') {
    throw Object.assign(new Error('a folder name is required'), { code: 'name-invalid' })
  }
  if (/[/\\]/u.test(segment)) {
    throw Object.assign(new Error('a folder name cannot contain a path separator'), { code: 'name-invalid' })
  }
  return segment
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
 * List the folders on a node.
 *
 * Runs through the SSH connection this plugin already has, not through the node's Harness:
 * browsing a directory is a filesystem question, and asking a running Host would mean the
 * node had to be up before its own folders could be chosen. It also keeps a permission
 * error reported as one, instead of surfacing as a missing RPC endpoint.
 *
 * @param {import('../ssh/connection.js').SshConnection} connection
 * @param {string} [path] - absolute POSIX path; empty means the node's home directory.
 * @returns {Promise<{ path: string, home: string, parent?: string, entries: Array<{ name: string, path: string }>, truncated: boolean, exists: boolean }>}
 *   `exists: false` is a legal absolute path the node does not have yet: the level is
 *   empty and confirmable, and `workspace/create` makes it. A path that could never be a
 *   directory, or one this process may not read, still throws.
 */
export async function listRemote(connection, path) {
  const wanted = typeof path === 'string' && path.trim().length > 0 ? path.trim() : ''
  // One shell invocation answers every fact this needs: the resolved absolute path (a bare
  // `~` or a relative argument has to become absolute before it can be a workspace), the
  // home directory, and the folder list. `$1` is passed as an argument, not interpolated,
  // so a path with spaces or quotes cannot become part of the script.
  //
  // A missing directory is reported as its own fact rather than folded into the error: a
  // path that is legal but not there yet is exactly what "open a project that does not
  // exist" hands this function, and the picker has to let that path be confirmed. The two
  // markers are mutually exclusive, so a caller never has to read shell prose to tell
  // "not there" from "not allowed".
  const script = `
set -u
target=\${1:-}
if [ -z "$target" ]; then target="$HOME"; fi
if [ ! -e "$target" ]; then
  printf 'RNH_BROWSE_MISSING=%s\\n' "$target"
  printf 'RNH_BROWSE_HOME=%s\\n' "$HOME"
  exit 0
fi
if ! cd "$target" 2>/dev/null; then
  printf 'RNH_BROWSE_ERROR=%s\\n' "$(cd "$target" 2>&1 | tail -1)"
  printf 'RNH_BROWSE_HOME=%s\\n' "$HOME"
  exit 0
fi
printf 'RNH_BROWSE_PATH=%s\\n' "$(pwd -P)"
printf 'RNH_BROWSE_HOME=%s\\n' "$HOME"
find . -mindepth 1 -maxdepth 1 -type d ! -name '.*' -print 2>/dev/null | LC_ALL=C sort | head -n ${String(MAX_ENTRIES + 1)}
`.trim()
  const result = await connection.exec({
    argv: ['sh', '-c', script, 'sh', wanted],
    timeoutMs: 30_000,
    maxBytes: 512 * 1024,
  })
  const output = `${result.stdout}\n${result.stderr}`
  const home = /RNH_BROWSE_HOME=(.*)/u.exec(output)?.[1]?.trim() ?? '/'
  const failure = /RNH_BROWSE_ERROR=(.*)/u.exec(output)
  if (failure !== null) {
    throw Object.assign(new Error(`${wanted === '' ? '~' : wanted}: ${failure[1].trim()}`), {
      code: 'browse-failed',
    })
  }
  // A path that is not there is answered as an **empty level**, and only when it could
  // become a directory: absolute, no `..`, and not the root itself. Anything else keeps
  // failing — a picker that silently accepted `../../etc` or `/` would be worse than one
  // that refuses, because the next step creates it on the node.
  const missing = /RNH_BROWSE_MISSING=(.*)/u.exec(output)?.[1]?.trim()
  if (missing !== undefined) {
    if (!isPosixAbsolute(missing) || missing === '/' || missing.split('/').includes('..')) {
      throw Object.assign(
        new Error(`${missing}: not a directory this node can be asked to create`),
        { code: 'path-invalid' },
      )
    }
    const normalized = missing.replace(/\/+$/u, '') || '/'
    return {
      path: normalized,
      home,
      roots: ['/'],
      crumbs: posixCrumbs(normalized),
      entries: [],
      truncated: false,
      // The one field that tells "an empty folder" from "a folder that is not there yet".
      // A caller that ignores it sees an empty level either way, which is what the phone's
      // picker needs; a caller that reads it can say what confirming will do.
      exists: false,
    }
  }
  const resolved = /RNH_BROWSE_PATH=(.*)/u.exec(output)?.[1]?.trim()
  if (resolved === undefined) {
    throw Object.assign(new Error(`reading ${wanted === '' ? '~' : wanted} failed: ${output.trim().slice(-300)}`), {
      code: 'browse-failed',
    })
  }
  const names = []
  for (const line of output.split('\n')) {
    const match = /^\.\/(.+)$/u.exec(line.trim())
    if (match !== null) names.push(match[1])
  }
  const truncated = names.length > MAX_ENTRIES
  const entries = names.slice(0, MAX_ENTRIES).map(name => ({
    name,
    // POSIX joining, on purpose: this path belongs to the node, not to this machine.
    path: `${resolved.replace(/\/+$/u, '')}/${name}`,
  }))
  const parent = resolved === '/' ? undefined : resolved.replace(/\/[^/]+$/u, '') || '/'
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
 * POSIX ancestor chain, root first and the directory itself last.
 * @param {string} path
 * @returns {Array<{ name: string, path: string, hidden: false }>}
 */
function posixCrumbs(path) {
  const crumbs = [{ name: '/', path: '/', hidden: false }]
  let current = '/'
  for (const segment of path.split('/')) {
    if (segment.length === 0) continue
    current = current === '/' ? `/${segment}` : `${current}/${segment}`
    crumbs.push({ name: segment, path: current, hidden: false })
  }
  return crumbs
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
  if (!isPosixAbsolute(parent)) {
    throw Object.assign(new Error('a node directory must be an absolute path'), { code: 'path-invalid' })
  }
  const target = `${parent.replace(/\/+$/u, '')}/${segment}`
  const script = 'mkdir -- "$1"'
  const result = await connection.exec({
    argv: ['sh', '-c', script, 'sh', target],
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
 * Whether a string is an absolute POSIX path a node could own.
 *
 * Deliberately not `path.isAbsolute`: on Windows that answers true for `/foo` as well,
 * so it cannot tell "a path on the node" from "a path on this machine".
 * @param {unknown} path
 * @returns {boolean}
 */
export function isPosixAbsolute(path) {
  return typeof path === 'string' && path.startsWith('/')
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
 * Naming this path is safe precisely because it is absolute and the node owns it —
 * a caller cannot use `.`/`..` to escape, and `--` stops a leading dash becoming a flag.
 *
 * @param {import('../ssh/connection.js').SshConnection} connection
 * @param {string} path - absolute POSIX path.
 * @returns {Promise<void>}
 */
export async function ensureRemoteDirectory(connection, path) {
  if (!isPosixAbsolute(path)) {
    throw Object.assign(new Error('a node path must be absolute'), { code: 'path-invalid' })
  }
  // `cd -P` is not needed: `mkdir -p` already treats the argument as a path, and
  // resolving symlinks here would create the target of a link instead of the link.
  const result = await connection.exec({
    argv: ['sh', '-c', 'mkdir -p -- "$1"', 'sh', path],
    timeoutMs: 30_000,
    maxBytes: 64 * 1024,
  })
  if (result.code !== 0) {
    const reason = `${result.stderr}`.trim() || `mkdir exited ${String(result.code)}`
    throw Object.assign(new Error(`${path}: ${reason.slice(0, 300)}`), { code: 'create-failed' })
  }
}
