/**
 * Embed this bundle's files into the plugin, so a node can be provisioned
 * without the plugin having to find this package on disk at runtime.
 *
 * ## Why embed instead of copying from a path
 *
 * The rnh plugin runs from inside DSH's own installation (in the desktop build,
 * from `app.asar`). It cannot assume this package sits next to it on the same disk —
 * that is true in this workspace and false everywhere else. So the composition is
 * *generated into* the plugin as a plain module of string constants: one source of
 * truth (`cordis.patch.yml` + `presets/` + `src/runtime.js`), one generated
 * consumer, and no runtime path assumption.
 *
 * Run this after `sync-from-upstream.mjs`:
 *
 * ```bash
 * node scripts/sync-from-upstream.mjs && node scripts/embed-into-rnh.mjs
 * ```
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RNH = resolve(PKG, '..', 'dsh-remote-node-harness')
const OUT = join(RNH, 'src', 'host', 'brain-bundle.generated.js')

/** Files that travel to a node, as package-relative paths. */
const FILES = [
  'package.json',
  'cordis.patch.yml',
  ...readdirSync(join(PKG, 'presets')).filter(name => name.endsWith('.yml')).map(name => `presets/${name}`),
  'src/runtime.js',
]

/**
 * Render one file as a template literal.
 *
 * Backslashes and backticks are the only characters a JS template literal cannot
 * carry verbatim; `${` is escaped too, and the patch contains no such sequence today
 * but a future upstream comment might.
 */
function literal(text) {
  return `\`${text.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${')}\``
}

const entries = FILES.map(path => `  ${JSON.stringify(path)}: ${literal(readFileSync(join(PKG, path), 'utf8'))},`)

// **The capability roster travels too, derived rather than restated.** The host needs a few
// facts from `capabilities.mjs` — today only which credential refs the composed capabilities
// cannot work without — and it cannot import that module: the plugin runs from `app.asar` with
// no `rnh-brain` package beside it, which is why this whole file exists. Emitting the derived
// values here keeps one source of truth (`capabilities.mjs`) and one generated consumer,
// instead of a second hand-written list in the plugin that would drift exactly like the old
// `RETAINED` did.
const capabilityFacts = await import(new URL('../capabilities.mjs', import.meta.url).href)
const credentialRefs = capabilityFacts.credentialRefsOfCapabilities()
const embeddedCredentials = credentialRefs.map(ref => `  ${JSON.stringify(ref)},`).join('\n')
// The third-party configuration registry travels the same way, for the same reason: the Host
// has to know which files a composed bundle reads, and it cannot ask `capabilities.mjs` at
// runtime. Emitted as one JSON literal so it reads as data rather than as code.
const thirdPartyConfigs = capabilityFacts.declaredConfigFiles()
const embeddedThirdParty = JSON.stringify(thirdPartyConfigs, undefined, 2)
  .split('\n')
  .map((line, index) => (index === 0 ? line : `  ${line}`))
  .join('\n')

const source = `/**
 * The node-side brain composition, embedded.
 *
 * GENERATED — do not edit. Source of truth:
 *   packages/rnh-brain/{cordis.patch.yml, presets/*.yml, src/runtime.js, package.json,
 *   capabilities.mjs}
 * Regenerate:
 *   cd packages/rnh-brain
 *   node scripts/sync-from-upstream.mjs && node scripts/embed-into-rnh.mjs
 *
 * Embedded sources (${String(FILES.length)}):
${FILES.map(path => ` *   ${path}`).join('\n')}
 *
 * The capability facts below are **derived** from \`capabilities.mjs\` at generation time, not
 * restated: the plugin cannot import that module at runtime (it ships inside the app), and a
 * second hand-written copy in the plugin is the drift this whole rewrite removed.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/brain-bundle.generated
 */

/** Package name the node profile lists in \`dsh.profile.bundles\`. */
export const BRAIN_PACKAGE = '@local/rnh-brain'

/**
 * Credential refs a composed capability cannot work without.
 *
 * Checked against what provisioning actually pushed at connect time (\`rnh.js\`) and against
 * what the provisioning whitelist can derive (\`check-capabilities\`). Today this is
 * \`DEEPSEEK_API_KEY\`, required by \`web_search\`: \`tool-web\` is mounted by every preset, and a
 * desktop whose model provider is not DeepSeek pushes no key at all.
 */
export const BRAIN_CREDENTIAL_REFS = Object.freeze([
${embeddedCredentials}
])

/**
 * Files a composed third-party bundle reads from the node's \`$HOME\`, and which of their keys
 * may travel.
 *
 * Derived from \`THIRD_PARTY_BUNDLES\` in \`capabilities.mjs\` at generation time, for the same
 * reason as the credential list above: the plugin cannot import that module at runtime. The
 * whitelist is load-bearing rather than tidy — the desktop's own config file can hold several
 * servers' credentials, and only the keys named here are written to another machine.
 */
export const BRAIN_THIRD_PARTY_CONFIG = Object.freeze(${embeddedThirdParty})

/** Package-relative path → file contents, for everything a node needs. */
export const BRAIN_FILES = Object.freeze({
${entries.join('\n')}
})
`

writeFileSync(OUT, source, 'utf8')
process.stdout.write(
  `[embed-into-rnh] embedded ${String(FILES.length)} files `
  + `(${String(source.length)} bytes) into ${OUT.replace(RNH, 'packages/dsh-remote-node-harness')}\n`,
)
