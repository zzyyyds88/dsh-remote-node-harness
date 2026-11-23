/**
 * One node's Typert Gateway client.
 *
 * The remote brain is a full DSH Host listening on its own loopback. This class
 * is the local half of that relationship: it mints the browser cookie the remote
 * requires, issues unary RPC over pooled SSH channels, and keeps one stream
 * carrier open per node so `workspace/follow`, `session/follow` and
 * `session/events` reach local subscribers as ordinary event streams.
 *
 * Nothing here translates paths, mirrors files or synthesises results. Every
 * value crossing this boundary is the remote Host's own answer.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/remote-gateway
 */
import { randomUUID } from 'node:crypto'
import { decodeGatewayAnswer } from './multipart.js'
import { cookiesOf, httpOverSsh, openChannel } from './ssh-http.js'
import { upgradeWebSocket } from './ws.js'

/** Endpoint that answers with the browser cookie when given the launch token. */
const TOKEN_PATH = token => `/?token=${encodeURIComponent(token)}`

/**
 * The transport bounds a caller passed, in the shape `httpOverSsh` reads.
 *
 * Copied field by field rather than spread: an `undefined` value must stay absent, so
 * the transport's own defaults apply, and a caller's unrelated option cannot leak into
 * an HTTP request object.
 * @param {{ signal?: AbortSignal, timeoutMs?: number, maxResponseBytes?: number }} init
 * @returns {{ signal?: AbortSignal, timeoutMs?: number, maxResponseBytes?: number }}
 */
function transportBounds(init) {
  /** @type {{ signal?: AbortSignal, timeoutMs?: number, maxResponseBytes?: number }} */
  const bounds = {}
  if (init.signal !== undefined) bounds.signal = init.signal
  if (init.timeoutMs !== undefined) bounds.timeoutMs = init.timeoutMs
  if (init.maxResponseBytes !== undefined) bounds.maxResponseBytes = init.maxResponseBytes
  return bounds
}

/** Failure codes this client can produce before the remote even answers. */
export const GATEWAY_FAILURE = Object.freeze({
  OFFLINE: 'rnh/offline',
  AUTH: 'rnh/auth',
  CARRIER: 'rnh/carrier',
  TIMEOUT: 'rnh/timeout',
})

/** One in-flight logical stream. */
class LogicalStream {
  /**
   * @param {string} endpoint
   * @param {{ onFrame: (value: unknown) => void, onEnd: (failure?: unknown) => void }} handlers
   * @param {import('./ws.js').WebSocketClient | undefined} carrier
   */
  constructor(endpoint, handlers, carrier) {
    this.endpoint = endpoint
    this.handlers = handlers
    this.carrier = carrier
    this.id = `s-${randomUUID()}`
    this.closed = false
    /** Whether the uplink was already half-closed, so it is not sent twice. */
    this.uplinkEnded = false
    /** What ended this stream, for a caller that only sees the settled handle. */
    this.outcome = /** @type {'end' | 'error' | 'cancelled' | undefined} */ (undefined)
  }

  /** Send one uplink item on this stream, if the carrier is still writable. */
  send(value) {
    if (this.closed || this.carrier === undefined) return false
    try {
      return this.carrier.send(JSON.stringify({ type: 'item', streamId: this.id, value }))
    } catch {
      return false
    }
  }

  /** Half-close the uplink: the node's `uplink()` iteration ends. Idempotent. */
  endUplink() {
    if (this.closed || this.uplinkEnded || this.carrier === undefined) return
    this.uplinkEnded = true
    try {
      this.carrier.send(JSON.stringify({ type: 'end', streamId: this.id }))
    } catch { /* the carrier is already gone */ }
  }

  /**
   * End this stream exactly once, whatever the reason.
   *
   * Every path out of a logical stream — the node's own `end`, its `error`, and this
   * side cancelling it — converges here, because the alternative is what produced the
   * worst bug in this file: `finish()` called `onEnd()` with no failure, and the error
   * frame then called `onEnd(error)` on an already-closed stream. The consumer's queue
   * had been told "clean end" first and dropped the error, so a node-side failure
   * reached the browser as an ordinary end of stream.
   *
   * `kind` is `'end'` (node finished), `'error'` (node failed, payload is why) or
   * `'cancelled'` (this side stopped reading). Only the first call has any effect.
   *
   * @param {'end' | 'error' | 'cancelled'} kind
   * @param {unknown} [payload] - the failure, for `kind: 'error'`.
   */
  settle(kind, payload) {
    if (this.closed) return
    this.closed = true
    this.outcome = kind
    if (kind === 'cancelled' && this.carrier !== undefined) {
      // Telling the node this stream is done matters for anything that holds a resource
      // on its side (a terminal attachment, a live follow). Without it the node keeps the
      // attachment until its own heartbeat gives up.
      try {
        this.carrier.send(JSON.stringify({ type: 'cancel', streamId: this.id }))
      } catch { /* the carrier is already gone */ }
    }
    try {
      if (kind === 'error') this.handlers.onEnd(payload)
      else this.handlers.onEnd()
    } catch { /* a consumer's handler must not break teardown */ }
  }

  /** Stop reading and tell the node to release its side. */
  close() {
    this.settle('cancelled')
  }

  /** The node ended this stream itself: drop it locally without telling it back. */
  finish() {
    this.settle('end')
  }
}

/** One node's gateway link: cookie, unary RPC, and the shared stream carrier. */
export class RemoteGateway {
  /**
   * @param {object} options
   * @param {import('../ssh/connection.js').SshConnection} options.connection
   * @param {() => ({ port: number, token: string } | undefined)} options.serving
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    this.connection = options.connection
    this.servingOf = options.serving
    this.log = options.log ?? (() => {})
    /** @type {string | undefined} */
    this.cookieValue = undefined
    /** @type {import('./ws.js').WebSocketClient | undefined} */
    this.carrier = undefined
    /** @type {Promise<import('./ws.js').WebSocketClient> | undefined} */
    this.carrierPending = undefined
    /** Bumped per carrier, so a late `close` from an old socket cannot clear the new one. */
    this.generation = 0
    /** @type {Map<string, LogicalStream>} */
    this.streams = new Map()
    /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this.waiters = new Map()
  }

  /** The endpoint facts of the resident host, or `undefined` while it is down. */
  serving() {
    return this.servingOf()
  }

  /** Drop cached auth and carrier state, e.g. after the node reconnects. */
  reset() {
    this.cookieValue = undefined
    // Invalidate the carrier's generation first: its `close` handler must not clear the state
    // this method is about to build for the next connection.
    this.generation = (this.generation ?? 0) + 1
    const carrier = this.carrier
    this.carrier = undefined
    this.carrierPending = undefined
    if (carrier !== undefined) {
      try { carrier.close() } catch { /* already closing */ }
    }
    for (const stream of [...this.streams.values()]) {
      try { stream.close() } catch { /* already closing */ }
    }
    this.streams.clear()
    for (const [id, waiter] of this.waiters) {
      clearTimeout(waiter.timer)
      this.waiters.delete(id)
      waiter.reject(Object.assign(new Error('the node went offline'), { code: GATEWAY_FAILURE.OFFLINE }))
    }
  }

  /**
   * Mint (or reuse) the browser cookie the remote application requires.
   *
   * A launch token is single-purpose: exchanging it at `/?token=` answers 303
   * with a v1 browser cookie. That cookie — not an API operator credential — is
   * what `authorizeIndex` and the `/api` interceptor accept, so every later
   * request carries it.
   *
   * `init` carries the per-call transport bounds (`signal`, `timeoutMs`,
   * `maxResponseBytes`). They are forwarded rather than owned here: a caller that
   * aborts or has its own deadline must be able to stop the cookie exchange too, and
   * a connection attempt and a data call can want different budgets.
   *
   * @param {boolean} [force]
   * @param {{ signal?: AbortSignal, timeoutMs?: number, maxResponseBytes?: number }} [init]
   * @returns {Promise<string>}
   */
  async cookie(force = false, init = {}) {
    if (!force && this.cookieValue !== undefined) return this.cookieValue
    const serving = this.serving()
    if (serving === undefined) {
      throw Object.assign(new Error('this node is not serving yet'), { code: GATEWAY_FAILURE.OFFLINE })
    }
    const response = await httpOverSsh(this.connection, serving.port, {
      path: TOKEN_PATH(serving.token),
      ...transportBounds(init),
    })
    const cookies = cookiesOf(response.headers)
    if (cookies.length === 0) {
      throw Object.assign(
        new Error(`the remote answered HTTP ${String(response.status)} without issuing a session cookie`),
        { code: GATEWAY_FAILURE.AUTH },
      )
    }
    this.cookieValue = cookies.join('; ')
    return this.cookieValue
  }

  /**
   * One unary Gateway call, retried once against a fresh cookie when the remote
   * rejects the cached one.
   *
   * `signal` stays a positional argument because the routing layer passes it that way;
   * the rest of the transport bounds ride in `init`. Both reach `httpOverSsh`, so an
   * aborted call and a call with its own deadline are stoppable at every wait, not only
   * before the request is written.
   *
   * @param {string} endpoint - e.g. `session/list`.
   * @param {Record<string, unknown>} args
   * @param {AbortSignal} [signal]
   * @param {{ timeoutMs?: number, maxResponseBytes?: number }} [init]
   * @returns {Promise<{ ok: true, value: unknown } | { ok: false, error: { code: string, message: string, details?: unknown } }>}
   */
  async call(endpoint, args = {}, signal, init = {}) {
    const bounds = transportBounds({ ...init, ...(signal === undefined ? {} : { signal }) })
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const serving = this.serving()
      if (serving === undefined) {
        throw Object.assign(new Error('this node is not serving yet'), { code: GATEWAY_FAILURE.OFFLINE })
      }
      bounds.signal?.throwIfAborted()
      const cookie = await this.cookie(attempt > 0, bounds)
      const payload = JSON.stringify({
        type: 'client-request',
        rpcId: `rnh-${randomUUID()}`,
        method: endpoint,
        payload: { args },
      })
      const response = await httpOverSsh(this.connection, serving.port, {
        path: `/api/${endpoint}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
          cookie,
        },
        body: payload,
        ...bounds,
      })
      if (response.status === 401) {
        lastError = Object.assign(new Error(`the remote rejected the call to ${endpoint} (HTTP 401)`), {
          code: GATEWAY_FAILURE.AUTH,
        })
        this.cookieValue = undefined
        continue
      }
      if (response.status !== 200) {
        throw Object.assign(
          new Error(`the remote answered HTTP ${String(response.status)} for ${endpoint}`),
          { code: GATEWAY_FAILURE.CARRIER },
        )
      }
      // A result carrying bytes comes back as `multipart/form-data`, not JSON:
      // `workspaceFiles/readBytes` is the common case, and a node's image or PDF
      // preview would silently break if this only JSON-parsed.
      let result
      try {
        result = decodeGatewayAnswer(response.body, response.headers['content-type'])
      } catch (error) {
        throw Object.assign(
          new Error(`the remote sent an unreadable answer for ${endpoint}: ${error.message}`),
          { code: GATEWAY_FAILURE.CARRIER, cause: error },
        )
      }
      if (result === undefined || typeof result !== 'object') {
        throw Object.assign(new Error(`the remote sent no result for ${endpoint}`), {
          code: GATEWAY_FAILURE.CARRIER,
        })
      }
      return result
    }
    throw lastError ?? Object.assign(new Error(`the call to ${endpoint} failed`), { code: GATEWAY_FAILURE.CARRIER })
  }

  /**
   * Run `open` again shortly, for a stream whose carrier ended.
   *
   * A carrier ends whenever the resident host restarts — a plugin switch does exactly that —
   * and a relay that does not come back stays dead until something else touches the node set.
   * Measured, that is not a cosmetic gap: after one plugin switch the node's Session rows
   * stopped producing events, its projection blocks vanished from the sidebar's control
   * baseline, and an approval card was answered here while the node never heard the answer.
   *
   * The pause is part of the fix. Reconnecting in the same tick reaches a host that is still
   * shutting down, fails, and there is then no second attempt. The attempts are bounded on
   * purpose: a node that is really gone must not keep a timer alive for ever.
   * @param {() => void | Promise<void>} open
   * @param {{ delayMs?: number, attempts?: number }} [options]
   */
  revive(open, options = {}) {
    const delayMs = options.delayMs ?? 1_000
    let left = options.attempts ?? 8
    const attempt = () => {
      if (left <= 0) return
      left -= 1
      if (this.serving() === undefined) return
      try {
        void open()
      } catch { /* the relay reports its own failure */ }
      if (left > 0) schedule()
    }
    const schedule = () => {
      const timer = setTimeout(attempt, delayMs)
      timer.unref?.()
    }
    schedule()
  }

  /**
   * Whether the cached carrier can still carry frames.
   *
   * A socket can be dead before its `close` event is delivered — the node's resident host
   * going away is exactly that case. Sending into it returns a write nobody reads, and the
   * logical stream opened on it then produces no frames at all: measured, `tool-parity` saw
   * `0 frames` for a Session that ran to completion right after a plugin switch restarted
   * the node's host.
   * @returns {boolean}
   */
  #carrierUsable() {
    const carrier = this.carrier
    if (carrier === undefined || carrier.closed) return false
    const stream = carrier.stream
    if (stream === null || typeof stream !== 'object') return true
    return stream.destroyed !== true && stream.writable !== false
  }

  /**
   * The live carrier, opening it on first use.
   *
   * `init` bounds only the **opening**: once the carrier is live, its lifetime is the
   * connection's, not a call's. An already-open carrier is returned regardless of the
   * bounds, because a subscriber asking for a short deadline must not be handed a
   * different socket from the one its sibling streams are already on.
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [init]
   * @returns {Promise<import('./ws.js').WebSocketClient>}
   */
  async carrierClient(init = {}) {
    if (this.#carrierUsable()) return this.carrier
    if (this.carrierPending !== undefined) return this.carrierPending
    this.carrierPending = this.#openCarrier(init)
    try {
      return await this.carrierPending
    } finally {
      this.carrierPending = undefined
    }
  }

  async #openCarrier(init = {}) {
    const serving = this.serving()
    if (serving === undefined) {
      throw Object.assign(new Error('this node is not serving yet'), { code: GATEWAY_FAILURE.OFFLINE })
    }
    // Two attempts, the second one with a freshly minted cookie. A resident host that
    // restarted (a plugin switch does it) rejects the previous cookie with HTTP 401 on the
    // upgrade, and one retry is all the difference between "the node's streams came back"
    // and "this Host believes the node has no event bus".
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const cookie = await this.cookie(attempt > 0, init)
      // The deadline belongs to the whole opening, but a dead channel has to be dropped
      // before that deadline: `openChannel` cannot see the carrier's connect timer, and
      // the upgrade timer cannot close a channel it never received.
      const channel = await openChannel(this.connection, serving.port, init.signal)
      let client
      // Generation guard: a carrier that closes late must not tear down the one that replaced
      // it. Without this, the corpse of a previous socket reports `close` after the retry has
      // already opened a new carrier, clears `this.carrier`, and closes every stream that the
      // new carrier was carrying — a restart then takes two carriers to settle, or never does.
      const generation = (this.generation = (this.generation ?? 0) + 1)
      try {
        client = await upgradeWebSocket(channel.stream, {
          host: `127.0.0.1:${String(serving.port)}`,
          path: '/api/remote.mux',
          origin: `http://127.0.0.1:${String(serving.port)}`,
          cookie,
          ...(init.timeoutMs === undefined ? {} : { connectTimeoutMs: init.timeoutMs }),
          // The carrier is the one place a protocol violation must be visible: a frame
          // this client cannot decode ends the socket, and the reason has to reach this
          // plugin's log or the node looks silent.
          log: message => this.log(message),
        }, {
          onText: text => this.#onCarrierText(text),
          onClose: () => {
            if (this.generation !== generation) return
            this.carrier = undefined
            for (const stream of [...this.streams.values()]) {
              try { stream.close() } catch { /* closing anyway */ }
            }
            this.streams.clear()
          },
        })
      } catch (error) {
        lastError = error
        if (Reflect.get(error ?? {}, 'status') === 401) {
          this.cookieValue = undefined
          continue
        }
        throw error
      }
      this.carrier = client
      return client
    }
    throw lastError ?? Object.assign(new Error('the stream carrier could not be opened'), { code: GATEWAY_FAILURE.CARRIER })
  }

  /** Fan one carrier frame out to the logical stream it belongs to. */
  #onCarrierText(text) {
    let frame
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    const stream = this.streams.get(frame.streamId)
    if (frame.type === 'item') {
      stream?.handlers.onFrame(frame.value)
      return
    }
    if (frame.type === 'end') {
      this.streams.delete(frame.streamId)
      stream?.settle('end')
      return
    }
    if (frame.type === 'error') {
      // One call, and it is the failing one: settling with the error is what lets the
      // consumer's queue reject. Finishing first and reporting the error second was the
      // bug — the queue had already been closed cleanly, and `fail()` on a closed queue
      // dropped the error, so an ordinary end of stream reached the browser.
      this.streams.delete(frame.streamId)
      if (stream === undefined) {
        // A failure for a stream this Host has already dropped (a closed tab, a cancelled
        // follow). There is no consumer left to fail, but the node said something went
        // wrong and it belongs in the log rather than nowhere.
        this.log(`the node reported a failure for stream ${String(frame.streamId)}: ${JSON.stringify(frame.error)}`)
        return
      }
      stream.settle('error', frame.error)
    }
  }

  /**
   * Open one logical stream on the shared carrier.
   *
   * The returned handle can also carry a *node-bound uplink*: a browser-facing
   * method that is itself a stream (`terminal/attach`, for instance) takes its
   * uplink items from this Host's own mux and has to hand them to the node instead
   * of consuming them locally. `send`/`endUplink` are that direction.
   *
   * `init` bounds the opening only (`signal`, `timeoutMs`). A stream that is already
   * open is not re-bounded: its lifetime is the carrier's.
   * @param {string} endpoint
   * @param {Record<string, unknown>} args
   * @param {{ onFrame: (value: unknown) => void, onEnd: (failure?: unknown) => void }} handlers
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [init]
   * @returns {Promise<{ close: () => void, send: (value: unknown) => boolean, endUplink: () => void }>}
   */
  async openStream(endpoint, args, handlers, init = {}) {
    // One retry on a fresh carrier: a socket that looked writable can still be the corpse of
    // the connection to a host that has since gone away, and the failure mode there is a
    // silently empty stream rather than an error. Reopening costs one round trip and turns
    // "this Session shows nothing" into "it shows everything".
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const carrier = await this.carrierClient(init)
      const stream = new LogicalStream(endpoint, handlers, carrier)
      this.streams.set(stream.id, stream)
      const sent = carrier.send(JSON.stringify({ type: 'open', streamId: stream.id, endpoint, payload: { args } }))
      if (sent) {
        return {
          close: () => {
            if (!this.streams.has(stream.id)) return
            this.streams.delete(stream.id)
            stream.close()
          },
          send: value => stream.send(value),
          endUplink: () => stream.endUplink(),
        }
      }
      this.streams.delete(stream.id)
      // Drop the carrier that refused the write, so the next attempt opens a new one.
      this.carrier = undefined
      try { carrier.close() } catch { /* already gone */ }
    }
    throw Object.assign(new Error('the stream carrier is not writable'), { code: GATEWAY_FAILURE.CARRIER })
  }
}
