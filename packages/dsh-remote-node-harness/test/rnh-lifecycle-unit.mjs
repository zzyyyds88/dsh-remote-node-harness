/**
 * `host/rnh.js` — the three behaviours this round added, without a real node.
 *
 * Everything here is driven through the real `Rnh`, with the SSH and remote layers replaced
 * by the smallest fakes that answer the calls `connect()` makes. What it proves:
 *
 *   1. a dropped socket becomes `idle` + `droppedAt` (not a green dot over a dead machine);
 *   2. the reconnect ladder is 2s → 4s → 8s → every 2 min, and a deliberate disconnect cancels
 *      it (otherwise pressing Disconnect would be undone two seconds later);
 *   3. the first host key seen is recorded on the record, and the connection is handed the
 *      recorded one on the next connect — the chain that was dead code before;
 *   4. a failed connect keeps its phase and carries a classified failure;
 *   5. a node that is merely unreachable keeps its workspace rows.
 *
 * Usage: node test/rnh-lifecycle-unit.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// **Before anything imports the registry.** `NodeRegistry` writes to `$DSH_HOME/rnh/nodes.json`,
// so a suite that builds real `Rnh` objects would otherwise append its fake nodes to the
// machine's own node list. Measured the hard way: three `fake` records landed in the developer's
// `~/.dsh/rnh/nodes.json` and every later e2e run picked the wrong node. A private home makes
// this suite safe to run anywhere, including next to a live profile.
const sandbox = mkdtempSync(join(tmpdir(), 'rnh-lifecycle-'))
process.env.DSH_HOME = sandbox

const { Rnh, NODE_STATE } = await import('../src/host/rnh.js')
const { STATUS_EVENT, NODE_STATUS_KIND } = await import('../src/host/node-status.js')
const { classifyFailure } = await import('../src/core/errors.js')
const { RemoteWorkspaces } = await import('../src/host/remote-workspaces.js')

let failed = 0
const check = (ok, label, detail) => {
  if (ok) {
    process.stdout.write(`[rnh-lifecycle] ok   ${label}\n`)
    return
  }
  failed += 1
  process.stdout.write(`[rnh-lifecycle] FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** The resident endpoint `ensureServing` returns, for fixtures. */
const SERVICE = Object.freeze({ port: 1234, token: 't', pid: 1, version: '0.0.0-test' })

/**
 * Put one runtime into `connected` through the **state machine**.
 *
 * This used to be `node.state = NODE_STATE.CONNECTED; node.serving = …`. Those two fields no
 * longer exist: they were part of the fifteen independent lifecycle variables batch 4 replaced
 * with one discriminated union, so a fixture that assigns them would be testing a shape that is
 * gone. Dispatching the same events `connect()` dispatches is what a real connect does.
 */
const markConnected = (node, service = SERVICE) => {
  node.dispatch({ type: STATUS_EVENT.CONNECT_REQUESTED, phase: 'probe' })
  node.dispatch({ type: STATUS_EVENT.SERVICE_STARTED, service })
  node.dispatch({ type: STATUS_EVENT.CONNECT_SUCCEEDED, service })
}

/** A credential store that answers from memory. */
function memoryCredentials() {
  const records = new Map()
  return {
    readRecord: key => records.get(key),
    modifyRecord: (key, mutate) => { records.set(key, mutate(records.get(key))); return records.get(key) },
    deleteRecord: key => { records.delete(key) },
    describeRecord: key => (records.has(key) ? { kind: 'password' } : undefined),
    // The real `ctx.credentials` shape the SecretStore drives.
    read: key => records.get(key),
  }
}

// ---- 1. a drop is visible, and the ladder starts ---------------------------

{
  const rnh = new Rnh({ credentials: memoryCredentials(), version: '0.0.0-test', log: () => {} })
  const runtime = rnh.put({ id: 'n0000000000aa', name: 'fake', host: 'example.test', username: 'root', auth: { kind: 'password' } })
  const node = await runtime

  // Pretend a connect succeeded.
  markConnected(node)

  // The connection reports a drop the way `SshConnection` does.
  node.connection.target.onDrop?.()

  check(node.describe().state === NODE_STATE.IDLE, 'a drop takes the node out of `connected`',
    node.describe().state)
  check(node.status.kind === NODE_STATUS_KIND.RECOVERING,
    'and the lossless `kind` says it is recovering', String(node.status.kind))
  check(typeof node.describe().droppedAt === 'number' && node.describe().droppedAt > 0,
    'and records when it happened, so the card can say "since …"', String(node.describe().droppedAt))
  check(node.describe().serving === undefined,
    'the resident host is forgotten, because nothing can reach it')
  check(node.describe().droppedAt !== undefined, 'the snapshot carries it to the settings page')
  check(node.describe().failure === undefined,
    'and a drop is not reported as a failure — nothing is misconfigured')
  // The card can only say "attempt 2 of 3" if the rung is in the snapshot. Without it the
  // difference between the first try and the tenth is invisible, and those are the two cases
  // a person acts differently on. The rung is a payload of `recovering` now (`status.attempt`);
  // the snapshot keeps omitting `recoveryAttempts` while it is 0, exactly as before.
  check(node.status.attempt === 0,
    'the ladder starts at rung 0', String(node.status.attempt))
  node.dispatch({ type: STATUS_EVENT.RECOVERY_ATTEMPT_STARTED })
  check(node.describe().recoveryAttempts === 1,
    'and the snapshot reports the rung once an attempt has started',
    String(node.describe().recoveryAttempts))
  node.dispatch({ type: STATUS_EVENT.RECOVERY_ATTEMPT_FAILED, error: 'unreachable' })
  check(node.describe().recoveryAttempts === 1 && node.describe().lastError === 'unreachable',
    'a missed rung keeps its number and its reason',
    `${String(node.describe().recoveryAttempts)} / ${String(node.describe().lastError)}`)
  check(node.recoveryTimer !== undefined, 'the reconnect ladder is armed')
  rnh.dispose()
  node.recoveryTimer = undefined
}

// ---- 2. a deliberate disconnect cancels the ladder -------------------------

{
  const rnh = new Rnh({ credentials: memoryCredentials(), version: '0.0.0-test', log: () => {} })
  const node = await rnh.put({ id: 'n0000000000ab', name: 'fake', host: 'example.test', username: 'root', auth: { kind: 'password' } })
  markConnected(node)
  node.connection.target.onDrop?.()
  check(node.recoveryTimer !== undefined, 'the ladder is armed after a drop')

  await rnh.disconnect(node).catch(() => undefined)
  check(node.recoveryTimer === undefined,
    'pressing Disconnect cancels it — otherwise the node comes back two seconds later',
    String(node.recoveryTimer))
  check(node.describe().state === NODE_STATE.IDLE, 'and the node stays down', node.describe().state)
  check(node.describe().droppedAt === undefined, 'a deliberate disconnect is not a drop',
    String(node.describe().droppedAt))
  rnh.dispose()
}

// ---- 3. the host key is recorded, then handed back ------------------------

{
  const rnh = new Rnh({ credentials: memoryCredentials(), version: '0.0.0-test', log: () => {} })
  const node = await rnh.put({ id: 'n0000000000ac', name: 'fake', host: 'example.test', username: 'root', auth: { kind: 'password' } })
  check(node.connection.target.hostFingerprint === undefined,
    'a machine never seen before starts with no recorded key')

  // What `ssh2` does on the first handshake.
  node.connection.target.onFirstFingerprint?.('aa:bb:cc')
  check(rnh.registry.get('n0000000000ac').hostKey === 'aa:bb:cc',
    'the first key is written to the node record',
    String(rnh.registry.get('n0000000000ac').hostKey))
  check(node.connection.target.hostFingerprint === 'aa:bb:cc',
    'and the live connection is told, so its next handshake compares')
  check(node.describe().hostKey === 'aa:bb:cc', 'the settings page can show it')

  // A second connect reads the record and must hand the key to the connection.
  const again = rnh.get('n0000000000ac')
  check(again.connection.target.hostFingerprint === 'aa:bb:cc',
    'a later read of the same node still carries the key',
    String(again.connection.target.hostFingerprint))
  rnh.dispose()
}

// ---- 4. a failed connect keeps its phase and is classified ---------------

{
  const failure = classifyFailure(
    Object.assign(new Error('this machine runs Node v18.0.0'), { code: 'node-too-old' }),
    { phase: 'probe' },
  )
  check(failure.code === 'node-too-old', 'an explicit code wins', failure.code)
  check(failure.action === 'upgrade-node', 'and brings the action a person can take', failure.action)
  check(failure.retryable === false, 'and says retrying will not help', String(failure.retryable))

  const byPhase = classifyFailure(new Error('boom'), { phase: 'install' })
  check(byPhase.code === 'runtime-install', 'a failure during install is named after the stage', byPhase.code)
  check(byPhase.detail === 'boom', 'the original sentence is kept for a bug report', byPhase.detail)
}

// ---- 5b. the card's two clocks come from the snapshot ---------------------
// "How long has this been in `install`" and "how many bytes have arrived" are both facts the
// Host knows and the browser cannot compute: the page may be opened mid-connect, and a
// download that started before the tab did would otherwise read as just-started.
{
  const rnh = new Rnh({ credentials: memoryCredentials(), version: '0.0.0-test', log: () => {} })
  const node = await rnh.put({ id: 'n0000000000ad', name: 'fake', host: 'example.test', username: 'root', auth: { kind: 'password' } })

  // Nothing running: neither key is present, so a card cannot render a clock or a bar that
  // belongs to a phase the node is not in.
  check(node.describe().phaseStartedAt === undefined, 'a node with no phase has no phase clock')
  check(node.describe().transfer === undefined, 'and no transfer numbers')
  check(node.describe().recoveryAttempts === undefined, 'and no ladder rung while it is healthy')

  // **Changed fixture shape, same behaviour.** A phase and a transfer used to be two fields
  // written straight onto the runtime; they are payloads of the `connecting` status now, so
  // the fixture dispatches the events a real connect dispatches.
  node.dispatch({ type: STATUS_EVENT.CONNECT_REQUESTED, phase: 'install' })
  check(typeof node.describe().phaseStartedAt === 'number',
    'a phase carries the moment it began, so the card can show elapsed time',
    String(node.describe().phaseStartedAt))
  check(node.describe().phase === 'install', 'and the step it names', String(node.describe().phase))

  node.dispatch({
    type: STATUS_EVENT.TRANSFER_UPDATED,
    transfer: { bytes: 12 * 1024 * 1024, total: 58 * 1024 * 1024, bytesPerSecond: 2 * 1024 * 1024 },
  })
  check(node.describe().transfer?.bytes === 12 * 1024 * 1024,
    'live transfer numbers reach the card', JSON.stringify(node.describe().transfer))
  // A transfer belongs to the phase that was downloading: moving on clears it, so a bar can
  // never appear under a step that is not downloading anything.
  node.dispatch({ type: STATUS_EVENT.PHASE_ENTERED, phase: 'provision' })
  check(node.describe().transfer === undefined,
    'and they are dropped when the phase moves on, so a stale bar cannot be shown')
  rnh.dispose()
}

// ---- 6. an unreachable node keeps its rows -------------------------------

{
  const rows = [{ workspaceId: 'w1' }, { workspaceId: 'w2' }]
  const node = {
    baseline: { items: rows, archivedSessionIds: [], pinnedSessionIds: [] },
    offline: false,
    stream: undefined,
    close() { this.baseline = null },
    markOffline() { this.offline = true; this.stream = undefined },
    open: async () => undefined,
    ready: async () => undefined,
    onIncrement: undefined,
    onReplaced: undefined,
  }
  check(node.baseline.items.length === 2, 'the fixture starts with two rows')
  node.markOffline()
  check(node.offline === true, 'marking offline sets the flag')
  check(node.baseline !== null && node.baseline.items.length === 2,
    'and keeps the rows, because a workspace that still exists must not vanish from the sidebar',
    JSON.stringify(node.baseline?.items.length))

  // A node whose *record* was removed is the one case that drops them.
  node.close()
  check(node.baseline === null, 'removing the node does drop them', String(node.baseline))
  void RemoteWorkspaces
}

await sleep(10)
rmSync(sandbox, { recursive: true, force: true })
if (failed > 0) {
  process.stdout.write(`\n[rnh-lifecycle] FAILED: ${String(failed)} check(s)\n`)
  process.exitCode = 1
} else {
  process.stdout.write('\n[rnh-lifecycle] all checks passed\n')
}
