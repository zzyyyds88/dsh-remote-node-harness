/**
 * Whether one of this desktop's third-party bundles is a fit for one node.
 *
 * A per-plugin switch means "this plugin also runs on that machine". Two things can make that
 * sentence false, and only one of them can be derived:
 *
 * 1. **The node is the wrong platform.** Derivable: the bundle's own composition is on disk
 *    here, and a Windows drive path in it (`C:\…\rhinomcp.exe`) cannot exist on Linux. No
 *    declaration is needed and none would survive the person editing their own plugin, so this
 *    module reads the bytes.
 * 2. **The bundle needs configuration this desktop cannot give it.** Not derivable: nothing
 *    machine-readable says "this plugin reads `~/.hindsight/coding-agent.json`". That fact is
 *    declared in `capabilities.mjs` and arrives here as the generated registry; this module
 *    only applies it.
 *
 * Both produce the same outcome — the bundle is left out of the node's composition — and both
 * are reported with the reason, because a switch that silently did nothing is the bug this
 * module exists to prevent.
 *
 * ## Why the platform check is asymmetric
 *
 * A Windows drive path in a bundle composed onto a Linux node is a **proof** of unfitness: that
 * literal names a file that cannot exist there. The reverse (a POSIX path inside a bundle going
 * to a Windows node) is not proof of anything — `/foo` appears in URLs, route prefixes and
 * package-relative paths, and this project never sends bundles to a Windows node anyway
 * (`PUBLISHED_PLATFORMS` is `linux-x64` alone). Refusing a plugin that would have worked is
 * worse than letting through one that will fail on its first call, so the check stays one-way.
 *
 * @module @greatbaby/dsh-remote-node-harness/core/plugin-applicability
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** A path that only means something on Windows: a drive letter, a colon, a backslash. */
const WINDOWS_DRIVE_PATH = /(?:^|[\s'"=:(])([A-Za-z]:\\[^\s'"`]*)/u

/**
 * The OS a probe answer names, in npm's vocabulary.
 *
 * `describeProbe()` reports `os: 'linux' | 'darwin' | 'win32'` already (it comes from
 * `uname`/`process.platform` on the node), so this is a narrowing rather than a translation —
 * and an unknown answer returns `undefined` instead of a guess, because "assume Linux" is how a
 * Windows-only plugin would end up composed onto a Linux node.
 * @param {{ os?: string } | undefined} facts
 * @returns {'linux' | 'darwin' | 'win32' | undefined}
 */
export function nodeOsOf(facts) {
  const os = facts?.os
  if (os === 'linux' || os === 'darwin' || os === 'win32') return os
  return undefined
}

/**
 * The platforms one installed bundle declares, in npm's vocabulary.
 *
 * `package.json` `os` is the standard field npm itself refuses an install on, so a bundle that
 * carries it has already answered this question. A bundle that does not carry it is **not**
 * assumed portable — it is reported as no declaration, and the byte-level check decides.
 * @param {string} dir - the bundle's directory on this desktop.
 * @returns {string[] | undefined} `undefined` when the bundle declares nothing.
 */
export function manifestPlatforms(dir) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  const os = manifest?.os
  const declared = typeof os === 'string' ? [os] : Array.isArray(os) ? os.filter(entry => typeof entry === 'string') : []
  return declared.length === 0 ? undefined : declared
}

/**
 * The files one bundle composes, from its own manifest.
 *
 * Mirrors how the Loader reads `dsh.bundle.patch` (a string or a list) rather than re-spelling
 * the bundles it knows about: this has to answer for a plugin this repository has never seen.
 * A `!` prefix is npm's negation and is not a patch file, so it is skipped.
 * @param {string} dir
 * @returns {string[]} absolute paths of the composition files that exist.
 */
export function compositionFilesOf(dir) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return []
  }
  const declared = manifest?.dsh?.bundle?.patch
  const relative = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : []
  const out = []
  for (const entry of relative) {
    if (typeof entry !== 'string' || entry.startsWith('!')) continue
    const full = join(dir, entry)
    if (existsSync(full)) out.push(full)
  }
  return out
}

/**
 * The host-bound literals a bundle's composition contains.
 *
 * Returns the **first** one per file with its line number, which is what a person needs to
 * either fix their plugin or accept the refusal. Reading only the composition files (not the
 * bundle's whole source) keeps this cheap and keeps the answer about what actually gets
 * composed: a Windows path inside a Windows-only code branch that no composed row reaches
 * would be a false positive.
 * @param {string[]} files - absolute paths, from `compositionFilesOf`.
 * @returns {Array<{ file: string, line: number, literal: string }>}
 */
export function hostBoundPaths(files) {
  const out = []
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (const [index, line] of lines.entries()) {
      const match = WINDOWS_DRIVE_PATH.exec(line)
      if (match === null) continue
      out.push({ file, line: index + 1, literal: match[1] })
      break
    }
  }
  return out
}

/**
 * Whether one bundle can be composed onto one node, and why not when it cannot.
 *
 * The order of the checks is the order of confidence: an explicit `os` declaration is the
 * bundle's own answer, and the byte scan is a proof. Everything else is a fit.
 *
 * @param {object} options
 * @param {string} options.bundle - full package name.
 * @param {string} options.dir - where this desktop installed it.
 * @param {{ os?: string } | undefined} options.facts - the node's probe answer.
 * @returns {{ bundle: string, fits: boolean, reason?: string, detail?: { file: string, line: number, literal: string } }}
 */
export function nodeApplies({ bundle, dir, facts }) {
  const os = nodeOsOf(facts)
  // No probe answer means the question cannot be asked yet. Saying "fits" is the safe side
  // here: the caller runs this after a probe, and a wrong refusal would drop a capability for
  // a fact that was never read.
  if (os === undefined) return { bundle, fits: true }

  const declared = manifestPlatforms(dir)
  if (declared !== undefined) {
    // npm's `os` list supports negation (`["!win32"]`) as well as enumeration; the positive
    // form is what bundles actually use, and a negated list is honoured the same way npm does.
    const denied = declared.filter(entry => entry.startsWith('!')).map(entry => entry.slice(1))
    const allowed = declared.filter(entry => !entry.startsWith('!'))
    const fits = denied.length > 0 ? !denied.includes(os) && (allowed.length === 0 || allowed.includes(os))
      : allowed.includes(os)
    if (!fits) {
      return {
        bundle,
        fits: false,
        reason: `its package.json declares os ${JSON.stringify(declared)}, and this node is ${os}`,
      }
    }
  }

  for (const hit of hostBoundPaths(compositionFilesOf(dir))) {
    // A drive path is only a proof of unfitness where it cannot be reinterpereted: never on
    // Windows, and the message names the file and line so nobody has to grep for it.
    if (os === 'win32') continue
    const relative = hit.file.slice(Math.max(dir.length + 1, 0))
    return {
      bundle,
      fits: false,
      // Quoted with backticks rather than JSON-stringified: this sentence is read by a person
      // looking for the line in their own plugin, and `C:\\Users\\…` is not what that file says.
      reason: `its composition names the Windows path \`${hit.literal}\` at `
        + `${relative}:${String(hit.line)}, and this node is ${os}`,
      detail: { file: relative, line: hit.line, literal: hit.literal },
    }
  }

  return { bundle, fits: true }
}