/**
 * Make a node's pending approval / question visible and answerable in this Host's
 * browser — the piece that turns "the remote turn hits a permission prompt and
 * hangs" into "a card appears, exactly like a local session".
 *
 * ## Why the client needs no change
 *
 * Upstream forwards these two events as *waterfalls* on the Gateway-owned `$events`
 * stream. The browser half (`ClientRemoteEvents`) resolves `agentId` through the
 * `agent` Context adapter, which the session controller implements with
 * `retainAgentScope(id)` — and that path **synthesises a scope for any id,
 * including one that never appeared in `session/list`**. So a `rnh_…` identity
 * works: `ui-approval` / `ui-user-questions` receive the frame, key the card by
 * `ctx.sessions.scopeOf(this)`, and answer through the ordinary
 * `$events/result` RPC.
 *
 * ## Why this module builds the pending entry by hand
 *
 * The Host-side entry point for a forwarded waterfall is `api-remotes`, and its
 * listener requires `this` to be `scopeTarget(agent, agent)` — a carrier only
 * `@deepseek-ai/dsh-scope` can mint, and this plugin imports nothing from upstream.
 * Everything *after* that listener is plain instance state, though: the Gateway
 * keeps pending forwarded events in `pendingRemoteEvents` and delivers them with
 * `deliverRemoteEvent`, and the browser's answer comes back through
 * `receiveRemoteEventResult` into the very same table. So this module inserts a
 * pending entry that looks exactly like `startRemoteEvent` built it, and lets
 * upstream own delivery, deduplication and settlement.
 *
 * The three outcomes therefore mean what they mean upstream:
 *
 * | browser result | node receives | effect on the node |
 * |---|---|---|
 * | sentinel (nobody claimed it) | `{kind:'next'}` | the node's own default runs (`'unavailable'` for approval) |
 * | a real value | `{kind:'result', value}` | that value settles the node's waterfall |
 * | node cancelled | nothing | the local card disappears; the node already settled |
 *
 * ## Two hard constraints
 *
 * - `agentId` must be wrapped with `Router.toLocal`. The node's frame carries its
 *   native `session-…`; left bare, the browser would synthesise a scope for an id
 *   that is not in this Host's list, and the card would never reach the right
 *   session's composer.
 * - With no live owner client the pending would wait forever, which is precisely
 *   the failure this module exists to remove. So an unanswered Host asks the node
 *   for its own default immediately, and a stuck request expires on a timer.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/remote-waterfall
 */

/** Waterfalls the node may ask this Host to answer. */
export const RELAYED_WATERFALLS = Object.freeze(['approval/request', 'user-questions/request'])

/**
 * A request nobody answers within this window is handed back to the node's own
 * default. The node's default for an approval is `'unavailable'`, i.e. the exact
 * behaviour this plugin had before it could answer at all — so expiring is a
 * degrade, never a new failure mode.
 */
import { NodeStreamSet } from './node-stream-set.js'

const DEFAULT_TTL_MS = 10 * 60_000

/** Result the local dispatch returns when no listener claimed the request. */
const UNCLAIMED = Symbol('rnh.waterfall.unclaimed')

/** Marks the expiry of a request nobody answered, so the caller can still reply. */
const EXPIRED = 'rnh/waterfall-expired'

/** The Gateway-owned stream / result endpoints on the node. */
const EVENT_RESULT_ENDPOINT = '$events/result'

/**
 * Ask this Host's browser to answer one node waterfall.
 *
 * Returns `undefined` when the entry could not be built (unknown Gateway shape),
 * which the caller reports as "cannot relay" rather than silently answering for
 * the user.
 */
class LocalPending {
  /**
   * @param {object} gateway - this Host's `typertGateway` service.
   * @param {string} event
   * @param {string} eventId
   * @param {string} agentId - already wrapped into local form.
   * @param {Record<string, unknown>} request - wire-safe, without `agent`/`signal`.
   */
  constructor(gateway, event, eventId, agentId, request) {
    this.gateway = gateway
    this.id = eventId
    this.settled = Promise.withResolvers()
    this.timer = undefined
    this.frame = { type: 'waterfall', event, eventId, agentId, request }
    this.entry = {
      id: eventId,
      source: {
        resolve: outcome => this.settled.resolve(outcome),
        reject: error => this.settled.reject(error),
      },
      frame: this.frame,
      deliveries: /** @type {Set<unknown>} */ (new Set()),
      // The upstream entry releases the Agent context and the request signal here.
      // This relay owns neither: the context is the browser's, the lifetime is the
      // node's, and its `{type:'cancel'}` frame is what ends the local card.
      releaseContext: () => {},
      releaseSignal: () => {},
    }
  }

  /** Insert the entry and hand it to every owner client, like `startRemoteEvent`. */
  publish(ttlMs, onExpire) {
    const gateway = this.gateway
    gateway.pendingRemoteEvents.set(this.id, this.entry)
    for (const client of gateway.remoteEventClients.values()) {
      if (client.answers) gateway.deliverRemoteEvent(this.entry, client)
    }
    this.timer = setTimeout(() => {
      onExpire(this)
    }, ttlMs)
    this.timer.unref?.()
  }

  /** Withdraw the entry, telling every browser to drop the card. */
  cancel(reason) {
    clearTimeout(this.timer)
    try { this.gateway.cancelRemoteEvent(this.entry, reason) } catch { /* already settled */ }
  }

  /**
   * Give up waiting: withdraw the local card and remember *why*, so the caller can
   * still answer the node.
   *
   * Expiry and withdrawal are different outcomes for the node: expiry means "no
   * browser claimed this, use your default", withdrawal means "nobody needs an
   * answer any more". The reason carries the distinction.
   */
  expire() {
    clearTimeout(this.timer)
    const error = Object.assign(new Error('no browser answered in time'), {
      code: EXPIRED,
    })
    try { this.gateway.cancelRemoteEvent(this.entry, error) } catch { /* already settled */ }
    this.settled.reject(error)
  }

  /** Wait for the browser's answer, or for a cancellation. */
  async answer() {
    try {
      return await this.settled.promise
    } finally {
      clearTimeout(this.timer)
    }
  }
}

/** One node's relayed waterfalls, keyed by the node's own event identity. */
class NodeWaterfalls {
  /**
   * @param {string} nodeId
   * @param {import('./remote-gateway.js').RemoteGateway} gateway
   * @param {import('./router.js').Router} router
   * @param {object | undefined} hostGateway - this Host's `typertGateway`.
   * @param {{ log: (message: string) => void, ttlMs: number }} settings
   */
  constructor(nodeId, gateway, router, hostGateway, settings) {
    this.nodeId = nodeId
    this.gateway = gateway
    this.router = router
    this.hostGateway = hostGateway
    this.settings = settings
    /** The Client generation a node-side result must quote. */
    this.clientId = undefined
    /** Pending local entries, so a node `cancel` frame can find what to withdraw. */
    this.pending = new Map()
    this.closed = false
  }

  /**
   * Remember the node's client identity; a result is worthless without it.
   *
   * `closed` is cleared here on purpose. A stream that ends (the resident host restarting
   * is the ordinary cause — a plugin switch does it) calls {@link close}, and the reopened
   * stream arrives as a new client generation through this same method. Leaving `closed`
   * set meant every later answer was dropped after the browser had accepted it: measured,
   * an approval card was answered and the node never recorded the outcome.
   */
  ready(clientId) {
    this.closed = false
    this.clientId = typeof clientId === 'string' ? clientId : undefined
  }

  /** The node's stream ended: withdraw every card it left behind. */
  close() {
    this.closed = true
    this.clientId = undefined
    for (const pending of [...this.pending.values()]) {
      pending.cancel(new Error('the node disconnected before this request was answered'))
    }
    this.pending.clear()
  }

  /**
   * Relay one node waterfall into this Host.
   * @param {Record<string, unknown>} frame
   */
  async relay(frame) {
    const event = Reflect.get(frame, 'event')
    if (typeof event !== 'string' || !RELAYED_WATERFALLS.includes(event)) {
      await this.#reply(frame, { kind: 'next' })
      return
    }
    const eventId = Reflect.get(frame, 'eventId')
    const agentId = Reflect.get(frame, 'agentId')
    const request = Reflect.get(frame, 'request')
    if (typeof eventId !== 'string' || typeof agentId !== 'string'
      || request === null || typeof request !== 'object') {
      await this.#reply(frame, { kind: 'next' })
      return
    }
    const hostGateway = this.hostGateway
    // No browser is attached, so nothing could ever claim this: hand the node its
    // own default now instead of holding the remote turn open until it times out.
    if (hostGateway === undefined || typeof hostGateway.hasLiveClient !== 'function'
      || !hostGateway.hasLiveClient()) {
      await this.#reply(frame, { kind: 'next' })
      return
    }
    const local = new LocalPending(
      hostGateway,
      event,
      eventId,
      this.router.toLocal(agentId, this.nodeId),
      request,
    )
    this.pending.set(eventId, local)
    local.publish(this.settings.ttlMs, expired => {
      this.settings.log(`[${this.nodeId}] ${event} got no answer in time; the node's default applies`)
      if (this.pending.get(eventId) === expired) this.pending.delete(eventId)
      expired.expire()
    })
    try {
      const outcome = await local.answer()
      if (this.closed) return
      if (outcome?.kind === 'result' && this.#jsonSafe(outcome.value)) {
        await this.#reply(frame, { kind: 'result', value: outcome.value })
      } else {
        await this.#reply(frame, { kind: 'next' })
      }
    } catch (error) {
      // Two very different reasons to end up here:
      //
      //   - the node withdrew the request (`cancelled`, or its stream closed). The
      //     node already settled that waterfall, so answering is pointless.
      //   - nobody answered in time. The node is still waiting, and its own default
      //     is exactly what this plugin did before it could show a card — so hand it
      //     that default instead of leaving the remote turn blocked forever.
      if (Reflect.get(error ?? {}, 'code') === EXPIRED && !this.closed) {
        await this.#reply(frame, { kind: 'next' })
      }
    } finally {
      this.pending.delete(eventId)
    }
  }

  /** Withdraw the local card for one node-cancelled request. */
  cancelled(eventId) {
    const pending = typeof eventId === 'string' ? this.pending.get(eventId) : undefined
    if (pending === undefined) return
    this.pending.delete(eventId)
    pending.cancel(new Error('the node withdrew this request'))
  }

  /** Whether a value survives the Gateway's lossless-JSON result check. */
  #jsonSafe(value) {
    if (value === undefined) return false
    try {
      return JSON.stringify(value) !== undefined
    } catch {
      return false
    }
  }

  /**
   * Answer the node. A failure here cannot be retried and must not take the
   * stream down: the node has its own default, and a lost answer only means the
   * remote turn continues unanswered.
   */
  async #reply(frame, outcome) {
    const clientId = this.clientId
    if (clientId === undefined) {
      this.settings.log(`[${this.nodeId}] cannot answer ${String(Reflect.get(frame, 'event'))}: no client generation`)
      return
    }
    const eventId = Reflect.get(frame, 'eventId')
    if (typeof eventId !== 'string') return
    try {
      await this.gateway.call(EVENT_RESULT_ENDPOINT, { clientId, eventId, outcome })
    } catch (error) {
      this.settings.log(`[${this.nodeId}] could not answer ${String(Reflect.get(frame, 'event'))}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Every node's relayed waterfalls. */
export class RemoteWaterfalls {
  /**
   * @param {import('./rnh.js').Rnh} rnh
   * @param {import('./router.js').Router} router
   * @param {object | undefined} hostGateway - this Host's `typertGateway` service.
   * @param {{ log?: (message: string) => void, ttlMs?: number }} [options]
   */
  constructor(rnh, router, hostGateway, options = {}) {
    this.rnh = rnh
    this.router = router
    this.hostGateway = hostGateway
    this.settings = {
      log: options.log ?? (() => {}),
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    }
    this.streams = new NodeStreamSet(runtime => new NodeWaterfalls(
      runtime.record.id, runtime.gateway, this.router, this.hostGateway, this.settings,
    ))
    this.disposed = false
  }

  /**
   * Bring the relay set in line with the plugin.
   *
   * A node's forwarded-event stream already carries these frames, so this only
   * has to say which node owns the stream it just opened.
   */
  sync() {
    if (this.disposed) return
    const plan = this.streams.plan(this.rnh)
    for (const nodeId of plan.left) this.streams.drop(nodeId)
    for (const runtime of plan.arrived) this.streams.add(runtime)
  }

  /** The relay for one node, creating it if the caller got here first. */
  forNode(runtime) {
    return this.streams.get(runtime.record.id) ?? this.streams.add(runtime)
  }

  /** Withdraw every card and stop relaying. */
  dispose() {
    this.disposed = true
    this.streams.disposeAll()
  }
}
