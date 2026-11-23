/**
 * POSIX path algebra for a node's filesystem — pure, no I/O, no shell.
 *
 * This module exists because the same question ("is this path something a node may be asked
 * about?") was answered in three places with three different rules: `browse.js` checked `..`
 * only in its MISSING branch and had a `//` hole, `picker-paths.js` folded separators but not
 * `.`/`..`, and `ensureRemoteDirectory` claimed in a comment that `..` could not escape while
 * checking nothing at all. Each was individually defensible and together they disagreed.
 *
 * Node's `path.posix` is deliberately not used for the *validation* half: it happily returns
 * `/etc` for `/../../etc`, which is exactly the answer a caller must not be given. Folding is
 * therefore written out, with the escape case reported rather than silently clamped.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/posix-path
 */

/** The root of a POSIX tree. */
export const POSIX_ROOT = '/'

/**
 * Whether a value is an absolute POSIX path.
 *
 * Deliberately not `path.isAbsolute`: on Windows that answers true for `/foo` as well, so it
 * cannot tell "a path on the node" from "a path on this machine".
 * @param {unknown} path
 * @returns {boolean}
 */
export function isPosixAbsolute(path) {
  return typeof path === 'string' && path.startsWith('/')
}

/**
 * Fold a POSIX path into its canonical lexical form.
 *
 * Collapses repeated separators, drops `.` segments, resolves `..` against the preceding
 * segment, and removes a trailing separator (except at the root). A `..` that would rise above
 * the root is reported as an escape instead of being clamped, because clamping turns
 * `/../../etc/passwd` into `/etc/passwd` — a different path than the caller asked about, which
 * is precisely the silent substitution this project refuses to make.
 *
 * @param {unknown} path
 * @returns {{ ok: true, path: string } | { ok: false, reason: 'not-absolute' | 'escapes-root', detail: string }}
 */
export function normalizePosix(path) {
  if (!isPosixAbsolute(path)) {
    return { ok: false, reason: 'not-absolute', detail: String(path).slice(0, 120) }
  }
  const out = []
  for (const segment of String(path).split('/')) {
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') {
      if (out.length === 0) {
        return { ok: false, reason: 'escapes-root', detail: String(path).slice(0, 120) }
      }
      out.pop()
      continue
    }
    out.push(segment)
  }
  return { ok: true, path: out.length === 0 ? POSIX_ROOT : `/${out.join('/')}` }
}

/**
 * The parent of a canonical POSIX path, or `undefined` at the root.
 *
 * The `undefined` is what stops a picker offering a "go up" that goes nowhere, and it is why
 * this is a function rather than a regex at each call site.
 * @param {string} path - an absolute POSIX path.
 * @returns {string | undefined}
 */
export function posixParent(path) {
  if (!isPosixAbsolute(path)) return undefined
  const normalized = normalizePosix(path)
  if (!normalized.ok) return undefined
  if (normalized.path === POSIX_ROOT) return undefined
  const cut = normalized.path.lastIndexOf('/')
  return cut <= 0 ? POSIX_ROOT : normalized.path.slice(0, cut)
}

/**
 * Join one already-validated segment onto a canonical POSIX path.
 *
 * The segment is assumed checked (`checkedSegment`); this function only joins, so a caller
 * cannot accidentally get two validations that disagree about what a segment is.
 * @param {string} parent - an absolute POSIX path.
 * @param {string} segment - one path segment, no separators.
 * @returns {string}
 */
export function posixJoin(parent, segment) {
  const base = parent === POSIX_ROOT ? '' : parent.replace(/\/+$/u, '')
  return `${base}/${segment}`
}

/**
 * The ancestor chain of one directory, root first and the directory itself last.
 *
 * The picker's breadcrumbs are a list of jump targets the Host computes — a client never
 * joins segments itself.
 * @param {string} path - an absolute POSIX path.
 * @returns {Array<{ name: string, path: string, hidden: false }>}
 */
export function posixCrumbs(path) {
  const crumbs = [{ name: POSIX_ROOT, path: POSIX_ROOT, hidden: false }]
  const normalized = normalizePosix(path)
  if (!normalized.ok) return crumbs
  let current = ''
  for (const segment of normalized.path.split('/')) {
    if (segment.length === 0) continue
    current = `${current}/${segment}`
    crumbs.push({ name: segment, path: current, hidden: false })
  }
  return crumbs
}

/**
 * Whether one canonical path is the other or lies inside it.
 *
 * Written with a separator-aware comparison rather than `startsWith`: `/home/user2` starts
 * with `/home/user` and is not inside it, which is the mistake this function exists to not make.
 * @param {string} path - an absolute POSIX path.
 * @param {string} root - an absolute POSIX path.
 * @returns {boolean}
 */
export function isSameOrWithin(path, root) {
  const inner = normalizePosix(path)
  const outer = normalizePosix(root)
  if (!inner.ok || !outer.ok) return false
  if (inner.path === outer.path) return true
  if (outer.path === POSIX_ROOT) return true
  return inner.path.startsWith(`${outer.path}/`)
}

/**
 * Reject a name that is not one usable directory segment.
 *
 * The name is a single segment on purpose: the picker asks for a folder name, not a path, so a
 * caller cannot walk out of the directory it is looking at. The check runs here rather than
 * only in the browser, because this function is reachable over HTTP.
 * @param {unknown} name
 * @returns {string}
 */
export function checkedSegment(name) {
  const segment = typeof name === 'string' ? name.trim() : ''
  if (segment.length === 0 || segment === '.' || segment === '..') {
    throw Object.assign(new Error('a folder name is required'), { code: 'name-invalid' })
  }
  if (/[/\\]/u.test(segment)) {
    throw Object.assign(new Error('a folder name cannot contain a path separator'), { code: 'name-invalid' })
  }
  // A NUL cannot exist in a POSIX filename, so a name carrying one is a forged input rather
  // than a folder the user typed.
  if (segment.includes('\u0000')) {
    throw Object.assign(new Error('a folder name cannot contain a NUL'), { code: 'name-invalid' })
  }
  return segment
}
