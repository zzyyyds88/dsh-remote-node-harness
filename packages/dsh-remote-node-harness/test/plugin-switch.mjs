/**
 * A plugin switch has to land on the node, not just in a settings file.
 *
 * The whole reason this is a separate surface from "install a plugin here" is that a node
 * is another machine: flipping a switch has to install the package there, name it in the
 * node's own profile, and restart its resident host — and the node has to still answer
 * afterwards. A test that only reads back the switch would pass while the node composed
 * nothing, which is the failure this file exists to catch.
 *
 * It runs the whole round trip: on → the package and the bundle list are on the node and
 * `session/list` still answers → off → both are gone and the node still answers. The
 * switch is restored on every exit path, including a crash, because leaving a test plugin
 * enabled on somebody's node is a side effect nobody asked for.
 *
 * Usage: node test/plugin-switch.mjs <hostBase> <launchToken>
 */
import { nodeConfig, nodeExec } from './node.mjs'
import { nodeLayout } from './layout.mjs'
import { authenticate, call, openCarrier } from './carrier.mjs'

const [base, token] = process.argv.slice(2)
if (base === undefined || token === undefined) {
  process.stderr.write('usage: node test/plugin-switch.mjs <hostBase> <launchToken>\n')
  process.exit(2)
}

const log = message => process.stderr.write(`[plugin-switch] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

try {
  nodeConfig()
} catch (error) {
  log(`no node credentials: ${error.message}`)
  process.exit(3)
}

const cookie = await authenticate(base, token)
const get = async path => {
  const response = await fetch(`${base}/rnh/api${path}`, { headers: { cookie } })
  const text = await response.text()
  return { status: response.status, body: text.length === 0 ? {} : JSON.parse(text) }
}
const post = async (path, payload) => {
  const response = await fetch(`${base}/rnh/api${path}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  const text = await response.text()
  return { status: response.status, body: text.length === 0 ? {} : JSON.parse(text) }
}

const waitForConnected = async id => {
  const deadline = Date.now() + 240_000
  let last
  while (Date.now() < deadline) {
    last = ((await get('/nodes')).body.nodes ?? []).find(node => node.id === id)
    if (last?.state === 'connected') return last
    if (last?.state === 'failed') return last
    await sleep(1_000)
  }
  return last
}

const nodes = (await get('/nodes')).body.nodes ?? []
const remote = nodes.find(node => node.id !== undefined)
if (remote === undefined) {
  log('no remote node is configured')
  process.exit(3)
}
if (remote.state !== 'connected') {
  await post(`/nodes/${remote.id}/connect`)
  const settled = await waitForConnected(remote.id)
  if (settled?.state !== 'connected') {
    log(`node ${remote.id} did not connect: ${settled?.error ?? 'no reason given'}`)
    process.exit(3)
  }
}

// ---- the switch list is about plugins, not internal rows --------------------
// Start from the defaults. A previous run of this suite can leave a stored `false` behind
// (that is what "switch it off" writes), and asserting on the defaults while a decision is
// still recorded would make this test's first check depend on what ran before it. Clearing
// is also the operation a person uses to undo a switch, so it is worth exercising.
const listed = await get('/plugins')
check(listed.status === 200, 'the plugin list answers', `HTTP ${String(listed.status)}`)
let rows = listed.body.rows ?? []
// A profile with nothing third-party installed answers `[]`, and that is a **skip**, not a
// failure: the only plugin in a clean `rnhtest` profile is this one, which is correctly never
// offered. Declared here rather than after the row checks, because those checks are vacuously
// true on an empty list and the old order reported a failure for a healthy profile.
if (rows.length === 0) {
  log('no third-party plugin is installed on this desktop; nothing to switch')
  // A clean exit, not `process.exit`: the carrier's sockets are still open and Node 24 raises
  // a libuv assertion while tearing them down, which the runner reads as a crash.
  await sleep(250)
  process.exit(3)
}
check(rows.length > 0, 'it lists the plugins installed here', `${String(rows.length)} row(s)`)
for (const row of rows.filter(entry => entry.source === 'explicit')) {
  const cleared = await post(`/plugins/${encodeURIComponent(row.bundle)}`, { sync: true })
  if (cleared.status !== 200) log(`could not clear the override on ${row.bundle}: HTTP ${String(cleared.status)}`)
}
rows = (await get('/plugins')).body.rows ?? []
check(rows.every(row => typeof row.bundle === 'string' && row.bundle.length > 0),
  'each row is a bundle name')
check(rows.every(row => !row.bundle.startsWith('@deepseek-ai/')),
  'no upstream bundle is offered as a choice')
check(rows.every(row => row.bundle !== '@local/rnh-brain' && row.bundle !== '@greatbaby/dsh-remote-node-harness'),
  'neither the brain bundle nor this plugin itself is a choice')
// Never-sync is a separate answer from "third party": the relay plugin is a plugin the
// user installed, and it must still never be offered. Listing it would mean a node could
// open a second way in.
check(rows.every(row => row.bundle !== 'ds-harness-remote' && row.bundle !== '@dsh-remote/plugin'),
  'the relay plugin is not offered either', rows.map(row => row.bundle).join(','))
// The default is **on**: one installation, one working environment. The store only ever
// records the exceptions, so a row nobody touched says `source: 'default'`.
check(rows.every(row => row.sync === true), 'your plugins are sent to a node by default',
  rows.map(row => `${row.bundle}=${String(row.sync)}/${row.source}`).join(','))
check(rows.every(row => row.source === 'default'), 'and nothing has been overridden yet',
  rows.map(row => `${row.bundle}=${row.source}`).join(','))

// Pick one the node can actually install. The test must not depend on a particular
// third-party plugin being installed on the desktop, so it takes the first candidate and
// skips the whole suite when there is none.
const target = rows[0]
log(`switching ${target.bundle} (${String(target.spec || 'latest')}) on ${remote.name}`)

// Where the node's own profile lives. Derived from the recorded `remoteRoot`, not spelled
// out: the profile name follows that root (`rnh` only for the default one), so a node
// registered elsewhere kept its manifest under a different name and this suite read `{}`.
const { layout: nodePaths } = await nodeLayout(base, cookie)
const NODE_PROFILE = nodePaths.profile
const manifest = async () => (await nodeExec(`cat ${NODE_PROFILE}/package.json 2>/dev/null || echo {}`)).trim()
const bundleList = async () => {
  try {
    const parsed = JSON.parse(await manifest())
    return Array.isArray(parsed?.dsh?.profile?.bundles) ? parsed.dsh.profile.bundles : []
  } catch {
    return []
  }
}
const packagePresent = async name => (await nodeExec(`test -d ${NODE_PROFILE}/node_modules/${name} && echo yes || echo no`)).trim() === 'yes'

/** The node still serves: a switch that leaves it dead is not a switch that worked. */
const nodeAnswers = async () => {
  const probe = await get('/workspaces')
  const remoteRows = (probe.body.baseline?.items ?? []).filter(item => String(item.workspaceId).startsWith(`rnh_${remote.id}_`))
  return { ok: probe.status === 200, workspaces: remoteRows.length }
}

/**
 * The relay from the node is alive again after the restart — checked by *causing* an event.
 *
 * A restart is not just "the node answers again": the socket this Host was holding to the
 * previous resident host stays *writable* after that process dies, so a stream opened on it
 * succeeds and then yields nothing. That is invisible to every check above — the node
 * answers, the workspaces are listed, and the sidebar is simply frozen. Measured on this
 * exact suite: after one switch, `event-relay` saw no events at all and `tool-parity` waited
 * seven minutes for a turn that had finished.
 *
 * The probe is a remote Session created through this Host: it must come back as a relayed
 * `api-session/added` naming the wrapped identity, which only happens if the Host's `$events`
 * relay reopened on the new resident host.
 */
const relayAlive = async () => {
  const workspaceId = ((await get('/workspaces')).body.baseline?.items ?? [])
    .map(item => String(item.workspaceId))
    .find(id => id.startsWith(`rnh_${remote.id}_`))
  if (workspaceId === undefined) return { ok: false, reason: 'no remote workspace to create a Session in' }
  const carrier = await openCarrier({ base, cookie: await authenticate(base, token) })
  const events = []
  carrier.onMessage(text => {
    let frame
    try { frame = JSON.parse(text) } catch { return }
    if (frame.type === 'item' && frame.value?.type === 'emit' && String(frame.value.event).startsWith('api-session/')) {
      events.push({ event: frame.value.event, args: frame.value.args ?? [] })
    }
  })
  carrier.send(JSON.stringify({ type: 'open', streamId: 'relay-probe', endpoint: '$events', payload: { args: {} } }))
  try {
    let sessionId
    try {
      const created = await call(base, await authenticate(base, token), 'session/create', { request: { workspaceId } })
      sessionId = String(created?.sessionId ?? created?.value?.sessionId ?? '')
    } catch (error) {
      return { ok: false, reason: `session/create failed: ${error.message}` }
    }
    if (!sessionId.startsWith('rnh_')) return { ok: false, reason: `session/create answered ${sessionId.slice(0, 60)}` }
    const deadline = Date.now() + 30_000
    let hits = 0
    while (Date.now() < deadline && hits === 0) {
      await sleep(500)
      hits = events.filter(entry => JSON.stringify(entry.args).includes(sessionId)).length
    }
    return { ok: hits > 0, sessionId, hits, reason: hits === 0 ? 'no relayed event named the new Session' : undefined }
  } finally {
    carrier.close()
  }
}

const before = await bundleList()
check(before.includes('@local/rnh-brain'), 'the node composes the brain bundle before the switch',
  before.join(','))
const beforeAnswers = await nodeAnswers()
check(beforeAnswers.ok, 'and answers before the switch')

let restored = false
const restore = async () => {
  if (restored) return
  restored = true
  // The default is "sent", so putting the switch back means clearing the override.
  const on = await post(`/plugins/${encodeURIComponent(target.bundle)}`, { sync: true }).catch(() => undefined)
  if (on !== undefined && on.status !== 200) log(`could not restore ${target.bundle}: ${JSON.stringify(on.body).slice(0, 300)}`)
}
process.on('SIGINT', () => { void restore().finally(() => process.exit(130)) })
process.on('SIGTERM', () => { void restore().finally(() => process.exit(143)) })
process.on('uncaughtException', error => { log(`uncaught: ${error.message}`); void restore().finally(() => process.exit(1)) })

try {
  // ---- off ------------------------------------------------------------------
  // Off is the exceptional state now, so the suite starts by creating it: everything a
  // node receives by default has to be something a person can take away again, and the
  // node has to survive the removal.
  const off = await post(`/plugins/${encodeURIComponent(target.bundle)}`, { sync: false })
  check(off.status === 200, 'switching a plugin off answers', `HTTP ${String(off.status)}`)
  check(off.body.row?.sync === false && off.body.row?.source === 'explicit',
    'the switch is recorded as a hand-made decision', JSON.stringify(off.body.row ?? {}).slice(0, 160))
  const removed = await bundleList()
  check(!removed.includes(target.bundle), 'the node no longer composes it', removed.join(','))
  check(removed.includes('@local/rnh-brain'), 'and still composes the brain bundle', removed.join(','))
  const removedAnswers = await nodeAnswers()
  check(removedAnswers.ok, 'the node answers after the plugin is taken away')
  check(removedAnswers.workspaces === beforeAnswers.workspaces,
    'with its workspaces intact',
    `${String(beforeAnswers.workspaces)} → ${String(removedAnswers.workspaces)}`)

  // ---- on -------------------------------------------------------------------
  // The reply has to report what the node did, not just "saved": installing over SSH can
  // fail on the node's own registry, and a silent success is the bug this catches.
  const on = await post(`/plugins/${encodeURIComponent(target.bundle)}`, { sync: true })
  check(on.status === 200, 'switching it back on answers', `HTTP ${String(on.status)}`)
  check(on.body.row?.sync === true, 'the switch is on again', JSON.stringify(on.body.row ?? {}).slice(0, 120))
  const report = (on.body.nodes ?? []).find(node => node.id === remote.id)
  check(report !== undefined, 'the answer names the node it talked to')
  check(report?.error === undefined, 'the node took the change', report?.error)
  // Two ways a plugin arrives, and the reply says which one happened: installed from npm
  // when it is published, copied file by file when it is a local `link:` bundle. A local
  // bundle has no registry entry, so `npm install` on the node is a guaranteed 404 — the
  // test accepts either route but insists one of them really ran.
  const delivered = [...(report?.plugins?.installed ?? []), ...(report?.plugins?.copied ?? [])]
  check(delivered.includes(target.bundle),
    'the plugin is reported delivered to the node', JSON.stringify(report?.plugins ?? {}).slice(0, 300))

  const after = await bundleList()
  check(after.includes(target.bundle), 'the node names the plugin in its own bundle list', after.join(','))
  check(after.includes('@local/rnh-brain'), 'and still composes the brain bundle', after.join(','))
  check(after.indexOf(target.bundle) < after.indexOf('@local/rnh-brain'),
    'the plugin is composed BEFORE the brain bundle, which must be last', after.join(','))
  check(await packagePresent(target.bundle), 'the package is really on the node')
  const afterAnswers = await nodeAnswers()
  check(afterAnswers.ok, 'the node still answers after the switch')
  check(afterAnswers.workspaces === beforeAnswers.workspaces,
    'and still lists the same remote workspaces',
    `${String(beforeAnswers.workspaces)} → ${String(afterAnswers.workspaces)}`)
  // The restart left the Host holding a socket to a process that is gone. A stream opened on
  // that socket succeeds and yields nothing, so "the node answers" is not enough: an event
  // the node emits has to reach this Host's browser again.
  const relayed = await relayAlive()
  check(relayed.ok,
    'the Host still relays the node’s Session events after the restart',
    relayed.reason ?? `${String(relayed.hits)} event(s) for ${String(relayed.sessionId).slice(0, 40)}`)

  // ---- back to the default --------------------------------------------------
  // Clearing the override means "do what the default says", which is the same state the
  // suite found. This is the path a person takes after trying a switch and changing
  // their mind, and it must not leave a stored `false` behind.
  const cleared = await post(`/plugins/${encodeURIComponent(target.bundle)}`, { sync: true })
  restored = true
  check(cleared.status === 200, 'putting the switch back to its default answers', `HTTP ${String(cleared.status)}`)
  check(cleared.body.row?.source === 'default', 'and the row reports the default, not a decision',
    JSON.stringify(cleared.body.row ?? {}).slice(0, 160))
  const final = await bundleList()
  check(final.includes(target.bundle), 'the node composes it again, because that is the default', final.join(','))
  check(final.includes('@local/rnh-brain'), 'the brain bundle survives the round trip', final.join(','))
  const finalAnswers = await nodeAnswers()
  check(finalAnswers.ok, 'the node answers at the end')
  check(finalAnswers.workspaces === beforeAnswers.workspaces,
    'with its workspaces intact',
    `${String(beforeAnswers.workspaces)} → ${String(finalAnswers.workspaces)}`)
} finally {
  await restore()
}

log(failures.length === 0 ? 'all checks passed' : `${String(failures.length)} failed`)
process.exit(failures.length === 0 ? 0 : 1)
