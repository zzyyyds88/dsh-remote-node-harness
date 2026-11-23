/**
 * Which of your installed plugins a node should load, and the switches that decide it.
 *
 * The decision *what* a switch means lives in `src/core/plugin-sync.js`; this owns the
 * facts about this desktop (its profile manifest and its installed packages) and the file
 * that remembers the answers.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/sync-switches
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  NODE_BASE_BUNDLES,
  installedPlugins,
  isLocalSpec,
  parseSwitches,
  resolvePlugins,
  nodeBundles,
} from '../core/plugin-sync.js'

/**
 * The bundles a node composes by construction, in compose order.
 *
 * **Re-exported, not re-spelled.** This file used to hold its own literal pair, which had to
 * agree with `rnh.js: BRAIN_BUNDLES` by inspection alone; the two would have stayed correct
 * until the day one of them changed. The list now lives once, in `core/plugin-sync.js`, and
 * `check-capabilities` asserts that neither file spells a bundle name of its own.
 */
export { NODE_BASE_BUNDLES }

/**
 * The row ids one installed bundle contributes.
 *
 * Used to show a person what a switch actually brings, and to refuse a switch that would
 * contribute nothing. Reads the bundle's own patch file(s) through its manifest's
 * `dsh.bundle.patch`, so it needs no list of package names.
 *
 * **`dsh.bundle.patch` is a string *or* a list.** Both shapes are in use by bundles a node
 * composes: upstream's `dsh-web-app` and this project's own `@local/rnh-brain` declare an
 * array (the brain needs its composition plus four preset files), while `dsh-base` declares a
 * single string. Reading only the string shape returned `[]` for those bundles — so the plugin
 * page said "this switch brings 0 rows" for the two bundles it most needs to explain, and the
 * "a switch that contributes nothing is refused" guard silently did not apply to them.
 * Measured on 2026-11-23: `rowsOfBundle()` answered `[]` for both.
 *
 * @param {string} nodeModules - where this profile's packages are installed.
 * @param {string} name
 * @returns {string[]}
 */
function rowsOfBundle(nodeModules, name) {
  const dir = join(nodeModules, name)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return []
  }
  const declared = manifest?.dsh?.bundle?.patch
  const files = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : []
  const ids = []
  for (const relative of files) {
    if (typeof relative !== 'string') continue
    let text
    try {
      text = readFileSync(join(dir, relative), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const match = /^\s*-\s*id:\s*(\S+)\s*$/u.exec(line)
      if (match !== null && !ids.includes(match[1])) ids.push(match[1])
    }
  }
  return ids
}

/** Icon files DSH itself accepts for a plugin, with the media type each is served as. */
const ICON_TYPES = Object.freeze({
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
})

/** DSH refuses a plugin icon above this size; the list must not grow the page past it. */
const MAX_ICON_BYTES = 256 * 1024

/**
 * How one installed bundle presents itself.
 *
 * Mirroring DSH's own resolution matters more than it looks: the plugin page this switch
 * list mirrors shows a title, a sentence and an icon per row, and rows that read
 * `@local/dsh-rhino-mode / 22 行` describe a composition rather than a plugin. The
 * sources are the same three DSH reads — `locale/<lang>.json` for localized display text,
 * the package manifest's `name`/`description` as the fallback, and the manifest `icon`
 * as a file relative to the package root, inlined as a data URL because the browser
 * cannot fetch inside a profile directory.
 *
 * @param {string} nodeModules
 * @param {string} name
 * @returns {{ title?: string, titleEn?: string, description?: string, descriptionEn?: string, icon?: string }}
 */
function metaOfBundle(nodeModules, name) {
  const dir = join(nodeModules, name)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
  const localized = language => {
    try {
      return JSON.parse(readFileSync(join(dir, 'locale', `${language}.json`), 'utf8'))
    } catch {
      return undefined
    }
  }
  const zh = localized('zh')
  const en = localized('en')
  const textOf = (dictionary, field) => {
    const value = dictionary === undefined ? undefined : Reflect.get(dictionary, field)
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const meta = {}
  const titleZh = textOf(zh, 'title')
  const titleEn = textOf(en, 'title')
  if (titleZh !== undefined) meta.title = titleZh
  else if (titleEn !== undefined) meta.title = titleEn
  else if (typeof manifest.name === 'string') meta.title = manifest.name
  if (titleEn !== undefined) meta.titleEn = titleEn
  const descriptionZh = textOf(zh, 'description')
  const descriptionEn = textOf(en, 'description')
  const fallbackDescription = typeof manifest.description === 'string' && manifest.description.length > 0
    ? manifest.description
    : undefined
  const description = descriptionZh ?? descriptionEn ?? fallbackDescription
  if (description !== undefined) meta.description = description
  if (descriptionEn !== undefined) meta.descriptionEn = descriptionEn
  else if (fallbackDescription !== undefined) meta.descriptionEn = fallbackDescription
  const iconPath = typeof manifest.icon === 'string' && manifest.icon.length > 0 ? join(dir, manifest.icon) : undefined
  const candidates = iconPath === undefined
    ? Object.keys(ICON_TYPES).map(extension => join(dir, `icon.${extension}`))
    : [iconPath]
  for (const candidate of candidates) {
    const extension = candidate.split('.').pop()?.toLowerCase()
    const type = extension === undefined ? undefined : ICON_TYPES[extension]
    if (type === undefined) continue
    try {
      const bytes = readFileSync(candidate)
      if (bytes.length > MAX_ICON_BYTES) continue
      meta.icon = `data:${type};base64,${bytes.toString('base64')}`
      break
    } catch {
      // No icon file at this candidate: the page falls back to its own placeholder.
    }
  }
  return meta
}

export class SyncSwitches {
  /**
   * @param {object} options
   * @param {string} options.home - `$DSH_HOME`, used when the profile is not known yet.
   * @param {() => string | undefined} options.profileDir - this desktop's profile
   *   directory, where its manifest and installed packages live.
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    this.home = options.home
    this.profileDir = options.profileDir
    this.log = options.log ?? (() => {})
    /** @type {Record<string, { sync: boolean }>} */
    this.overrides = this.#read()
  }

  /**
   * Where the decisions live.
   *
   * Inside the profile, not `$DSH_HOME`: the switches describe *this* composition, and two
   * profiles under one home (`desktop`, `rnhtest`) have different plugin sets. Storing it
   * under the home would make one profile's choice govern the other's nodes.
   */
  get path() {
    const dir = this.profileDir()
    return typeof dir === 'string' && dir.length > 0
      ? join(dir, 'rnh-plugins.json')
      : join(this.home, 'rnh', 'plugins.json')
  }

  #read() {
    try {
      return parseSwitches(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch {
      // A missing or unreadable file means "no opinions yet", which is exactly the state
      // a fresh install is in. It is not an error to report.
      return {}
    }
  }

  #write() {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, `${JSON.stringify(this.overrides, undefined, 2)}\n`, 'utf8')
    } catch (error) {
      this.log(`rnh: could not save the plugin switches: ${error.message}`)
    }
  }

  /** This desktop's profile directory, if the Host knows it yet. */
  #dir() {
    const dir = this.profileDir()
    return typeof dir === 'string' && dir.length > 0 && existsSync(dir) ? dir : undefined
  }

  /** The manifest that says what this desktop installed and loads. */
  manifest() {
    const dir = this.#dir()
    if (dir === undefined) return undefined
    try {
      return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      return undefined
    }
  }

  /** The third-party plugins this desktop installed, in profile order. */
  plugins() {
    const dir = this.#dir()
    if (dir === undefined) return []
    const nodeModules = join(dir, 'node_modules')
    return installedPlugins(this.manifest(), name => rowsOfBundle(nodeModules, name))
      .map(plugin => ({ ...plugin, meta: metaOfBundle(nodeModules, plugin.bundle) }))
  }

  /** Every plugin with its effective switch and where that answer came from. */
  list() {
    return resolvePlugins(this.plugins(), this.overrides)
  }

  /**
   * Record one decision.
   *
   * Setting a switch back to its default removes the override instead of storing the same
   * value twice — that keeps the file meaning "what I changed", so an upgrade that flips a
   * default still reaches the user who never touched it. The default is now **on**, so the
   * value worth storing is the `false`.
   * @param {string} bundle
   * @param {boolean} sync
   */
  set(bundle, sync) {
    if (!this.plugins().some(plugin => plugin.bundle === bundle)) {
      throw Object.assign(
        new Error(`${bundle} is not a plugin this desktop installed`),
        { code: 'plugin-not-found' },
      )
    }
    if (sync === true) delete this.overrides[bundle]
    else this.overrides[bundle] = { sync }
    this.#write()
    return this.list().find(row => row.bundle === bundle)
  }

  /** The node's full bundle list: this desktop's choice plus the brain by construction. */
  nodeBundles(base = NODE_BASE_BUNDLES) {
    return nodeBundles(base, this.list())
  }

  /**
   * The install spec for one plugin, as this desktop's manifest recorded it.
   *
   * Reusing the desktop's own spec is what keeps both sides on the same release: a
   * `^0.3.8` here means a node gets a compatible 0.3.x rather than whatever `latest` is
   * by the time the switch is flipped.
   * @param {string} bundle
   * @returns {string | undefined}
   */
  specOf(bundle) {
    const dependencies = this.manifest()?.dependencies
    const spec = dependencies === null || typeof dependencies !== 'object' ? undefined : dependencies[bundle]
    return typeof spec === 'string' && spec.length > 0 ? spec : undefined
  }

  /**
   * Whether this plugin is a directory on this machine rather than something npm has.
   *
   * The rule lives in `core/plugin-sync.js` with the other decisions about what a switch
   * means; this only supplies the spec. Getting it wrong is expensive in a specific way:
   * a local bundle treated as published makes the node run `npm install @local/x`, which
   * is a guaranteed 404.
   * @param {string} bundle
   * @returns {boolean}
   */
  isLocal(bundle) {
    return isLocalSpec(this.specOf(bundle))
  }

  /**
   * Every file of a locally built plugin, as relative path → base64.
   *
   * `node_modules` is skipped: a local bundle's own dependencies are the node's problem
   * (they install from the registry there), and shipping them would mean sending a tree
   * that npm would immediately re-resolve anyway.
   * @param {string} bundle
   * @returns {Record<string, string>}
   */
  localFiles(bundle) {
    const dir = this.#dir()
    if (dir === undefined) return {}
    const root = join(dir, 'node_modules', bundle)
    /** @type {Record<string, string>} */
    const files = {}
    const walk = (current, prefix) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        const absolute = join(current, entry.name)
        const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) { walk(absolute, relative); continue }
        if (!entry.isFile()) continue
        files[relative] = readFileSync(absolute).toString('base64')
      }
    }
    try {
      walk(root, '')
    } catch (error) {
      this.log(`rnh: could not read ${bundle} from ${root}: ${error.message}`)
      return {}
    }
    return files
  }

  /**
   * The plugins a node should be given, and the ones its switch asks to remove.
   * @returns {{ install: Array<{ bundle: string, spec?: string }>, enabled: string[] }}
   */
  wanted() {
    const rows = this.list().filter(row => row.sync === true)
    return {
      install: rows.map(row => (row.spec.length > 0 ? { bundle: row.bundle, spec: row.spec } : { bundle: row.bundle })),
      enabled: rows.map(row => row.bundle),
    }
  }
}
