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
 *   3. each registered component renders without throwing,
 *   4. a failed node's card really renders the step it died in (E5), a node with a
 *      leftover `error` but no failure does not render a red failure block (E5b), and
 *      the two dictionaries a browser can choose between have the same keys.
 *
 * Sections 1–2 talk to a running Host and are therefore skipped when the arguments are
 * absent; everything from section 3 on executes the *local* source, so `node
 * test/client-bundle.mjs` on its own is a real (partial) check rather than a no-op. The
 * skip is printed as SKIP and the closing line says it was not a full pass.
 *
 * Usage: node test/client-bundle.mjs [<hostBase> <launchToken>]
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const [base, token] = process.argv.slice(2)
const online = base !== undefined && token !== undefined

const PLUGIN_ID = '@greatbaby/dsh-remote-node-harness/client.js'
const log = message => process.stderr.write(`[client-bundle] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const sourcePath = fileURLToPath(new URL('../src/client/client.js', import.meta.url))
const source = readFileSync(sourcePath, 'utf8')

// ---- 1. the shell serves the bundle --------------------------------------
// Only meaningful against a Host. Everything below this block reads the local file, which is
// the same text the Host would serve (checked verbatim in section 2 when it runs).
if (online) {
  const { authenticate, clientBundleFor, get } = await import('./carrier.mjs')
  const cookie = await authenticate(base, token)
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
  check(bundle.text.includes(source), 'the served bundle contains this plugin’s source verbatim',
    `${String(source.length)} characters`)
  check(bundle.text.includes(`id: '@greatbaby/dsh-remote-node-harness'`), 'the module declares its plugin id')
} else {
  log('SKIP the served-bundle checks (1–2): no <hostBase> <launchToken> given')
}

// ---- 3. execute that module in a stub loader ----------------------------
const registered = []
let factory

/**
 * A tiny React stand-in **with state**.
 *
 * The first version returned `[initial, () => {}]` from `useState` and ran no effects: enough
 * to prove a component renders once, useless for asserting what it renders *after* the first
 * poll answers. The two defects this file now covers — a failed node losing its phase
 * timeline, and a stale red block on a node that is merely idle — only exist in the settled
 * render. So hooks live in per-component slots keyed by the path the walk reached them by,
 * effects actually run, and `mount()` re-renders until nothing is dirty.
 */
const hookStore = new Map()
let currentHooks = []
let hookIndex = 0
let dirty = false
let pendingEffects = []
const sameDeps = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))

function enterHooks(key) {
  let hooks = hookStore.get(key)
  if (hooks === undefined) {
    hooks = []
    hookStore.set(key, hooks)
  }
  const previous = { hooks: currentHooks, index: hookIndex }
  currentHooks = hooks
  hookIndex = 0
  return previous
}
function leaveHooks(previous) {
  currentHooks = previous.hooks
  hookIndex = previous.index
}
function hookSlot() {
  const index = hookIndex++
  if (currentHooks[index] === undefined) currentHooks[index] = {}
  return currentHooks[index]
}

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const slot = hookSlot()
    if (!('value' in slot)) slot.value = typeof initial === 'function' ? initial() : initial
    return [slot.value, next => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (!Object.is(value, slot.value)) {
        slot.value = value
        dirty = true
      }
    }]
  },
  useCallback(fn, deps) {
    const slot = hookSlot()
    if (slot.deps === undefined || !sameDeps(slot.deps, deps)) {
      slot.value = fn
      slot.deps = deps
    }
    return slot.value
  },
  useMemo(fn, deps) {
    const slot = hookSlot()
    if (slot.deps === undefined || !sameDeps(slot.deps, deps)) {
      slot.value = fn()
      slot.deps = deps
    }
    return slot.value
  },
  useEffect(fn, deps) {
    const slot = hookSlot()
    if (slot.deps === undefined || !sameDeps(slot.deps, deps)) {
      slot.deps = deps
      pendingEffects.push(fn)
    }
  },
  useRef(value) {
    const slot = hookSlot()
    if (slot.value === undefined) slot.value = { current: value }
    return slot.value
  },
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

// ---- 4. apply() registers its slots -------------------------------------
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

// ---- 5. render each component ------------------------------------------
// Rendering reaches the plugin API, which needs the browser cookie; supply a
// `fetch` that decides by URL so a missing endpoint surfaces as an error.
//
// What the Host would answer is a variable, not a constant: the failure-state checks below
// need the same page rendered against a failed node and against an idle node carrying a
// stale sentence, so the fixtures live in one table and `servedNodes` is what `fetch` reads.
const BASE_NODE = {
  id: 'n0123456789ab',
  name: 'test node',
  host: '127.0.0.1',
  port: 22,
  username: 'root',
  authKind: 'password',
  credentialsReady: true,
  enabled: true,
}
const NODE_FIXTURES = {
  connected: { ...BASE_NODE, state: 'connected' },
  // E5: the Host keeps `phase`/`phaseStartedAt` on a failure on purpose. `inspect-log` is the
  // action that has no button, so this fixture also covers the explanation line.
  failed: {
    ...BASE_NODE,
    state: 'failed',
    phase: 'install',
    phaseStartedAt: Date.now() - 4000,
    error: 'the node runtime could not be installed',
    failure: { code: 'runtime-install', message: 'x', action: 'inspect-log', retryable: true, detail: 'boom' },
  },
  // The same failure with an action that does have a control, to prove the explanation line is
  // the three explained actions rather than every failure.
  failedRetry: {
    ...BASE_NODE,
    state: 'failed',
    phase: 'install',
    phaseStartedAt: Date.now() - 4000,
    error: 'the node runtime could not be installed',
    failure: { code: 'runtime-install', message: 'x', action: 'retry', retryable: true, detail: 'boom' },
  },
  // The `connecting` case the timeline was originally written for: it must not regress.
  connecting: {
    ...BASE_NODE,
    state: 'connecting',
    phase: 'install',
    phaseStartedAt: Date.now() - 4000,
    transfer: { bytes: 1_048_576, total: 4_194_304, bytesPerSecond: 524_288, etaMs: 6000 },
  },
  // E5b: a sentence left behind by an attempt that is over. The Host no longer produces this
  // pair, but a snapshot from an older Host can, and it must not paint a red failure block.
  idleStaleError: {
    ...BASE_NODE,
    state: 'idle',
    error: 'leftover sentence',
    failure: { code: 'ssh-auth', message: 'x', action: 'fix-credential', retryable: false, detail: 'x' },
  },
}
let servedNodes = [NODE_FIXTURES.connected]

globalThis.fetch = async url => {
  const path = String(url)
  if (path.includes('/workspaces')) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, baseline: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }),
    }
  }
  if (path.includes('/log')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, text: '' }) }
  }
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, version: '0.2.2-rc.3', nodes: servedNodes }),
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
    const previous = enterHooks(`${String(depth)}<${node.type.name}>`)
    try {
      render(node.type({ ...node.props, children: node.children }), depth + 1)
    } finally {
      leaveHooks(previous)
    }
    return
  }
  for (const child of node.children ?? []) render(child, depth + 1)
}

/**
 * Render one component to a settled tree.
 *
 * "Settled" is what the assertions need: the page's only data source is a two-second poll
 * started by an effect, so a single pass renders the empty state. Each pass re-runs the
 * component from its stored hooks, runs the effects it queued, lets the awaited `fetch`
 * resolve, and stops when no state changed. Returns the text fragments and, for every host
 * element, the text it owns directly plus its style — the phase row's colour is half of what
 * E5 is about, so the tree has to be readable, not just countable.
 */
async function settle(component, props = {}) {
  let last
  for (let pass = 0; pass < 10; pass += 1) {
    dirty = false
    pendingEffects = []
    const text = []
    const elements = []
    const walk = (node, depth, path) => {
      if (depth > 40) return
      if (node === null || node === undefined || typeof node === 'boolean') return
      if (typeof node === 'string' || typeof node === 'number') {
        text.push(String(node))
        return
      }
      if (Array.isArray(node)) {
        node.forEach((child, index) => walk(child, depth + 1, `${path}[${String(index)}]`))
        return
      }
      if (typeof node.type === 'function') {
        const previous = enterHooks(`${path}<${node.type.name}>`)
        let rendered
        try {
          rendered = node.type({ ...node.props, children: node.children })
        } finally {
          leaveHooks(previous)
        }
        walk(rendered, depth + 1, `${path}/`)
        return
      }
      elements.push({
        style: node.props?.style,
        own: (node.children ?? []).filter(child => typeof child === 'string').join(''),
      })
      for (const child of node.children ?? []) walk(child, depth + 1, path)
    }
    walk(React.createElement(component, props), 0, 'r')
    for (const effect of pendingEffects) effect()
    await new Promise(resolve => setTimeout(resolve, 25))
    last = { text, elements }
    if (!dirty && pass > 1) return last
  }
  return last
}

// The directory-flow slots are dialogs: mounted with `open: false` they render nothing,
// which would prove nothing. Opening them exercises the form page — the device control and
// the source-folder card — and that is where a broken JSX shape or a missing caption
// surfaces. Later pages are reached by state, and a single pass does not advance it, so
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
pendingEffects = []

// ---- 6. the device step exists in the shipped text -----------------------
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

// ---- 7. every failure action leads somewhere ------------------------------
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

// ---- 8. the two dictionaries are key-for-key equal ------------------------
// `T` is chosen once from `navigator.language`, so a key added to one branch and not the
// other renders as `undefined` for half the users — silently, because a missing function
// only throws when it is called, and a missing string renders as nothing at all.
//
// This used to spot-check ten keys for "appears twice", which is exactly how
// `pluginOnHint`/`pluginOffHint` stayed missing from English: they were in the Chinese
// branch only, and the two strings that used them rendered as an empty `title`. Comparing
// the two key *sets* cannot miss a key, whatever it is called.
//
// Every parse below runs against a LF copy: the file is CRLF in the working tree, and a
// pattern anchored on `\n` silently matches the wrong line without that.
const flat = source.replaceAll('\r\n', '\n')
const tStart = flat.indexOf('const T = zh')
const zhBodyStart = flat.indexOf('? {', tStart) + 3
const zhBoundary = flat.indexOf('\n        }\n      : {', zhBodyStart)
const enBodyStart = zhBoundary + '\n        }\n      : {'.length
const enBodyEnd = flat.indexOf('\n        }\n', enBodyStart)
check(tStart > 0 && zhBoundary > zhBodyStart && enBodyEnd > enBodyStart,
  'the two dictionaries can be located in the source',
  `T@${String(tStart)} zh@{${String(zhBodyStart)}..${String(zhBoundary)}}`
  + ` en@{${String(enBodyStart)}..${String(enBodyEnd)}}`)
const topLevelKeys = body => [...body.matchAll(/^ {10}(?:'([^']+)'|([A-Za-z_$][\w$]*)):/gmu)]
  .map(match => match[1] ?? match[2])
const zhKeys = topLevelKeys(flat.slice(zhBodyStart, zhBoundary))
const enKeys = topLevelKeys(flat.slice(enBodyStart, enBodyEnd))
const zhOnly = zhKeys.filter(key => !enKeys.includes(key))
const enOnly = enKeys.filter(key => !zhKeys.includes(key))
check(zhKeys.length > 100 && zhKeys.length === enKeys.length && zhOnly.length === 0 && enOnly.length === 0,
  'both languages define the same set of copy keys',
  `${String(zhKeys.length)} vs ${String(enKeys.length)}; `
  + `zh-only=${zhOnly.join(',') || '-'}; en-only=${enOnly.join(',') || '-'}`)

// ---- 9. a failed node keeps its timeline, an idle one loses the red block --
// Source text can say "the condition no longer requires connecting"; only the rendered tree
// says the timeline is actually there after the poll answers. Both defects are in the
// settled render, so this uses the stateful stand-in above.
const settingsSection = calls.find(call => call.name === 'settings.section')

/** Pull one nested copy block (`phases`, `runtimeVia`, …) out of a dictionary body. */
const blockOf = (body, name) => {
  const start = body.indexOf(`${name}: {`)
  if (start < 0) return ''
  const open = body.indexOf('{', start)
  const end = body.indexOf('\n          }', open)
  return end < 0 ? '' : body.slice(open + 1, end)
}
/** `key: 'value'` pairs in one block, in source order. */
const pairsOf = block => [...block.matchAll(/([A-Za-z]+): '([^']*)'/gu)]
  .map(match => ({ key: match[1], value: match[2] }))

const zhPhases = pairsOf(blockOf(flat.slice(zhBodyStart, zhBoundary), 'phases'))
const enPhases = pairsOf(blockOf(flat.slice(enBodyStart, enBodyEnd), 'phases'))
/** The phase labels this page can print. `build` is the route-specific alias of `install`, so
 *  it is a label the card may show but never a row of its own. */
const PHASE_LABELS = [...zhPhases, ...enPhases].map(pair => pair.value)
const PHASE_ROWS = zhPhases.filter(pair => pair.key !== 'build').length
check(PHASE_ROWS === 5 && enPhases.filter(pair => pair.key !== 'build').length === PHASE_ROWS,
  'the phase labels are readable from both copy tables',
  `zh ${String(zhPhases.length)}, en ${String(enPhases.length)}`)

/** The `errorTitle` values, in both languages. */
const ERROR_TITLES = [zhBodyStart, enBodyStart].map(start =>
  /errorTitle: '([^']+)'/u.exec(flat.slice(start))?.[1]).filter(Boolean)
check(ERROR_TITLES.length === 2, 'the failure headline is readable from the copy tables',
  String(ERROR_TITLES.length))

/** The actions the surface explains instead of offering a button. */
const EXPLAINED_ONLY = (/const EXPLAINED_ACTIONS = Object\.freeze\(\[([^\]]*)\]\)/u.exec(flat)?.[1] ?? '')
  .split(',').map(part => part.trim().replaceAll("'", '')).filter(part => part.length > 0)
check(EXPLAINED_ONLY.length === 3, 'the explained-action list is readable from the source',
  EXPLAINED_ONLY.join(','))

/**
 * Render the settings page against one node and describe what came out.
 *
 * The hook store is cleared first: two fixtures through the same store would keep the
 * previous node's `nodes` state and both renders would describe one page.
 */
async function pageFor(fixture) {
  servedNodes = [fixture]
  hookStore.clear()
  const settled = await settle(settingsSection.registered.component)
  const text = settled.text.join('\u0001')
  const rows = settled.elements
    .filter(element => PHASE_LABELS.includes(element.own))
    .map(element => ({ label: element.own, color: element.style?.color }))
  return {
    text,
    has: needle => text.includes(needle),
    rows,
    currentRow: rows.find(row => row.color !== 'var(--dsw-alias-label-tertiary)'),
  }
}

// E5: `failed` carries `phase`/`phaseStartedAt` because "which step did it die in" is the one
// fact worth keeping. Requiring `connecting` to draw the timeline threw it away.
const failedPage = await pageFor(NODE_FIXTURES.failed)
check(failedPage.rows.length === PHASE_ROWS, 'a failed node still renders its phase timeline',
  `${String(failedPage.rows.length)} of ${String(PHASE_ROWS)} rows`)
check(failedPage.currentRow?.color === 'var(--dsw-alias-label-error)',
  'the step a failed node died in is painted with the error colour',
  `${String(failedPage.currentRow?.label)} → ${String(failedPage.currentRow?.color)}`)
check(failedPage.rows.filter(row => row.color !== 'var(--dsw-alias-label-tertiary)').length === 1,
  'only the step it died in is highlighted, not the whole timeline')
check(failedPage.has('已用') || failedPage.has('elapsed'),
  'a failed node keeps the elapsed clock beside its timeline')
check(failedPage.has('下一步') || failedPage.has('Next step'),
  'the explained action is shown as a next step, not a button')
check(failedPage.has('查看连接日志') || failedPage.has('Connection log'),
  'the explained action names the thing to do outside this surface')

// The `connecting` path the timeline was written for must not have changed: same rows, same
// clock, live transfer numbers, and the current row still in the brand colour.
const connectingPage = await pageFor(NODE_FIXTURES.connecting)
check(connectingPage.rows.length === PHASE_ROWS, 'a connecting node still renders its phase timeline',
  String(connectingPage.rows.length))
check(connectingPage.currentRow?.color === 'var(--dsw-alias-label-primary)',
  'the current step of a connecting node is still painted in the brand colour',
  `${String(connectingPage.currentRow?.label)} → ${String(connectingPage.currentRow?.color)}`)
check(connectingPage.has('MiB'), 'a connecting node still shows transfer progress')

// E5b: an attempt that is over leaves a sentence behind. Painting it red describes a
// connection nobody is making, so the block belongs to `failed` alone.
const idlePage = await pageFor(NODE_FIXTURES.idleStaleError)
check(!ERROR_TITLES.some(title => idlePage.has(title)),
  'a node with a leftover error but no failure does not paint the red block',
  ERROR_TITLES.join('/'))
check(!idlePage.has('leftover sentence'), 'the stale sentence is not rendered at all')
check(idlePage.rows.length === 0, 'an idle node shows no phase timeline')

// The explained-action line is for the three actions without a control: an action that does
// have one must not grow the extra line as well.
const retryPage = await pageFor(NODE_FIXTURES.failedRetry)
check(retryPage.rows.length === PHASE_ROWS, 'a failed node with a retry action keeps its timeline')
check(!retryPage.has('下一步') && !retryPage.has('Next step'),
  'an action with its own button is not also explained as a next step')

// ---- 10. the three copy strings say what the code does ---------------------
// These were wrong about behaviour, not merely clumsy: the runtime `via` is reported by the
// Host and never judged, so a node kept on an older route keeps it until something replaces
// that tree — the old sentence promised a replacement on reconnect that does not happen.
const runtimeNpm = [...source.matchAll(/runtimeVia: \{([\s\S]*?)\n {10}\}/gu)]
  .flatMap(match => [...match[1].matchAll(/npm: '([^']*)'/gu)].map(inner => inner[1]))
check(runtimeNpm.length === 2, 'the runtime-route copy is readable in both languages',
  String(runtimeNpm.length))
check(!runtimeNpm.some(line => /reconnect|重连/u.test(line)),
  'the runtime-route copy no longer promises a reconnect replaces the tree',
  runtimeNpm.join(' | '))
const buildCopy = [...source.matchAll(/build: '([^']*)'/gu)].map(match => match[1])
check(buildCopy.length >= 2, 'the build-phase copy is readable in both languages',
  String(buildCopy.length))
check(!buildCopy.some(line => /正在由节点自行构建|Building the runtime on the node/u.test(line)),
  'the build-phase copy no longer claims the node is building anything',
  buildCopy.join(' | '))
for (const key of ['pluginOnHint', 'pluginOffHint', 'nextStep']) {
  const hits = source.split(`${key}:`).length - 1
  check(hits >= 2, `T.${key} exists in both languages`, `${String(hits)} definition(s)`)
}

// The ladder length is the one constant duplicated into the browser half; it has to match
// the Host's, or "attempt 3/4" would be wrong on the card.
//
// The ladder moved into `host/node-status.js` with the batch-4 state machine (the Host now only
// re-exports the arithmetic). Reading it from `rnh.js` silently found zero rungs and failed the
// comparison, so this points at the module that owns the table.
const statusSource = readFileSync(fileURLToPath(new URL('../src/host/node-status.js', import.meta.url)), 'utf8')
const ladder = /RECOVERY_LADDER_MS = Object\.freeze\(\[([^\]]*)\]\)/u.exec(statusSource)?.[1]
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
