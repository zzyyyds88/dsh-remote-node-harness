/**
 * One node's lifecycle, as a **discriminated union**.
 *
 * Before this module the same lifecycle was spread over a dozen independent mutable fields on
 * `NodeRuntime` (`state`, `phase`, `phaseStartedAt`, `error`, `failure`, `serving`, `droppedAt`,
 * `recoveries`, `recoveryAttempts`, `transfer`, `gate`, `provision`, …) and the only thing tying
 * them together was `describe()` expanding whatever happened to be non-undefined. Every
 * cross-field invariant was therefore an unwritten convention, and the ones that broke were
 * measured, not guessed:
 *
 *   - `connect({ force: true })` left `state: 'connecting'` next to the **old** `serving`,
 *     so the node was reported routable while it was being torn down;
 *   - `put()` changed a host or credential on a connected node and left `state: 'connected'`
 *     with the dead port still in `serving`;
 *   - `disconnect()` cleared `failure` but not `error`, so `idle` rendered a red failure block;
 *   - a reinstall route wrote `phase` directly, outside the serial queue, without the clock.
 *
 * The fix is structural: **the lifecycle is one value**, and it can only change through
 * `reduce(status, event, context)`. Everything else — timers, sockets, gateways, the node's
 * resident host — is an *effect* the caller carries out, so a reducer stays a pure function
 * (no IO, no timers, no clock) and the transitions are unit-testable without a node.
 *
 * ```js
 * status =
 *   | { kind: 'idle' }
 *   | { kind: 'connecting', phase: { name, startedAt }, transfer?, via?, gate?,
 *       pendingService?, recovery?: { droppedAt, attempt } }
 *   | { kind: 'connected', service: { port, token, pid, version }, via?, gate? }
 *   | { kind: 'recovering', droppedAt, attempt, nextAt, lastError? }
 *   | { kind: 'failed', phase?: { name, startedAt }, error, failure, via? }
 *   | { kind: 'stopping' }
 *   | { kind: 'terminated' }
 * ```
 *
 * Two payloads are not part of the six invariants but are part of one kind:
 *
 *   - `connecting.pendingService` is the resident endpoint that has been started but is **not
 *     verified yet** (the gateway needs it to mint a cookie); it is deliberately not `service`,
 *     so `serving` still means "connected" and nothing else;
 *   - `connecting.recovery` is the in-flight reconnect attempt: the ladder's `droppedAt` and
 *     `attempt` have to survive the transition into `connecting` (otherwise "attempt 2 of 3"
 *     became "attempt 1" every rung), but they are **not** top-level state fields — invariant 4
 *     is about the status field `droppedAt`, and the projection reads both carriers so the
 *     settings page keeps seeing `state: 'connecting'` + `droppedAt` while a rung runs, exactly
 *     as it did before this module existed.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/node-status
 */

/** The seven lifecycle kinds. `kind` is the discriminator on every status value. */
export const NODE_STATUS_KIND = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  /** Dropped on its own and waiting for / running a reconnect attempt. */
  RECOVERING: 'recovering',
  FAILED: 'failed',
  /** A deliberate teardown is in progress (disconnect). */
  STOPPING: 'stopping',
  /** The runtime was released for good (plugin unload). */
  TERMINATED: 'terminated',
})

/**
 * The public `state` value each kind reports.
 *
 * `recovering` reports `idle`. That is a **compatibility decision, written down on purpose**:
 * both the settings page and the phone (DSH Go through the relay) read `state` and only know
 * `idle` / `connecting` / `connected` / `failed`. The settings page already renders
 * "disconnected, reconnecting" from `state: 'idle'` + `droppedAt`, which is why `recovering`
 * maps onto exactly that pair instead of introducing a fifth value to clients that were not
 * changed in this batch. `kind` is the new, lossless field; `state` stays the four-value
 * vocabulary it always was for this one kind.
 *
 * `stopping` and `terminated` **are** new values in `state`. They are only visible for the
 * duration of a teardown (and after the plugin unloaded, when no page can be reading), and an
 * old client that does not know them falls back to its `idle` rendering, which is what a
 * tearing-down node honestly is. No old value was renamed or removed.
 */
export const STATE_BY_KIND = Object.freeze({
  [NODE_STATUS_KIND.IDLE]: 'idle',
  [NODE_STATUS_KIND.CONNECTING]: 'connecting',
  [NODE_STATUS_KIND.CONNECTED]: 'connected',
  [NODE_STATUS_KIND.RECOVERING]: 'idle',
  [NODE_STATUS_KIND.FAILED]: 'failed',
  [NODE_STATUS_KIND.STOPPING]: 'stopping',
  [NODE_STATUS_KIND.TERMINATED]: 'terminated',
})

/**
 * How long each rung of the reconnect ladder waits, in order.
 *
 * Three quick tries for the common case (a machine that rebooted), then the steady interval
 * below. Measured against the real node: a `systemctl restart ssh` comes back in about two
 * seconds, so the first attempt almost always succeeds; a full reboot took 21 s, which lands on
 * the third or fourth.
 */
export const RECOVERY_LADDER_MS = Object.freeze([2_000, 4_000, 8_000])

/** The interval between reconnect attempts once the quick ladder is exhausted. */
export const RECOVERY_INTERVAL_MS = 120_000

/**
 * How long rung `attempt` of the reconnect ladder waits, in milliseconds.
 *
 * `attempt` is **the rung the next attempt will use** (0-based): 0 → 2 s, 1 → 4 s, 2 → 8 s,
 * 3+ → two minutes. Negative or fractional values are not meaningful; they fall back to the
 * first delay so `setTimeout` never receives `NaN`. A rung past the end of the quick ladder
 * keeps the steady interval rather than wrapping back to two seconds.
 *
 * @param {number} attempt
 * @returns {number}
 */
export function recoveryDelayMs(attempt) {
  if (!Number.isInteger(attempt) || attempt < 0) return RECOVERY_LADDER_MS[0]
  return attempt < RECOVERY_LADDER_MS.length ? RECOVERY_LADDER_MS[attempt] : RECOVERY_INTERVAL_MS
}

/** Every event the lifecycle understands. Only these may change a status. */
export const STATUS_EVENT = Object.freeze({
  /** A person (or `autoConnect`) asked for a connection; not a ladder attempt. */
  CONNECT_REQUESTED: 'connect-requested',
  /** The connect flow moved to another step of the five-step timeline. */
  PHASE_ENTERED: 'phase-entered',
  /** Live download numbers for the runtime archive, or `undefined` to clear them. */
  TRANSFER_UPDATED: 'transfer-updated',
  /** The version gate decided what this connect has to do. */
  GATE_DECIDED: 'gate-decided',
  /** The route the installed runtime arrived by was read (or the tree was just installed). */
  RUNTIME_ROUTE_KNOWN: 'runtime-route-known',
  /** The resident host answered with its endpoint; not verified yet. */
  SERVICE_STARTED: 'service-started',
  /** The gateway proved it answers: the node is routable. */
  CONNECT_SUCCEEDED: 'connect-succeeded',
  /** A **manual** connect stopped trying; the card has to say why. */
  CONNECT_FAILED: 'connect-failed',
  /** The SSH socket closed on its own. */
  DROP_DETECTED: 'drop-detected',
  /** The ladder timer fired and this attempt began. */
  RECOVERY_ATTEMPT_STARTED: 'recovery-attempt-started',
  /** A ladder attempt failed; stay quiet and rearm. */
  RECOVERY_ATTEMPT_FAILED: 'recovery-attempt-failed',
  /** The ladder has to stop (node disabled, plugin unloading). */
  RECOVERY_ABANDONED: 'recovery-abandoned',
  /** A stored setting that the handshake depends on changed. */
  CONFIG_CHANGED: 'config-changed',
  /** A config sync restarted the resident host; the endpoint moved. */
  SERVICE_REFRESHED: 'service-refreshed',
  /** A config sync failed after the node was already connected. */
  SYNC_FAILED: 'sync-failed',
  DISCONNECT_REQUESTED: 'disconnect-requested',
  DISCONNECTED: 'disconnected',
  /** A manual reachability probe answered; `ok: false` carries the failure. */
  PROBE_FINISHED: 'probe-finished',
  REINSTALL_REQUESTED: 'reinstall-requested',
  REINSTALL_FINISHED: 'reinstall-finished',
  REINSTALL_FAILED: 'reinstall-failed',
  /** The plugin is unloading: the runtime is released for good. */
  TERMINATE_REQUESTED: 'terminate-requested',
})

/** Shared effect records; they carry no per-transition data and are frozen so a reducer cannot
 *  accidentally mutate one and change another transition's meaning. */
const PUBLISH = Object.freeze({ type: 'publish' })
const CANCEL_TIMER = Object.freeze({ type: 'cancelTimer' })
const INVALIDATE_SOCKET = Object.freeze({ type: 'invalidateSocket' })
const RESET_GATEWAY = Object.freeze({ type: 'resetGateway' })
const STOP_RESIDENT_HOST = Object.freeze({ type: 'stopResidentHost' })

/** An effect that publishes the new status to the settings surface and the sidebar. */
const publish = () => PUBLISH
/** An effect that clears the reconnect timer. It deliberately does **not** touch `attempt`. */
const cancelTimer = () => CANCEL_TIMER
/** An effect that drops the SSH socket so the next connect handshakes afresh. */
const invalidateSocket = () => INVALIDATE_SOCKET
/** An effect that drops the gateway's cookie, carrier and logical streams. */
const resetGateway = () => RESET_GATEWAY
/** An effect that stops the node's resident host (slow: SSH round trips). */
const stopResidentHost = () => STOP_RESIDENT_HOST

/**
 * @typedef {{ type: 'armTimer', delayMs: number }} ArmTimerEffect
 * @typedef {{ type: 'persistOutcome', outcome: { ok: boolean, version?: string, error?: string } }} PersistOutcomeEffect
 * @typedef {{ type: 'log', message: string }} LogEffect
 * @typedef {{ type: 'publish' } | { type: 'cancelTimer' } | { type: 'invalidateSocket' }
 *   | { type: 'resetGateway' } | { type: 'stopResidentHost' } | ArmTimerEffect
 *   | PersistOutcomeEffect | LogEffect} NodeStatusEffect
 */

/** Arm the reconnect timer. `delayMs` comes from `recoveryDelayMs(attempt)`, never a literal. */
const armTimer = delayMs => ({ type: 'armTimer', delayMs })
/** Write the outcome into the durable node record (`lastConnectedAt` / `lastError`). */
const persistOutcome = outcome => ({ type: 'persistOutcome', outcome })
/** Append one line to the node's own log (the interpreter prefixes the node name). */
const log = message => ({ type: 'log', message })

/** The status every runtime starts in. */
export function initialStatus() {
  return Object.freeze({ kind: NODE_STATUS_KIND.IDLE })
}

/** Whether one value is the `{ name, startedAt }` phase payload. */
function isPhase(value) {
  return value !== null && typeof value === 'object'
    && typeof value.name === 'string' && value.name.length > 0
    && typeof value.startedAt === 'number' && Number.isFinite(value.startedAt)
}

/** Whether one value is the `{ port, token, pid, version }` service payload. */
function isService(value) {
  return value !== null && typeof value === 'object'
    && Number.isInteger(value.port) && value.port >= 0
    && typeof value.token === 'string'
}

/**
 * The six cross-field invariants, checked structurally.
 *
 * Returns a list of human-readable violations; an empty list means the status is well formed.
 * Kept as a list rather than a boolean because a test that constructs a broken status wants to
 * read *which* rule it broke, and because `assertInvariants` is just the throwing wrapper.
 *
 * The six rules (design doc §六):
 *
 *   1. `phase` exists **iff** `kind === 'connecting'`. A failure keeps its last phase as a
 *      **payload** (`failed.phase`), which this checker accepts only in that shape and only on
 *      `failed` — that is the difference between "the card can still say which step failed" and
 *      "a state field leaked onto a state that does not own it".
 *   2. `service` exists **iff** `kind === 'connected'`.
 *   3. `error` (and its classified `failure`) exists **iff** `kind === 'failed'`. A recovering
 *      node's reason lives in `lastError`, so the settings page cannot render a red failure
 *      block for a node that is merely waiting.
 *   4. `droppedAt` exists **iff** `kind === 'recovering'`. The in-flight ladder attempt carries
 *      the same time inside `connecting.recovery`, never as the status field.
 *   5. `attempt` only exists on `recovering` (and inside `connecting.recovery`); it is not
 *      reset when a timer is cancelled or rearmed — that is a property of `reduce`, asserted by
 *      the unit tests rather than by this structural check.
 *   6. "state changes only through `reduce`" is not a property of a single value; it is checked
 *      by `node-status-unit.mjs` against the source of `rnh.js` (one assignment to
 *      `NodeRuntime.status`, inside `dispatch`).
 *
 * @param {unknown} status
 * @returns {string[]}
 */
export function violationsOf(status) {
  /** @type {string[]} */
  const problems = []
  if (status === null || typeof status !== 'object') return ['status is not an object']
  const kind = Reflect.get(status, 'kind')
  if (!Object.values(NODE_STATUS_KIND).includes(kind)) {
    return [`unknown status kind ${JSON.stringify(kind)}`]
  }

  // 1. phase: the field only on `connecting`; the payload only on `failed`.
  const phase = Reflect.get(status, 'phase')
  if (kind === NODE_STATUS_KIND.CONNECTING) {
    if (!isPhase(phase)) problems.push(`connecting requires a { name, startedAt } phase, got ${JSON.stringify(phase)}`)
  } else if (kind === NODE_STATUS_KIND.FAILED) {
    if (phase !== undefined && !isPhase(phase)) problems.push(`failed.phase must be a { name, startedAt } payload, got ${JSON.stringify(phase)}`)
  } else if (phase !== undefined) {
    problems.push(`${kind} must not carry phase`)
  }

  // 2. service: connected only. The in-progress endpoint is `pendingService`.
  const service = Reflect.get(status, 'service')
  if ((service !== undefined) !== (kind === NODE_STATUS_KIND.CONNECTED)) {
    problems.push(service === undefined
      ? 'connected requires a service payload'
      : `${kind} must not carry service`)
  } else if (service !== undefined && !isService(service)) {
    problems.push(`service must be a { port, token, pid, version } payload, got ${JSON.stringify(service)}`)
  }
  const pending = Reflect.get(status, 'pendingService')
  if (pending !== undefined) {
    if (kind !== NODE_STATUS_KIND.CONNECTING) problems.push(`${kind} must not carry pendingService`)
    else if (!isService(pending)) problems.push(`pendingService must be a service payload, got ${JSON.stringify(pending)}`)
  }

  // 3. error/failure: failed only. Recovering carries `lastError`.
  const error = Reflect.get(status, 'error')
  const failure = Reflect.get(status, 'failure')
  if ((error !== undefined) !== (kind === NODE_STATUS_KIND.FAILED)) {
    problems.push(error === undefined
      ? 'failed requires the error sentence'
      : `${kind} must not carry error (a recovering node uses lastError)`)
  }
  if ((failure !== undefined) !== (kind === NODE_STATUS_KIND.FAILED)) {
    problems.push(failure === undefined
      ? 'failed requires the classified failure payload'
      : `${kind} must not carry failure`)
  }
  if (failure !== undefined && (failure === null || typeof failure !== 'object' || typeof failure.code !== 'string')) {
    problems.push(`failure must carry a machine-readable code, got ${JSON.stringify(failure)}`)
  }

  // 4. droppedAt: recovering only as a status field.
  const droppedAt = Reflect.get(status, 'droppedAt')
  if ((droppedAt !== undefined) !== (kind === NODE_STATUS_KIND.RECOVERING)) {
    problems.push(droppedAt === undefined
      ? 'recovering requires droppedAt'
      : `${kind} must not carry droppedAt (a ladder attempt keeps it in connecting.recovery)`)
  } else if (droppedAt !== undefined && !(typeof droppedAt === 'number' && Number.isFinite(droppedAt))) {
    problems.push(`droppedAt must be a timestamp, got ${JSON.stringify(droppedAt)}`)
  }

  // 5. attempt: the recovering payload, integer and non-negative.
  const attempt = Reflect.get(status, 'attempt')
  if ((attempt !== undefined) !== (kind === NODE_STATUS_KIND.RECOVERING)) {
    problems.push(attempt === undefined
      ? 'recovering requires attempt'
      : `${kind} must not carry attempt`)
  } else if (attempt !== undefined && (!Number.isInteger(attempt) || attempt < 0)) {
    problems.push(`attempt must be a non-negative integer, got ${JSON.stringify(attempt)}`)
  }
  if (kind === NODE_STATUS_KIND.RECOVERING) {
    const nextAt = Reflect.get(status, 'nextAt')
    if (!(typeof nextAt === 'number' && Number.isFinite(nextAt))) {
      problems.push(`recovering requires nextAt, got ${JSON.stringify(nextAt)}`)
    }
  }

  // The nested ladder carrier has to be complete on its own, or a projection reading it would
  // silently print a half "attempt 1 of 3".
  const recovery = Reflect.get(status, 'recovery')
  if (recovery !== undefined) {
    if (kind !== NODE_STATUS_KIND.CONNECTING) {
      problems.push(`recovery payload is only valid on connecting, got ${kind}`)
    } else if (recovery === null || typeof recovery !== 'object'
      || !(typeof recovery.droppedAt === 'number' && Number.isFinite(recovery.droppedAt))
      || !Number.isInteger(recovery.attempt) || recovery.attempt < 1) {
      problems.push(`connecting.recovery must be { droppedAt, attempt >= 1 }, got ${JSON.stringify(recovery)}`)
    }
  }

  return problems
}

/**
 * Throw when a status breaks one of the invariants.
 *
 * The reducer itself is deterministic enough that a violation can only come from a hand-built
 * status (a test fixture, a future code path that bypassed `reduce`); this wrapper turns that
 * into an immediate, named failure instead of a rendering bug three layers away.
 * @param {unknown} status
 */
export function assertInvariants(status) {
  const problems = violationsOf(status)
  if (problems.length > 0) {
    throw new Error(`node status breaks its invariants: ${problems.join('; ')}`)
  }
}

/** A phase payload stamped with `now`. */
const phaseAt = (name, now) => (typeof name === 'string' && name.length > 0
  ? Object.freeze({ name, startedAt: now })
  : undefined)

/**
 * Apply one event to one status.
 *
 * **Pure**: no timers, no IO, no `Date.now()` — the clock arrives as `context.now` so a test can
 * assert a transition at a fixed instant. The result names every side effect explicitly; the
 * caller's interpreter (`NodeRuntime.dispatch`) is the only thing that touches the world.
 *
 * Events that do not apply to the current kind are ignored (empty effect list), not thrown:
 * a socket `close` event and a drop report can race, and a duplicate `disconnect` must not
 * crash the teardown. An **unknown event name** is a programming error and throws.
 *
 * @param {object} status
 * @param {{ type: string } & Record<string, unknown>} event
 * @param {{ now?: number }} [context]
 * @returns {{ status: object, effects: NodeStatusEffect[] }}
 */
export function reduce(status, event, context = {}) {
  assertInvariants(status)
  const now = typeof context.now === 'number' && Number.isFinite(context.now) ? context.now : 0
  const kind = status.kind
  const type = Reflect.get(event, 'type')
  const ignore = () => ({ status, effects: [] })

  switch (type) {
    case STATUS_EVENT.CONNECT_REQUESTED: {
      if (kind === NODE_STATUS_KIND.TERMINATED || kind === NODE_STATUS_KIND.STOPPING
        || kind === NODE_STATUS_KIND.CONNECTING) return ignore()
      const via = Reflect.get(status, 'via') ?? event.via
      return {
        status: {
          kind: NODE_STATUS_KIND.CONNECTING,
          phase: phaseAt(event.phase ?? 'probe', now),
          // How the runtime arrived survives a reconnect: it is a property of the tree on the
          // node, not of this attempt, and the settings page shows it while connected.
          ...(via === undefined ? {} : { via }),
        },
        // A person pressing Connect takes the ladder over: the timer is cancelled, the rung is
        // **not** touched (only a success or a deliberate disconnect ends the ladder).
        effects: [cancelTimer(), publish()],
      }
    }
    case STATUS_EVENT.PHASE_ENTERED: {
      if (kind !== NODE_STATUS_KIND.CONNECTING) return ignore()
      const phase = phaseAt(event.phase, now)
      if (phase === undefined) return ignore()
      // The transfer numbers belong to the previous phase only while that phase is current; the
      // install step republishes them as they arrive.
      return {
        status: { ...status, phase, transfer: undefined },
        effects: [publish()],
      }
    }
    case STATUS_EVENT.TRANSFER_UPDATED: {
      if (kind !== NODE_STATUS_KIND.CONNECTING) return ignore()
      return { status: { ...status, transfer: event.transfer }, effects: [publish()] }
    }
    case STATUS_EVENT.GATE_DECIDED: {
      if (kind !== NODE_STATUS_KIND.CONNECTING || event.gate === undefined) return ignore()
      return { status: { ...status, gate: event.gate }, effects: [publish()] }
    }
    case STATUS_EVENT.RUNTIME_ROUTE_KNOWN: {
      if (kind !== NODE_STATUS_KIND.CONNECTING || event.via === undefined) return ignore()
      // `via` is a property of the tree on the node, not of this attempt, so it is read on
      // **every** connect (from the install stamp) rather than only on the one that installed
      // it. Otherwise the "this node builds its own runtime" line on the card would vanish
      // after the first disconnect and never come back, because a second connect does not
      // reinstall a usable tree.
      return { status: { ...status, via: event.via }, effects: [publish()] }
    }
    case STATUS_EVENT.SERVICE_STARTED: {
      if (kind !== NODE_STATUS_KIND.CONNECTING || event.service === undefined) return ignore()
      return { status: { ...status, pendingService: event.service }, effects: [] }
    }
    case STATUS_EVENT.CONNECT_SUCCEEDED: {
      if (kind !== NODE_STATUS_KIND.CONNECTING && kind !== NODE_STATUS_KIND.RECOVERING) return ignore()
      const service = event.service ?? Reflect.get(status, 'pendingService')
      if (service === undefined) return ignore()
      return {
        status: {
          kind: NODE_STATUS_KIND.CONNECTED,
          service,
          ...(event.via === undefined && Reflect.get(status, 'via') === undefined
            ? {}
            : { via: event.via ?? Reflect.get(status, 'via') }),
          ...(Reflect.get(status, 'gate') === undefined ? {} : { gate: Reflect.get(status, 'gate') }),
        },
        // A success ends the ladder: the recovering payload (droppedAt / attempt) is gone with
        // the status it lived on.
        effects: [
          cancelTimer(),
          persistOutcome({ ok: true, version: typeof event.version === 'string' ? event.version : undefined }),
          publish(),
        ],
      }
    }
    case STATUS_EVENT.CONNECT_FAILED: {
      if (kind !== NODE_STATUS_KIND.CONNECTING && kind !== NODE_STATUS_KIND.RECOVERING
        && kind !== NODE_STATUS_KIND.CONNECTED && kind !== NODE_STATUS_KIND.FAILED) return ignore()
      return {
        status: {
          kind: NODE_STATUS_KIND.FAILED,
          // The last phase is a **payload**: the card can still say which step failed, and the
          // phase field itself stays owned by `connecting`.
          ...(isPhase(Reflect.get(status, 'phase')) ? { phase: Reflect.get(status, 'phase') } : {}),
          error: typeof event.error === 'string' ? event.error : String(event.error ?? 'the connection failed'),
          failure: event.failure ?? { code: 'unknown', message: 'unknown failure', action: 'retry', retryable: true, detail: '' },
          ...(Reflect.get(status, 'via') === undefined ? {} : { via: Reflect.get(status, 'via') }),
        },
        effects: [
          resetGateway(),
          persistOutcome({ ok: false, error: typeof event.error === 'string' ? event.error : String(event.error ?? '') }),
          publish(),
        ],
      }
    }
    case STATUS_EVENT.DROP_DETECTED: {
      if (kind !== NODE_STATUS_KIND.CONNECTED) return ignore()
      const at = typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : now
      if (event.recover === false) {
        // A node the person disabled is not "reconnecting": that card would say so forever.
        return { status: { kind: NODE_STATUS_KIND.IDLE }, effects: [cancelTimer(), resetGateway(), publish()] }
      }
      return {
        status: {
          kind: NODE_STATUS_KIND.RECOVERING,
          droppedAt: at,
          attempt: 0,
          nextAt: at + recoveryDelayMs(0),
        },
        effects: [
          cancelTimer(),
          resetGateway(),
          armTimer(recoveryDelayMs(0)),
          log('the SSH connection closed; starting the reconnect ladder'),
          publish(),
        ],
      }
    }
    case STATUS_EVENT.RECOVERY_ATTEMPT_STARTED: {
      if (kind !== NODE_STATUS_KIND.RECOVERING) return ignore()
      const startedAt = typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : now
      return {
        // The attempt counter advances when the attempt **starts**, which is what makes the
        // rearm delay correct: after the rung that failed, `attempt` names the next rung.
        status: {
          kind: NODE_STATUS_KIND.CONNECTING,
          phase: phaseAt('probe', startedAt),
          recovery: { droppedAt: status.droppedAt, attempt: status.attempt + 1 },
        },
        effects: [cancelTimer(), publish()],
      }
    }
    case STATUS_EVENT.RECOVERY_ATTEMPT_FAILED: {
      const recovery = kind === NODE_STATUS_KIND.CONNECTING ? Reflect.get(status, 'recovery') : undefined
      const droppedAt = kind === NODE_STATUS_KIND.RECOVERING
        ? Reflect.get(status, 'droppedAt')
        : recovery?.droppedAt
      const attempt = kind === NODE_STATUS_KIND.RECOVERING
        ? Reflect.get(status, 'attempt')
        : recovery?.attempt
      if (droppedAt === undefined || attempt === undefined) return ignore()
      const at = typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : now
      // **`attempt` is carried, never recomputed from zero.** This is the root fix for the
      // ladder that used to schedule 2 s forever: cancelling/rearming the timer is not the end
      // of the ladder.
      return {
        status: {
          kind: NODE_STATUS_KIND.RECOVERING,
          droppedAt,
          attempt,
          nextAt: at + recoveryDelayMs(attempt),
          ...(typeof event.error === 'string' && event.error.length > 0 ? { lastError: event.error } : {}),
        },
        effects: [
          resetGateway(),
          // Explicit, not implied: the old timer is cleared **and** the rung it belonged to is
          // carried forward in the status. A reducer that silently relied on `armTimer` also
          // cancelling would make "cancel does not reset the attempt" impossible to assert.
          cancelTimer(),
          armTimer(recoveryDelayMs(attempt)),
          // The reason a rung missed goes to the node's own log, never to `error`: the card
          // would turn red for a machine that is simply switched off.
          log(`reconnect attempt ${String(attempt)} failed: ${typeof event.error === 'string' ? event.error : 'unknown reason'}`),
          publish(),
        ],
      }
    }
    case STATUS_EVENT.RECOVERY_ABANDONED: {
      if (kind !== NODE_STATUS_KIND.RECOVERING && kind !== NODE_STATUS_KIND.CONNECTING) return ignore()
      return {
        status: { kind: NODE_STATUS_KIND.IDLE },
        effects: [cancelTimer(), resetGateway(), log('the reconnect ladder stopped'), publish()],
      }
    }
    case STATUS_EVENT.CONFIG_CHANGED: {
      if (kind !== NODE_STATUS_KIND.CONNECTED) return ignore()
      // The stored handshake inputs changed, so the socket this status describes is no longer
      // the node's real connection. `idle` (not `failed`): nothing is broken, the person is
      // editing the node and has to reconnect.
      return {
        status: { kind: NODE_STATUS_KIND.IDLE },
        effects: [cancelTimer(), resetGateway(), invalidateSocket(), log('connection settings changed; the node was disconnected'), publish()],
      }
    }
    case STATUS_EVENT.SERVICE_REFRESHED: {
      if (kind !== NODE_STATUS_KIND.CONNECTED || event.service === undefined) return ignore()
      return { status: { ...status, service: event.service }, effects: [resetGateway(), publish()] }
    }
    case STATUS_EVENT.SYNC_FAILED: {
      if (kind !== NODE_STATUS_KIND.CONNECTED) return ignore()
      const phase = phaseAt(event.phase, now)
      return {
        status: {
          kind: NODE_STATUS_KIND.FAILED,
          ...(phase === undefined ? {} : { phase }),
          error: typeof event.error === 'string' ? event.error : String(event.error ?? 'the config sync failed'),
          failure: event.failure ?? { code: 'unknown', message: 'unknown failure', action: 'retry', retryable: true, detail: '' },
          ...(Reflect.get(status, 'via') === undefined ? {} : { via: Reflect.get(status, 'via') }),
        },
        effects: [
          resetGateway(),
          invalidateSocket(),
          persistOutcome({ ok: false, error: typeof event.error === 'string' ? event.error : String(event.error ?? '') }),
          publish(),
        ],
      }
    }
    case STATUS_EVENT.DISCONNECT_REQUESTED: {
      if (kind === NODE_STATUS_KIND.TERMINATED || kind === NODE_STATUS_KIND.STOPPING) return ignore()
      // `stopping` is published **before** the (slow) host stop so the card can say so; the
      // error/failure/droppedAt payloads are gone with the state they belonged to, which is what
      // clears the stale red block a deliberate disconnect used to leave on `idle`.
      //
      // The socket is **not** invalidated here: the host stop runs over SSH and would lose its
      // own connection. That is the `DISCONNECTED` event's job, after this has been awaited.
      return {
        status: { kind: NODE_STATUS_KIND.STOPPING },
        effects: [cancelTimer(), resetGateway(), publish(), stopResidentHost()],
      }
    }
    case STATUS_EVENT.DISCONNECTED: {
      if (kind !== NODE_STATUS_KIND.STOPPING) return ignore()
      // `invalidate` drops the socket so the next connect handshakes afresh. `dispose` would
      // latch the connection shut, and Connect after Disconnect would then fail with
      // "ssh connection was closed" forever.
      return { status: { kind: NODE_STATUS_KIND.IDLE }, effects: [invalidateSocket(), publish()] }
    }
    case STATUS_EVENT.REINSTALL_REQUESTED: {
      if (kind === NODE_STATUS_KIND.TERMINATED || kind === NODE_STATUS_KIND.STOPPING
        || kind === NODE_STATUS_KIND.CONNECTING) return ignore()
      const service = event.service ?? (kind === NODE_STATUS_KIND.CONNECTED ? status.service : undefined)
      return {
        status: {
          kind: NODE_STATUS_KIND.CONNECTING,
          phase: phaseAt('install', now),
          // Keep the resident endpoint reachable during the reinstall: the process is still the
          // one that answers, only the tree on disk is being replaced.
          ...(service === undefined ? {} : { pendingService: service }),
        },
        effects: [cancelTimer(), publish()],
      }
    }
    case STATUS_EVENT.REINSTALL_FINISHED: {
      if (kind !== NODE_STATUS_KIND.CONNECTING) return ignore()
      const service = event.service ?? Reflect.get(status, 'pendingService')
      const via = Reflect.get(status, 'via')
      if (service === undefined) {
        return { status: { kind: NODE_STATUS_KIND.IDLE }, effects: [publish()] }
      }
      return {
        status: {
          kind: NODE_STATUS_KIND.CONNECTED,
          service,
          ...(via === undefined ? {} : { via }),
          ...(Reflect.get(status, 'gate') === undefined ? {} : { gate: Reflect.get(status, 'gate') }),
        },
        // The resident host was (or has to be) replaced, so the gateway's cookie, carrier and
        // streams all point at a process that may be gone.
        effects: [resetGateway(), publish()],
      }
    }
    case STATUS_EVENT.REINSTALL_FAILED: {
      if (kind !== NODE_STATUS_KIND.CONNECTING) return ignore()
      return {
        status: {
          kind: NODE_STATUS_KIND.FAILED,
          ...(isPhase(Reflect.get(status, 'phase')) ? { phase: Reflect.get(status, 'phase') } : {}),
          error: typeof event.error === 'string' ? event.error : String(event.error ?? 'the reinstall failed'),
          failure: event.failure ?? { code: 'unknown', message: 'unknown failure', action: 'retry', retryable: true, detail: '' },
        },
        effects: [resetGateway(), persistOutcome({ ok: false, error: typeof event.error === 'string' ? event.error : String(event.error ?? '') }), publish()],
      }
    }
    case STATUS_EVENT.PROBE_FINISHED: {
      if (kind === NODE_STATUS_KIND.TERMINATED || kind === NODE_STATUS_KIND.STOPPING) return ignore()
      if (event.ok === true) {
        // A successful reachability probe changes no lifecycle fact: the cached probe result is
        // not part of the status (it is a fact about the machine, not about this connection).
        // It is still published, because the settings page renders it.
        return { status, effects: [publish()] }
      }
      // A probe is the one read a person can ask for on a red card, and its failure has to reach
      // the card: reporting 500 with `state` unchanged (the old route) left a node that could not
      // be reached looking `idle` — or worse, `connected`.
      //
      // Only a **settled, not-connected** node changes here: `idle` or `failed`.
      //
      // A `connected` node is deliberately excluded: its liveness is the SSH layer's fact, and
      // `SshConnection` reports a dead socket through `onDrop` (which is what starts the quiet
      // ladder). A probe that fails on a live socket would otherwise flip the card to a red
      // `failed` that promises the app stopped trying — and then the drop event, arriving a
      // moment later, would be ignored because the status is no longer `connected`. That is the
      // D2 defect in a different disguise.
      //
      // A `connecting`/`recovering` node is mid-attempt and reports its own outcome for the same
      // reason. The probe route exists for the case it is named after: a person on a red or
      // grey card asking "can this machine be reached at all".
      if (kind !== NODE_STATUS_KIND.IDLE && kind !== NODE_STATUS_KIND.FAILED) return ignore()
      return {
        status: {
          kind: NODE_STATUS_KIND.FAILED,
          error: typeof event.error === 'string' ? event.error : String(event.error ?? 'the probe failed'),
          failure: event.failure ?? { code: 'unknown', message: 'unknown failure', action: 'retry', retryable: true, detail: '' },
        },
        effects: [resetGateway(), invalidateSocket(), publish()],
      }
    }
    case STATUS_EVENT.TERMINATE_REQUESTED: {
      if (kind === NODE_STATUS_KIND.TERMINATED) return ignore()
      return {
        status: { kind: NODE_STATUS_KIND.TERMINATED },
        effects: [cancelTimer(), resetGateway()],
      }
    }
    default:
      throw new TypeError(`unknown node status event ${JSON.stringify(type)}`)
  }
}

/**
 * Project a status into the fields the settings page, the sidebar, the phone and the agent tool
 * surface already read.
 *
 * **No field name changes.** The projection keeps every name `describe()` used to expand
 * conditionally (`state`, `phase`, `phaseStartedAt`, `serving`, `error`, `failure`,
 * `droppedAt`, `recoveryAttempts`, `transfer`, `runtimeVia`) and adds `kind` (the lossless
 * discriminator) and `gate` (the version decision, previously invisible to every caller).
 * Who reads what:
 *
 * | projected field | status payload |
 * |---|---|
 * | `kind` | `status.kind` |
 * | `state` | `STATE_BY_KIND[kind]` (`recovering` → `idle`, see above) |
 * | `phase` / `phaseStartedAt` | `connecting.phase`, or the `failed.phase` payload |
 * | `transfer` | `connecting.transfer` |
 * | `serving` (`{ port, version }`) | `connected.service` |
 * | `runtimeVia` | `via` on `connecting` / `connected` / `failed` |
 * | `error` / `failure` | `failed.error` / `failed.failure` |
 * | `droppedAt` | `recovering.droppedAt`, or `connecting.recovery.droppedAt` |
 * | `recoveryAttempts` | `recovering.attempt`, or `connecting.recovery.attempt` (only > 0) |
 * | `gate` | `gate` on `connecting` / `connected` |
 * | `lastError` | `recovering.lastError` (the reason a rung missed, never `error`) |
 *
 * `extras` carries everything that is **not** lifecycle state — identity, cached probe facts,
 * the provisioning report — and is spread last so the caller keeps one snapshot builder.
 *
 * @param {object} status
 * @param {Record<string, unknown>} [extras]
 * @returns {Record<string, unknown>}
 */
export function describeStatus(status, extras = {}) {
  assertInvariants(status)
  const kind = status.kind
  /** @type {Record<string, unknown>} */
  const snapshot = { kind, state: STATE_BY_KIND[kind] }
  const phase = kind === NODE_STATUS_KIND.CONNECTING || kind === NODE_STATUS_KIND.FAILED
    ? Reflect.get(status, 'phase')
    : undefined
  if (isPhase(phase)) {
    snapshot.phase = phase.name
    snapshot.phaseStartedAt = phase.startedAt
  }
  if (kind === NODE_STATUS_KIND.CONNECTING && status.transfer !== undefined) snapshot.transfer = status.transfer
  if (kind === NODE_STATUS_KIND.CONNECTED) {
    snapshot.serving = { port: status.service.port, version: status.service.version }
    if (status.via !== undefined) snapshot.runtimeVia = status.via
    if (status.gate !== undefined) snapshot.gate = status.gate
  }
  if (kind === NODE_STATUS_KIND.CONNECTING) {
    if (status.via !== undefined) snapshot.runtimeVia = status.via
    if (status.gate !== undefined) snapshot.gate = status.gate
  }
  if (kind === NODE_STATUS_KIND.FAILED) {
    if (status.via !== undefined) snapshot.runtimeVia = status.via
    snapshot.error = status.error
    snapshot.failure = status.failure
  }
  if (kind === NODE_STATUS_KIND.RECOVERING) {
    snapshot.droppedAt = status.droppedAt
    if (status.attempt > 0) snapshot.recoveryAttempts = status.attempt
    if (status.lastError !== undefined) snapshot.lastError = status.lastError
  }
  if (kind === NODE_STATUS_KIND.CONNECTING && status.recovery !== undefined) {
    // The card has always shown "reconnecting since …" while the rung runs, with the attempt
    // count next to it; that pair now comes from the nested ladder carrier.
    snapshot.droppedAt = status.recovery.droppedAt
    if (status.recovery.attempt > 0) snapshot.recoveryAttempts = status.recovery.attempt
  }
  return { ...snapshot, ...extras }
}
