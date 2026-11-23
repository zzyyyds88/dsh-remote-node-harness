/**
 * The reconnect ladder, without a node and without a Host.
 *
 * This file exists for the two halves of D1 and D2 that were only visible on a real
 * disconnected machine:
 *
 *   - the ladder's delay used to be `2 s` on **every** rung, because `#scheduleRecovery`
 *     cancelled the previous timer first and that cancellation zeroed the rung it was about
 *     to read (D1). Six schedules gave `2000, 2000, 2000, 2000, 2000, 2000`; the table is
 *     `2000, 4000, 8000, 120000, …`;
 *   - a failed ladder attempt left `state: 'failed'`, so the card went red and showed the last
 *     attempt's sentence after the first miss, even though the design says the ladder is a
 *     quiet `idle` + `droppedAt` (D2).
 *
 * No SSH is dialled: the ladder is driven with a fake `setTimeout` (so six rungs run
 * instantly), and the only real `connect()` calls fail before touching the network (a node
 * with no stored credential throws `credential-missing` immediately). `DSH_HOME` is a
 * temporary directory so the registry writes never reach the developer's own node list.
 *
 * **Updated for the batch-4 state machine.** The lifecycle is one discriminated union now
 * (`host/node-status.js`), so a fixture can no longer set `node.state = 'connected'` and
 * `node.serving = …`: it dispatches the events the Host dispatches. Where an assertion had to
 * change for that reason, the reason is written at the assertion. The behaviours this file
 * was created to protect — 2/4/8/120 s, a quiet failed rung, a deliberate disconnect ending
 * the ladder, `dispose()` cancelling the timer, an agent node storing a record — are all still
 * asserted, through the new shape.
 *
 * Usage: node test/recovery-ladder-unit.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Before anything imports the registry: `NodeRegistry` resolves its file lazily under
// `$DSH_HOME`, and `put()` writes it. A private home makes this suite safe anywhere.
const sandbox = mkdtempSync(join(tmpdir(), 'rnh-ladder-'))
process.env.DSH_HOME = sandbox

const { Rnh, NODE_STATE, recoveryDelayMs } = await import('../src/host/rnh.js')
const { STATUS_EVENT, NODE_STATUS_KIND } = await import('../src/host/node-status.js')
const { SecretStore } = await import('../src/core/secrets.js')

let failed = 0
const check = (ok, label, detail) => {
  if (ok) {
    process.stdout.write(`[recovery-ladder] ok   ${label}\n`)
    return
  }
  failed += 1
  process.stdout.write(`[recovery-ladder] FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

/** The credential-store shape `SecretStore` drives, held in one Map. */
function memoryCredentials() {
  const records = new Map()
  return {
    records,
    // `modifyRecord`'s mutator is an `async` function: the store must await it before the new
    // value becomes the record, exactly as the real serialized read-modify-write does.
    readRecord: async key => records.get(key),
    modifyRecord: async (key, mutate) => {
      records.set(key, await mutate(records.get(key)))
      return records.get(key)
    },
    deleteRecord: async key => { records.delete(key) },
    describeRecord: async key => (records.has(key) ? { present: true } : { present: false }),
  }
}

/** One `Rnh` over a private in-memory store. */
const newRnh = () => {
  const credentials = memoryCredentials()
  const rnh = new Rnh({ credentials, version: '0.0.0-test', log: () => {} })
  return { rnh, credentials }
}

/** Let every `.then`/`.catch` in the ladder's promise chain run. */
const flush = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

/** A resident-host endpoint, in the shape `ensureServing` returns one. */
const SERVICE = Object.freeze({ port: 1, token: 't', pid: 1, version: '0.0.0-test' })

/**
 * Put one runtime into `connected` **through the state machine**, the way `connect()` does.
 *
 * This used to be two field assignments (`node.state = …`, `node.serving = …`). The fields are
 * gone: they were the fifteen independent variables this batch replaced with one status value,
 * so a test that assigns them would be testing a shape that no longer exists.
 */
const markConnected = node => {
  node.dispatch({ type: STATUS_EVENT.CONNECT_REQUESTED, phase: 'probe' })
  node.dispatch({ type: STATUS_EVENT.SERVICE_STARTED, service: SERVICE })
  node.dispatch({ type: STATUS_EVENT.CONNECT_SUCCEEDED, service: SERVICE })
}

/** The projected snapshot, which is what a card and the tests read now. */
const snapshot = node => node.describe()

// ---- 1. the table itself ----------------------------------------------------
// The delays are the contract: the card says "attempt n of 3", and the Host's timer has to
// agree with it. `recoveryDelayMs` is exported exactly so this can be asserted without a
// clock or a node.
{
  const expected = [2_000, 4_000, 8_000, 120_000, 120_000, 120_000]
  const actual = expected.map((_, attempt) => recoveryDelayMs(attempt))
  check(JSON.stringify(actual) === JSON.stringify(expected),
    'rungs 0..5 are 2000, 4000, 8000, then the steady 120000 interval',
    JSON.stringify(actual))
  check(recoveryDelayMs(60) === 120_000,
    'a ladder that has been running for hours keeps the steady interval, it does not wrap',
    String(recoveryDelayMs(60)))
  check(recoveryDelayMs(-1) === 2_000 && recoveryDelayMs(1.5) === 2_000,
    'garbage rungs fall back to the first delay instead of producing NaN in setTimeout',
    `${String(recoveryDelayMs(-1))}, ${String(recoveryDelayMs(1.5))}`)
}

// ---- 2. the real ladder advances, one rung per failed attempt (D1) ----------
// Ended offline with six schedules all at 2000. This drives the Host's own timer path: a fake
// `setTimeout` captures each delay and lets the test fire it by hand, and `rnh.connect` rejects
// like an unreachable machine would, so the chain rearms exactly as it does in production.
{
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  /** @type {Array<{ id: number, ms: number }>} */
  let scheduled = []
  const pending = new Map()
  let nextId = 1
  globalThis.setTimeout = (callback, ms) => {
    const id = nextId
    nextId += 1
    scheduled.push({ id, ms })
    pending.set(id, callback)
    // `#armTimer` calls `unref()` so a laptop lid closing cannot hold the app open.
    return { id, unref() {} }
  }
  globalThis.clearTimeout = handle => {
    if (typeof handle === 'object' && handle !== null && 'id' in handle) pending.delete(handle.id)
  }

  try {
    const { rnh } = newRnh()
    const node = await rnh.put({
      id: 'n0000000000bb', name: 'offline', host: 'example.test', username: 'root',
      auth: { kind: 'password' }, password: 'not-a-real-secret',
    })
    let dialled = 0
    rnh.connect = async () => {
      dialled += 1
      throw new Error('the machine could not be reached over the network')
    }

    // A connected node drops, which is the only way the ladder starts. The status is built by
    // dispatching the events a real connect dispatches — there are no state fields to assign.
    markConnected(node)
    node.connection.target.onDrop?.()
    check(node.recoveryTimer !== undefined, 'the ladder is armed by a drop', String(node.recoveryTimer))
    check(scheduled.length === 1, 'exactly one timer is pending', String(scheduled.length))
    check(node.status.kind === NODE_STATUS_KIND.RECOVERING,
      'and the node is in `recovering`, not a half-state', String(node.status.kind))

    const observed = []
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const last = scheduled[scheduled.length - 1]
      observed.push(last.ms)
      const callback = pending.get(last.id)
      pending.delete(last.id)
      callback()
      await flush()
    }
    check(JSON.stringify(observed) === JSON.stringify([2_000, 4_000, 8_000, 120_000, 120_000, 120_000]),
      'six failed attempts walk 2 s → 4 s → 8 s → 2 min and stay there (D1 fixed)',
      `observed ${JSON.stringify(observed)}`)
    check(dialled === 6, 'each rung really tried to connect', `dialled ${String(dialled)}`)
    // **Changed name, same fact.** The rung is a payload of `recovering` now
    // (`status.attempt`), and the settings snapshot still exposes it as `recoveryAttempts`, so
    // the card keeps printing "attempt 3 of 3".
    check(node.status.attempt === 6, 'and the rung counter advanced with the ladder',
      String(node.status.attempt))
    check(snapshot(node).recoveryAttempts === 6,
      'the settings snapshot reports the same rung under its old field name',
      String(snapshot(node).recoveryAttempts))
    check(node.status.kind === NODE_STATUS_KIND.RECOVERING
      && snapshot(node).state === NODE_STATE.IDLE && snapshot(node).droppedAt !== undefined,
      'a run of failed reconnects stays `recovering` → `state: idle` + `droppedAt`, not `failed` (D2 fixed)',
      `${String(snapshot(node).state)}, droppedAt=${String(snapshot(node).droppedAt)}`)
    check(snapshot(node).error === undefined && snapshot(node).failure === undefined,
      'and the card is not given a red failure to show while the ladder keeps trying',
      `${String(snapshot(node).error)} / ${String(snapshot(node).failure?.code)}`)
    check(snapshot(node).lastError !== undefined,
      'the reason a rung missed is still recorded, under `lastError` instead of `error`',
      String(snapshot(node).lastError))
    rnh.dispose()
    check(node.recoveryTimer === undefined, 'dispose() cancels the pending rung')
    // **Changed assertion, deliberate.** The rung lived in a field that `dispose()` used to
    // leave behind; it now lives inside the `recovering` status, and `dispose()` terminates the
    // runtime (there is nothing left to reconnect to). The property this assertion was really
    // protecting — "cancelling a timer does not zero the rung" — is asserted at the reducer in
    // `node-status-unit.mjs`, where it can be stated directly.
    check(node.status.kind === NODE_STATUS_KIND.TERMINATED,
      'and terminate() releases the runtime for good, so no rung can be revived',
      String(node.status.kind))
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
}

// ---- 3. a rearm is not the end of the ladder ------------------------------
// The root cause of D1, at the Host's own level: `#armTimer` clears the previous timer before
// arming the next one, and that cancellation must not be what the rung is read from. Driven
// through the fake timer, so the rearm is the real code path rather than a direct `reduce`.
{
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  /** @type {Array<{ id: number, ms: number }>} */
  const scheduled = []
  const pending = new Map()
  let nextId = 1
  globalThis.setTimeout = (callback, ms) => {
    const id = nextId
    nextId += 1
    scheduled.push({ id, ms })
    pending.set(id, callback)
    return { id, unref() {} }
  }
  globalThis.clearTimeout = handle => {
    if (typeof handle === 'object' && handle !== null && 'id' in handle) pending.delete(handle.id)
  }

  try {
    const { rnh } = newRnh()
    const node = await rnh.put({
      id: 'n0000000000bc', name: 'rung', host: 'example.test', username: 'root',
      auth: { kind: 'password' }, password: 'not-a-real-secret',
    })
    rnh.connect = async () => { throw new Error('still unreachable') }
    markConnected(node)
    node.connection.target.onDrop?.()

    // Fire two rungs. Each rearm cancels the old timer and arms a longer one.
    for (let rung = 0; rung < 2; rung += 1) {
      const last = scheduled[scheduled.length - 1]
      pending.get(last.id)()
      pending.delete(last.id)
      await flush()
    }
    check(JSON.stringify(scheduled.map(entry => entry.ms)) === JSON.stringify([2_000, 4_000, 8_000]),
      'rearming reads the rung that already ran, so the third wait is 8000 ms',
      JSON.stringify(scheduled.map(entry => entry.ms)))
    check(node.status.attempt === 2,
      'and the rung advanced to 2 instead of being zeroed by the cancellation',
      String(node.status.attempt))
    check(node.recoveryTimer !== undefined, 'a rearmed ladder has a pending timer')
    rnh.dispose()
    check(node.recoveryTimer === undefined, 'dispose() clears it')
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
}

// ---- 4. a deliberate disconnect resets the rung ---------------------------
// The other allowed reset. `host.stop()` is faked because this suite must not dial anything;
// everything else in `disconnect()` is the real code path.
{
  const { rnh } = newRnh()
  const node = await rnh.put({
    id: 'n0000000000bd', name: 'stop', host: 'example.test', username: 'root',
    auth: { kind: 'password' }, password: 'not-a-real-secret',
  })
  markConnected(node)
  node.connection.target.onDrop?.()
  // Two rungs, so the reset is observable.
  node.dispatch({ type: STATUS_EVENT.RECOVERY_ATTEMPT_STARTED })
  node.dispatch({ type: STATUS_EVENT.RECOVERY_ATTEMPT_FAILED, error: 'down' })
  node.dispatch({ type: STATUS_EVENT.RECOVERY_ATTEMPT_STARTED })
  node.dispatch({ type: STATUS_EVENT.RECOVERY_ATTEMPT_FAILED, error: 'down' })
  check(node.status.attempt === 2, 'the fixture is two rungs into the ladder', String(node.status.attempt))
  node.host.stop = async () => {}

  await rnh.disconnect(node)
  // **Changed field name, same fact.** The rung has no field of its own any more; a deliberate
  // disconnect leaves plain `idle`, and a fresh drop starts again at rung 0. That is the
  // observable meaning of "pressing Disconnect puts the ladder back to the first rung".
  check(node.status.kind === NODE_STATUS_KIND.IDLE,
    'pressing Disconnect puts the node back to plain `idle`', String(node.status.kind))
  check(snapshot(node).recoveryAttempts === undefined,
    'and the snapshot carries no rung at all',
    String(snapshot(node).recoveryAttempts))
  check(node.recoveryTimer === undefined, 'and clears its timer')
  check(snapshot(node).droppedAt === undefined, 'and forgets the drop, because the person asked for this')

  // A later drop starts the ladder over rather than resuming where it was.
  markConnected(node)
  node.connection.target.onDrop?.()
  check(node.status.attempt === 0, 'a new drop starts at rung 0, not where the old ladder stopped',
    String(node.status.attempt))
  check(snapshot(node).recoveryAttempts === undefined,
    'and the card shows no attempt number for the first rung',
    String(snapshot(node).recoveryAttempts))
  rnh.dispose()
}

// ---- 5. a failed ladder attempt is quiet; a failed manual connect is not ---
// The state semantics D2 decides: `failed` means "the app stopped trying and something is
// wrong"; an in-flight ladder attempt is `recovering` (projected as `state: idle` + `droppedAt`),
// with the reason only in `lastError` and the node's own log. Nothing here reaches SSH: a node
// with no stored credential throws before the handshake.
{
  const { rnh } = newRnh()
  const node = await rnh.put({
    id: 'n0000000000be', name: 'credentialless', host: 'example.test', username: 'root',
    auth: { kind: 'password' },
  })
  check(snapshot(node).credentialsReady === false,
    'the fixture has no stored credential, so connect fails before the network')

  // What a drop leaves behind.
  markConnected(node)
  node.connection.target.onDrop?.()
  const droppedAt = snapshot(node).droppedAt
  check(typeof droppedAt === 'number', 'the fixture is dropped and reconnecting', String(droppedAt))

  // A ladder attempt, exactly as the timer starts one: the rung advances first, then the
  // connect runs and fails before the handshake.
  node.dispatch({ type: STATUS_EVENT.RECOVERY_ATTEMPT_STARTED })
  await rnh.connect(node, { recovering: true }).catch(() => undefined)
  check(node.status.kind === NODE_STATUS_KIND.RECOVERING,
    'a failed ladder attempt leaves the node `recovering`, which the card renders as idle (D2)',
    String(node.status.kind))
  check(snapshot(node).state === NODE_STATE.IDLE,
    'the projected `state` is the compatible `idle`', String(snapshot(node).state))
  check(snapshot(node).droppedAt === droppedAt, 'and keeps the time of the drop, so the card can say "since …"',
    String(snapshot(node).droppedAt))
  check(snapshot(node).error === undefined && snapshot(node).failure === undefined,
    'and reports no error, because the ladder is still trying',
    `${String(snapshot(node).error)} / ${String(snapshot(node).failure?.code)}`)
  check(snapshot(node).lastError !== undefined,
    'the reason is kept as `lastError`, which is a log fact rather than a red block',
    String(snapshot(node).lastError))
  check(node.status.phase === undefined,
    'the failed attempt\u2019s phase is not left on a card that is merely waiting',
    String(node.status.phase))
  check(node.recoveryTimer !== undefined, 'and the next rung is armed')

  // A manual Connect is the opposite: it stops trying and must say why.
  await rnh.connect(node).catch(() => undefined)
  check(snapshot(node).state === NODE_STATE.FAILED,
    'a failed manual connect is `failed`, so the card goes red and offers Retry',
    String(snapshot(node).state))
  check(snapshot(node).failure?.code === 'credential-missing',
    'and carries the classified reason, not just a sentence',
    String(snapshot(node).failure?.code))
  check(snapshot(node).error !== undefined, 'and the sentence for the bug report', String(snapshot(node).error))
  check(node.recoveryTimer === undefined,
    'and the ladder is not left running behind a failure the person has to act on',
    String(node.recoveryTimer))
  rnh.dispose()
}

// ---- 6. after dispose the ladder cannot restart ---------------------------
// The timer is cancelled, but a queued caller (or a callback already in flight) must not be
// able to reopen a connection on an unloaded plugin either.
{
  const { rnh } = newRnh()
  const node = await rnh.put({
    id: 'n0000000000bf', name: 'gone', host: 'example.test', username: 'root',
    auth: { kind: 'password' }, password: 'not-a-real-secret',
  })
  rnh.dispose()
  check(rnh.disposed === true, 'dispose() latches the rnh as disposed')
  const described = await rnh.connect(node)
  // **Changed expected value, deliberate.** `dispose()` now terminates the runtime, so the
  // snapshot says `terminated` (a new value in the `state` vocabulary) instead of the old
  // `idle`. What this assertion is for — "connect() after dispose dials nothing" — is unchanged
  // and asserted by the next line.
  check(described.state === NODE_STATE.TERMINATED,
    'connect() after dispose is a no-op instead of dialling into a dead plugin', String(described.state))
  check(described.kind === NODE_STATUS_KIND.TERMINATED,
    'and the lossless `kind` says the same', String(described.kind))
  check(described.state !== NODE_STATE.CONNECTING && described.state !== NODE_STATE.FAILED,
    'and it did not even enter a connect phase', String(described.state))
}

// ---- 7. an agent-authenticated node stores a record ----------------------
// Layer 2 of D3: `{ kind: 'agent' }` used to look like "no value" (only `version` + `kind`),
// so `write()` deleted the record and `read()` could never return it.
{
  const credentials = memoryCredentials()
  const secrets = new SecretStore(credentials)
  await secrets.write('n0000000000c0', { kind: 'agent' })
  const key = [...credentials.records.keys()].find(entry => entry.includes('0000000000c0'))
  check(key !== undefined, 'writing an agent secret writes a record instead of deleting one', String(key))
  const read = await secrets.read('n0000000000c0')
  check(read?.kind === 'agent',
    'and read() gives it back as `{ kind: "agent" }` — the kind is the whole credential',
    JSON.stringify(read))
  check(JSON.stringify(await secrets.describe('n0000000000c0')) === JSON.stringify({ configured: true }),
    'and describe() says a credential is configured')
}

// A password with no value still means "forget it", which is how switching auth kinds clears
// the field it no longer needs.
{
  const credentials = memoryCredentials()
  const secrets = new SecretStore(credentials)
  await secrets.write('n0000000000c1', { kind: 'password' })
  check((await secrets.describe('n0000000000c1')).configured === false,
    'an empty password still deletes the record rather than storing an empty one')
}

// ---- 8. put() writes the agent record (D3, layer 1) ----------------------
// `put()` only wrote a record when a value field was present, so an agent node — which has no
// value field — ended up with no record at all and `credentialsReady()` stayed false.
{
  const { rnh, credentials } = newRnh()
  const node = await rnh.put({
    id: 'n0000000000c2', name: 'agent-node', host: 'example.test', username: 'root',
    auth: { kind: 'agent' },
  })
  const key = [...credentials.records.keys()].find(entry => entry.includes('0000000000c2'))
  check(key !== undefined, 'put() persists an agent node record', String(key))
  check(credentials.records.get(key)?.payload?.kind === 'agent',
    'with the kind the node will authenticate by',
    JSON.stringify(credentials.records.get(key)?.payload))
  check(snapshot(node).credentialsReady === true,
    'so the node reports a usable credential and connect() will attempt the SSH agent',
    String(snapshot(node).credentialsReady))
  check(node.secret?.kind === 'agent', 'and the runtime adopted it, so an agent node can be dialled',
    JSON.stringify(node.secret))

  // A password node updated without a new value must keep its secret: PATCH sends the record
  // back with no value fields, and dropping the record there would silently break every edit.
  const passwordNode = await rnh.put({
    id: 'n0000000000c3', name: 'password-node', host: 'example.test', username: 'root',
    auth: { kind: 'password' }, password: 'kept-secret',
  })
  const passwordKey = [...credentials.records.keys()].find(entry => entry.includes('0000000000c3'))
  check(credentials.records.get(passwordKey)?.payload?.password === 'kept-secret',
    'a password node starts with its stored secret')
  await rnh.put({ ...passwordNode.record })
  check(credentials.records.get(passwordKey)?.payload?.password === 'kept-secret',
    'and a record-only update (what PATCH sends) does not erase it')
  rnh.dispose()
}

// ---- 9. a changed handshake input downgrades a connected node (new) ------
// This is the `put()` half of the cross-field invariants: changing a host or credential on a
// connected node used to leave `state: connected` with the old `serving` port while `adopt()`
// had already torn the socket down — green dot, `routable: true`, every call failing.
{
  const { rnh } = newRnh()
  const node = await rnh.put({
    id: 'n0000000000c4', name: 'edited', host: 'example.test', username: 'root',
    auth: { kind: 'password' }, password: 'first-secret',
  })
  markConnected(node)
  check(snapshot(node).state === NODE_STATE.CONNECTED && node.routable === true,
    'the fixture is connected and routable')
  await rnh.put({ ...node.record, host: 'other.test' })
  check(snapshot(node).state === NODE_STATE.IDLE,
    'a changed host downgrades the node instead of leaving it green over a dead socket',
    String(snapshot(node).state))
  check(snapshot(node).serving === undefined && node.routable === false,
    'and the stale endpoint is gone, so nothing routes to it',
    `${JSON.stringify(snapshot(node).serving)} / routable=${String(node.routable)}`)
  check(snapshot(node).error === undefined && snapshot(node).failure === undefined,
    'and it is not reported as a failure: the person is editing, not broken',
    `${String(snapshot(node).error)} / ${String(snapshot(node).failure?.code)}`)
  rnh.dispose()
}

// ---- 10. syncConfig failure is visible, not silent ----------------------
// The last half of "syncConfig fails, state unchanged": the node stayed green while its
// configured composition had not been written.
{
  const { rnh } = newRnh()
  const node = await rnh.put({
    id: 'n0000000000c5', name: 'unsynced', host: 'example.test', username: 'root',
    auth: { kind: 'password' }, password: 'not-a-real-secret',
  })
  markConnected(node)
  node.host.installPlugins = async () => ({ installed: [], copied: [], failed: [] })
  node.host.writeBrainBundle = async () => { throw new Error('the node stopped answering') }
  const reports = await rnh.syncConfig('test')
  check(reports.length === 1 && reports[0].error === 'the node stopped answering',
    'the report carries the failure', JSON.stringify(reports[0]))
  check(snapshot(node).state === NODE_STATE.FAILED,
    'and the node itself is `failed` rather than a green dot over an unsynced node',
    String(snapshot(node).state))
  check(snapshot(node).failure !== undefined,
    'with a classified failure, so the card can offer the right action',
    String(snapshot(node).failure?.code))
  rnh.dispose()
}

rmSync(sandbox, { recursive: true, force: true })
if (failed > 0) {
  process.stdout.write(`\n[recovery-ladder] FAILED: ${String(failed)} check(s)\n`)
  process.exitCode = 1
} else {
  process.stdout.write('\n[recovery-ladder] all checks passed\n')
}
