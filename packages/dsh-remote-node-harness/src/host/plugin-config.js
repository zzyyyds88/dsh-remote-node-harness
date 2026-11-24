/**
 * The configuration a third-party bundle needs, assembled from this desktop for one node.
 *
 * The registry (`BRAIN_THIRD_PARTY_CONFIG`, generated from `capabilities.mjs`) says which files
 * a bundle reads and which keys may travel. This module does the two things that are easy to
 * get wrong and invisible when wrong:
 *
 * 1. **It copies keys, not files.** The desktop's own `~/.hindsight/coding-agent.json` can hold
 *    several servers' credentials (`banks.<id>.apiToken`) and personal settings; only the
 *    whitelisted keys are read at all, so nothing else can leak into what is written on the
 *    node by accident — a future field added to that file travels nowhere until somebody names
 *    it here.
 * 2. **It decides "available" from what it could actually read.** A bundle whose configuration
 *    is absent here must not be composed there: the plugin would load, activate, and then fail
 *    every call. That is the exact state the real node was found in, and "declared, then
 *    broken" is what a capability's `optional` verdict exists to prevent.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/plugin-config
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Read one whitelisted key set out of a JSON config file on **this** desktop.
 *
 * Returns the keys that were present. A file that does not exist is `available: false` with a
 * reason a person can act on, not a silent empty object: an empty config would make the node's
 * plugin fall back to its hosted default, which is what produced the 401s.
 * @param {{ path: string, keys: readonly string[], format: string }} spec
 * @param {string} [home] - this desktop's home, for the unit tests.
 * @returns {{ available: boolean, values?: Record<string, unknown>, reason?: string }}
 */
export function readConfigFile(spec, home = homedir()) {
  const full = join(home, ...spec.path.split('/'))
  let text
  try {
    text = readFileSync(full, 'utf8')
  } catch (error) {
    return {
      available: false,
      reason: `${spec.path} is not on this desktop (${error.code ?? error.message}), so the node `
        + 'would fall back to the plugin\'s hosted default and fail every call',
    }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { available: false, reason: `${spec.path} on this desktop is not valid JSON: ${error.message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { available: false, reason: `${spec.path} on this desktop is not a JSON object` }
  }
  const values = {}
  for (const key of spec.keys) {
    if (!Object.hasOwn(parsed, key)) continue
    const value = parsed[key]
    if (value === null || value === undefined) continue
    values[key] = value
  }
  if (Object.keys(values).length === 0) {
    return {
      available: false,
      reason: `${spec.path} on this desktop has none of the keys this bundle needs `
        + `(${spec.keys.join(', ')})`,
    }
  }
  return { available: true, values }
}

/**
 * Everything one node should be given for the bundles it is about to compose.
 *
 * One outcome per bundle, never a partial one: a bundle either has all of its declared files or
 * it has nothing and stays out of the composition. Half a configuration is not closer to
 * working — it is the same silent failure with more steps.
 * @param {object} options
 * @param {readonly string[]} options.bundles - the third-party bundles that fit the node.
 * @param {ReadonlyArray<{ bundle: string, path: string, format: string, mode: string, keys: readonly string[] }>} options.registry
 * @param {string} [options.home] - this desktop's home.
 * @returns {{
 *   files: Array<{ bundle: string, path: string, format: string, mode: string, content: string, keys: string[] }>,
 *   unavailable: Array<{ bundle: string, path: string, reason: string }>,
 * }}
 */
export function assembleConfig({ bundles, registry, home }) {
  const files = []
  const unavailable = []
  for (const bundle of bundles) {
    const specs = registry.filter(entry => entry.bundle === bundle)
    // A bundle the registry does not know needs no configuration; that is a normal answer.
    if (specs.length === 0) continue
    const values = {}
    let failed = false
    for (const spec of specs) {
      const read = readConfigFile(spec, home)
      if (read.available !== true) {
        unavailable.push({ bundle, path: spec.path, reason: read.reason ?? 'unreadable' })
        failed = true
        continue
      }
      Object.assign(values, read.values)
      files.push({
        bundle,
        path: spec.path,
        format: spec.format,
        mode: spec.mode,
        // Serialised here rather than on the node: the node has no JSON tool to merge into an
        // existing file, and a shell redirect is how a half-written config becomes a broken one.
        content: `${JSON.stringify(read.values, undefined, 2)}\n`,
        keys: Object.keys(read.values),
      })
    }
    if (failed) {
      // Drop the files read for this bundle: composing it without all of them is the state this
      // guard exists to prevent.
      for (let index = files.length - 1; index >= 0; index -= 1) {
        if (files[index].bundle === bundle) files.splice(index, 1)
      }
    }
  }
  return { files, unavailable }
}

/**
 * Whether a written config differs from what the file already holds.
 *
 * Compared before writing so a connect that changes nothing does not restart a resident host.
 * The node's side has its own byte comparison at the shell level; this one decides whether the
 * call is worth making at all.
 * @param {{ content: string }} file
 * @param {string | undefined} existing
 */
export function configDiffers(file, existing) {
  if (typeof existing !== 'string') return true
  return existing.trim() !== file.content.trim()
}