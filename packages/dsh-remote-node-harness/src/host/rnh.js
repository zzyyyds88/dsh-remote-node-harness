/**
 * The rnh: every configured node, its warm SSH connection, its resident Host,
 * and the gateway the routing layer calls.
 *
 * This is the single owner of live node state. The HTTP management API, the
 * routing decorators and the settings surface all read nodes from here, so a
 * connection started by one path is visible to the others without a second
 * bookkeeping channel.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/rnh
 */
import { NodeRegistry } from '../core/registry.js'
import { SecretStore, authFromSecret } from '../core/secrets.js'
import { classifyFailure } from '../core/errors.js'
import { GATE, decideGate } from '../core/version.js'
import { SshConnection } from '../ssh/connection.js'
import { RemoteHost, remoteLayout, MINIMUM_NODE_MAJOR } from '../remote/daemon.js'
import { BRAIN_FILES, BRAIN_PACKAGE } from './brain-bundle.generated.js'
import { NodeLog } from './node-log.js'
import { Provisioner } from './provision.js'
import { RemoteGateway } from './remote-gateway.js'

/**
 * The bundle list a node's profile composes.
 *
 * `dsh-base` is the shared core; the brain bundle is that core plus a Host and the
 * Remote API, with the browser surface removed. Upstream's `dsh-web-app` is
 * deliberately absent: a node serves no window, so it never even loads that layer.
 */
export const BRAIN_BUNDLES = Object.freeze(['@deepseek-ai/dsh-base', BRAIN_PACKAGE])

/**
 * How long to wait before each reconnect attempt after a drop, in order.
 *
 * Three quick tries for the common case (a machine that rebooted), then the steady interval
 * below. Measured against the real node: a `systemctl restart ssh` comes back in about two
 * seconds, so the first attempt almost always succeeds; a full reboot took 21 s, which lands on
 * the third or fourth.
 */
const RECOVERY_LADDER_MS = Object.freeze([2_000, 4_000, 8_000])

/** The interval between reconnect attempts once the quick ladder is exhausted. */
const RECOVERY_INTERVAL_MS = 120_000
/** Connection lifecycle of one node, as a settings surface shows it. */
export const NODE_STATE = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  FAILED: 'failed',
})

/** One live node: SSH connection, resident Host, and gateway. */
export class NodeRuntime {
  /**
   * @param {import('../core/registry.js').NodeRecord} record
   * @param {{ log: (message: string) => void, version: string }} options
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
    this.state = NODE_STATE.IDLE
    this.phase = undefined
    /**
     * When the current phase began, so the card can say how long it has been there.
     *
     * A five-step timeline with no clock reads the same at two seconds and at four minutes;
     * the one case where a person needs to know which is "is this hung". Cleared with the
     * phase, kept on a failure so the last phase still shows its duration.
     * @type {number | undefined}
     */
    this.phaseStartedAt = undefined
    this.error = undefined
    /** The classified form of `error`: `{ code, message, action, retryable, detail }`. */
    this.failure = undefined
    /**
     * When this node's connection dropped on its own, if it did.
     *
     * Kept separate from `lastConnectedAt` because the two answer different questions: "when
     * did it last work" survives a drop, "when did it stop" is what the card needs while the
     * reconnect ladder runs. Cleared on a successful connect.
     * @type {number | undefined}
     */
    this.droppedAt = undefined
    /** How many times this runtime has come back after a drop, since the app started. */
    this.recoveries = 0
    /** Which rung of the reconnect ladder the next attempt uses. */
    this.recoveryAttempts = 0
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.recoveryTimer = undefined
    this.facts = undefined
    /**
     * How this node's runtime arrived: `artefact` or `npm`.
     *
     * Kept on the runtime rather than re-read from the stamp on every `describe()`: the
     * settings page shows it next to the version, and a round trip per paint would be a
     * command on the node for a word on a card.
     * @type {'artefact' | 'npm' | undefined}
     */
    this.runtimeVia = undefined
    /** @type {{ port: number, token: string, pid: number, version: string } | undefined} */
    this.serving = undefined
    /**
     * Live download progress while a runtime archive is arriving, else `undefined`.
     *
     * Set and cleared by the install step itself: it exists only for as long as there is a
     * number to show, so a card can render it unconditionally instead of also tracking which
     * phase it belongs to.
     * @type {{ bytes: number, total?: number, bytesPerSecond?: number, etaMs?: number } | undefined}
     */
    this.transfer = undefined
    this.queue = Promise.resolve()
    /** @type {{ kind: 'password' | 'key' | 'agent', password?: string, privateKey?: string, passphrase?: string } | undefined} */
    this.secret = undefined
    /** What provisioning put on the node, for the settings surface. */
    this.provision = undefined
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
      serving: () => this.serving,
      log: message => this.log(`[${record.name}] ${message}`),
    })
  }

  /** Whether the node can answer routing calls right now. */
  get routable() {
    return this.state === NODE_STATE.CONNECTED && this.serving !== undefined
  }

  /** Adopt a freshly read secret, rebuilding the SSH client when it changes. */
  adopt(secret) {
    this.secret = secret
    const auth = authFromSecret(secret)
    if (auth === undefined) {
      this.connection.target.auth = { kind: this.record.auth.kind }
      return
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
  }

  /** Whether the stored secret is enough to attempt a connection. */
  credentialsReady() {
    const auth = authFromSecret(this.secret)
    if (auth === undefined) return false
    if (auth.kind === 'agent') return true
    if (auth.kind === 'password') return typeof auth.password === 'string' && auth.password.length > 0
    return auth.privateKey !== undefined
  }

  /** Snapshot for the management surface. */
  describe() {
    return {
      id: this.record.id,
      name: this.record.name,
      host: this.record.host,
      port: this.record.port,
      username: this.record.username,
      authKind: this.record.auth.kind,
      credentialsReady: this.credentialsReady(),
      enabled: this.record.enabled,
      remoteRoot: this.record.remoteRoot,
      state: this.state,
      ...(this.phase === undefined ? {} : { phase: this.phase }),
      ...(this.phaseStartedAt === undefined ? {} : { phaseStartedAt: this.phaseStartedAt }),
      ...(this.transfer === undefined ? {} : { transfer: this.transfer }),
      ...(this.runtimeVia === undefined ? {} : { runtimeVia: this.runtimeVia }),
      ...(this.error === undefined ? {} : { error: this.error }),
      // The machine-readable half of the same failure: a stable code, the one action worth
      // offering, and whether pressing Connect again could change anything. The client
      // localises the sentence and picks the button; this object is what makes that possible
      // without parsing an English message.
      ...(this.failure === undefined ? {} : { failure: this.failure }),
      ...(this.facts === undefined ? {} : { remote: this.facts }),
      ...(this.serving === undefined
        ? {}
        : { serving: { port: this.serving.port, version: this.serving.version } }),
      ...(this.provision === undefined ? {} : { provision: this.provision }),
      ...(this.record.hostKey === undefined ? {} : { hostKey: this.record.hostKey }),
      ...(this.record.lastConnectedAt === undefined ? {} : { lastConnectedAt: this.record.lastConnectedAt }),
      ...(this.record.lastSeenVersion === undefined ? {} : { lastSeenVersion: this.record.lastSeenVersion }),
      ...(this.droppedAt === undefined ? {} : { droppedAt: this.droppedAt }),
      ...(this.recoveries === 0 ? {} : { recoveries: this.recoveries }),
      // How many rungs of the ladder have been used. Without it the card can say "reconnecting"
      // but not whether that is the first attempt or the tenth, which is the difference
      // between waiting and going to look at the machine.
      ...(this.recoveryAttempts === 0 ? {} : { recoveryAttempts: this.recoveryAttempts }),
    }
  }
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
    if (typeof input.password === 'string' || typeof input.privateKey === 'string'
      || typeof input.passphrase === 'string') {
      await this.secrets.write(record.id, {
        kind: record.auth.kind,
        ...(typeof input.password === 'string' ? { password: input.password } : {}),
        ...(typeof input.privateKey === 'string' ? { privateKey: input.privateKey } : {}),
        ...(typeof input.passphrase === 'string' ? { passphrase: input.passphrase } : {}),
      })
      runtime.connection.invalidate()
    }
    await this.#adoptSecret(runtime)
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
   * @param {NodeRuntime} runtime
   * @param {{ force?: boolean, recovering?: boolean }} [options]
   */
  async connect(runtime, options = {}) {
    return await this.serial(runtime, async () => {
      if (runtime.state === NODE_STATE.CONNECTED && runtime.serving !== undefined && options.force !== true) {
        return runtime.describe()
      }
      // A person pressing Connect cancels a ladder that is already running: two attempts on
      // one node would race on `runtime.queue` and the loser would report a failure the other
      // one had already fixed.
      if (options.recovering !== true) this.#cancelRecovery(runtime)
      runtime.state = NODE_STATE.CONNECTING
      runtime.error = undefined
      runtime.failure = undefined
      this.#publish()
      try {
        await this.#adoptSecret(runtime)
        if (!runtime.credentialsReady()) {
          throw Object.assign(
            new Error('this node has no stored credential; add its password or private key first'),
            { code: 'credential-missing' },
          )
        }
        runtime.phase = 'probe'
        runtime.phaseStartedAt = Date.now()
        this.#publish()
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
        runtime.phase = 'install'
        runtime.phaseStartedAt = Date.now()
        this.#publish()
        // The gate decides; the installer only carries it out. Doing the comparison
        // here rather than inside `install` keeps the reason available to the settings
        // page, which is what the user reads when a connect refuses to proceed.
        const installed = await runtime.host.inspectRuntime()
        const gate = decideGate({
          hostVersion: this.version,
          hostBrain: this.brainVersion,
          nodeVersion: installed.version,
          nodeBrain: runtime.provision?.brainVersion,
          // A tree on the right version but packed by a different build is still wrong:
          // the version says which release it is, the stamp says which rules packed it.
          nodeRuntime: installed.usable ? undefined : installed.reason,
          // Reported, never judged: a tree the node resolved itself is as good as a
          // downloaded one, but "this node builds its own runtime" explains why it behaves
          // differently from its neighbours.
          nodeVia: installed.via,
        })
        runtime.gate = gate
        if (gate.action === GATE.AHEAD || gate.action === GATE.UNKNOWN) {
          throw new Error(gate.message)
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
              runtime.transfer = progress
              this.#publish()
            },
          })
          runtime.runtimeVia = installedRuntime.via
          runtime.log?.(
            `resident DSH ${installedRuntime.version} installed (${installedRuntime.via})`,
          )
        }
        // Customise the node BEFORE starting it: install the plugins the user chose,
        // restore the brain bundle, point the profile at the list, and write the model
        // overlay. All of it has to be on disk for the host to load it, and a node that
        // came up with the wrong composition would look healthy and then either serve a
        // browser surface it has no use for or load no tools at all.
        runtime.phase = 'provision'
        runtime.phaseStartedAt = Date.now()
        this.#publish()
        const wanted = [...this.nodeBundles()]
        const extras = wanted.filter(name => name !== BRAIN_PACKAGE && name !== '@deepseek-ai/dsh-base')
        // A bundle only composes when the Loader can resolve it from the profile, so the
        // switched-on plugins have to exist on the node before the list names them. Doing
        // it here (not in the settings handler) keeps "the node is connected" and "the node
        // composes what the page says" the same fact.
        /** @type {Array<{ bundle: string, reason: string }>} */
        const unmet = []
        if (extras.length > 0) {
          const install = await this.#installPlugins(runtime, extras)
          runtime.provision ??= {}
          runtime.provision.plugins = { wanted: extras, ...install }
          unmet.push(...install.failed)
          for (const failure of install.failed) {
            this.log(`[${runtime.record.name}] ${failure.bundle} was not installed: ${failure.reason}`)
          }
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
        const composed = wanted.filter(name => !unmet.some(failure => failure.bundle === name))
        const bundles = await runtime.host.writeProfileBundles(composed)
        const provisioner = this.#provisionerFor(runtime)
        const plan = provisioner.plan()
        const wrote = await runtime.host.writePatch(plan.text)
        runtime.phase = 'start'
        runtime.phaseStartedAt = Date.now()
        this.#publish()
        runtime.serving = await runtime.host.ensureServing({
          force: options.force === true,
          // Only the bundle's *code* needs a restart (modules re-import). A config
          // change reaches a running host through its profile patch, which the host
          // hot-reloads — see docs/adr-0001.
          bundleChanged: composition.changed || bundles.changed || bundles.revertedPrevious,
        })
        runtime.phase = 'verify'
        runtime.phaseStartedAt = Date.now()
        this.#publish()
        const cookie = await runtime.gateway.cookie(true)
        if (cookie.length === 0) throw new Error('the resident host issued no browser cookie')
        const listed = await runtime.gateway.call('session/list', { _request: {} })
        if (listed.ok !== true) {
          throw new Error(`the resident host refused session/list: ${listed.error?.message ?? 'unknown reason'}`)
        }
        // Credentials last: they can only be pushed once the host answers, and a
        // failure here must be reported without discarding a working connection.
        runtime.provision = {
          rows: plan.rows.length,
          refs: [],
          composition: {
            bundle: BRAIN_PACKAGE,
            files: composition.files,
            changed: composition.changed || bundles.changed,
          },
        }
        try {
          runtime.provision.refs = await provisioner.pushCredentials(runtime.gateway, plan.refs)
        } catch (error) {
          runtime.provision.error = error instanceof Error ? error.message : String(error)
          this.log(`[${runtime.record.name}] could not push credentials: ${runtime.provision.error}`)
        }
        runtime.state = NODE_STATE.CONNECTED
        runtime.phase = undefined
        runtime.phaseStartedAt = undefined
        runtime.transfer = undefined
        runtime.failure = undefined
        runtime.droppedAt = undefined
        runtime.registryError = undefined
        this.registry.recordOutcome(runtime.record.id, { ok: true, version: runtime.facts.nodeVersion })
        this.#publish()
        return runtime.describe()
      } catch (error) {
        runtime.state = NODE_STATE.FAILED
        // The phase is **kept**. It used to be cleared here, which threw away the single most
        // useful fact about the failure: which step it happened at. Measured: a node that
        // failed while unpacking its runtime and one that failed in the SSH handshake both
        // rendered as "无法连接: <one sentence>" with a Retry button, and the phase list that
        // had been filling in during the attempt vanished at exactly the moment it mattered.
        runtime.error = error instanceof Error ? error.message : String(error)
        runtime.failure = classifyFailure(error, { phase: runtime.phase })
        runtime.serving = undefined
        // The bytes are gone with the attempt; the phase clock is not — a failure keeps
        // `phaseStartedAt` so the card can still say how long the failing step took.
        runtime.transfer = undefined
        runtime.gateway.reset()
        this.registry.recordOutcome(runtime.record.id, { ok: false, error: runtime.error })
        this.#publish()
        throw error
      }
    })
  }

  /**
   * Take one node down: cancel routing state, drop SSH, stop the resident Host.
   */
  async disconnect(runtime) {
    return await this.serial(runtime, async () => {
      // A deliberate disconnect must not be reported as a drop, and must not start the
      // reconnect ladder: cancel it before the socket goes away.
      this.#cancelRecovery(runtime)
      runtime.gateway.reset()
      runtime.serving = undefined
      runtime.state = NODE_STATE.IDLE
      runtime.phase = undefined
      runtime.failure = undefined
      runtime.droppedAt = undefined
      await runtime.host.stop().catch(() => undefined)
      // `invalidate` drops the socket so the next connect handshakes afresh.
      // `dispose` would latch the connection shut, and Connect after Disconnect
      // would then fail with "ssh connection was closed" forever.
      runtime.connection.invalidate()
      this.#publish()
      return runtime.describe()
    })
  }

  /**
   * A node's SSH socket closed on its own.
   *
   * This is the state that used to be invisible. `SshConnection` cleared its client and said
   * nothing, so `NodeRuntime.state` stayed `connected`: the card kept a green dot, the sidebar
   * kept listing that node's workspaces, and every call routed to it failed with
   * `rnh/node-offline` — a failure that names a state the UI never showed.
   *
   * The recovery ladder is deliberately quiet and deliberately long. A machine that reboots
   * comes back in under a minute; a laptop that closed its lid comes back in hours. So: three
   * quick attempts (2 s, 4 s, 8 s) for the common case, then once every two minutes, forever,
   * until it works or the person presses Disconnect. Nothing is reported as an error while the
   * ladder runs — `state` is `idle` with `droppedAt` set, which the card renders as "已断线，
   * 正在重连", not as a red failure.
   *
   * A drop is not treated as "the person wants it down": an explicit `disconnect()` cancels
   * the ladder first, which is the only way to say "stop trying".
   */
  #onDrop(nodeId) {
    const runtime = this.runtimes.get(nodeId)
    if (runtime === undefined) return
    if (runtime.state !== NODE_STATE.CONNECTED) return
    this.log(`[${runtime.record.name}] the SSH connection closed; starting the reconnect ladder`)
    runtime.state = NODE_STATE.IDLE
    runtime.serving = undefined
    runtime.gateway.reset()
    runtime.phase = undefined
    runtime.failure = undefined
    runtime.droppedAt = Date.now()
    this.#publish()
    this.#scheduleRecovery(runtime)
  }

  /**
   * One attempt at bringing a dropped node back, and the next delay when it fails.
   *
   * The first three delays are short because the overwhelmingly common drop is a machine that
   * restarted; after that the interval settles at two minutes, because continuing to hammer a
   * machine that has been gone for a minute is pointless and every attempt costs a handshake.
   */
  #scheduleRecovery(runtime) {
    this.#cancelRecovery(runtime)
    const attempt = runtime.recoveryAttempts ?? 0
    const delay = attempt < RECOVERY_LADDER_MS.length
      ? RECOVERY_LADDER_MS[attempt]
      : RECOVERY_INTERVAL_MS
    const timer = setTimeout(() => {
      runtime.recoveryTimer = undefined
      if (runtime.state === NODE_STATE.CONNECTED) return
      if (!runtime.record.enabled) return
      runtime.recoveryAttempts = (runtime.recoveryAttempts ?? 0) + 1
      void this.connect(runtime, { recovering: true })
        .then(() => {
          runtime.recoveries += 1
          runtime.recoveryAttempts = 0
          runtime.droppedAt = undefined
          this.log(`[${runtime.record.name}] reconnected after a drop`)
          this.#publish()
        })
        .catch(error => {
          // Silent by design: a machine that is simply off is not an error the person needs to
          // read every two minutes. The card already says "已断线"; the log keeps the reason.
          this.log(
            `[${runtime.record.name}] reconnect attempt ${String(runtime.recoveryAttempts)} failed: `
            + `${error instanceof Error ? error.message : String(error)}`,
          )
          if (runtime.state !== NODE_STATE.CONNECTED) this.#scheduleRecovery(runtime)
        })
    }, delay)
    // Never hold the Host open for a reconnect: a laptop lid closing must not keep the app alive.
    timer.unref?.()
    runtime.recoveryTimer = timer
  }

  /** Stop the reconnect ladder for one node. */
  #cancelRecovery(runtime) {
    if (runtime.recoveryTimer !== undefined) {
      clearTimeout(runtime.recoveryTimer)
      runtime.recoveryTimer = undefined
    }
    runtime.recoveryAttempts = 0
  }

  /**
   * Connect every enabled node at startup without blocking the Host.
   *
   * **The secret has to be adopted here, not only in `connect()`.** `credentialsReady()`
   * reads `runtime.secret`, which is filled by `put()` and by `connect()` — so on a Host
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
            this.log(`[${runtime.record.name}] could not read its stored credential: ${error instanceof Error ? error.message : String(error)}`)
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
   * Nodes that are not connected are skipped on purpose — `connect` writes the same
   * content, so there is nothing to queue for later.
   * @param {string} reason - logged, so a surprise sync is traceable.
   * @returns {Promise<Array<{ id: string, name: string, rows: number, changed: boolean, error?: string }>>}
   */
  async syncConfig(reason) {
    const results = []
    for (const runtime of this.list()) {
      if (runtime.state !== NODE_STATE.CONNECTED) continue
      results.push(await this.serial(runtime, async () => {
        const report = { id: runtime.record.id, name: runtime.record.name, rows: 0, changed: false }
        try {
          // Plugin switches first: the bundle list is written from what is installed, so a
          // package has to be on the node before the list can name it.
          const wanted = [...this.nodeBundles()]
          const extras = wanted.filter(name => name !== BRAIN_PACKAGE && name !== '@deepseek-ai/dsh-base')
          let composed = wanted
          if (extras.length > 0) {
            const install = await this.#installPlugins(runtime, extras)
            report.plugins = { wanted: extras, ...install }
            runtime.provision ??= {}
            runtime.provision.plugins = report.plugins
            for (const failure of install.failed) {
              this.log(`[${runtime.record.name}] ${failure.bundle} was not installed: ${failure.reason}`)
            }
            composed = wanted.filter(name => !install.failed.some(failure => failure.bundle === name))
          }
          // Re-copy the brain bundle after npm: an install prunes the packages the profile
          // manifest does not depend on, and this one is copied in rather than installed.
          const composition = await runtime.host.writeBrainBundle(BRAIN_FILES, BRAIN_PACKAGE)
          const bundles = await runtime.host.writeProfileBundles(composed)
          // A changed bundle list is module code: the resident host has to be restarted for
          // it to compose the new set, exactly as at connect time. The restart leaves this
          // Host holding a socket to a process that no longer exists — and a dead socket is
          // still *writable*, so it accepts frames nobody reads. Every stream opened on it
          // then produces nothing at all: measured, `tool-parity` waited 7 minutes for a
          // turn that had already completed on the node, and `event-relay` saw no
          // `api-session/*` events. `reset()` invalidates the carrier and every logical
          // stream; each relay's `onEnd` reopens on the new host (see `gateway.revive`).
          if (bundles.changed || bundles.revertedPrevious || composition.changed) {
            report.bundles = { changed: true, restarted: true }
            runtime.serving = await runtime.host.ensureServing({ force: true })
            runtime.gateway.reset()
            this.#publish()
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
          this.log(`[${runtime.record.name}] config synced after ${reason}`
            + `${report.changed ? '' : ' (node already current)'}`)
        } catch (error) {
          // One unreachable node must not stop the others, and it must not be silent.
          report.error = error instanceof Error ? error.message : String(error)
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
        failed.push({ bundle, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return { installed, copied, failed }
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

  /** Release every connection and gateway. */
  dispose() {
    for (const runtime of this.runtimes.values()) {
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

  async #adoptSecret(runtime) {
    runtime.adopt(await this.secrets.read(runtime.record.id))
  }

  #publish() {
    const nodes = this.list()
    for (const listener of [...this.listeners]) {
      try { listener(nodes) } catch { /* an observer must not break a lifecycle action */ }
    }
  }
}
