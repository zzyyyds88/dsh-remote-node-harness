/**
 * Prove the browser half actually loads, registers its slots, and renders.
 *
 * A Host-side pass is not enough: the settings page and the sidebar panel are
 * shipped to the browser as a client bundle, and a plugin whose bundle the shell
 * never includes looks perfectly healthy on the Host side. This test fetches the
 * bundle the shell actually serves, executes it in a stubbed module loader, and
 * checks that:
 *
 *   1. the bundle is served and contains this plugin's client code,
 *   2. `apply()` registers exactly the three slots it claims,
 *   3. each registered component renders without throwing.
 *
 * Usage: node test/client-bundle.mjs <hostBase> <launchToken>
 */
import { authenticate, clientBundleFor, get } from './carrier.mjs'

const [base, token] = process.argv.slice(2)
if (base === undefined || token === undefined) {
  process.stderr.write('usage: node test/client-bundle.mjs <hostBase> <launchToken>\n')
  process.exit(2)
}

const PLUGIN_ID = '@greatbaby/dsh-remote-node-harness/client.js'
const log = message => process.stderr.write(`[client-bundle] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const cookie = await authenticate(base, token)

// ---- 1. the shell serves the bundle --------------------------------------
const bundle = await clientBundleFor(base, cookie, PLUGIN_ID)
check(bundle !== undefined, 'the shell serves a bundle containing this plugin')
if (bundle === undefined) {
  log('FAILED: no bundle lists this plugin')
  process.exit(1)
}
log(`bundle: ${bundle.url.slice(0, 120)}`)
check(bundle.text.includes('远程节点') || bundle.text.includes('Remote nodes'),
  'the bundle carries this plugin’s copy')
check(bundle.text.includes('settings.section'), 'the bundle registers a settings section')

// The index must also name the plugin, otherwise the shell never loads the bundle.
const index = await get(base, cookie, '/')
check(index.text.includes(PLUGIN_ID), 'the Host index names this client plugin')

// ---- 2. the served bundle carries this plugin's source verbatim ----------
// The combo concatenates many plugins into one script, so extracting one balanced
// statement means tokenising JavaScript. Rather than reimplement a parser, compare
// against the file that is the source of truth: if the shipped text contains our
// module word for word, the shell is serving exactly what was written, and the
// local file is what gets executed below.
const { readFileSync } = await import('node:fs')
const { fileURLToPath } = await import('node:url')
const sourcePath = fileURLToPath(new URL('../src/client/client.js', import.meta.url))
const source = readFileSync(sourcePath, 'utf8')
check(bundle.text.includes(source), 'the served bundle contains this plugin’s source verbatim',
  `${String(source.length)} characters`)
check(bundle.text.includes(`id: '@greatbaby/dsh-remote-node-harness'`), 'the module declares its plugin id')

// ---- 3. execute that module in a stub loader ----------------------------
const registered = []
let factory

/** A tiny React stand-in: enough shape to render without a DOM. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  Fragment: Symbol('Fragment'),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useCallback: fn => fn,
  useMemo: fn => fn(),
  useEffect: () => {},
  useRef: value => ({ current: value }),
}

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory: make }) {
      registered.push(id)
      factory = make
    },
  },
}
// Node 22+ exposes `navigator` as a getter-only global; override the property
// descriptor rather than assigning it.
try {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { language: 'zh-CN' },
  })
} catch {
  // A language-neutral default is fine when the global cannot be replaced.
}

let loadError
try {
  // eslint-disable-next-line no-new-func
  new Function(source)()
} catch (error) {
  loadError = error
}
check(loadError === undefined, 'the client module evaluates', loadError?.message?.slice(0, 300))
check(registered.includes('@greatbaby/dsh-remote-node-harness'), 'the module announces this plugin id',
  registered.join(','))

if (typeof factory !== 'function') {
  log(`FAILED: ${failures.join(', ')}`)
  process.exit(1)
}

// ---- 3. apply() registers its slots -------------------------------------
const calls = []
const ctx = {
  slots: {
    inject(name, fn) {
      calls.push({ name, registered: fn() })
    },
    register(registration, component) {
      return { ...registration, component }
    },
  },
}
// The browser half also resolves the shell's own control set through the module table.
// `StateDot` and the icon components are all this test needs from it: the real module is
// in the shell bundle, so a stub that renders a placeholder element is enough to prove
// the plugin asks for the right names.
const primitives = {
  StateDot: () => null,
  Button: () => null,
}
for (const name of [
  'IconChevronLeftOutlineRegular', 'IconChevronRightOutlineRegular',
  'IconChevronsUpDownOutlineRegular', 'IconFolderCloseRegular', 'IconPlusOutlineRegular',
]) primitives[name] = props => ({ type: 'svg', props: props ?? {}, children: [] })

const mod = factory(specifier => {
  if (specifier === 'react') return React
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require: ${specifier}`)
})
check(typeof mod?.apply === 'function', 'the module exports apply()')
mod.apply(ctx)

// The three slots above are this plugin's own surfaces. The three below are the shell's
// folder-picker holes: occupying them is what lets the dialog offer a folder on a node,
// because the shipped pickers browse this machine only.
const FLOW_SLOTS = [
  'sidebar.workspaces.directoryFlow',
  'conversation.hero.workspace.directoryFlow',
  'workspace.picker.directoryFlow',
]
check(calls.length === 3 + FLOW_SLOTS.length, 'apply() registers every slot it claims', String(calls.length))
const names = calls.map(call => call.name)
check(names.includes('settings.section'), 'a settings section is registered')
check(names.includes('sidebar.panellist'), 'a sidebar panel icon is registered')
check(names.includes('main'), 'a main-column page is registered')
for (const slot of FLOW_SLOTS) {
  check(names.includes(slot), `the ${slot} folder picker is replaced`)
}
for (const call of calls) {
  check(typeof call.registered.component === 'function',
    `the ${call.name} slot has a renderable component`)
}

// ---- 4. render each component ------------------------------------------
// Rendering reaches the plugin API, which needs the browser cookie; supply a
// `fetch` that decides by URL so a missing endpoint surfaces as an error.
globalThis.fetch = async url => {
  const path = String(url)
  if (path.includes('/workspaces')) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, baseline: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }),
    }
  }
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      ok: true,
      version: '0.2.2-rc.3',
      nodes: [{
        id: 'n0123456789ab',
        name: 'test node',
        host: '127.0.0.1',
        port: 22,
        username: 'root',
        state: 'connected',
        authKind: 'password',
        credentialsReady: true,
        enabled: true,
      }],
    }),
  }
}

/** Depth-limited render: enough to prove no component throws. */
function render(node, depth = 0) {
  if (depth > 40) return
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) {
    for (const child of node) render(child, depth + 1)
    return
  }
  if (typeof node.type === 'function') {
    render(node.type({ ...node.props, children: node.children }), depth + 1)
    return
  }
  for (const child of node.children ?? []) render(child, depth + 1)
}

// The directory-flow slots are dialogs: mounted with `open: false` they render nothing,
// which would prove nothing. Opening them exercises the form page — the device control and
// the source-folder card — and that is where a broken JSX shape or a missing caption
// surfaces. Later pages are reached by state, and the stub `useState` never advances, so
// the device list itself is covered by the source check further down instead.
for (const call of calls) {
  const props = FLOW_SLOTS.includes(call.name) ? { open: true } : {}
  try {
    render(React.createElement(call.registered.component, props))
    check(true, `the ${call.name} component renders${FLOW_SLOTS.includes(call.name) ? ' while open' : ''}`)
  } catch (error) {
    check(false, `the ${call.name} component renders`, error.message)
  }
}

// ---- 5. the device step exists in the shipped text -----------------------
// The folder flow has to ask "which machine" before "which folder", and the answer for this
// machine is its drive letters while a node's answer is that node's root. Those are the two
// states that cannot be covered by rendering above, so they are checked as shipped copy and
// as the one request that feeds them.
for (const [needle, label] of [
  ["if (page === 'device')", 'the flow has a device page'],
  ["if (page === 'roots')", 'the flow has a per-device entry-point page'],
  ['T.chooseDevice', 'the device page is titled'],
  ['T.drivesHere', 'this device is described by its drives'],
  ['T.nodeRootHint', 'a node is described by its root'],
  ['T.browseAnywhere', 'a device entry-point page can still browse freely'],
]) check(source.includes(needle), label)

// ---- 6. every failure action leads somewhere ------------------------------
// The error bar used to map only `retry` and `reinstall` onto buttons and send the other six
// to the log, which is the same as having no button: a person told "fix the credential" and
// handed a hundred redacted lines has been told nothing. Each action now either acts or is
// deliberately absent, and this is what keeps a new code from silently landing in "no button".
for (const action of [
  'retry', 'reinstall', 'check-network', 'fix-credential', 'review-host-key',
]) check(source.includes(`case '${action}':`), `the ${action} failure action has its own control`)

// The three that stay absent on purpose: they ask the person to do something outside this
// surface (install a newer Node, upgrade the desktop) or to read the log. Naming them here
// documents the decision rather than leaving it as an omission.
for (const action of ['upgrade-node', 'upgrade-desktop', 'inspect-log']) {
  check(!source.includes(`case '${action}':`),
    `the ${action} failure action is an explanation, not a button`)
}

// ---- 7. the new copy exists in both languages ------------------------------
// `T` is chosen once from `navigator.language`, so a key added to one branch and not the
// other renders as `undefined` for half the users — silently, because a missing function
// only throws when it is called.
for (const key of [
  'recoveryAttempt', 'phasesElapsed', 'transfer', 'resetHostKey', 'reprobe',
  'copyError', 'errorCopied', 'reveal', 'hide', 'noFoldersYet',
]) {
  const hits = source.split(`${key}:`).length - 1
  check(hits >= 2, `T.${key} exists in both languages`, `${String(hits)} definition(s)`)
}

// The ladder length is the one constant duplicated into the browser half; it has to match
// the Host's, or "attempt 3/4" would be wrong on the card.
const rnhSource = readFileSync(fileURLToPath(new URL('../src/host/rnh.js', import.meta.url)), 'utf8')
const ladder = /RECOVERY_LADDER_MS = Object\.freeze\(\[([^\]]*)\]\)/u.exec(rnhSource)?.[1]
const hostRungs = (ladder ?? '').split(',').filter(part => part.trim().length > 0).length
const clientRungs = Number(/RECOVERY_LADDER_LENGTH = (\d+)/u.exec(source)?.[1])
check(hostRungs > 0 && hostRungs === clientRungs,
  'the recovery ladder length the card prints matches the Host\'s ladder',
  `host ${String(hostRungs)}, client ${String(clientRungs)}`)

if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
  process.exitCode = 0
}
// Let undici's pooled sockets settle before the process tears down; exiting with
// a live connection pool trips a libuv assertion on Windows.
await new Promise(resolve => setTimeout(resolve, 250))
process.exit(process.exitCode ?? 0)
