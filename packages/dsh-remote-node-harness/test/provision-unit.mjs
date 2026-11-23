/**
 * Provisioning: what the Host gives a node so its first prompt works.
 *
 * A node is a separate DSH installation. It boots fine, answers `session/list`,
 * and then fails the first prompt because it has no provider route and no API key
 * of its own. That looks like a routing bug from the desktop, so it has to be
 * closed here rather than left as a setup step.
 *
 * The three pieces are unit-tested in isolation because each one is easy to get
 * subtly wrong and invisible when wrong:
 *
 *   - the row picker must copy provider routes but NOT account-backed routes;
 *   - the credential refs come from `apiKeyEnv`, not from a guessed name;
 *   - the YAML emitter must round-trip through a real parser, since a mis-quoted
 *     scalar turns a model list into a string and the node boots with no models.
 *
 * Usage: node test/provision-unit.mjs
 */
import { copyableRows, credentialRefsOf, renderBrainPatch } from '../src/host/provision.js'
import * as compiledModule from '../src/host/provision.js'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

/**
 * The YAML parser the round-trip check needs.
 *
 * This plugin deliberately has no YAML dependency — it must run inside the bundled
 * runtime — so the test borrows the copy the DSH installation already ships. That
 * copy lives inside `app.asar`, which only the Electron-patched `node:fs` can read:
 * under plain Node the import fails and the round-trip checks are skipped rather
 * than failing for an unrelated reason. Run this test with the harness's own Node
 * to get the full check.
 */
async function loadYaml() {
  const attempts = []
  const installDir = process.env.DSH_INSTALL_DIR
  if (typeof installDir === 'string' && installDir.length > 0) {
    // `DSH_INSTALL_DIR` points at .../@deepseek-ai/dsh; the hoisted module is two
    // levels up, beside the `@deepseek-ai` scope directory.
    attempts.push(join(installDir, '..', '..', 'yaml', 'dist', 'index.js'))
    attempts.push(join(installDir, '..', '..', 'yaml', 'index.js'))
  }
  for (const candidate of attempts) {
    try {
      const mod = await import(pathToFileURL(candidate).href)
      const parsed = mod.default ?? mod
      if (typeof parsed?.parse === 'function') return parsed
    } catch {
      // Try the next candidate.
    }
  }
  try {
    const mod = await import('yaml')
    const parsed = mod.default ?? mod
    if (typeof parsed?.parse === 'function') return parsed
  } catch {
    // No parser anywhere.
  }
  return undefined
}
const YAML = await loadYaml()

const log = message => process.stderr.write(`[provision-unit] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

// ---- 1. the row picker keeps provider routes, drops account routes ---------
const rows = copyableRows({
  configuration: () => [
    {
      entry: { options: { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key' } },
      inherited: { baseURL: 'https://llm.example.test/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' },
      override: {
        models: [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', maxTokens: 256000 }],
      },
    },
    {
      entry: { options: { id: 'llm-deepseek-account', name: '@deepseek-ai/dsh-llm-deepseek-account' } },
      inherited: { accountEnv: 'DEEPSEEK_ACCOUNT' },
      override: {},
    },
    {
      entry: { options: { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model' } },
      inherited: { provider: 'deepseek-official', model: 'deepseek-v4.1-flash' },
      override: { reasoningEffort: 'high' },
    },
    {
      entry: { options: { id: 'permission', name: '@deepseek-ai/dsh-permission-presets' } },
      inherited: {},
      override: { defaultPreset: 'danger-full-access' },
    },
    {
      entry: { options: { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' } },
      inherited: { transcriptView: 'standard' },
      override: {},
    },
  ],
})
const ids = rows.map(row => row.id)
check(ids.includes('llm-deepseek'), 'a provider route is copied')
check(!ids.includes('llm-deepseek-account'), 'an account-backed route is NOT copied',
  ids.join(','))
check(ids.includes('agent-default-model'), 'the default model is copied')
check(ids.includes('permission'), 'the permission preset is copied')
check(!ids.includes('ui-chat'), 'a browser row is not copied')

const deepseek = rows.find(row => row.id === 'llm-deepseek')
check(deepseek?.config.baseURL === 'https://llm.example.test/v1',
  'inherited config is merged in', deepseek?.config.baseURL)
check(Array.isArray(deepseek?.config.models) && deepseek.config.models.length === 1,
  'this profile’s override wins over the layer below',
  JSON.stringify(deepseek?.config.models)?.slice(0, 60))

// ---- 2. credential refs come from apiKeyEnv --------------------------------
check(credentialRefsOf(rows).includes('DEEPSEEK_API_KEY'),
  'the API key ref is taken from apiKeyEnv', credentialRefsOf(rows).join(','))
check(!credentialRefsOf(rows).includes('DEEPSEEK_ACCOUNT'),
  'an account route contributes no key ref')
const nested = credentialRefsOf([{ name: 'x', config: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } } }])
check(nested.includes('OPENAI_API_KEY'), 'a nested provider’s apiKeyEnv is found too', nested.join(','))

// The adapter's own default matters: a row composed WITHOUT an explicit
// `apiKeyEnv` (the shipped default) still names a key, and missing it would
// provision a node whose provider loads but cannot authenticate.
const noExplicitRef = credentialRefsOf([{
  name: '@deepseek-ai/dsh-llm-deepseek-api-key',
  config: { baseURL: 'https://llm.example.test/v1' },
}])
check(noExplicitRef.includes('DEEPSEEK_API_KEY'),
  'an adapter’s default key ref is inferred when the row omits it', noExplicitRef.join(','))
const oddRef = credentialRefsOf([{
  name: '@deepseek-ai/dsh-llm-something',
  config: { apiKeyEnv: 'custom_key_name' },
}])
check(oddRef.includes('custom_key_name'), 'an unusual explicit ref is still honoured', oddRef.join(','))

// ---- 2b. the search gap: a capability's credential, versus what gets pushed ---
// `web_search` is mounted by every preset (`tool-web`) and authenticates with
// `DEEPSEEK_API_KEY`. The refs pushed are derived from the rows this desktop *copies*, so a
// desktop whose model provider is not DeepSeek pushes nothing — and the node then advertises a
// tool whose every call answers "no credential". That is the office defect's shape one
// capability over: a declaration and a runtime dependency that nothing compared.
//
// The declaration now lives in `capabilities.mjs` (`web.credentials`), which is what makes this
// assertable at all: the two sides are (a) what a capability says it needs, (b) what the
// whitelist can derive. Measured before: (b) was `[]` for that desktop and nothing noticed.
{
  const capabilities = await import(new URL('../../rnh-brain/capabilities.mjs', import.meta.url).href)
  const declared = capabilities.credentialRefsOfCapabilities()
  check(declared.includes('DEEPSEEK_API_KEY'),
    'a capability declares the search credential', declared.join(','))

  const nonDeepSeek = {
    configuration: () => [
      {
        entry: { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } },
        inherited: {},
        override: { baseURL: 'https://other.example.test/v1' },
      },
      {
        entry: { options: { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model' } },
        inherited: {},
        override: { model: 'm' },
      },
    ],
  }
  const pushed = credentialRefsOf(copyableRows(nonDeepSeek))
  check(!pushed.includes('DEEPSEEK_API_KEY'),
    'a desktop on another provider pushes no DeepSeek key — the case that used to fail silently',
    pushed.join(',') || '(none)')
  const unmet = capabilities.unmetCredentialRequirements(pushed)
  check(unmet.some(gap => gap.capability === 'web' && gap.missing.includes('DEEPSEEK_API_KEY')),
    'and the gap is reportable from the declaration alone, not inferred from a row list',
    JSON.stringify(unmet))
  check(capabilities.unmetCredentialRequirements(['DEEPSEEK_API_KEY']).length === 0,
    'while the DeepSeek desktop this project runs satisfies it')
}

// ---- 3. the overlay carries configuration, never composition --------------
// The bundle list is owned by @local/rnh-brain. If this overlay also tried to
// switch browser rows off, there would be two writers for "which plugins run on a
// node" — and a `disabled: true` naming a row that the composition never inserts is
// dead weight that hides the real signal (a UI row appearing means the composition
// is wrong, not that it needs switching off).
check(!("clientOnlyIds" in compiledModule),
  'provision exports no browser-row disable helper',
  'that concern belongs to the brain composition')

// ---- 4. the overlay is real YAML the node can boot from -------------------
const plan = {
  rows,
  version: '0.2.2-rc.3',
}
const text = renderBrainPatch(plan)
check(text.includes('Managed by @greatbaby/dsh-remote-node-harness'), 'the overlay says who owns it')
check(text.includes('0.2.2-rc.3'), 'and which version it targets')
check(!/disabled: true/u.test(text),
  'with no per-plugin switches set, nothing is disabled')

// The plugin set is NOT in this file any more. It lives in the node's profile bundle
// list, and a `disabled: true` row here was the old second way to say the same thing —
// two answers to "which plugins does this node load" is how a node ends up composing
// something nobody chose. The check guards against that second path coming back.
check(!('syncBlock' in plan), 'the overlay takes no per-plugin block')
check(!/disabled:/u.test(renderBrainPatch({ ...plan, syncBlock: '- id: bash' })),
  'and a leftover per-plugin block is not written into the node patch')

// An empty roster must still be a YAML **array**. A header-only file parses to `null`, and the
// resident host refuses to boot with "must be a top-level YAML array of loader patch entries" —
// measured on the real node: one sync with no copyable rows left exactly such a file, and every
// later start failed, including the `ensureServing` that same sync went on to report as fine.
const emptyOverlay = renderBrainPatch({ rows: [], version: '0.2.2-rc.3' })
check(emptyOverlay.trimEnd().endsWith('[]'),
  'an overlay with no rows still writes a top-level array', JSON.stringify(emptyOverlay.slice(-40)))
if (YAML !== undefined) {
  // `parse`, not `load`: the parser this test borrows is the `yaml` package, whose entry point
  // exposes `parse`/`stringify`. `YAML.load` only exists on the older `js-yaml` shape, and
  // calling it threw a TypeError instead of running the check — the one assertion that proves an
  // empty roster still boots the node was the one not running.
  check(Array.isArray(YAML.parse(emptyOverlay)),
    'and it parses to an array, not null', JSON.stringify(YAML.parse(emptyOverlay)))
}

if (YAML === undefined) {
  log('note: no YAML parser available; skipping the round-trip checks')
} else {
  let parsed
  try {
    parsed = YAML.parse(text)
  } catch (error) {
    check(false, 'the overlay parses as YAML', error.message)
  }
  if (parsed !== undefined) {
    check(Array.isArray(parsed), 'the overlay is a patch list')
    check(parsed.length === rows.length,
      'every plan row became exactly one patch', `${String(parsed.length)} patches`)
    const provider = parsed.find(patch => patch.id === 'llm-deepseek')
    check(provider?.config?.baseURL === 'https://llm.example.test/v1',
      'the provider URL survives the round trip', provider?.config?.baseURL)
    check(Array.isArray(provider?.config?.models) && provider.config.models[0]?.maxTokens === 256000,
      'the model list stays a list of objects, not a string',
      JSON.stringify(provider?.config?.models)?.[0]?.maxTokens)
    check(provider?.config?.apiKeyEnv === 'DEEPSEEK_API_KEY',
      'the key ref is a plain string')
    const permission = parsed.find(patch => patch.id === 'permission')
    check(permission?.config?.defaultPreset === 'danger-full-access', 'the preset survives')
    // A row the overlay enables must not lose a field to quoting.
    const model = provider?.config?.models?.[0]
    check(model?.id === 'deepseek-v4.1-flash' && model?.name === 'deepseek-v4.1-flash',
      'model identity strings are unquoted-but-exact',
      `${String(model?.id)} / ${String(model?.name)}`)
  }

  // ---- 5. awkward scalars are quoted rather than silently coerced ---------
  const tricky = renderBrainPatch({
    rows: [{
      id: 'llm-tricky',
      config: {
        yes: 'true',
        num: '123',
        colon: 'a: b',
        hash: 'a #comment',
        empty: '',
        realBool: true,
        realNum: 42,
        path: '/root/x',
      },
    }],
    version: 'x',
  })
  const trickyParsed = YAML.parse(tricky)
  const config = trickyParsed[0].config
  check(config.yes === 'true', 'the string "true" stays a string', typeof config.yes)
  check(config.num === '123', 'the string "123" stays a string', typeof config.num)
  check(config.colon === 'a: b', 'a colon is quoted', config.colon)
  check(config.hash === 'a #comment', 'a hash is quoted', config.hash)
  check(config.empty === '', 'an empty string survives', JSON.stringify(config.empty))
  check(config.realBool === true && config.realNum === 42, 'real booleans and numbers stay native')
  check(config.path === '/root/x', 'a plain path is left readable', config.path)
}

if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
  process.exitCode = 0
}
