/**
 * Relay every connected node's forwarded Host events into this Host's own bus.
 *
 * A merged `session/list` answer is a *snapshot*. The sidebar is not built from
 * snapshots alone: the client keeps a live picture by subscribing to five Host
 * events (`api-session/added`, `/removed`, `/status`, `/activity`, `/error`), and
 * a Session row that never receives them stays frozen — no title, no running
 * spinner, no new row until something else forces a full list pull.
 *
 * Local Sessions get those events from the local `SessionController`. A remote
 * Session is not a local Session, so nothing local ever emits them for it. This
 * module is the missing half: it opens each node's forwarded-event stream
 * (`$events`, the one endpoint the Gateway owns rather than a controller) and
 * re-emits what arrives on this Host, with identities wrapped exactly the way
 * `session/list` and `workspace/follow` wrap them.
 *
 * That re-emit is the whole trick, and it is why no browser-side change is
 * needed: upstream's `api-remotes` already forwards these events to every
 * attached client, so a wrapped `api-session/added` travels to the sidebar
 * through the same pipe a local one does.
 *
 * Scoped waterfalls (`approval/request`, `user-questions/request`) arrive on the
 * same stream. They are handed to {@link RemoteWaterfalls}, which asks this Host's
 * browser and answers the node with whatever came back: the browser synthesises an
 * Agent scope for the wrapped identity, renders the ordinary approval / question
 * card, and its answer settles the node's waterfall through `$events/result`.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/remote-events
 */
import { NodeStreamSet } from './node-stream-set.js'

/**
 * The forwarded events a remote Session row needs in order to stay live.
 *
 * Deliberately a closed list. Re-emitting an event this Host also emits locally
 * is safe (the client merges by identity), but re-emitting an event this Host
 * would have to *interpret* is not: an unlisted event would reach consumers that
 * assume a local Agent behind it.
 */
export const RELAYED_EVENTS = Object.freeze([
  'api-session/added',
  'api-session/removed',
  'api-session/status',
  'api-session/activity',
  'api-session/error',
])

/**
 * The Gateway's own stream / result endpoints.
 *
 * These are not `<namespace>/<method>` names on a controller: the Gateway
 * intercepts them before endpoint resolution. `$events` streams, `$events/result`
 * is an ordinary unary call that answers one pending waterfall.
 */
const EVENT_STREAM_ENDPOINT = '$events'
const EVENT_RESULT_ENDPOINT = '$events/result'

/** One node's forwarded-event stream. */
class NodeEvents {  /**
   * @param {string} nodeId
   * @param {import('./remote-gateway.js').RemoteGateway} gateway
   * @param {import('./remote-waterfall.js').NodeWaterfalls} waterfalls - the same node's waterfall relay.
   * @param {{ emit: (event: string, args: unknown[]) => void, log: (message: string) => void }} sink
   */
  constructor(nodeId, gateway, waterfalls, sink) {
    this.nodeId = nodeId
    this.gateway = gateway
    this.waterfalls = waterfalls
    this.sink = sink
    /** @type {{ close: () => void } | undefined} */
    this.stream = undefined
    /** The Client generation a waterfall result must quote. */
    this.clientId = undefined
    this.opening = undefined
    this.closed = false
  }

  /** Whether this node's event carrier is up right now. */
  get live() {
    return this.stream !== undefined
  }

  open() {
    if (this.stream !== undefined || this.opening !== undefined) return this.opening ?? Promise.resolve()
    this.opening = this.gateway.openStream(EVENT_STREAM_ENDPOINT, {}, {
      onFrame: value => this.#onFrame(value),
      onEnd: () => {
        // The carrier ended. Stop attributing anything to the old client id, and let the
        // owner notice: a stream that died has to be reopened, or this node's Session rows
        // freeze forever (no titles, no spinner, and approval cards never arrive).
        this.stream = undefined
        this.clientId = undefined
        this.waterfalls.close()
        this.sink.ended?.()
      },
    }).then(stream => {
      this.stream = stream
      this.opening = undefined
      return stream
    }).catch(error => {
      this.opening = undefined
      this.sink.log(`[${this.nodeId}] cannot follow node events: ${error instanceof Error ? error.message : String(error)}`)
    })
    return this.opening
  }

  close() {
    this.closed = true
    try { this.stream?.close() } catch { /* already closing */ }
    this.stream = undefined
    this.clientId = undefined
    this.waterfalls.close()
  }

  #onFrame(value) {
    if (this.closed) return
    const frame = value
    if (frame === null || typeof frame !== 'object') return
    const type = Reflect.get(frame, 'type')
    if (type === 'ready') {
      const clientId = Reflect.get(frame, 'clientId')
      this.clientId = typeof clientId === 'string' ? clientId : undefined
      this.waterfalls.ready(this.clientId)
      return
    }
    if (type === 'waterfall') {
      void this.waterfalls.relay(frame)
      return
    }
    // The node withdrew a request it had asked about — e.g. the tool call failed
    // or the turn was cancelled. The local card has to go away with it; answering
    // is pointless because the node already settled that waterfall.
    if (type === 'cancel') {
      this.waterfalls.cancelled(Reflect.get(frame, 'eventId'))
      return
    }
    if (type !== 'emit') return
    const event = Reflect.get(frame, 'event')
    if (typeof event !== 'string' || !RELAYED_EVENTS.includes(event)) return
    const args = Reflect.get(frame, 'args')
    if (!Array.isArray(args)) return
    this.sink.emit(event, args)
  }
}

/**
 * Answer every waterfall with `next` — the node's own default.
 *
 * Used when this Host has no `typertGateway` to relay through (an older or partial
 * composition). It keeps the old behaviour rather than leaving the remote turn
 * waiting for an answer that can never come.
 */
class DecliningRelay {
  /**
   * @param {string} nodeId
   * @param {import('./remote-gateway.js').RemoteGateway} gateway
   * @param {(message: string) => void} log
   */
  constructor(nodeId, gateway, log) {
    this.nodeId = nodeId
    this.gateway = gateway
    this.log = log
    this.clientId = undefined
    /** @type {Map<string, never>} */
    this.pending = new Map()
  }

  ready(clientId) {
    this.clientId = typeof clientId === 'string' ? clientId : undefined
  }

  close() {
    this.clientId = undefined
  }

  cancelled() {}

  async relay(frame) {
    const clientId = this.clientId
    const eventId = Reflect.get(frame, 'eventId')
    if (clientId === undefined || typeof eventId !== 'string') return
    try {
      await this.gateway.call(EVENT_RESULT_ENDPOINT, { clientId, eventId, outcome: { kind: 'next' } })
    } catch (error) {
      this.log(`[${this.nodeId}] could not decline ${String(Reflect.get(frame, 'event'))}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Every node's forwarded-event stream, feeding this Host's own event bus. */
export class RemoteEvents {
  /**
   * @param {import('./rnh.js').Rnh} rnh
   * @param {import('./router.js').Router} router
   * @param {{ emit: (event: string, args: unknown[]) => void, log?: (message: string) => void }} sink
   * @param {{ forNode: (runtime: object) => object } | undefined} waterfalls - relays the
   *   two scoped waterfalls that arrive on the same stream; without it they are
   *   answered for the user (the old behaviour) instead of shown. It is read through
   *   a getter because the Gateway this Host composes arrives after the plugin body
   *   runs.
   */
  constructor(rnh, router, sink, waterfalls) {
    this.rnh = rnh
    this.router = router
    this.waterfalls = waterfalls
    this.emit = sink.emit
    this.log = sink.log ?? (() => {})
    this.streams = new NodeStreamSet(runtime => new NodeEvents(
      runtime.record.id,
      runtime.gateway,
      // Without a relay the node's own default applies, which is what this
      // module's older build always did. Keeping that fallback means a Host
      // composed without `typertGateway` still answers instead of hanging.
      this.waterfalls?.forNode(runtime) ?? new DecliningRelay(runtime.record.id, runtime.gateway, this.log),
      {
        emit: (event, args) => this.#relay(runtime.record.id, event, args),
        log: this.log,
        ended: () => this.#reopen(runtime.record.id),
      },
    ))
    this.disposed = false
  }

  /**
   * Bring the stream set in line with the plugin.
   *
   * Idempotent and cheap: called on every rnh lifecycle change, it opens a stream for a
   * node that just became routable and drops one that left.
   *
   * A node whose stream **ended** is reopened too, and that is not a micro-optimisation: a
   * switch that restarts the node's resident host closes every carrier, and a map entry
   * that survives the restart means the node never gets its stream back. Measured: after a
   * plugin switch, `event-relay` saw no `api-session/*` for a Session created on the node,
   * and `approval` waited 180 s for a card that could not arrive.
   */
  sync() {
    if (this.disposed) return
    const plan = this.streams.plan(this.rnh)
    for (const nodeId of plan.left) this.streams.drop(nodeId)
    for (const runtime of plan.staying) {
      // Same node, same gateway: only the carrier is missing.
      const existing = this.streams.get(runtime.record.id)
      if (!existing.live) void existing.open()
    }
    for (const runtime of plan.arrived) {
      const node = this.streams.add(runtime)
      void node.open()
    }
  }

  /**
   * Reopen one node's event stream after its carrier ended.
   *
   * Delayed rather than immediate: a carrier that ended because the resident host is
   * restarting will fail straight away if reconnected in the same tick, and then the node
   * would sit streamless until something else happened. See `RemoteGateway#revive`.
   * @param {string} nodeId
   */
  #reopen(nodeId) {
    if (this.disposed) return
    const node = this.streams.get(nodeId)
    if (node === undefined) return
    const runtime = this.rnh.get(nodeId)
    if (runtime === undefined) return
    runtime.gateway.revive(() => {
      const current = this.streams.get(nodeId)
      if (current === undefined || current.live) return
      const live = this.rnh.get(nodeId)
      if (live === undefined || !live.routable) return
      void current.open()
    })
  }

  /**
   * Start relaying waterfalls, now that the Host has composed a Gateway.
   *
   * Streams opened before this point hold the declining fallback, which answered
   * every request for the user. Reopening them is cheap and is the only way those
   * nodes start showing cards without a reconnect.
   * @param {import('./remote-waterfall.js').RemoteWaterfalls} waterfalls
   */
  adopt(waterfalls) {
    this.waterfalls = waterfalls
    if (this.disposed) return
    this.streams.disposeAll()
    this.sync()
  }

  /** Close every stream. */
  dispose() {
    this.disposed = true
    this.streams.disposeAll()
  }

  /**
   * Re-emit one node event locally with this Host's identity encoding.
   *
   * Wrapping is `Router#toLocalEventArgs`, which is `toLocal` plus the one thing a
   * positional argument needs: the events in this list name a Session **by
   * position**, so a subagent's marker-less id is wrapped there instead of being
   * passed through. `toLocal` alone cannot see that identity — there is no field
   * name to read — and the measured cost was a parent row that never showed its
   * running children for the whole turn.
   */
  #relay(nodeId, event, args) {
    if (this.disposed) return
    const wrapped = this.router.toLocalEventArgs(event, args, nodeId)
    try {
      this.emit(event, wrapped)
    } catch (error) {
      // A listener throwing must not take the node stream down with it.
      this.log(`[${nodeId}] relaying ${event} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
