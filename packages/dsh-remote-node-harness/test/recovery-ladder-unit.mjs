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
// Ended offline with six schedules all at 2000. This drives `#scheduleRecovery` itself: a fake
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
    // `#scheduleRecovery` calls `unref()` so a laptop lid closing cannot hold the app open.
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

    // A connected node drops, which is the only way the ladder starts.
    node.state = NODE_STATE.CONNECTED
    node.serving = { port: 1, token: 't', pid: 1, version: '0.0.0-test' }
    node.connection.target.onDrop?.()
    check(node.recoveryTimer !== undefined, 'the ladder is armed by a drop', String(node.recoveryTimer))
    check(scheduled.length === 1, 'exactly one timer is pending', String(scheduled.length))

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
    check(node.recoveryAttempts === 6, 'and the rung counter advanced with the ladder',
      String(node.recoveryAttempts))
    check(node.state === NODE_STATE.IDLE && node.droppedAt !== undefined,
      'a run of failed reconnects stays `idle` + `droppedAt`, not `failed` (D2 fixed)',
      `${String(node.state)}, droppedAt=${String(node.droppedAt)}`)
    check(node.error === undefined && node.failure === undefined,
      'and the card is not given a red failure to show while the ladder keeps trying',
      `${String(node.error)} / ${String(node.failure?.code)}`)
    rnh.dispose()
    check(node.recoveryTimer === undefined, 'dispose() cancels the pending rung')
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
}

// ---- 3. cancelling a timer does not forget the rung ------------------------
// The root cause of D1. `#cancelRecovery` is private, but `dispose()` is one of its two
// callers and a public entry point, so the contract is observable: stop the timer, keep the
// rung. If this assertion ever fails the ladder is self-zeroing again.
{
  const { rnh } = newRnh()
  const node = await rnh.put({
    id: 'n0000000000bc', name: 'rung', host: 'example.test', username: 'root',
    auth: { kind: 'password' }, password: 'not-a-real-secret',
  })
  node.recoveryAttempts = 2
  node.recoveryTimer = setTimeout(() => {}, 60_000)
  rnh.dispose()
  check(node.recoveryTimer === undefined, 'dispose() clears the timer')
  check(node.recoveryAttempts === 2,
    'but leaves the rung at 2 — cancelling a timer is not the end of the ladder (D1 root cause)',
    String(node.recoveryAttempts))
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
  node.state = NODE_STATE.IDLE
  node.droppedAt = Date.now()
  node.recoveryAttempts = 3
  node.recoveryTimer = setTimeout(() => {}, 60_000)
  node.host.stop = async () => {}

  await rnh.disconnect(node)
  check(node.recoveryAttempts === 0,
    'pressing Disconnect puts the ladder back to the first rung',
    String(node.recoveryAttempts))
  check(node.recoveryTimer === undefined, 'and clears its timer')
  check(node.droppedAt === undefined, 'and forgets the drop, because the person asked for this')
  rnh.dispose()
}

// ---- 5. a failed ladder attempt is quiet; a failed manual connect is not ---
// The state semantics D2 decides: `failed` means "the app stopped trying and something is
// wrong"; an in-flight ladder attempt is `idle` + `droppedAt`, with the reason only in the
// node's own log. Nothing here reaches SSH: a node with no stored credential throws before
// the handshake.
{
  const { rnh } = newRnh()
  const node = await rnh.put({
    id: 'n0000000000be', name: 'credentialless', host: 'example.test', username: 'root',
    auth: { kind: 'password' },
  })
  check(node.describe().credentialsReady === false,
    'the fixture has no stored credential, so connect fails before the network')

  // What a drop leaves behind.
  node.state = NODE_STATE.CONNECTED
  node.serving = { port: 1, token: 't', pid: 1, version: '0.0.0-test' }
  node.connection.target.onDrop?.()
  const droppedAt = node.droppedAt
  check(typeof droppedAt === 'number', 'the fixture is dropped and reconnecting', String(droppedAt))

  await rnh.connect(node, { recovering: true }).catch(() => undefined)
  check(node.state === NODE_STATE.IDLE,
    'a failed ladder attempt leaves the node in `idle` (D2)', String(node.state))
  check(node.droppedAt === droppedAt, 'and keeps the time of the drop, so the card can say "since …"',
    String(node.droppedAt))
  check(node.error === undefined && node.failure === undefined,
    'and reports no error, because the ladder is still trying',
    `${String(node.error)} / ${String(node.failure?.code)}`)
  check(node.describe().droppedAt !== undefined && node.describe().failure === undefined,
    'the settings snapshot agrees: reconnecting, not failed')
  check(node.phase === undefined,
    'the failed attempt\u2019s phase is not left on a card that is merely waiting',
    String(node.phase))

  // A manual Connect is the opposite: it stops trying and must say why.
  await rnh.connect(node).catch(() => undefined)
  check(node.state === NODE_STATE.FAILED,
    'a failed manual connect is `failed`, so the card goes red and offers Retry',
    String(node.state))
  check(node.failure?.code === 'credential-missing',
    'and carries the classified reason, not just a sentence',
    String(node.failure?.code))
  check(node.error !== undefined, 'and the sentence for the bug report', String(node.error))
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
  check(described.state === NODE_STATE.IDLE,
    'connect() after dispose is a no-op instead of dialling into a dead plugin', String(described.state))
  check(node.state !== NODE_STATE.CONNECTING && node.state !== NODE_STATE.FAILED,
    'and it did not even enter a connect phase', String(node.state))
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
  check(node.describe().credentialsReady === true,
    'so the node reports a usable credential and connect() will attempt the SSH agent',
    String(node.describe().credentialsReady))
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

rmSync(sandbox, { recursive: true, force: true })
if (failed > 0) {
  process.stdout.write(`\n[recovery-ladder] FAILED: ${String(failed)} check(s)\n`)
  process.exitCode = 1
} else {
  process.stdout.write('\n[recovery-ladder] all checks passed\n')
}
