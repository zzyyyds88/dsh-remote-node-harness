/**
 * Which of **your** plugins go to a node.
 *
 * The switch list used to be every row this desktop composes — 207 of them, one per
 * internal service and tool. That is the wrong unit: a person installs *plugins*, not
 * rows, and almost every row belongs to a package a node already has. A page with 207
 * toggles describes the composition; it does not let anyone decide anything.
 *
 * The unit here is the **bundle**: the packages this desktop installed and added to its
 * own `dsh.profile.bundles`. A node can load exactly that list, so one switch means
 * "install and load this plugin there", which is a decision a person can actually make
 * and which this plugin can actually carry out.
 *
 * Upstream bundles are excluded because a node composes them by construction — `dsh-base`
 * is what a brain is built on, and `dsh-web-app` is the surface a brain is a subtraction
 * from. This plugin's own bundle is excluded too: it is how the node becomes a brain, not
 * something to switch off.
 *
 * @module @greatbaby/dsh-remote-node-harness/core/plugin-sync
 */

/** The upstream bundle a node is built on: the half that is not the browser. */
export const NODE_BUNDLE_BASE = '@deepseek-ai/dsh-base'

/** The upstream bundle a node is a **subtraction from**: its rows are what the brain keeps. */
export const NODE_BUNDLE_UPSTREAM_SURFACE = '@deepseek-ai/dsh-web-app'

/**
 * Bundles a node always composes, so they are never a choice.
 *
 * Both names are exported on their own as well, because two callers need one of them each and
 * used to spell it themselves: `rnh.js` assembles the profile's bundle list, and
 * `sync-switches.js` filters a user's switches against it. A literal in those files had already
 * drifted once from this list, and a drifted literal is invisible until a node fails to boot.
 */
export const UPSTREAM_BUNDLES = Object.freeze([NODE_BUNDLE_BASE, NODE_BUNDLE_UPSTREAM_SURFACE])

/** This plugin's node-side bundle: the thing that makes a node a brain. */
export const BRAIN_PACKAGE = '@local/rnh-brain'

/**
 * The bundles a node composes by construction, in compose order.
 *
 * **The one list.** `rnh.js` builds a node's profile from it and re-exports it as
 * `BRAIN_BUNDLES`; `sync-switches.js` filters a user's switches against it. The brain has to
 * come after the base it subtracts from, and it does, in this order.
 */
export const NODE_BASE_BUNDLES = Object.freeze([NODE_BUNDLE_BASE, BRAIN_PACKAGE])

/**
 * This plugin's own package name.
 *
 * The preset it ships holds the node-management tool, so a node must never mount it — and
 * this is also the name a profile lists in `dsh.profile.bundles`. A constant rather than a
 * `package.json` read: the comparison happens against bundle names that came from a profile
 * manifest, and the two have to agree without a filesystem read at module load.
 */
export const RNH_PACKAGE = '@greatbaby/dsh-remote-node-harness'

/**
 * Packages a node must never receive, whichever list they appear on.
 *
 * This is a **hard exclusion**, not a prefix rule: each name answers a different question
 * and inferring them from a namespace would miss the next one DSH adds.
 *
 * - `@greatbaby/dsh-remote-node-harness` is the desktop half. Its preset holds the node-management tool,
 *   so a node that mounted it could manage other nodes — the one shape of control a node
 *   must not have. The two older spellings are listed beside it because they are the same
 *   package: a profile upgraded in place still carries one of them, and "it is the previous
 *   name of me" is not a reason to send it to a node.
 *   - `@local/dsh-fleet` — the name before 0.5.0.
 *   - `@greatbaby/dsh-fleet` — the name between 0.5.0 and 0.6.0.
 * - `@local/rnh-brain` is the node-side subtraction itself, already in the list.
 * - `ds-harness-remote` (and the older `@dsh-remote/plugin`) makes a Host reachable by a
 *   phone relay. A node is reached *through* this desktop; a second relay entry point on a
 *   node is exactly the surface nobody asked for.
 */
export const NODE_NEVER_SYNC = Object.freeze([
  RNH_PACKAGE,
  // The names this package had before the 0.6.0 rename, newest first.
  '@greatbaby/dsh-fleet',
  '@local/dsh-fleet',
  '@local/rnh-brain',
  'ds-harness-remote',
  '@dsh-remote/plugin',
])

/**
 * Whether a bundle has to stay off a node regardless of any switch.
 * @param {string} name
 * @returns {boolean}
 */
export function isNeverSynced(name) {
  return typeof name === 'string' && NODE_NEVER_SYNC.includes(name)
}

/**
 * Whether a bundle is one a person installed rather than part of the product.
 *
 * The prefix rules are deliberate: `@deepseek-ai/*` is upstream, `@local/*` is what this
 * repository builds. Everything else — a scoped third party or a bare npm name — is a
 * plugin the user added, which is exactly the set that should be switchable.
 *
 * `NODE_NEVER_SYNC` is a separate question ("may this reach a node at all") and is applied
 * where the list is built, not here: `isThirdParty` answers "is this part of the product".
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isThirdParty(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (UPSTREAM_BUNDLES.includes(name)) return false
  if (name === BRAIN_PACKAGE) return false
  if (name.startsWith('@deepseek-ai/')) return false
  // This plugin's own two names: the current one, and the one it had before 0.5.0. Any
  // other `@local/*` package is a user's own local bundle.
  if (name === RNH_PACKAGE || name === '@local/dsh-remote-node-harness') return false
  return true
}

/**
 * The plugins this desktop installed, in the order its profile lists them.
 *
 * Both facts come from the **profile manifest**, which is where DSH records them:
 * `dependencies` says what is installed and at what spec, `dsh.profile.bundles` says what
 * is actually loaded. A package in `dependencies` but not in `bundles` is installed and
 * not loaded here; it is reported so the page can show it rather than silently dropping
 * it, and it defaults to off — a node should receive what this desktop loads, not
 * everything it happens to have downloaded.
 *
 * @param {{ dependencies?: Record<string, string>, dsh?: { profile?: { bundles?: unknown } } } | undefined} manifest
 * @param {(name: string) => string[]} rowsOf - row ids one bundle contributes, if known.
 * @returns {Array<{ bundle: string, spec: string, rows: string[], loaded: boolean }>}
 */
export function installedPlugins(manifest, rowsOf = () => []) {
  const dependencies = manifest?.dependencies ?? {}
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter(name => typeof name === 'string')
    : []
  const names = []
  for (const name of bundles) {
    if (isThirdParty(name) && !isNeverSynced(name) && !names.includes(name)) names.push(name)
  }
  // Installed-but-not-loaded goes after, so the list reads "what a node gets" first.
  for (const name of Object.keys(dependencies)) {
    if (isThirdParty(name) && !isNeverSynced(name) && !names.includes(name)) names.push(name)
  }
  return names.map(bundle => ({
    bundle,
    spec: typeof dependencies[bundle] === 'string' ? dependencies[bundle] : '',
    rows: rowsOf(bundle),
    loaded: bundles.includes(bundle),
  }))
}

/**
 * Resolve every plugin's switch, and say where the answer came from.
 *
 * `source` matters in the UI: "you turned this off" and "this is off because a node must
 * never run it" are different facts, and only the first is something to undo.
 *
 * The default is **on**. A switch here means "this plugin also runs on that machine", and
 * a person who installed a plugin on this desktop and connected a node is asking for one
 * working environment, not for a second one that silently differs. `NODE_NEVER_SYNC` is
 * filtered out before this list is built, so "on" can never mean "the desktop half of this
 * plugin" or "a second relay entry point".
 *
 * @param {ReturnType<typeof installedPlugins>} plugins
 * @param {Record<string, { sync: boolean }>} overrides - persisted per-bundle choices.
 * @returns {Array<{ bundle: string, spec: string, rows: string[], loaded: boolean, sync: boolean, source: 'default' | 'explicit', reason: string }>}
 */
export function resolvePlugins(plugins, overrides) {
  return plugins.map(plugin => {
    const explicit = overrides[plugin.bundle]
    if (explicit !== undefined) {
      return {
        ...plugin,
        sync: explicit.sync,
        source: 'explicit',
        reason: explicit.sync ? 'sent by hand' : 'turned off by hand',
      }
    }
    return {
      ...plugin,
      sync: true,
      source: 'default',
      reason: plugin.loaded
        ? 'installed and loaded here; sent unless turned off'
        : 'installed here but not loaded by this desktop',
    }
  })
}

/**
 * The bundle list a node's profile should carry.
 *
 * Order matters to DSH: bundles compose in list order, and this plugin's brain bundle must
 * come last so its patch is applied over upstream's. The third-party plugins sit between
 * the two, because they extend the brain rather than replace it.
 *
 * @param {readonly string[]} base - the bundles a node composes by construction.
 * @param {Array<{ bundle: string, sync: boolean }>} resolved
 * @returns {string[]}
 */
export function nodeBundles(base, resolved) {
  const extra = resolved.filter(row => row.sync === true).map(row => row.bundle)
  const last = base.at(-1)
  const head = last === BRAIN_PACKAGE ? base.slice(0, -1) : [...base]
  return [...head, ...extra, ...(last === BRAIN_PACKAGE ? [BRAIN_PACKAGE] : [])]
}

/**
 * Whether a dependency spec names a directory on this machine rather than a registry
 * entry.
 *
 * Three shapes mean the same thing, all measured:
 *
 * - `link:` — how DSH records a bundle a person wrote;
 * - `file:` or a plain path — npm's own "this is on disk" forms;
 * - **no spec at all** while the package is nonetheless in `node_modules`. A profile can
 *   carry a linked bundle whose `dependencies` entry an earlier tool never wrote (the
 *   `rnhtest` profile did), and treating that as published means running
 *   `npm install @local/x` on a node, which is a guaranteed 404.
 *
 * The consequence matters: a local plugin travels by **copying its files**, not by npm.
 * @param {string | undefined} spec
 * @returns {boolean}
 */
export function isLocalSpec(spec) {
  const text = typeof spec === 'string' ? spec.trim() : ''
  if (text.length === 0) return true
  if (text.startsWith('link:') || text.startsWith('file:') || text.startsWith('.')) return true
  // An absolute POSIX path or a Windows drive path is a directory too.
  return text.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(text)
}

/**
 * Read the saved switches.
 *
 * Only `true`/`false` survive: a corrupt file should mean "no opinions yet" (everything
 * off) rather than a node that receives a package nobody asked for.
 *
 * @param {unknown} value
 * @returns {Record<string, { sync: boolean }>}
 */
export function parseSwitches(value) {
  if (value === null || typeof value !== 'object') return {}
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    const sync = entry !== null && typeof entry === 'object' ? Reflect.get(entry, 'sync') : undefined
    if (typeof sync === 'boolean') out[key] = { sync }
  }
  return out
}
