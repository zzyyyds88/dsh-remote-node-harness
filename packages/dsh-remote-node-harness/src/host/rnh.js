/**
 * The rnh: every configured node, its warm SSH connection, its resident Host,
 * and the gateway the routing layer calls.
 *
 * This is the single owner of live node state. The HTTP management API, the
 * routing decorators and the settings surface all read nodes from here, so a
 * connection started by one path is visible to the others without a second
 * bookkeeping channel.
 *
 * **The lifecycle itself is not owned here any more.** A node's `state` used to be
 * fifteen independent fields (`state`, `phase`, `phaseStartedAt`, `error`, `failure`,
 * `serving`, `droppedAt`, `recoveries`, `recoveryAttempts`, `transfer`, `gate`,
 * `provision`, …) whose only coherence was the order in which `connect()` happened to
 * assign them. Measured consequences, all fixed by construction now: a forced connect
 * left `state: 'connecting'` next to the previous `serving`; `put()` changed a host on a
 * connected node and left it `connected` over a dead socket; `disconnect()` cleared
 * `failure` but not `error`, so `idle` rendered a red failure block; `syncConfig()` could
 * fail while the card stayed green; the reinstall route wrote `phase` from outside the
 * serial queue.
 *
 * So the lifecycle lives in `host/node-status.js` as one discriminated union, and this
 * file only:
 *
 *   1. **dispatches events** into it (`connect`, `disconnect`, `put`, `#onDrop`,
 *      `syncConfig`, the reinstall route in `index.js`), and
 *   2. **executes the effects** those events name (timers, gateway resets, socket
 *      invalidation, the durable outcome record, publish).
 *
 * `describe()` is a pure projection of that one value plus the facts that are not
 * lifecycle state at all (identity, cached probe results, the provisioning report), so
 * the settings page, the sidebar, the phone and the agent tool surface cannot disagree
 * about what a node is doing.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/rnh
 */
import { NodeRegistry } from '../core/registry.js'
import { SecretStore, authFromSecret } from '../core/secrets.js'
import { classifyFailure } from '../core/errors.js'
import { GATE, decideGate } from '../core/version.js'
import { SshConnection } from '../ssh/connection.js'
import { RemoteHost, remoteLayout, MINIMUM_NODE_MAJOR } from '../remote/daemon.js'
import { BRAIN_CREDENTIAL_REFS, BRAIN_FILES, BRAIN_PACKAGE, BRAIN_THIRD_PARTY_CONFIG } from './brain-bundle.generated.js'
import { NODE_BASE_BUNDLES } from '../core/plugin-sync.js'
import { nodeApplies } from '../core/plugin-applicability.js'
import { assembleConfig, configDiffers } from './plugin-config.js'
import { NodeLog } from './node-log.js'
import { Provisioner } from './provision.js'
import { RemoteGateway } from './remote-gateway.js'
import {
  NODE_STATUS_KIND,
  STATUS_EVENT,
  describeStatus,
  initialStatus,
  reduce,
  recoveryDelayMs,
} from './node-status.js'

/**
 * The bundle list a node's profile composes.
 *
 * `dsh-base` is the shared core; the brain bundle is that core plus a Host and the
 * Remote API, with the browser surface removed. Upstream's `dsh-web-app` is
 * deliberately absent: a node serves no window, so it never even loads that layer.
 *
 * The list itself lives in `core/plugin-sync.js` because `sync-switches.js` filters a person's
 * switches against the same list, and two independent literals had already drifted apart
 * once. Re-exported here under the name the connect path has always used.
 */
export const BRAIN_BUNDLES = NODE_BASE_BUNDLES

/**
 * The `state` vocabulary the settings page and the phone read.
 *
 * These are the *projected* values, not the status kinds: `recovering` reports `state: 'idle'`
 * (with `droppedAt` set), because that is the pair the shipped client already renders as
 * "disconnected, reconnecting" and this batch does not change the client. `kind` in the
 * snapshot is the lossless field. `STOPPING` and `TERMINATED` are new values in this
 * vocabulary; an older reader that does not know them falls back to its idle rendering, which
 * is what a tearing-down node honestly is. See `host/node-status.js` for the mapping and the
 * note on why it is shaped this way.
 */
export const NODE_STATE = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  FAILED: 'failed',
  STOPPING: 'stopping',
  TERMINATED: 'terminated',
})

/**
 * Re-exported: the reconnect ladder's arithmetic belongs to the pure status module now, but
 * this name is how the Host has always reached it (and `recovery-ladder-unit.mjs` asserts it
 * directly).
 */
export { recoveryDelayMs }

/** `Error`/anything → one sentence, for a log line or a status payload. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One live node: SSH connection, resident Host, and gateway.
 *
 * Everything mutable that is **lifecycle** lives in `status` and changes only through
 * `dispatch()`. What remains as fields is either a resource (`connection`, `host`, `gateway`,
 * `recoveryTimer`, the serial `queue`) or a fact that outlives any one lifecycle state
 * (`facts`, `provision`, `recoveries`, `secret`).
 */
export class NodeRuntime {
  /**
   * @param {import('../core/registry.js').NodeRecord} record
   * @param {{ log: (message: string) => void, version: string,
   *   onEffects?: (runtime: NodeRuntime, effects: import('./node-status.js').NodeStatusEffect[]) => Promise<unknown>[] }} options
   */
  constructor(record, options) {
    this.record = record
    /**
     * This node's own log.
     *
     * `options.log` writes to the desktop's logger, which the person looking at a red card will
     * never find. This one is readable from the card itself, redacted on write.
     */
    this.logs = new NodeLog()
    const desktopLog = options.log
    /** Log to both the desktop's logger and this node's own buffer. */
    this.log = message => {
      desktopLog(message)
      this.logs.push(message)
    }
    this.version = options.version
    /**
     * The lifecycle, as one value.
     *
     * Deliberately **not** exposed as `state` / `phase` / `serving` / … fields: those were the
     * fifteen independent fields this batch removed. `describe()` is how anything outside this
     * class reads it.
     * @type {object}
     */
    this.status = initialStatus()
    /**
     * The effect interpreter, supplied by `Rnh`.
     *
     * A reducer returns *what should happen*; this runtime cannot arm a timer for a ladder it
     * does not own or write the registry. Keeping the interpreter outside is what makes
     * `node-status.js` a pure module the unit tests can drive with a fake.
     */
    this.onEffects = options.onEffects
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.recoveryTimer = undefined
    /** How many times this runtime has come back after a drop, since the app started. */
    this.recoveries = 0
    /** Cached probe facts (reachability, Node version); refreshed on every connect/probe. */
    this.facts = undefined
    /** What provisioning put on the node, for the settings surface. */
    this.provision = undefined
    this.queue = Promise.resolve()
    /** @type {{ kind: 'password' | 'key' | 'agent', password?: string, privateKey?: string, passphrase?: string } | undefined} */
    this.secret = undefined
    this.connection = new SshConnection({
      host: record.host,
      port: record.port,
      username: record.username,
      auth: { kind: record.auth.kind },
      label: record.name,
      // The SSH layer's own diagnostics (why a handshake was refused, why a socket closed).
      // Without this sink every `target.log?.()` inside `SshConnection` was a no-op, so the one
      // place that knows why a connection ended wrote nowhere.
      log: message => this.log(message),
      // The recorded host key, when this machine has been seen before. `undefined` is
      // first use: the key is recorded then, and every later handshake is compared against
      // it. Without this the verifier had nothing to compare with and the whole chain was
      // dead code — a man-in-the-middle was accepted silently.
      hostFingerprint: record.hostKey,
      onFirstFingerprint: fingerprint => options.onFirstFingerprint?.(record.id, fingerprint),
      onFingerprintMismatch: (expected, actual) => options.onFingerprintMismatch?.(record.id, expected, actual),
      // The socket died on its own. Reporting it here is what turns "the sidebar silently
      // lost every remote workspace" into a named, recoverable state.
      onDrop: () => options.onDrop?.(record.id),
    })
    this.host = new RemoteHost({
      connection: this.connection,
      version: this.version,
      // Its own paths: two node records can name the same machine under different
      // roots, and a shared layout would make the second node reuse the first one's
      // runtime, resident host and status file.
      layout: remoteLayout(record.remoteRoot),
      log: message => this.log(`[${record.name}] ${message}`),
    })
    this.gateway = new RemoteGateway({
      connection: this.connection,
      // The gateway asks where the resident host is. It must be told about an endpoint that is
      // started but not yet verified (the verify phase mints a cookie through it), which used to
      // be the same field as `serving` — so `serving` meant "connected" only by convention.
      serving: () => this.servingOf(),
      log: message => this.log(`[${record.name}] ${message}`),
    })
  }

  /** Whether the node can answer routing calls right now. */
  get routable() {
    return this.status.kind === NODE_STATUS_KIND.CONNECTED
  }

  /**
   * The resident-host endpoint, if one exists.
   *
   * Two carriers: a verified one (`connected.service`) and one that has been started inside a
   * connect attempt (`connecting.pendingService`). Only the former makes the node routable;
   * the latter exists so the verify step can talk to the process it just started.
   */
  servingOf() {
    if (this.status.kind === NODE_STATUS_KIND.CONNECTED) return this.status.service
    if (this.status.kind === NODE_STATUS_KIND.CONNECTING) return this.status.pendingService
    return undefined
  }

  /**
   * Deliver one event to the lifecycle and execute the effects it names.
   *
   * This is the **only** way a status changes (invariant 6). The event is reduced purely, the
   * new status is installed, then the interpreter runs; a caller that needs the slow effects to
   * finish (the host stop in `disconnect`) awaits `pending`.
   *
   * @param {{ type: string } & Record<string, unknown>} event
   * @param {{ now?: number }} [context] - injectable clock, for tests.
   * @returns {{ status: object, effects: import('./node-status.js').NodeStatusEffect[], pending: Promise<unknown>[] }}
   */
  dispatch(event, context = {}) {
    const reduced = reduce(this.status, event, { now: Date.now(), ...context })
    this.status = reduced.status
    const pending = typeof this.onEffects === 'function' ? this.onEffects(this, reduced.effects) : []
    return { status: this.status, effects: reduced.effects, pending }
  }

  /**
   * Adopt a freshly read secret, rebuilding the SSH client when it changes.
   *
   * @returns {Promise<boolean>} whether anything the handshake depends on actually changed.
   */
  async adopt(secret) {
    this.secret = secret
    const auth = authFromSecret(secret)
    if (auth === undefined) {
      this.connection.target.auth = { kind: this.record.auth.kind }
      return false
    }
    // **Only a real change may tear the connection down.** `adopt()` runs at the start of every
    // `connect()`, and it used to call `invalidate()` whenever a client existed — so a reconnect
    // of an already-connected node killed the socket it was about to use, and a settings-page
    // save killed a working node's link. Measured: after a drop, the recovery ladder reconnected
    // successfully and then immediately logged `invalidate() drops the connection (at
    // NodeRuntime.adopt)`, dropping the node again. The comparison is on the parts that decide
    // the handshake; a changed host/port/username has to reconnect too, because the client is
    // bound to them.
    const previous = this.connection.target
    const changed = previous.auth.kind !== auth.kind
      || previous.auth.password !== auth.password
      || previous.auth.privateKey !== auth.privateKey
      || previous.auth.passphrase !== auth.passphrase
      || previous.host !== this.record.host
      || previous.port !== this.record.port
      || previous.username !== this.record.username
    this.connection.target.auth = auth
    this.connection.target.host = this.record.host
    this.connection.target.port = this.record.port
    this.connection.target.username = this.record.username
    this.connection.target.label = this.record.name
    this.host.layout = remoteLayout(this.record.remoteRoot)
    if (this.connection.ready && changed) {
      this.gateway.reset()
      this.connection.invalidate()
    }
    return changed
  }

  /** Whether the stored secret is enough to attempt a connection. */
  credentialsReady() {
    const auth = authFromSecret(this.secret)
    if (auth === undefined) return false
    if (auth.kind === 'agent') return true
    if (auth.kind === 'password') return typeof auth.password === 'string' && auth.password.length > 0
    return auth.privateKey !== undefined
  }

  /**
   * Snapshot for the management surface.
   *
   * The lifecycle half is a **pure projection** of `status` (`describeStatus`), so no caller can
   * see a combination the state machine does not allow. The non-lifecycle half is spread after
   * it: identity, the cached probe facts, the provisioning report, the recorded host key and the
   * counters that outlive any one state. Every field name the shipped client reads is preserved;
   * `kind` and `gate` are the only additions.
   */
  describe() {
    return describeStatus(this.status, {
      id: this.record.id,
      name: this.record.name,
      host: this.record.host,
      port: this.record.port,
      username: this.record.username,
      authKind: this.record.auth.kind,
      credentialsReady: this.credentialsReady(),
      enabled: this.record.enabled,
      remoteRoot: this.record.remoteRoot,
      ...(this.facts === undefined ? {} : { remote: this.facts }),
      ...(this.provision === undefined ? {} : { provision: this.provision }),
      ...(this.record.hostKey === undefined ? {} : { hostKey: this.record.hostKey }),
      ...(this.record.lastConnectedAt === undefined ? {} : { lastConnectedAt: this.record.lastConnectedAt }),
      ...(this.record.lastSeenVersion === undefined ? {} : { lastSeenVersion: this.record.lastSeenVersion }),
      // How many times this runtime has come back after a drop: a counter that survives a
      // disconnect, unlike the ladder rung which dies with the `recovering` status.
      ...(this.recoveries === 0 ? {} : { recoveries: this.recoveries }),
    })
  }
}

/**
 * The agent-facing projection of one node snapshot.
 *
 * The point of this function is that there is **one** definition of "what a node snapshot looks
 * like". `rnh-control.js` used to re-shape `describe()` into a thinner object and, in doing so,
 * cut `failure`, `phase`, `transfer`, `serving` and `droppedAt` — so an agent asking `status`
 * got one English sentence where the settings page had a machine-readable code, the step that
 * failed, the live transfer numbers and the reconnect rung. A tool result is not a place to
 * lose the answer.
 *
 * `provision` is the one deliberate exclusion: it is a settings-page report and carries the
 * *names* of credential refs (`provision.refs`), which have no business crossing into a
 * conversation.
 *
 * @param {Record<string, unknown>} described - the object `NodeRuntime.describe()` returns.
 * @returns {Record<string, unknown>}
 */
export function describeForTool(described) {
  const snapshot = {}
  for (const key of [
    'id', 'name', 'host', 'port', 'username', 'authKind', 'credentialsReady', 'enabled',
    'remoteRoot', 'kind', 'state', 'phase', 'phaseStartedAt', 'transfer', 'serving',
    'runtimeVia', 'gate', 'lastError', 'error', 'failure', 'droppedAt', 'recoveryAttempts',
    'recoveries', 'remote', 'hostKey', 'lastConnectedAt', 'lastSeenVersion',
  ]) {
    if (described[key] !== undefined) snapshot[key] = described[key]
  }
  // Normalised rather than passed through: an older snapshot may lack them, and a tool
  // consumer branches on booleans.
  snapshot.credentialsReady = described.credentialsReady === true
  snapshot.enabled = described.enabled !== false
  return snapshot
}

/** Every node this profile knows, with its live connection when it has one. */
export class Rnh {
  /**
   * @param {object} options
   * @param {object} options.credentials - `ctx.credentials`
   * @param {string} options.version - the DSH version this profile runs.
   * @param {() => object | undefined} [options.configEditor] - the live config editor, for provisioning.
   * @param {() => readonly string[]} [options.nodeBundles] - the bundle list a node composes,
   *   read at connect and sync time so a plugin switched on reaches a node without a restart.
   * @param {() => { specOf: (bundle: string) => string | undefined, isLocal: (bundle: string) => boolean, localFiles: (bundle: string) => Record<string, string> } | undefined} [options.pluginSpecs] - where a plugin comes from and how it travels.
   * @param {Array<{kind: 'prefix' | 'template', prefix?: string, template?: string}>} [options.sources] - artefact sources, best first; replaces the default list.
   * @param {(nodeId: string, fingerprint: string) => void} [options.onFirstFingerprint] - called
   *   the first time this node's host key is seen, so the registry can record it.
   * @param {(nodeId: string, expected: string, actual: string) => void} [options.onFingerprintMismatch]
   *   - called when a node presents a different key than the one recorded for it.
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    this.log = options.log ?? (() => {})
    this.version = options.version
    /** Where a newly seen host key is recorded. */
    this.onFirstFingerprint = options.onFirstFingerprint
    /** Where a changed host key is reported. */
    this.onFingerprintMismatch = options.onFingerprintMismatch
    /** The brain build this plugin would install: its own package version. */
    this.brainVersion = options.brainVersion ?? '0.0.0'
    /** Ordered artefact sources; `undefined` means the default list (CNB). */
    this.sources = options.sources
    /**
     * The bundle list a node composes.
     *
     * Read through a callback rather than captured: the third-party plugins a person
     * switched on live outside this object, and a node that has been connected since
     * before the switch must receive it on the next sync rather than on the next connect.
     */
    this.nodeBundles = options.nodeBundles ?? (() => BRAIN_BUNDLES)
    /** Source of install specs for the switched-on plugins. */
    this.pluginSpecs = options.pluginSpecs ?? (() => undefined)
    this.configEditor = options.configEditor ?? (() => undefined)
    this.credentials = options.credentials
    this.registry = new NodeRegistry()
    this.secrets = new SecretStore({
      readRecord: key => options.credentials.readRecord(key),
      modifyRecord: (key, mutate) => options.credentials.modifyRecord(key, mutate),
      deleteRecord: key => options.credentials.deleteRecord(key),
      describeRecord: key => options.credentials.describeRecord(key),
    })
    /** @type {Map<string, NodeRuntime>} */
    this.runtimes = new Map()
    /** @type {Set<(nodes: NodeRuntime[]) => void>} */
    this.listeners = new Set()
    /**
     * Set by `dispose()`, and never cleared.
     *
     * The reconnect ladder is a `setTimeout` chain that outlives the plugin object unless it
     * is cancelled: unloading the plugin used to leave a timer that fired into a disposed
     * `Rnh`, opened an SSH connection nobody owned, and kept the process awake. Every entry
     * point that could revive a node (`connect`, the timer callback) checks this latch.
     */
    this.disposed = false
  }

  /** Every runtime, creating one per stored record. */
  list() {
    const nodes = []
    for (const record of this.registry.list()) {
      const runtime = this.#runtimeOf(record)
      runtime.record = record
      nodes.push(runtime)
    }
    return nodes
  }

  /** One runtime by node identity. */
  get(id) {
    const record = this.registry.get(id)
    if (record === undefined) return undefined
    const runtime = this.#runtimeOf(record)
    runtime.record = record
    return runtime
  }

  /** Every node that can answer a routing call right now. */
  routable() {
    return this.list().filter(runtime => runtime.routable)
  }

  /** Subscribe to lifecycle changes. */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Write one node record and adopt whatever secret came with it. */
  async put(input) {
    const record = this.registry.put(input)
    const runtime = this.#runtimeOf(record)
    runtime.record = record
    // **An `agent` node needs a record too.** The kind alone is the whole credential, so
    // `secrets.write({ kind: 'agent' })` is what makes "this node authenticates through the
    // SSH agent" distinguishable from "nobody has entered a credential yet". Skipping the
    // write here left `SecretStore.read()` empty, `credentialsReady()` false forever, and
    // `connect()` threw `credential-missing` — while `rnh-control.js` told the user the node
    // would use the agent. The two cases (`kind === 'agent'` with no value fields, and a
    // password/key node whose value fields are all absent) are otherwise indistinguishable.
    const carriesValue = typeof input.password === 'string' || typeof input.privateKey === 'string'
      || typeof input.passphrase === 'string'
    if (carriesValue || record.auth.kind === 'agent') {
      await this.secrets.write(record.id, {
        kind: record.auth.kind,
        ...(typeof input.password === 'string' ? { password: input.password } : {}),
        ...(typeof input.privateKey === 'string' ? { privateKey: input.privateKey } : {}),
        ...(typeof input.passphrase === 'string' ? { passphrase: input.passphrase } : {}),
      })
    }
    // **A changed host or credential has to downgrade the node.** `adopt()` tears the socket
    // down when the handshake inputs changed, but the status used to stay `connected` with the
    // old `serving` port, so `routable` reported true over a socket that no longer existed and
    // every routed call failed with a state the UI never showed. The status machine owns that
    // downgrade (`CONFIG_CHANGED` → idle, cleared endpoint); `put` only reports the fact.
    const changed = await this.#adoptSecret(runtime)
    if (changed) {
      runtime.dispatch({ type: STATUS_EVENT.CONFIG_CHANGED })
      this.log(`[${runtime.record.name}] connection settings changed; the node was disconnected`)
    }
    this.#publish()
    return runtime
  }

  /** Forget one node and everything it owns. */
  async remove(id) {
    const runtime = this.runtimes.get(id)
    if (runtime !== undefined) {
      await this.disconnect(runtime).catch(() => undefined)
      this.runtimes.delete(id)
    }
    await this.secrets.clear(id).catch(() => undefined)
    const removed = this.registry.remove(id)
    this.#publish()
    return removed
  }

  /** Serialize every lifecycle action for one node. */
  serial(runtime, action) {
    const next = runtime.queue.then(action, action)
    runtime.queue = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * Bring one node up: SSH, probe, install when the version differs, start the
   * resident host, then prove the gateway answers before reporting success.
   *
   * The body below is the **interpreter's user**: it dispatches events for every fact it
   * learns (phase, gate, transfer, endpoint, outcome) and carries out nothing else. That is why
   * a forced reconnect can no longer leave the previous endpoint attached to `connecting`, and
   * why a failed ladder attempt cannot leave a red error behind.
   *
   * @param {NodeRuntime} runtime
   * @param {{ force?: boolean, recovering?: boolean }} [options]
   */
  async connect(runtime, options = {}) {
    // Unloading the plugin must not be undone by a queued caller (the settings page polls, the
    // ladder fires): a disposed `Rnh` owns no connection and has no registry to write to.
    if (this.disposed) return runtime.describe()
    return await this.serial(runtime, async () => {
      if (runtime.status.kind === NODE_STATUS_KIND.CONNECTED && options.force !== true) {
        return runtime.describe()
      }
      // A person pressing Connect cancels a ladder that is already running: two attempts on
      // one node would race on `runtime.queue` and the loser would report a failure the other
      // one had already fixed. The rung itself is **not** cleared by a cancellation; only a
      // successful connect or a deliberate disconnect ends the ladder.
      if (options.recovering === true) {
        // The timer normally starts the attempt (it is what advances the rung); a caller that
        // dispatches `{recovering: true}` directly (a test, a tool) may still be on the
        // `recovering` status, so start it here in that one case.
        if (runtime.status.kind === NODE_STATUS_KIND.RECOVERING) {
          runtime.dispatch({ type: STATUS_EVENT.RECOVERY_ATTEMPT_STARTED, at: Date.now() })
        }
        // The status was not waiting for a rung (a stop won the race, the node was disabled, a
        // person pressed Connect first): there is nothing to recover into.
        if (runtime.status.kind !== NODE_STATUS_KIND.CONNECTING || runtime.status.recovery === undefined) {
          return runtime.describe()
        }
      } else {
        runtime.dispatch({
          type: STATUS_EVENT.CONNECT_REQUESTED,
          phase: 'probe',
          ...(runtime.status.via === undefined ? {} : { via: runtime.status.via }),
        })
      }
      // **The reducer decides whether a connect may start.** A runtime that is `stopping` or
      // `terminated` ignores the event, and continuing here would dial SSH and then report a
      // success into a status that never left the teardown — a connected socket nobody owns.
      if (runtime.status.kind !== NODE_STATUS_KIND.CONNECTING) return runtime.describe()
      try {
        await this.#adoptSecret(runtime)
        if (!runtime.credentialsReady()) {
          throw Object.assign(
            new Error('this node has no stored credential; add its password or private key first'),
            { code: 'credential-missing' },
          )
        }
        this.#enterPhase(runtime, 'probe')
        runtime.facts = await runtime.host.probe()
        if (!runtime.facts.nodeUsable) {
          throw Object.assign(
            new Error(
              `this machine runs Node ${runtime.facts.nodeVersion || '(none)'}, `
              + `but the resident host needs Node ${String(MINIMUM_NODE_MAJOR)} or newer`,
            ),
            { code: 'node-too-old' },
          )
        }
        this.#enterPhase(runtime, 'install')
        // The gate decides; the installer only carries it out. Doing the comparison
        // here rather than inside `install` keeps the reason available to the settings
        // page, which is what the user reads when a connect refuses to proceed.
        const installed = await runtime.host.inspectRuntime()
        const gate = decideGate({
          hostVersion: this.version,
          hostBrain: this.brainVersion,
          nodeVersion: installed.version,
          // **The node's brain bundle has no independent version, on purpose.** It is written
          // as files (never installed from npm) and its only durable stamp is `.rnh-digest`,
          // which is a content hash, not a release. Comparing that hash with `hostBrain` would
          // be comparing two different key spaces. `decideGate` only consults `nodeBrain` when
          // it is defined, so the inserted-brain branch stays inert and the gate answers
          // `refresh` for an in-step runtime — which is the honest answer, because the bundle
          // is rewritten on every connect/provision anyway (it is cheap; the runtime is not).
          // Giving the bundle a real version means changing `remote/daemon.js` and the embed
          // script, which this batch is not allowed to touch.
          nodeBrain: undefined,
          // A tree on the right version but packed by a different build is still wrong:
          // the version says which release it is, the stamp says which rules packed it.
          nodeRuntime: installed.usable ? undefined : installed.reason,
          // Reported, never judged: a tree the node resolved itself is as good as a
          // downloaded one, but "this node builds its own runtime" explains why it behaves
          // differently from its neighbours.
          nodeVia: installed.via,
        })
        runtime.dispatch({ type: STATUS_EVENT.GATE_DECIDED, gate })
        if (gate.action === GATE.AHEAD || gate.action === GATE.UNKNOWN) {
          // **Tag it, don't just throw the sentence.** `classifyFailure()` prefers an explicit
          // `code`, then the SSH category, then the phase — and a plain `Error` here fell
          // through to the phase (`install`), so a node that is *ahead* rendered as
          // `runtime-install` with a Retry button: the one case where retrying is exactly
          // wrong. Both codes exist in `ERROR_CODES` (`node-ahead` → `upgrade-desktop`,
          // retryable false), so the card can name the action instead of guessing.
          const code = gate.action === GATE.AHEAD ? 'node-ahead' : 'node-unknown-version'
          throw Object.assign(new Error(gate.message), { code })
        }
        // `install` is the only action that touches the runtime. `refresh` means the
        // runtime is right but this plugin's own brain bundle is behind, and that is
        // rewritten unconditionally in the provision phase below — reinstalling 169 MB
        // to change a few hundred KB of bundle would be the wrong 8 seconds.
        if (gate.action === GATE.INSTALL) {
          const installedRuntime = await runtime.host.install(runtime.facts, {
            sources: this.sources,
            // Live byte counts while the archive downloads, and `undefined` the moment the
            // download ends — the phase has moved on and a stale bar would be a lie. Only
            // the first connect to a fresh node takes this path, which is exactly the one
            // that can sit for minutes with nothing on screen.
            onTransfer: progress => {
              runtime.dispatch({ type: STATUS_EVENT.TRANSFER_UPDATED, transfer: progress })
            },
          })
          runtime.dispatch({ type: STATUS_EVENT.RUNTIME_ROUTE_KNOWN, via: installedRuntime.via })
          runtime.log?.(
            `resident DSH ${installedRuntime.version} installed (${installedRuntime.via})`,
          )
        } else if (installed.via !== undefined) {
          // The tree was already usable, so nothing was installed — but the card still says how
          // it got there ("this node builds its own runtime" is the one fact that explains why
          // it behaves differently from its neighbours), and that fact must not disappear on
          // the second connect just because there was nothing to reinstall.
          runtime.dispatch({ type: STATUS_EVENT.RUNTIME_ROUTE_KNOWN, via: installed.via })
        }
        // Customise the node BEFORE starting it: install the plugins the user chose,
        // restore the brain bundle, point the profile at the list, and write the model
        // overlay. All of it has to be on disk for the host to load it, and a node that
        // came up with the wrong composition would look healthy and then either serve a
        // browser surface it has no use for or load no tools at all.
        this.#enterPhase(runtime, 'provision')
        const wanted = [...this.nodeBundles()]
        // A switch is a bundle *beyond* the fixed composition. Asking the fixed list beats
        // naming its entries again: this filter used to spell `@deepseek-ai/dsh-base` and the
        // brain package itself, so a change to the composition left a stale exception behind
        // that would quietly install `dsh-base` as if it were a plugin.
        const extras = wanted.filter(name => !NODE_BASE_BUNDLES.includes(name))
        // **A switch is a claim, and the claim is checked before anything is installed.** A
        // bundle whose composition names a Windows-only path cannot run on this node, and one
        // whose configuration this desktop cannot supply would load and then fail every call.
        // Both are refused here, with the reason, rather than composed and left broken — see
        // `docs/adr-0009`.
        const applicability = await this.#applicable(runtime, extras)
        const applicable = applicability.compose
        // A bundle only composes when the Loader can resolve it from the profile, so the
        // switched-on plugins have to exist on the node before the list names them. Doing
        // it here (not in the settings handler) keeps "the node is connected" and "the node
        // composes what the page says" the same fact.
        /** @type {Array<{ bundle: string, reason: string }>} */
        const unmet = []
        if (applicable.length > 0) {
          const install = await this.#installPlugins(runtime, applicable)
          runtime.provision ??= {}
          runtime.provision.plugins = {
            wanted: applicable,
            ...install,
            skipped: applicability.plugins.skipped,
          }
          unmet.push(...install.failed)
          for (const failure of install.failed) {
            this.log(`[${runtime.record.name}] ${failure.bundle} was not installed: ${failure.reason}`)
          }
        } else {
          runtime.provision ??= {}
          runtime.provision.plugins = { wanted: [], installed: [], copied: [], failed: [], skipped: applicability.plugins.skipped }
        }
        // **After** npm, not before: `npm install` prunes anything the profile's
        // `dependencies` does not list, and the brain bundle is copied in rather than
        // installed, so it counts as extraneous. Measured: installing one plugin deleted
        // `node_modules/@local/rnh-brain`, and the node then refused to start with
        // "cannot resolve profile bundle @local/rnh-brain".
        const composition = await runtime.host.writeBrainBundle(BRAIN_FILES, BRAIN_PACKAGE)
        // Only the bundles that really resolved are named: listing a package the node does
        // not have would compose nothing and hide the install failure behind a warning the
        // settings page never shows.
        const composed = wanted
          .filter(name => !extras.includes(name) || applicable.includes(name))
          .filter(name => !unmet.some(failure => failure.bundle === name))
        // The configuration files come **after** the packages and before the host starts:
        // the plugin reads them on its first session, so a host started without them caches
        // "no configuration" for that workspace (ADR-0009 §三).
        const configWritten = await this.#writePluginConfig(runtime, applicability.config)
        // The report carries paths, modes and key names; never the contents (see `#applicable`).
        const configReport = { ...applicability.config, files: undefined, written: configWritten.written }
        const bundles = await runtime.host.writeProfileBundles(composed)
        const provisioner = this.#provisionerFor(runtime)
        const plan = provisioner.plan()
        const wrote = await runtime.host.writePatch(plan.text)
        this.#enterPhase(runtime, 'start')
        const serving = await runtime.host.ensureServing({
          force: options.force === true,
          // Only the bundle's *code* needs a restart (modules re-import). A config
          // change reaches a running host through its profile patch, which the host
          // hot-reloads — see docs/adr-0001. The one exception is a third-party bundle's
          // own config file: that is outside DSH, so it is read once per workspace, and a
          // changed file therefore needs a fresh host.
          bundleChanged: composition.changed || bundles.changed || bundles.revertedPrevious
            || configWritten.changed,
        })
        // The endpoint is known but unproven: `pendingService` keeps the gateway able to mint
        // a cookie, while `serving` still means "connected" and nothing else.
        runtime.dispatch({ type: STATUS_EVENT.SERVICE_STARTED, service: serving })
        this.#enterPhase(runtime, 'verify')
        const cookie = await runtime.gateway.cookie(true)
        if (cookie.length === 0) throw new Error('the resident host issued no browser cookie')
        const listed = await runtime.gateway.call('session/list', { _request: {} })
        if (listed.ok !== true) {
          throw new Error(`the resident host refused session/list: ${listed.error?.message ?? 'unknown reason'}`)
        }
        // Credentials last: they can only be pushed once the host answers, and a
        // failure here must be reported without discarding a working connection.
        //
        // **Merged, not replaced.** This assignment used to be a fresh object literal, which
        // silently dropped the `plugins` report written a few lines above it — so the settings
        // card could never say "this plugin was refused, here is why" on a *first* connect,
        // only on a later sync. The one fact a person needs most is the one from the connect
        // that just happened.
        runtime.provision = {
          ...(runtime.provision ?? {}),
          rows: plan.rows.length,
          refs: [],
          config: configReport,
          composition: {
            bundle: BRAIN_PACKAGE,
            files: composition.files,
            changed: composition.changed || bundles.changed,
          },
        }
        try {
          runtime.provision.refs = await provisioner.pushCredentials(runtime.gateway, plan.refs)
        } catch (error) {
          runtime.provision.error = messageOf(error)
          this.log(`[${runtime.record.name}] could not push credentials: ${runtime.provision.error}`)
        }
        // **A capability that names a credential the node did not receive is reported, not
        // swallowed.** `web_search` is the case that taught this: `tool-web` is mounted by every
        // preset and needs `DEEPSEEK_API_KEY`, but the refs pushed are derived from the rows
        // this desktop copies — so a desktop whose model provider is not DeepSeek pushes
        // nothing, and the node advertises a tool whose every call answers "no credential".
        // The requirement is declared once, in `capabilities.mjs`, and reaches this file through
        // the generated `BRAIN_CREDENTIAL_REFS` (the plugin cannot import that module at
        // runtime). This is where the declaration and the pushed refs meet. It is a warning
        // rather than a refusal because the rest of the node works, and `web_fetch` needs no key.
        const missing = BRAIN_CREDENTIAL_REFS.filter(ref => !runtime.provision.refs.includes(ref))
        if (missing.length > 0) {
          runtime.provision.unmet = missing
          this.log(
            `[${runtime.record.name}] this node did not receive ${missing.join(', ')}, which a `
            + 'composed capability declares it needs — that tool will refuse every call until a '
            + 'matching provider row is on this desktop',
          )
        }
        // A recovery that reaches here is the end of the ladder; the `recovering` status (with
        // its rung) is gone with the success. The counter is what lets the card say "came back
        // twice since the app started".
        if (options.recovering === true) runtime.recoveries += 1
        runtime.dispatch({
          type: STATUS_EVENT.CONNECT_SUCCEEDED,
          service: serving,
          version: runtime.facts.nodeVersion,
        })
        if (options.recovering === true) this.log(`[${runtime.record.name}] reconnected after a drop`)
        return runtime.describe()
      } catch (error) {
        if (options.recovering === true && runtime.status.kind === NODE_STATUS_KIND.CONNECTING) {
          // **A failed reconnect rung is not a failure the person should see.** The ladder is a
          // quiet state by design: `recovering` (+ `state: 'idle'` + `droppedAt`), rendered as
          // "已断线，正在重连". Reporting it as `failed` made the card go red and show the last
          // attempt's sentence after the very first miss — the opposite of what the quiet ladder
          // is for, and misleading (`failed` promises the app stopped trying, while it is about
          // to try again). The reason is kept in `recovering.lastError` and the node's own log.
          this.#failRecoveryAttempt(runtime, error)
        } else {
          // The phase travels as a **payload** of the failure, so the card can still say which
          // step failed. It used to be cleared here, which threw away the single most useful
          // fact about the failure: a node that failed while unpacking its runtime and one that
          // failed in the SSH handshake both rendered as "无法连接: <one sentence>".
          const phase = runtime.status.kind === NODE_STATUS_KIND.CONNECTING
            ? runtime.status.phase?.name
            : undefined
          runtime.dispatch({
            type: STATUS_EVENT.CONNECT_FAILED,
            error: messageOf(error),
            failure: classifyFailure(error, { phase }),
          })
        }
        throw error
      }
    })
  }

  /**
   * Take one node down: cancel routing state, drop SSH, stop the resident Host.
   *
   * Every one of those is an effect of `DISCONNECT_REQUESTED`. The slow one (stopping the
   * resident host over SSH) is awaited from the returned effect list before the socket is
   * invalidated — invalidating first would leave the stop with no connection to run on.
   */
  async disconnect(runtime) {
    return await this.serial(runtime, async () => {
      const { pending } = runtime.dispatch({ type: STATUS_EVENT.DISCONNECT_REQUESTED })
      await Promise.allSettled(pending)
      runtime.dispatch({ type: STATUS_EVENT.DISCONNECTED })
      return runtime.describe()
    })
  }

  /**
   * A node's SSH socket closed on its own.
   *
   * This is the state that used to be invisible. `SshConnection` cleared its client and said
   * nothing, so the node's state stayed `connected`: the card kept a green dot, the sidebar
   * kept listing that node's workspaces, and every call routed to it failed with
   * `rnh/node-offline` — a failure that names a state the UI never showed.
   *
   * The recovery ladder is deliberately quiet and deliberately long. A machine that reboots
   * comes back in under a minute; a laptop that closed its lid comes back in hours. So: three
   * quick attempts (2 s, 4 s, 8 s) for the common case, then once every two minutes, forever,
   * until it works or the person presses Disconnect. Nothing is reported as an error while the
   * ladder runs.
   *
   * A drop is not treated as "the person wants it down": an explicit `disconnect()` cancels
   * the ladder first, which is the only way to say "stop trying". A **disabled** node is the
   * other exception — it goes to plain `idle`, not to a "reconnecting" that would say so
   * forever.
   */
  #onDrop(nodeId) {
    const runtime = this.runtimes.get(nodeId)
    if (runtime === undefined) return
    runtime.dispatch({
      type: STATUS_EVENT.DROP_DETECTED,
      at: Date.now(),
      recover: runtime.record.enabled,
    })
  }

  /**
   * Arm the reconnect timer for `delayMs`.
   *
   * The delay is **computed by the reducer** (`recoveryDelayMs(attempt)`) and handed here as a
   * number, so the ladder's arithmetic is testable without a clock and this method has no
   * opinion about rungs. Cancelling the previous timer is not "the ladder is over": the rung
   * lives in the status (`recovering.attempt`) and only a successful connect or a deliberate
   * disconnect removes it.
   */
  #armTimer(runtime, delayMs) {
    if (this.disposed) return
    this.#cancelTimer(runtime)
    const timer = setTimeout(() => {
      runtime.recoveryTimer = undefined
      if (this.disposed) return
      // A person may have disconnected, disabled the node, or reconnected it by hand while
      // this timer was pending; in every case this rung is stale.
      if (runtime.status.kind !== NODE_STATUS_KIND.RECOVERING) return
      if (!runtime.record.enabled) {
        runtime.dispatch({ type: STATUS_EVENT.RECOVERY_ABANDONED })
        return
      }
      // The rung advances **when the attempt starts**, exactly as the old ladder did. It is a
      // state change, so it goes through the reducer; a caller that stubs `connect()` (the unit
      // test does) still sees the ladder advance, because that is the timer's job, not connect's.
      const started = runtime.dispatch({ type: STATUS_EVENT.RECOVERY_ATTEMPT_STARTED, at: Date.now() })
      if (started.status.kind !== NODE_STATUS_KIND.CONNECTING) return
      void this.connect(runtime, { recovering: true }).catch(error => {
        // `connect()` normally reports the miss itself; this is the fallback for a connect that
        // threw before it could (and it is what the unit test's stubbed connect exercises).
        if (this.disposed) return
        this.#failRecoveryAttempt(runtime, error)
      })
    }, delayMs)
    // Never hold the Host open for a reconnect: a laptop lid closing must not keep the app alive.
    timer.unref?.()
    runtime.recoveryTimer = timer
  }

  /**
   * Stop the reconnect ladder's timer for one node: clear the timer, nothing else.
   *
   * Deliberately **does not reset the rung**. The rung is the ladder's memory, and "rearm the
   * timer" is not "the ladder is over". Reset belongs to a successful connect and to a
   * deliberate `disconnect()`, which discards the `recovering` status itself.
   */
  #cancelTimer(runtime) {
    if (runtime.recoveryTimer !== undefined) {
      clearTimeout(runtime.recoveryTimer)
      runtime.recoveryTimer = undefined
    }
  }

  /**
   * Report one missed ladder attempt: quiet `recovering`, reason in `lastError`, next rung armed.
   *
   * Idempotent by construction: only a `connecting` status that belongs to a recovery attempt
   * can be failed this way, so the `connect()` catch and the timer's own catch cannot both
   * rearm the ladder.
   */
  #failRecoveryAttempt(runtime, error) {
    if (runtime.status.kind !== NODE_STATUS_KIND.CONNECTING) return
    if (runtime.status.recovery === undefined) return
    runtime.dispatch({
      type: STATUS_EVENT.RECOVERY_ATTEMPT_FAILED,
      error: messageOf(error),
      at: Date.now(),
    })
  }

  /**
   * Execute the effects one reduction named.
   *
   * The whole side-effect surface of the lifecycle is this switch; adding a new state change
   * means adding an effect here (and to the `NodeStatusEffect` union), not sprinkling
   * assignments through the connect path. Order matters and is the reducer's: a host stop has
   * to be awaited before the socket is invalidated, which is why `stopResidentHost` returns a
   * promise the caller can await.
   *
   * @param {NodeRuntime} runtime
   * @param {import('./node-status.js').NodeStatusEffect[]} effects
   * @returns {Promise<unknown>[]}
   */
  #executeEffects(runtime, effects) {
    const pending = []
    for (const effect of effects) {
      switch (effect.type) {
        case 'publish':
          this.#publish()
          break
        case 'cancelTimer':
          this.#cancelTimer(runtime)
          break
        case 'armTimer':
          this.#armTimer(runtime, effect.delayMs)
          break
        case 'invalidateSocket':
          try { runtime.connection.invalidate() } catch { /* already gone */ }
          break
        case 'resetGateway':
          try { runtime.gateway.reset() } catch { /* already gone */ }
          break
        case 'stopResidentHost':
          pending.push(runtime.host.stop().catch(() => undefined))
          break
        case 'persistOutcome':
          try { this.registry.recordOutcome(runtime.record.id, effect.outcome) } catch { /* record may be gone */ }
          break
        case 'log':
          runtime.log?.(effect.message)
          break
        default:
          // An unknown effect is a programming error, and swallowing it would silently drop a
          // side effect the state machine asked for. Fail loudly.
          throw new TypeError(`unknown node status effect ${JSON.stringify(Reflect.get(effect, 'type'))}`)
      }
    }
    return pending
  }

  /** Move one connecting node to `name`, stamping the clock the card reads. */
  #enterPhase(runtime, name) {
    runtime.dispatch({ type: STATUS_EVENT.PHASE_ENTERED, phase: name, at: Date.now() })
  }

  /**
   * Connect every enabled node at startup without blocking the Host.
   *
   * **The secret has to be adopted here, not only in `connect()`.** `credentialsReady()`
   * reads the runtime's secret, which is filled by `put()` and by `connect()` — so on a Host
   * that just started, every runtime still reads "no credential" and this loop skipped
   * every node. Measured: after a restart the settings page showed all nodes `未连接`
   * and no remote workspace ever appeared, which is indistinguishable from "the plugin
   * is not working". A person's fix was to click 连接 by hand, which is exactly the
   * manual step autoConnect exists to remove.
   *
   * The read is per node and non-fatal: a node whose credential cannot be read is
   * reported by `connect()` itself (it adopts again and throws the named error), so a
   * broken store must not take the whole loop down.
   */
  autoConnect(delayMs = 2_000) {
    return setTimeout(() => {
      void (async () => {
        for (const runtime of this.list()) {
          if (!runtime.record.enabled) continue
          try {
            await this.#adoptSecret(runtime)
          } catch (error) {
            this.log(`[${runtime.record.name}] could not read its stored credential: ${messageOf(error)}`)
            continue
          }
          if (!runtime.credentialsReady()) continue
          void this.connect(runtime).catch(() => undefined)
        }
      })()
    }, delayMs)
  }

  /**
   * Push this Host's current model roster and keys to every **connected** node.
   *
   * This is what makes "the local Host is the only source of truth" true at every
   * moment rather than only at connect time: a model added, a provider edited or a
   * key rotated locally reaches a running node without a reconnect. The node's
   * profile patch is hot-reloaded by its own `dsh-hmr`, so no restart is involved.
   *
   * A failure is **not** swallowed: it becomes the node's status (through `SYNC_FAILED`), so
   * the card cannot stay green over a node whose configured composition was not written. That
   * was the remaining half of the "syncConfig fails, state unchanged" defect.
   *
   * Nodes that are not connected are skipped on purpose — `connect` writes the same
   * content, so there is nothing to queue for later.
   * @param {string} reason - logged, so a surprise sync is traceable.
   * @returns {Promise<Array<{ id: string, name: string, rows: number, changed: boolean, error?: string }>>}
   */
  async syncConfig(reason) {
    const results = []
    for (const runtime of this.list()) {
      if (runtime.status.kind !== NODE_STATUS_KIND.CONNECTED) continue
      results.push(await this.serial(runtime, async () => {
        const report = { id: runtime.record.id, name: runtime.record.name, rows: 0, changed: false }
        try {
          // Plugin switches first: the bundle list is written from what is installed, so a
          // package has to be on the node before the list can name it.
          const wanted = [...this.nodeBundles()]
          // Same exception as the connect path, and now the same expression: the fixed
          // composition is asked, not re-spelled.
          const extras = wanted.filter(name => !NODE_BASE_BUNDLES.includes(name))
          // The same fit check as the connect path, for the same reason: a plugin can be
          // switched on *after* a node is connected, and a platform refusal or a missing
          // configuration that only applied at connect time would be a switch that looks
          // applied on second use and does nothing. One decision, both entry points.
          const applicability = await this.#applicable(runtime, extras)
          const applicable = applicability.compose
          let composed = wanted
          if (applicable.length > 0) {
            const install = await this.#installPlugins(runtime, applicable)
            report.plugins = { wanted: applicable, ...install, skipped: applicability.plugins.skipped }
            runtime.provision ??= {}
            runtime.provision.plugins = report.plugins
            for (const failure of install.failed) {
              this.log(`[${runtime.record.name}] ${failure.bundle} was not installed: ${failure.reason}`)
            }
            composed = wanted
              .filter(name => !extras.includes(name) || applicable.includes(name))
              .filter(name => !install.failed.some(failure => failure.bundle === name))
          } else {
            report.plugins = { wanted: [], installed: [], copied: [], failed: [], skipped: applicability.plugins.skipped }
            runtime.provision ??= {}
            runtime.provision.plugins = report.plugins
            composed = wanted.filter(name => !extras.includes(name))
          }
          // Re-copy the brain bundle after npm: an install prunes the packages the profile
          // manifest does not depend on, and this one is copied in rather than installed.
          const composition = await runtime.host.writeBrainBundle(BRAIN_FILES, BRAIN_PACKAGE)
          // Configuration before the host decision below: a changed config file is one of the
          // two reasons the resident host has to be restarted (the other is a changed bundle
          // list). `optional` plugins whose configuration this desktop cannot supply were
          // already dropped from `composed` by `#applicable`.
          const configWritten = await this.#writePluginConfig(runtime, applicability.config)
          if (runtime.provision !== undefined) {
            runtime.provision.config = {
              ...applicability.config,
              files: undefined,
              written: configWritten.written,
            }
          }
          const bundles = await runtime.host.writeProfileBundles(composed)
          // A changed bundle list is module code: the resident host has to be restarted for
          // it to compose the new set, exactly as at connect time. The restart leaves this
          // Host holding a socket to a process that no longer exists — and a dead socket is
          // still *writable*, so it accepts frames nobody reads. Every stream opened on it
          // then produces nothing at all: measured, `tool-parity` waited 7 minutes for a
          // turn that had already completed on the node, and `event-relay` saw no
          // `api-session/*` events. `reset()` invalidates the carrier and every logical
          // stream; each relay's `onEnd` reopens on the new host (see `gateway.revive`).
          if (bundles.changed || bundles.revertedPrevious || composition.changed || configWritten.changed) {
            report.bundles = { changed: true, restarted: true }
            const serving = await runtime.host.ensureServing({ force: true })
            // The endpoint moved; the status machine owns it, so the gateway's serving
            // callback never reports a port nothing listens on.
            runtime.dispatch({ type: STATUS_EVENT.SERVICE_REFRESHED, service: serving })
          }
          const provisioner = this.#provisionerFor(runtime)
          const plan = provisioner.plan()
          report.rows = plan.rows.length
          report.changed = (await runtime.host.writePatch(plan.text)).changed
          report.refs = await provisioner.pushCredentials(runtime.gateway, plan.refs)
          if (runtime.provision !== undefined) {
            runtime.provision.rows = plan.rows.length
            runtime.provision.refs = report.refs
          }
          // The same declaration-versus-delivery check as the connect path: a desktop that
          // changes its model provider can *lose* a credential the node's capabilities need,
          // and a sync that silently stopped pushing it would leave a working-looking node
          // whose search tool fails on the first call.
          const missingRefs = BRAIN_CREDENTIAL_REFS.filter(ref => !report.refs.includes(ref))
          if (missingRefs.length > 0) {
            report.unmet = missingRefs
            if (runtime.provision !== undefined) runtime.provision.unmet = missingRefs
            this.log(
              `[${runtime.record.name}] config synced but ${missingRefs.join(', ')} is no longer `
              + 'provided by this desktop — a composed capability needs it',
            )
          } else if (runtime.provision !== undefined) {
            delete runtime.provision.unmet
          }
          this.log(`[${runtime.record.name}] config synced after ${reason}`
            + `${report.changed ? '' : ' (node already current)'}`)
        } catch (error) {
          // One unreachable node must not stop the others, and it must not be silent — neither
          // in the report nor in the node's own status.
          report.error = messageOf(error)
          const phase = runtime.status.kind === NODE_STATUS_KIND.CONNECTING
            ? runtime.status.phase?.name
            : 'provision'
          runtime.dispatch({
            type: STATUS_EVENT.SYNC_FAILED,
            error: report.error,
            failure: classifyFailure(error, { phase }),
          })
          this.log(`[${runtime.record.name}] config sync after ${reason} failed: ${report.error}`)
        }
        return report
      }))
    }
    return results
  }

  /**
   * Put the switched-on plugins on the node.
   *
   * Two kinds of plugin, two ways to arrive, and the distinction is not cosmetic:
   *
   * - **Published**: this desktop's manifest carries a version spec, so the node installs
   *   the same release from its own npm. Reusing the desktop's spec keeps both sides on the
   *   same release instead of whatever `latest` is by the time the switch is flipped.
   * - **Local** (`link:`): the plugin is a directory this person wrote, with no registry
   *   entry at all. `npm install @local/x` there is a guaranteed 404 — measured on a real
   *   node — so its files are copied instead.
   *
   * A copy cannot live in the profile's `dependencies` — there is nothing for npm to name —
   * so `npm install` sees it as extraneous. That is why published plugins are installed
   * **first** and copies are written **after**: a later install would prune a copy, and the
   * node would drop a plugin the switch says is on. Every connect and every sync repeats
   * the copy for exactly this reason (the write is digest-stamped, so an unchanged tree
   * costs one `cat`).
   *
   * @param {NodeRuntime} runtime
   * @param {readonly string[]} bundles
   * @returns {Promise<{ installed: string[], copied: string[], failed: Array<{ bundle: string, reason: string }> }>}
   */
  async #installPlugins(runtime, bundles) {
    const specs = this.pluginSpecs()
    if (specs === undefined) {
      return {
        installed: [], copied: [],
        failed: bundles.map(bundle => ({ bundle, reason: 'no plugin source is available' })),
      }
    }
    const local = bundles.filter(bundle => specs.isLocal(bundle))
    const published = bundles.filter(bundle => !specs.isLocal(bundle))
    const installed = []
    const failed = []
    // Published ones FIRST: `npm install` prunes whatever the profile manifest does not
    // list, and a copied local bundle is not in it. Copying before npm would mean copying
    // and then deleting, which looks like a working switch until the node restarts.
    if (published.length > 0) {
      const result = await runtime.host.installPlugins(published, bundle => specs.specOf(bundle))
      installed.push(...result.installed)
      failed.push(...result.failed)
    }
    const copied = []
    for (const bundle of local) {
      const files = specs.localFiles(bundle)
      if (Object.keys(files).length === 0) {
        failed.push({ bundle, reason: `${bundle} is a local plugin but its directory could not be read` })
        continue
      }
      try {
        await runtime.host.writePluginBundle(files, bundle)
        copied.push(bundle)
      } catch (error) {
        failed.push({ bundle, reason: messageOf(error) })
      }
    }
    return { installed, copied, failed }
  }

  /**
   * Decide which of the switched-on bundles may actually be composed onto this node.
   *
   * The switch says "this plugin also runs there". Two facts can make that false, and both are
   * answered **before** anything is installed, because installing a plugin the node cannot use
   * leaves a package on that disk forever and a switch that looks applied:
   *
   * 1. **Platform fit** — derived from the bundle's own bytes (`core/plugin-applicability.js`).
   *    A composition that names `C:\…\rhinomcp.exe` cannot be composed on Linux. This is also
   *    the answer for a real user of this project: they wrote a Windows-only plugin, they set
   *    up a Linux node, and the program refuses it **with the file and line** instead of
   *    silently composing a mode whose every tool call fails.
   * 2. **Configuration this desktop cannot supply** — declared in `capabilities.mjs` and
   *    applied by `host/plugin-config.js`. A plugin whose settings live outside DSH (memory is
   *    the measured case: `~/.hindsight/coding-agent.json`) loads and activates without them,
   *    then fails every call with 401. Composing it would be "declared, then broken", which is
   *    what the `optional` verdict exists to forbid.
   *
   * @param {NodeRuntime} runtime
   * @param {readonly string[]} extras - third-party bundle names from the switches.
   * @returns {{ compose: string[], plugins: object, config: object }}
   */
  async #applicable(runtime, extras) {
    const specs = this.pluginSpecs()
    const skipped = []
    const fitting = []
    for (const bundle of extras) {
      // No plugin source at all (a Host composed before the switches existed, a test double):
      // the fit question cannot be asked, and `#installPlugins` already answers it with "no
      // plugin source is available". Reporting a platform refusal here would be a guess.
      if (specs === undefined) {
        fitting.push(bundle)
        continue
      }
      const dir = specs.dirOf?.(bundle)
      if (dir === undefined) {
        // The package is listed by the switch but not on this disk any more (a person removed
        // it, or a profile was edited). Not a platform question: report it as unreadable.
        skipped.push({ bundle, reason: 'this desktop no longer has the package installed' })
        continue
      }
      const fit = nodeApplies({ bundle, dir, facts: runtime.facts })
      if (fit.fits) fitting.push(bundle)
      else {
        skipped.push({ bundle, reason: fit.reason, detail: fit.detail })
        this.log(`[${runtime.record.name}] ${bundle} was not sent: ${fit.reason}`)
      }
    }
    const { files, unavailable } = assembleConfig({ bundles: fitting, registry: BRAIN_THIRD_PARTY_CONFIG })
    const unusable = new Set(unavailable.map(gap => gap.bundle))
    for (const gap of unavailable) {
      this.log(
        `[${runtime.record.name}] ${gap.bundle} was not sent: ${gap.reason} — it would compose and `
        + 'fail every call, so it is left out of this node',
      )
    }
    const composable = fitting.filter(bundle => !unusable.has(bundle))
    return {
      compose: composable,
      plugins: { skipped },
      // **`content` never leaves this function.** `config` is spread into `describe()`, which
      // the settings page and the phone both read, and these files hold credentials: the report
      // carries the path, the mode and the key *names* only — the same rule `rnh-control`
      // follows for tool results ("no authentication material").
      config: {
        files,
        unavailable,
        written: [],
        report: files.map(file => ({ path: file.path, mode: file.mode, keys: file.keys })),
      },
    }
  }

  /**
   * Write the configured files onto the node, and say whether that changed anything.
   *
   * Written **before** the resident host is confirmed serving: the plugin reads its settings on
   * the first session in each workspace, and a host that was already running one has that read
   * cached — which is why the caller restarts when `changed` is true. See ADR-0009.
   * @param {NodeRuntime} runtime
   * @param {object} config - from `#applicable`.
   * @returns {Promise<{ changed: boolean, written: string[], error?: string }>}
   */
  async #writePluginConfig(runtime, config) {
    const written = []
    let changed = false
    for (const file of config.files) {
      try {
        // Read-before-write for one reason only: a connect that changes nothing must not
        // restart the resident host. The mode is checked too — a file with the right bytes and
        // the wrong permissions is re-chmodded by the write without rewriting the content.
        const existing = await runtime.host.readNodeFile(file.path)
        const sameBytes = existing.exists && !configDiffers(file, existing.content)
        if (sameBytes && existing.mode === file.mode) {
          written.push({ path: file.path, mode: file.mode, keys: file.keys, changed: false })
          continue
        }
        const result = await runtime.host.writeNodeFile(file.path, file.content, { mode: file.mode })
        written.push({ path: file.path, mode: result.mode, keys: file.keys, changed: result.changed })
        if (result.changed || !sameBytes) changed = true
      } catch (error) {
        // Reported, never swallowed: the bundle stays composed (its best chance is a working
        // file from an earlier connect) but the node's status carries the failure.
        config.error = messageOf(error)
        this.log(`[${runtime.record.name}] could not write ${file.path}: ${config.error}`)
        break
      }
    }
    config.written = written
    return { changed, written }
  }

  /** A provisioner bound to one node's logging and this Host's live config. */
  #provisionerFor(runtime) {
    return new Provisioner({
      // `Provisioner` calls the accessor itself, so a late-composed `configEditor`
      // is picked up rather than captured as `undefined` at construction time.
      configEditor: this.configEditor,
      credentials: this.credentials,
      version: this.version,
      log: message => this.log(`[${runtime.record.name}] ${message}`),
    })
  }

  /**
   * Release every connection and gateway, and stop every reconnect ladder.
   *
   * **The timers have to be cancelled here, not just forgotten.** The ladder arms a
   * `setTimeout` per dropped node; nothing else clears it when the plugin is unloaded, so a
   * timer fired into a disposed `Rnh`, opened a fresh SSH connection nobody was going to close,
   * and kept the process alive. The status machine terms the runtime (`TERMINATE_REQUESTED` →
   * `cancelTimer` + `resetGateway`), and `disposed` is set first so a callback that has already
   * fired cannot rearm the chain either.
   */
  dispose() {
    this.disposed = true
    for (const runtime of this.runtimes.values()) {
      try { runtime.dispatch({ type: STATUS_EVENT.TERMINATE_REQUESTED }) } catch { /* already gone */ }
      try { runtime.gateway.reset() } catch { /* already gone */ }
      try { runtime.connection.dispose() } catch { /* already gone */ }
    }
    this.runtimes.clear()
    this.listeners.clear()
  }

  #runtimeOf(record) {
    const existing = this.runtimes.get(record.id)
    if (existing !== undefined) {
      // The record is re-read on every `list()`, so a host key recorded by one connect has
      // to reach the connection that already exists — otherwise the verifier keeps seeing
      // `undefined` and every handshake is "first use".
      existing.connection.target.hostFingerprint = record.hostKey
      return existing
    }
    const created = new NodeRuntime(record, {
      log: this.log,
      version: this.version,
      // The state machine names its side effects; this Host is the only thing that owns the
      // timers, the registry and the listeners they need.
      onEffects: (runtime, effects) => this.#executeEffects(runtime, effects),
      onFirstFingerprint: (id, fingerprint) => this.#recordHostKey(id, fingerprint),
      onFingerprintMismatch: (id, expected, actual) => {
        this.log(
          `[${this.registry.get(id)?.name ?? id}] SSH host key changed: recorded ${expected}, `
          + `presented ${actual}. Refusing the connection.`,
        )
      },
      onDrop: id => this.#onDrop(id),
    })
    this.runtimes.set(record.id, created)
    return created
  }

  /**
   * Record the host key a node presented for the first time.
   *
   * Trust on first use, and only that: the point is not to prove the first key is right (no
   * out-of-band channel exists for that) but to make **every later** handshake provable. A key
   * that changes afterwards is the one signal a person can act on, and it is only available if
   * the first one was written down.
   */
  #recordHostKey(nodeId, fingerprint) {
    const record = this.registry.get(nodeId)
    if (record === undefined) return
    if (record.hostKey === fingerprint) return
    const written = this.registry.put({ ...record, hostKey: fingerprint })
    const runtime = this.runtimes.get(nodeId)
    if (runtime !== undefined) {
      // The runtime's own copy is what `describe()` reads, and it is only refreshed by
      // `list()`/`get()`. Without this line the key is recorded but the settings page keeps
      // showing the record from before the handshake until something else re-reads the list.
      runtime.record = written
      runtime.connection.target.hostFingerprint = fingerprint
    }
    this.log(`[${record.name}] recorded SSH host key ${fingerprint}`)
  }

  /** Read and adopt the stored secret; `true` when the handshake inputs changed. */
  async #adoptSecret(runtime) {
    return await runtime.adopt(await this.secrets.read(runtime.record.id))
  }

  #publish() {
    const nodes = this.list()
    for (const listener of [...this.listeners]) {
      try { listener(nodes) } catch { /* an observer must not break a lifecycle action */ }
    }
  }
}
