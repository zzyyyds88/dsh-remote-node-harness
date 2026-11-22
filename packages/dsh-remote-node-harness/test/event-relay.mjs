/**
 * Prove a remote Session keeps its sidebar row alive.
 *
 * `session/list` and `workspace/follow` are snapshots, so a test that only reads
 * them can pass while the UI is dead. Upstream's client half keeps a Session row
 * live from two more sources, and a remote Session feeds neither unless this
 * plugin relays them:
 *
 *   - `$events` — `api-session/added`, `/removed`, `/status`, `/activity`,
 *     `/error`. Without these a new row appears only on a full list pull, and a
 *     running spinner never spins.
 *   - `session/control` — per-Session projections: title, model selection,
 *     pending-input flags. Without these a title the node's brain writes after the
 *     first turn never reaches the sidebar.
 *
 * Both are checked here, and both are checked *against a Session created directly
 * on the node*: the local Host never issued the call, so anything the browser tab
 * hears about it can only have come through the relay.
 *
 * Usage: node test/event-relay.mjs <hostBase> <launchToken>
 */
import { SshConnection } from '../src/ssh/connection.js'
import { cookiesOf, httpOverSsh } from '../src/host/ssh-http.js'
import { authenticate, call, liveStream, openCarrier } from './carrier.mjs'
import { nodeLayout } from './layout.mjs'
import { nodeConfig } from './node.mjs'

const [base, token] = process.argv.slice(2)
if (base === undefined || token === undefined) {
  process.stderr.write('usage: node test/event-relay.mjs <hostBase> <launchToken>\n')
  process.exit(2)
}

const log = message => process.stderr.write(`[event-relay] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Strip this Host's node prefix, so a node sees its own identity. */
const bare = sessionId => sessionId.replace(/^rnh_[a-z0-9]+_/u, '')

/**
 * Drive the node's own Gateway over a throwaway SSH connection.
 *
 * This is what makes the test honest: every call below is issued to the node by a
 * client that is not this Host, so nothing local can have caused an event.
 *
 * The status file's location comes from the node's recorded `remoteRoot`, not from a
 * spelled-out `~/.dsh-remote-node-harness`: a node registered under another root keeps
 * its runtime and its `run/status.json` there instead, and guessing produced a
 * "no such file" that read like a broken host.
 *
 * @param {(context: { exec: (argv: string[]) => Promise<string>, call: (endpoint: string, args: unknown) => Promise<unknown> }) => Promise<unknown>} action
 * @param {{ status: string }} layout
 */
async function onNode(action, layout) {
  const config = nodeConfig()
  const connection = new SshConnection({
    host: config.host,
    port: config.port,
    username: config.username,
    auth: config.privateKey === undefined
      ? { kind: 'password', password: config.password }
      : { kind: 'key', privateKey: config.privateKey },
    label: 'event-relay',
  })
  try {
    await connection.client()
    // `~` is a shell expansion, so this has to go through `sh -c`; an argv element
    // is quoted verbatim and would ask for a literal directory named `~`.
    const status = JSON.parse((await connection.exec({
      argv: ['sh', '-c', `cat ${layout.status}`],
    })).stdout)
    const login = await httpOverSsh(connection, status.port, { path: `/?token=${status.token}` })
    const cookie = cookiesOf(login.headers) ?? ''
    return await action({
      exec: async argv => (await connection.exec({ argv })).stdout,
      call: async (endpoint, args) => {
        const answer = await httpOverSsh(connection, status.port, {
          path: `/api/${endpoint}`,
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ type: 'client-request', rpcId: 'relay', method: endpoint, payload: { args } }),
        })
        return JSON.parse(answer.body.toString('utf8')).result
      },
    })
  } finally {
    connection.dispose()
  }
}

const cookie = await authenticate(base, token)
const carrier = await openCarrier({ base, cookie })
// Where this node keeps its resident host — asked for, not spelled out. A node registered
// with a non-default `remoteRoot` keeps `run/status.json` somewhere else, and guessing the
// default produced a missing-file error that read like a broken host.
const { layout: nodePaths } = await nodeLayout(base, cookie)
/** @type {Array<{ event: string, args: unknown[] }>} */
const events = []
carrier.onMessage(text => {
  let frame
  try {
    frame = JSON.parse(text)
  } catch {
    return
  }
  if (frame.type === 'item' && frame.value?.type === 'emit') {
    events.push({ event: frame.value.event, args: frame.value.args ?? [] })
  }
})
carrier.send(JSON.stringify({ type: 'open', streamId: 'relay', endpoint: '$events', payload: { args: {} } }))
const control = liveStream(carrier, 'session/control', {})
await sleep(3_000)
// The opening frames prove only that this Host's own streams exist; the relay is
// judged by what arrives afterwards, so both baselines must be quiet.
const eventsBefore = events.length
const controlBefore = control.frames.length
check(eventsBefore < 5, 'the local event stream is quiet before anything happens',
  `${String(eventsBefore)} event(s) at open`)

const created = await onNode(async ({ exec, call: nodeCall }) => {
  // The node's own home, not a spelled-out `/root`: the fixture directory belongs on the
  // machine under test whatever its user is called.
  const home = (await exec(['sh', '-c', 'printf %s "$HOME"'])).trim() || '/'
  const path = `${home}/rnh-relay-${Date.now().toString(36)}`
  await exec(['mkdir', '-p', path])
  const value = await nodeCall('session/create', { request: { cwd: path } })
  return { sessionId: value.value.sessionId, path }
}, nodePaths)
log(`node Session ${created.sessionId} in ${created.path}`)

// ---- 1. the list events ---------------------------------------------------
const deadline = Date.now() + 60_000
const matching = () => events
  .slice(eventsBefore)
  .filter(entry => entry.event.startsWith('api-session/') && JSON.stringify(entry.args).includes(created.sessionId))
while (Date.now() < deadline && matching().length === 0) await sleep(400)

const hits = matching()
check(hits.length > 0, 'the node Session reaches the browser as a forwarded event',
  hits.length === 0 ? 'no api-session/* event named that Session' : `${String(hits.length)} event(s)`)

const added = hits.find(entry => entry.event === 'api-session/added')
check(added !== undefined, 'one of them is api-session/added')
if (added === undefined) {
  control.stop()
  carrier.close()
  await sleep(300)
  process.exit(1)
}
const wrapped = String(added.args[0]?.sessionId ?? '')
check(wrapped.startsWith('rnh_'), 'the relayed identity is wrapped, the way session/list wraps it',
  wrapped.slice(0, 48))
check(String(added.args[0]?.cwd ?? '').startsWith('/'), 'and it keeps the node path', added.args[0]?.cwd)
const listed = await call(base, cookie, 'session/list', { _request: {} })
const rows = Array.isArray(listed?.items) ? listed.items : []
check(rows.some(row => row.sessionId === wrapped),
  'the same identity is what session/list reports', `${String(rows.length)} rows`)

// ---- 2. the projection stream --------------------------------------------
// Two properties matter and they fail in opposite directions, so both are checked:
//
//   - there must be **exactly one** baseline on a stream, because a client treats any
//     baseline as "this is now the whole picture" — a second one would wipe the first out
//     and remote projections would look like they never worked;
//   - a client that attaches **later** must find the node's Sessions in its opening
//     baseline, i.e. a node that was already running is visible without a page reload.
//
// The second one is checked on a second stream, opened once this test's Session exists.
// Sampling the first stream's baseline would make the check depend on whether the node's
// resident host happened to have a Session in memory, which is exactly what a restart
// clears — measured: after a plugin switch the node's own baseline is legitimately empty.
const baselines = control.frames
  .slice(0, controlBefore)
  .filter(frame => frame.value?.type === 'baseline')
check(baselines.length === 1, 'the client receives exactly one control baseline',
  String(baselines.length))

// Now a change made on the node has to arrive as a projection frame. A rename is
// the cheapest projection the node can move on its own.
const title = `relayed-title-${Date.now().toString(36)}`
await onNode(async ({ call: nodeCall }) => {
  await nodeCall('session/rename', { request: { sessionId: created.sessionId, title } })
}, nodePaths)
const projected = Date.now() + 30_000
const seenTitle = () => control.frames
  .slice(controlBefore)
  .flatMap(frame => (frame.value?.type === 'projection' ? [frame.value] : []))
  .some(frame => frame.sessionId === wrapped
    && (frame.changes ?? []).some(change => change.key === 'title' && change.val === title))
while (Date.now() < projected && !seenTitle()) await sleep(300)
check(seenTitle(), 'a title the node writes reaches the browser as a projection frame', title)

// ---- 2b. a client attaching now sees the node's Sessions ------------------
// Opened after the Session exists, so the assertion is about the merge and not about the
// node's memory. This is the "second browser window" case.
const later = liveStream(carrier, 'session/control', {})
const laterDeadline = Date.now() + 15_000
const laterBlocks = () => Object.keys(
  later.frames.find(frame => frame.value?.type === 'baseline')?.value?.value?.projections ?? {},
)
while (Date.now() < laterDeadline && !laterBlocks().includes(wrapped)) await sleep(300)
check(laterBlocks().includes(wrapped),
  'a client attaching later finds the node Session in its opening baseline',
  `${String(laterBlocks().filter(key => key.startsWith('rnh_')).length)} remote of ${String(laterBlocks().length)}`)
later.stop()
const leaked = control.frames
  .slice(controlBefore)
  .filter(frame => /"sessionId":"session-[0-9a-f]{8}-/u.test(JSON.stringify(frame.value ?? null)))
check(leaked.length === 0, 'no control frame leaks a bare node Session id',
  leaked.length === 0 ? 'none' : `${String(leaked.length)} leak(s)`)

// The rewrite helper used above must agree with the id the Host reports, or the
// two halves of this test would be describing different Sessions.
check(bare(wrapped) === created.sessionId, 'the wrapped id decodes back to the node id',
  bare(wrapped).slice(0, 40))

control.stop()
carrier.close()
await sleep(300)
if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
}
process.exit(failures.length === 0 ? 0 : 1)
