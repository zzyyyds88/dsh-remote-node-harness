/**
 * `host/node-status.js` — the node lifecycle as one discriminated union.
 *
 * No Host, no node, no clock, no timers: the module is pure, so every transition, every effect
 * and every invariant is asserted here. What this file exists for, in the order the checks run:
 *
 *   1. the seven kinds and the `state` compatibility mapping (`recovering` → `idle`);
 *   2. every event's transition, including the ones that used to be field assignments;
 *   3. the six cross-field invariants, from both directions: a hand-built illegal status is
 *      caught by `violationsOf`, and **every** status `reduce` produces is legal;
 *   4. the effect list — the reconnect ladder's delay is now data the reducer emits, so
 *      "the third attempt waits 8000 ms" and "cancelling a timer does not reset the rung" are
 *      asserted without a fake clock or a fake node;
 *   5. `describeStatus`'s field mapping (the old field names the client and the phone read);
 *   6. invariant 6 at the source level: `NodeRuntime.status` is assigned in exactly one place,
 *      and no `runtime.state = …`-style assignment survives anywhere in `src/`.
 *
 * Usage: node test/node-status-unit.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const {
  NODE_STATUS_KIND,
  STATE_BY_KIND,
  STATUS_EVENT,
  RECOVERY_LADDER_MS,
  RECOVERY_INTERVAL_MS,
  initialStatus,
  reduce,
  violationsOf,
  assertInvariants,
  describeStatus,
  recoveryDelayMs,
} = await import('../src/host/node-status.js')

let failed = 0
const check = (ok, label, detail) => {
  if (ok) {
    process.stdout.write(`[node-status] ok   ${label}\n`)
    return
  }
  failed += 1
  process.stdout.write(`[node-status] FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

/** A service payload, as `ensureServing` returns one. */
const SERVICE = Object.freeze({ port: 4100, token: 'tok', pid: 7, version: '0.6.7' })

/**
 * Drive a list of events from a start status and assert every intermediate status is legal.
 * @param {object} start
 * @param {Array<{ type: string }>} events
 * @param {number} [now]
 */
function run(start, events, now = 1_000) {
  let status = start
  /** @type {Array<{ status: object, effects: object[] }>} */
  const steps = []
  for (const event of events) {
    const reduced = reduce(status, event, { now })
    const problems = violationsOf(reduced.status)
    check(problems.length === 0,
      `reduce(${String(status.kind)}, ${event.type}) produces a legal status`,
      problems.join('; '))
    status = reduced.status
    steps.push(reduced)
  }
  return { status, steps }
}

/** A connected status, built the way the connect path builds it (no field assignment). */
function connectedStatus() {
  let status = initialStatus()
  for (const event of [
    { type: STATUS_EVENT.CONNECT_REQUESTED, phase: 'probe' },
    { type: STATUS_EVENT.PHASE_ENTERED, phase: 'start' },
    { type: STATUS_EVENT.SERVICE_STARTED, service: SERVICE },
    { type: STATUS_EVENT.CONNECT_SUCCEEDED, service: SERVICE },
  ]) status = reduce(status, event, { now: 1 }).status
  return status
}

/** A recovering status at rung `attempt`. */
function recoveringStatus(attempt = 0, droppedAt = 500) {
  const status = {
    kind: NODE_STATUS_KIND.RECOVERING,
    droppedAt,
    attempt,
    nextAt: droppedAt + recoveryDelayMs(attempt),
  }
  // Round-trip through the module's own validation, so a fixture that is not a legal status
  // fails here rather than in the assertion it was meant to support.
  assertInvariants(status)
  return status
}

// ---- 1. the vocabulary ----------------------------------------------------
{
  const kinds = Object.values(NODE_STATUS_KIND)
  check(kinds.length === 7,
    'the lifecycle has seven kinds (idle, connecting, connected, recovering, failed, stopping, terminated)',
    kinds.join(','))
  check(initialStatus().kind === NODE_STATUS_KIND.IDLE && violationsOf(initialStatus()).length === 0,
    'a fresh runtime starts in a legal `idle`')
  check(Object.isFrozen(initialStatus()), 'the initial status is frozen, so a caller cannot mutate it')
  check(STATE_BY_KIND[NODE_STATUS_KIND.RECOVERING] === 'idle',
    '`recovering` projects `state: "idle"` — the pair the shipped client already renders as "reconnecting"',
    STATE_BY_KIND[NODE_STATUS_KIND.RECOVERING])
  check(STATE_BY_KIND[NODE_STATUS_KIND.STOPPING] === 'stopping'
    && STATE_BY_KIND[NODE_STATUS_KIND.TERMINATED] === 'terminated',
    '`stopping` and `terminated` are the two new values in the public `state` vocabulary')
  check(STATE_BY_KIND[NODE_STATUS_KIND.CONNECTED] === 'connected'
    && STATE_BY_KIND[NODE_STATUS_KIND.CONNECTING] === 'connecting'
    && STATE_BY_KIND[NODE_STATUS_KIND.FAILED] === 'failed',
    'and no existing value was renamed')
  check(JSON.stringify(RECOVERY_LADDER_MS) === JSON.stringify([2_000, 4_000, 8_000])
    && RECOVERY_INTERVAL_MS === 120_000,
    'the ladder is 2 s / 4 s / 8 s then every two minutes')
}

// ---- 2. every transition --------------------------------------------------
{
  // connect: idle → connecting with the first phase and the clock the card shows.
  const requested = reduce(initialStatus(), { type: STATUS_EVENT.CONNECT_REQUESTED, phase: 'probe' }, { now: 111 })
  check(requested.status.kind === NODE_STATUS_KIND.CONNECTING
    && requested.status.phase.name === 'probe' && requested.status.phase.startedAt === 111,
    'connect-requested enters `connecting` with a stamped phase',
    JSON.stringify(requested.status))
  check(requested.effects.some(effect => effect.type === 'cancelTimer'),
    'and cancels a pending ladder timer without touching the rung')
  check(requested.effects.some(effect => effect.type === 'publish'),
    'and publishes the new state to the settings surface')

  // A forced reconnect from `connected` must **not** keep the old endpoint.
  const forced = reduce(connectedStatus(), { type: STATUS_EVENT.CONNECT_REQUESTED, phase: 'probe' }, { now: 222 })
  check(forced.status.kind === NODE_STATUS_KIND.CONNECTING && forced.status.service === undefined,
    'a forced connect drops the old service instead of leaving it next to `connecting`',
    JSON.stringify(forced.status))
  check(forced.status.via === undefined,
    'and does not claim a runtime route it has not re-established')

  // phases: only connecting carries the field; a transfer belongs to the phase it arrived in.
  const phased = reduce(
    { ...requested.status, transfer: { bytes: 1, total: 2 } },
    { type: STATUS_EVENT.PHASE_ENTERED, phase: 'install' },
    { now: 333 },
  )
  check(phased.status.phase.name === 'install' && phased.status.phase.startedAt === 333,
    'phase-entered moves the step and restamps its clock')
  check(phased.status.transfer === undefined,
    'and drops the previous phase\u2019s transfer numbers rather than showing them under the new step')

  const transferred = reduce(phased.status, { type: STATUS_EVENT.TRANSFER_UPDATED, transfer: { bytes: 5 } })
  check(transferred.status.transfer.bytes === 5, 'transfer-updated carries live byte counts')
  check(transferred.effects.some(effect => effect.type === 'publish'),
    'and republishes, so the bar moves')

  const gated = reduce(transferred.status, { type: STATUS_EVENT.GATE_DECIDED, gate: { action: 'refresh', reason: 'node-brain-missing' } })
  check(gated.status.gate.action === 'refresh',
    'gate-decided stores the version decision on the connecting status',
    JSON.stringify(gated.status.gate))
  check(reduce(gated.status, { type: STATUS_EVENT.RUNTIME_ROUTE_KNOWN, via: 'artefact' }).status.via === 'artefact',
    'runtime-route-known records how the tree arrived')
  check(reduce(gated.status, { type: STATUS_EVENT.RUNTIME_ROUTE_KNOWN }).status.via === undefined,
    'and an empty route is ignored instead of blanking the one that is already known')

  const started = reduce(gated.status, { type: STATUS_EVENT.SERVICE_STARTED, service: SERVICE })
  check(started.status.kind === NODE_STATUS_KIND.CONNECTING && started.status.pendingService.port === 4100,
    'service-started keeps the endpoint as `pendingService`, not as `service`',
    JSON.stringify(started.status))
  check(violationsOf(started.status).length === 0,
    'a started-but-unverified endpoint is not a `serving` claim (invariant 2 holds)')

  const succeeded = reduce(started.status, { type: STATUS_EVENT.CONNECT_SUCCEEDED, service: SERVICE, version: '22.0.0' })
  check(succeeded.status.kind === NODE_STATUS_KIND.CONNECTED && succeeded.status.service.port === 4100,
    'connect-succeeded turns the pending endpoint into the verified service')
  check(succeeded.status.phase === undefined && succeeded.status.pendingService === undefined,
    'and clears both the phase field and the unverified endpoint')
  check(succeeded.effects.some(effect => effect.type === 'persistOutcome' && effect.outcome.ok === true),
    'and writes the success into the durable node record')
  check(succeeded.effects.some(effect => effect.type === 'cancelTimer'),
    'and stops the ladder, because a success ends it')

  // A failure keeps the phase as a **payload** and carries the classified reason.
  const failedStatus = reduce(
    started.status,
    { type: STATUS_EVENT.CONNECT_FAILED, error: 'boom', failure: { code: 'runtime-install', action: 'retry' } },
  ).status
  check(failedStatus.kind === NODE_STATUS_KIND.FAILED && failedStatus.error === 'boom'
    && failedStatus.failure.code === 'runtime-install',
    'connect-failed keeps the sentence and the machine-readable code')
  check(failedStatus.phase !== undefined,
    'and keeps the phase that failed as a payload, so the card can still name the step',
    JSON.stringify(failedStatus.phase))
  check(violationsOf(failedStatus).length === 0,
    'a failed status with a phase payload is legal (invariant 1 is about the field, not the payload)')

  // Disconnect: a deliberate stop is `stopping` then `idle`, and clears every payload.
  const stopping = reduce(connectedStatus(), { type: STATUS_EVENT.DISCONNECT_REQUESTED })
  check(stopping.status.kind === NODE_STATUS_KIND.STOPPING,
    'disconnect-requested enters `stopping` before the slow host stop')
  check(stopping.effects.some(effect => effect.type === 'stopResidentHost'),
    'and asks for the resident host to be stopped')
  check(!stopping.effects.some(effect => effect.type === 'invalidateSocket'),
    'but does not drop the socket yet: the stop runs over it')
  const disconnected = reduce(stopping.status, { type: STATUS_EVENT.DISCONNECTED })
  check(disconnected.status.kind === NODE_STATUS_KIND.IDLE && violationsOf(disconnected.status).length === 0,
    'disconnected lands on plain `idle`')
  check(disconnected.effects.some(effect => effect.type === 'invalidateSocket'),
    'and only then drops the SSH socket, so the next connect handshakes afresh')
  check(!('error' in disconnected.status) && !('failure' in disconnected.status),
    'with no leftover error/failure, which is what used to render a red block over `idle`')
  check(reduce(disconnected.status, { type: STATUS_EVENT.DISCONNECTED }).status.kind === NODE_STATUS_KIND.IDLE,
    'a duplicate disconnect is ignored instead of crashing the teardown')

  // Termination: the plugin unloading releases the runtime for good.
  const terminated = reduce(connectedStatus(), { type: STATUS_EVENT.TERMINATE_REQUESTED })
  check(terminated.status.kind === NODE_STATUS_KIND.TERMINATED,
    'terminate-requested releases the runtime for good')
  check(terminated.effects.some(effect => effect.type === 'cancelTimer'),
    'and cancels the ladder timer')
  check(reduce(terminated.status, { type: STATUS_EVENT.CONNECT_REQUESTED }).status.kind === NODE_STATUS_KIND.TERMINATED,
    'a terminated runtime cannot be revived by a queued connect')
}

// ---- 3. a drop starts the quiet ladder -----------------------------------
{
  const drop = reduce(connectedStatus(), { type: STATUS_EVENT.DROP_DETECTED, at: 900 }, { now: 900 })
  check(drop.status.kind === NODE_STATUS_KIND.RECOVERING
    && drop.status.droppedAt === 900 && drop.status.attempt === 0,
    'a drop becomes `recovering` with the time and the first rung',
    JSON.stringify(drop.status))
  check(drop.status.nextAt === 900 + 2_000,
    'and names when the next attempt is due', String(drop.status.nextAt))
  const armed = drop.effects.find(effect => effect.type === 'armTimer')
  check(armed?.delayMs === 2_000, 'the reducer itself schedules the first rung (2000 ms)', JSON.stringify(armed))
  check(drop.effects.some(effect => effect.type === 'resetGateway'),
    'and drops the gateway state that pointed at the dead host')
  check(!('error' in drop.status),
    'a drop carries no error: nothing is misconfigured (invariant 3)')

  const disabled = reduce(connectedStatus(), { type: STATUS_EVENT.DROP_DETECTED, at: 900, recover: false })
  check(disabled.status.kind === NODE_STATUS_KIND.IDLE,
    'a **disabled** node goes to plain `idle`, not to a "reconnecting" that would say so forever')
  check(!disabled.effects.some(effect => effect.type === 'armTimer'),
    'and arms no timer')
}

// ---- 4. the ladder advances and never resets itself ----------------------
{
  // Rung 0 → 1 → 2 → 3, the way the Host drives it: the drop arms the first rung, the timer
  // starts an attempt (which advances the rung), the attempt fails, and the failure re-arms at
  // the rung the **next** attempt will use.
  const dropped = reduce(connectedStatus(), { type: STATUS_EVENT.DROP_DETECTED, at: 0 }, { now: 0 })
  let status = dropped.status
  /** @type {number[]} */
  const delays = [dropped.effects.find(effect => effect.type === 'armTimer')?.delayMs]
  /** @type {number[]} */
  const attempts = []
  for (let rung = 0; rung < 5; rung += 1) {
    status = reduce(status, { type: STATUS_EVENT.RECOVERY_ATTEMPT_STARTED, at: 0 }, { now: 0 }).status
    attempts.push(status.recovery.attempt)
    const miss = reduce(status, { type: STATUS_EVENT.RECOVERY_ATTEMPT_FAILED, error: 'unreachable', at: 0 }, { now: 0 })
    status = miss.status
    delays.push(miss.effects.find(effect => effect.type === 'armTimer')?.delayMs)
    check(status.kind === NODE_STATUS_KIND.RECOVERING,
      `rung ${String(rung)}: a missed attempt stays quiet in \`recovering\``, status.kind)
    check(status.lastError === 'unreachable',
      `rung ${String(rung)}: and keeps the reason in lastError, not in error`)
    check(violationsOf(status).length === 0, `rung ${String(rung)}: status is legal`)
  }
  check(JSON.stringify(attempts) === JSON.stringify([1, 2, 3, 4, 5]),
    'each attempt advances the rung by exactly one', JSON.stringify(attempts))
  check(JSON.stringify(delays) === JSON.stringify([2_000, 4_000, 8_000, 120_000, 120_000, 120_000]),
    'six scheduled waits walk 2 s → 4 s → 8 s → two minutes and stay there (D1)',
    JSON.stringify(delays))
  check(status.attempt === 5 && status.droppedAt === 0,
    'the rung and the original drop time survive every rearm',
    `${String(status.attempt)} / ${String(status.droppedAt)}`)

  // **The root cause of D1, asserted directly**: cancelling/rearming a timer is not the end of
  // the ladder. `RECOVERY_ATTEMPT_FAILED` cancels the old timer and arms a new one; the rung it
  // reads must be the one that already ran.
  const third = recoveringStatus(2, 400)
  const rearmed = reduce(third, { type: STATUS_EVENT.RECOVERY_ATTEMPT_FAILED, error: 'still down', at: 10 })
  check(rearmed.status.attempt === 2,
    'a rearm does not reset the rung (it stays 2, the rung the next attempt uses)',
    String(rearmed.status.attempt))
  check(rearmed.effects.some(effect => effect.type === 'cancelTimer')
    && rearmed.effects.some(effect => effect.type === 'armTimer' && effect.delayMs === 8_000),
    'and the third rung really is 8000 ms', JSON.stringify(rearmed.effects))
  check(rearmed.status.nextAt === 10 + 8_000,
    'the next-at stamp agrees with the armed delay', String(rearmed.status.nextAt))

  // A successful attempt ends the ladder, and nothing of it leaks into `connected`.
  const back = reduce(
    reduce(status, { type: STATUS_EVENT.RECOVERY_ATTEMPT_STARTED, at: 0 }, { now: 0 }).status,
    { type: STATUS_EVENT.CONNECT_SUCCEEDED, service: SERVICE },
  ).status
  check(back.kind === NODE_STATUS_KIND.CONNECTED
    && back.droppedAt === undefined && back.attempt === undefined && back.recovery === undefined,
    'a successful rung ends the ladder and drops the recovering payload',
    JSON.stringify(back))

  // Abandoning the ladder (node disabled / plugin unloading) is explicit, not a stuck state.
  const abandoned = reduce(status, { type: STATUS_EVENT.RECOVERY_ABANDONED })
  check(abandoned.status.kind === NODE_STATUS_KIND.IDLE
    && abandoned.effects.some(effect => effect.type === 'cancelTimer'),
    'abandoning the ladder clears the timer and lands on `idle`')
}

// ---- 5. config changes and syncs are events too -------------------------
{
  const changed = reduce(connectedStatus(), { type: STATUS_EVENT.CONFIG_CHANGED })
  check(changed.status.kind === NODE_STATUS_KIND.IDLE,
    'a changed host/credential downgrades a connected node instead of leaving it green over a dead socket')
  check(changed.effects.some(effect => effect.type === 'invalidateSocket'),
    'and drops the socket the changed handshake can no longer use')

  const refreshed = reduce(connectedStatus(), { type: STATUS_EVENT.SERVICE_REFRESHED, service: { ...SERVICE, port: 4200 } })
  check(refreshed.status.service.port === 4200 && refreshed.status.kind === NODE_STATUS_KIND.CONNECTED,
    'a restarted resident host updates the endpoint it is reachable on')
  check(refreshed.effects.some(effect => effect.type === 'resetGateway'),
    'and resets the gateway, whose cookie and carrier pointed at the old process')

  const syncFailed = reduce(connectedStatus(), { type: STATUS_EVENT.SYNC_FAILED, error: 'write failed', phase: 'provision' })
  check(syncFailed.status.kind === NODE_STATUS_KIND.FAILED && syncFailed.status.error === 'write failed',
    'a failed config sync becomes `failed` instead of leaving a green dot over an unsynced node')
  check(syncFailed.status.phase?.name === 'provision',
    'and names the step it failed in')

  const probed = reduce(connectedStatus(), { type: STATUS_EVENT.PROBE_FINISHED, ok: false, error: 'no route' })
  check(probed.status.kind === NODE_STATUS_KIND.CONNECTED,
    'a failed probe on a connected node is ignored: the SSH layer owns liveness and reports the drop (the ladder)')
  const probedIdle = reduce(initialStatus(), { type: STATUS_EVENT.PROBE_FINISHED, ok: false, error: 'no route' })
  check(probedIdle.status.kind === NODE_STATUS_KIND.FAILED && probedIdle.status.error === 'no route',
    'but a failed probe on an idle node is `failed`, with the reason')
  const probedRecovering = reduce(recoveringStatus(1), { type: STATUS_EVENT.PROBE_FINISHED, ok: false, error: 'x' })
  check(probedRecovering.status.kind === NODE_STATUS_KIND.RECOVERING,
    'and a probe during the ladder is ignored: the attempt reports its own outcome (D2)')
  check(reduce(initialStatus(), { type: STATUS_EVENT.PROBE_FINISHED, ok: true }).status.kind === NODE_STATUS_KIND.IDLE,
    'a successful probe changes no lifecycle fact')
}

// ---- 6. reinstall is an event, not a field write ------------------------
{
  const requested = reduce(connectedStatus(), { type: STATUS_EVENT.REINSTALL_REQUESTED }, { now: 55 })
  check(requested.status.kind === NODE_STATUS_KIND.CONNECTING
    && requested.status.phase.name === 'install' && requested.status.phase.startedAt === 55,
    'reinstall-requested enters `connecting`/`install` with a stamped clock',
    JSON.stringify(requested.status))
  check(requested.status.pendingService?.port === SERVICE.port,
    'and keeps the endpoint reachable, because the old process still answers while the tree is replaced')
  const finished = reduce(requested.status, { type: STATUS_EVENT.REINSTALL_FINISHED, service: { ...SERVICE, port: 4300 } })
  check(finished.status.kind === NODE_STATUS_KIND.CONNECTED && finished.status.service.port === 4300,
    'reinstall-finished lands on the **new** endpoint, so the card cannot show a pid whose modules were replaced')
  const failedReinstall = reduce(requested.status, { type: STATUS_EVENT.REINSTALL_FAILED, error: 'disk full' })
  check(failedReinstall.status.kind === NODE_STATUS_KIND.FAILED && failedReinstall.status.error === 'disk full',
    'a failed reinstall is a visible failure, not a silent revert to `idle`')
  check(reduce(initialStatus(), { type: STATUS_EVENT.REINSTALL_FINISHED }).status.kind === NODE_STATUS_KIND.IDLE,
    'a finish event that arrives when nothing is installing is ignored')
}

// ---- 7. the six invariants, from both directions ------------------------
{
  // Hand-built illegal statuses: each must be caught, and the message must name the rule.
  const illegal = [
    ['idle carrying a phase', { kind: 'idle', phase: { name: 'probe', startedAt: 1 } }],
    ['idle carrying a phaseStartedAt-like payload only', { kind: 'idle', phase: { name: '', startedAt: 1 } }],
    ['connecting without a phase', { kind: 'connecting' }],
    ['connecting with a service', { kind: 'connecting', phase: { name: 'start', startedAt: 1 }, service: SERVICE }],
    ['connected without a service', { kind: 'connected' }],
    ['connected with an error', { kind: 'connected', service: SERVICE, error: 'boom' }],
    ['failed without an error', { kind: 'failed', failure: { code: 'unknown' } }],
    ['failed without a failure payload', { kind: 'failed', error: 'boom' }],
    ['recovering without droppedAt', { kind: 'recovering', attempt: 0, nextAt: 1 }],
    ['recovering with an error instead of lastError', { kind: 'recovering', droppedAt: 1, attempt: 0, nextAt: 2, error: 'boom' }],
    ['idle carrying droppedAt', { kind: 'idle', droppedAt: 1 }],
    ['connected carrying droppedAt', { kind: 'connected', service: SERVICE, droppedAt: 1 }],
    ['connected carrying an attempt', { kind: 'connected', service: SERVICE, attempt: 2 }],
    ['recovering with a negative attempt', { kind: 'recovering', droppedAt: 1, attempt: -1, nextAt: 2 }],
    ['an unknown kind', { kind: 'exploded' }],
    ['a non-object', 'idle'],
    ['connecting with a recovery payload of attempt 0', { kind: 'connecting', phase: { name: 'probe', startedAt: 1 }, recovery: { droppedAt: 1, attempt: 0 } }],
    ['idle carrying a recovery payload', { kind: 'idle', recovery: { droppedAt: 1, attempt: 1 } }],
    ['connected with a malformed service', { kind: 'connected', service: { port: 'x' } }],
  ]
  for (const [label, status] of illegal) {
    const problems = violationsOf(status)
    check(problems.length > 0, `violationsOf catches: ${label}`, JSON.stringify(status))
  }
  let threw = false
  try {
    assertInvariants({ kind: 'connected' })
  } catch (error) {
    threw = String(error.message).includes('invariants')
  }
  check(threw, 'assertInvariants throws a named error instead of returning quietly')

  // The other direction: nothing the reducer can produce is ever illegal. Every event is tried
  // against every kind, which is also what proves the "event does not apply" paths keep the
  // status untouched rather than half-updating it.
  const statuses = [
    initialStatus(),
    { kind: 'connecting', phase: { name: 'probe', startedAt: 1 } },
    { kind: 'connecting', phase: { name: 'install', startedAt: 1 }, recovery: { droppedAt: 1, attempt: 2 } },
    connectedStatus(),
    recoveringStatus(0),
    recoveringStatus(3),
    { kind: 'failed', phase: { name: 'install', startedAt: 1 }, error: 'boom', failure: { code: 'runtime-install' } },
    { kind: 'failed', error: 'boom', failure: { code: 'unknown' } },
    { kind: 'stopping' },
    { kind: 'terminated' },
  ]
  const events = Object.values(STATUS_EVENT).map(type => ({ type }))
  let combos = 0
  for (const start of statuses) {
    for (const event of events) {
      const reduced = reduce(start, event, { now: 5 })
      combos += 1
      const problems = violationsOf(reduced.status)
      if (problems.length > 0) {
        check(false, `reduce(${start.kind}, ${event.type}) is legal`, problems.join('; '))
      }
    }
  }
  check(true, `every reducer output is legal (${String(combos)} kind×event combinations)`)

  // Unknown events and effects are programming errors, and must not be silently ignored.
  let unknownEvent = undefined
  try {
    reduce(initialStatus(), { type: 'no-such-event' })
  } catch (error) {
    unknownEvent = error
  }
  check(unknownEvent instanceof TypeError && String(unknownEvent.message).includes('no-such-event'),
    'an unknown event name throws instead of being ignored', String(unknownEvent?.message))
}

// ---- 8. the projection keeps every field name the clients read ----------
{
  const connected = describeStatus(connectedStatus(), { id: 'n0000000000aa', name: 'probe' })
  check(connected.kind === 'connected' && connected.state === 'connected',
    'a connected snapshot carries both the new `kind` and the old `state`',
    `${String(connected.kind)}/${String(connected.state)}`)
  check(connected.serving?.port === SERVICE.port && connected.serving?.version === SERVICE.version,
    '`serving` is projected from `connected.service` (port + version, as before)',
    JSON.stringify(connected.serving))
  check(connected.id === 'n0000000000aa' && connected.name === 'probe',
    'and the non-lifecycle extras are passed through untouched')

  const recovering = describeStatus(recoveringStatus(2, 700), {})
  check(recovering.kind === 'recovering' && recovering.state === 'idle',
    'a recovering snapshot reports `kind: recovering` and the compatible `state: idle`')
  check(recovering.droppedAt === 700 && recovering.recoveryAttempts === 2,
    'with `droppedAt` and the rung under their old field names',
    `${String(recovering.droppedAt)} / ${String(recovering.recoveryAttempts)}`)
  check(recovering.error === undefined && recovering.failure === undefined,
    'and no error/failure, which is what keeps the card from going red while it retries')

  const midLadder = describeStatus({
    kind: 'connecting',
    phase: { name: 'probe', startedAt: 12 },
    recovery: { droppedAt: 700, attempt: 3 },
  }, {})
  check(midLadder.state === 'connecting' && midLadder.phase === 'probe' && midLadder.phaseStartedAt === 12,
    'an in-flight ladder attempt still shows its phase and clock')
  check(midLadder.droppedAt === 700 && midLadder.recoveryAttempts === 3,
    'and still reports "reconnecting since … / attempt 3" from the nested carrier',
    `${String(midLadder.droppedAt)} / ${String(midLadder.recoveryAttempts)}`)

  const failed = describeStatus({
    kind: 'failed',
    phase: { name: 'install', startedAt: 34 },
    error: 'boom',
    failure: { code: 'runtime-install', action: 'retry' },
    via: 'artefact',
  }, {})
  check(failed.state === 'failed' && failed.phase === 'install' && failed.phaseStartedAt === 34,
    'a failed snapshot still names the step and its duration (the payload projection)',
    `${String(failed.phase)}/${String(failed.phaseStartedAt)}`)
  check(failed.error === 'boom' && failed.failure.code === 'runtime-install',
    'and carries both the sentence and the classified failure')
  check(failed.runtimeVia === 'artefact', 'and the runtime route it last used')

  const idle = describeStatus(initialStatus(), {})
  check(idle.state === 'idle' && idle.phase === undefined && idle.serving === undefined
    && idle.error === undefined && idle.droppedAt === undefined && idle.recoveryAttempts === undefined,
    'a healthy idle snapshot expands nothing, exactly as the old `describe()` did',
    JSON.stringify(idle))

  const stopped = describeStatus({ kind: 'stopping' }, {})
  check(stopped.state === 'stopping' && stopped.kind === 'stopping',
    '`stopping` reaches the clients as its own value')
}

// ---- 9. purity and invariant 6, at the source level --------------------
{
  // Purity: the reducer must not read the wall clock or arm timers itself. The clock arrives in
  // `context`, so a fixed clock gives a byte-identical result.
  const first = reduce(connectedStatus(), { type: STATUS_EVENT.DROP_DETECTED }, { now: 42 })
  const second = reduce(connectedStatus(), { type: STATUS_EVENT.DROP_DETECTED }, { now: 42 })
  check(JSON.stringify(first) === JSON.stringify(second),
    'reduce is deterministic for a fixed clock')
  check(first.status.droppedAt === 42,
    'and takes its timestamps from the injected clock, not from Date.now()')

  // The reducer must not mutate the status it was given.
  const before = connectedStatus()
  const frozen = JSON.stringify(before)
  reduce(before, { type: STATUS_EVENT.CONNECT_REQUESTED, phase: 'probe' }, { now: 1 })
  check(JSON.stringify(before) === frozen, 'reduce never mutates its input status')

  // Invariant 6: state changes only through `reduce`. There are exactly two assignments to a
  // `NodeRuntime.status` (the initial value and the one inside `dispatch`), and the old mutable
  // lifecycle fields are gone from every module that drives a runtime — a `runtime.state = …`
  // would be the beginning of the same drift.
  const here = dirname(fileURLToPath(import.meta.url))
  const src = join(here, '..', 'src')

  const rnhSource = readFileSync(join(src, 'host', 'rnh.js'), 'utf8')
  const statusAssignments = rnhSource.split('\n').filter(line => /^\s*this\.status\s*=/u.test(line)
    || /^\s*runtime\.status\s*=/u.test(line)).map(line => line.trim())
  check(statusAssignments.length === 2
    && statusAssignments.includes('this.status = initialStatus()')
    && statusAssignments.includes('this.status = reduced.status'),
    'the only two assignments to a runtime status are the initial value and the one inside dispatch()',
    statusAssignments.join(' | '))
  check(/dispatch\(event[\s\S]{0,200}this\.status = reduced\.status/u.test(rnhSource),
    'and the changing one is inside dispatch(), next to reduce()')

  // Scoped to the modules that operate on a `NodeRuntime`. `host/routing.js` and
  // `remote/daemon.js` have their own unrelated `this.error` / `this.serving` fields (a stream
  // and a resident-host handle), so they are not evidence either way.
  const lifecycleModules = ['host/rnh.js', 'host/rnh-control.js', 'host/remote-workspaces.js', 'index.js']
  const legacyField = /(?:runtime|node)\.(state|phase|phaseStartedAt|serving|error|failure|droppedAt|recoveryAttempts|transfer|gate|runtimeVia)\s*=(?!=)/u
  const offenders = []
  for (const relative of lifecycleModules) {
    const text = readFileSync(join(src, relative), 'utf8')
    for (const line of text.split('\n')) {
      if (legacyField.test(line)) offenders.push(`${relative}: ${line.trim()}`)
    }
  }
  check(offenders.length === 0,
    'no module that drives a NodeRuntime assigns the removed lifecycle fields directly (invariant 6)',
    offenders.slice(0, 5).join(' | '))
}

// ---- 10. the Host re-exports the ladder ---------------------------------
{
  const rnh = await import('../src/host/rnh.js')
  check(typeof rnh.recoveryDelayMs === 'function' && rnh.recoveryDelayMs(2) === 8_000,
    'rnh.js re-exports recoveryDelayMs, which is what recovery-ladder-unit drives',
    String(rnh.recoveryDelayMs?.(2)))
  check(rnh.NODE_STATE.STOPPING === 'stopping' && rnh.NODE_STATE.TERMINATED === 'terminated',
    'and NODE_STATE names the new projected values')
  check(rnh.NODE_STATE.IDLE === 'idle' && rnh.NODE_STATE.CONNECTING === 'connecting'
    && rnh.NODE_STATE.CONNECTED === 'connected' && rnh.NODE_STATE.FAILED === 'failed',
    'while keeping the four it always had')
  check(typeof rnh.describeForTool === 'function', 'describeForTool is the single tool-facing projection')
}

if (failed > 0) {
  process.stdout.write(`\n[node-status] FAILED: ${String(failed)} check(s)\n`)
  process.exitCode = 1
} else {
  process.stdout.write('\n[node-status] all checks passed\n')
}
