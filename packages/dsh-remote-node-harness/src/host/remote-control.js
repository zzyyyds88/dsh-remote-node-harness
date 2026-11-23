/**
 * Keep remote Sessions' *projections* live in every attached client.
 *
 * `session/control` is the stream that carries per-Session projection state: the
 * title, the model selection, the permission preset, the pending-input flags, the
 * subagent roster. Upstream's client half keeps one of these per connection and
 * treats its opening frame as the authoritative baseline, then applies
 * `projection` frames by ascending seq.
 *
 * Local Sessions are already in that stream. A remote Session is not a local
 * Session, so without this module its projections never move: a title the node's
 * brain wrote after the first turn would stay "New Session" in the sidebar until
 * something forced a full list pull.
 *
 * Two differences from `RemoteWorkspaces` shape the design:
 *
 *   - the control stream is **per consumer** upstream, and a client can open
 *     several (one per connection generation). So the node streams are owned once
 *     here and fanned out, instead of being opened per consumer.
 *   - a client treats every `baseline` frame as replace-your-picture, so this
 *     module can re-publish one whenever the node set changes — which is exactly
 *     what makes a node connecting mid-session appear without a page reload.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/remote-control
 */
import { mergedStream } from './merge-stream.js'
import { decodeRemoteId, encodeRemoteId } from './routing.js'

/** One node's control stream, reduced to the two frame kinds that matter. */
class NodeControl {
  /**
   * @param {string} nodeId
   * @param {import('./remote-gateway.js').RemoteGateway} gateway
   * @param {(node: NodeControl, frame: unknown) => void} onFrame
   */
  constructor(nodeId, gateway, onFrame) {
    this.nodeId = nodeId
    this.gateway = gateway
    this.onFrame = onFrame
    /** @type {Record<string, unknown> | undefined} */
    this.projections = undefined
    /** @type {{ close: () => void } | undefined} */
    this.stream = undefined
    this.closed = false
  }

  /** Whether this node's control carrier is up right now. */
  get live() {
    return this.stream !== undefined
  }

  async open() {
    if (this.stream !== undefined || this.closed) return
    // The handle is only kept if this generation is still current: a carrier that dies while
    // the upgrade is in flight calls `onEnd` first, and assigning the (already closed) handle
    // afterwards would leave `live` true over a stream that delivers nothing — exactly the
    // state a restart produces.
    const token = (this.openingToken = (this.openingToken ?? 0) + 1)
    try {
      const stream = await this.gateway.openStream('session/control', {}, {
        onFrame: value => {
          if (this.closed) return
          const frame = value
          if (frame === null || typeof frame !== 'object') return
          const type = Reflect.get(frame, 'type')
          if (type === 'baseline') {
            const value = Reflect.get(frame, 'value')
            const projections = Reflect.get(value ?? {}, 'projections')
            this.projections = projections !== null && typeof projections === 'object' ? projections : {}
            this.onFrame(this, frame)
            return
          }
          if (type === 'projection') {
            // Fold the change into this node's block picture before passing it on.
            //
            // Without this, `projections` only ever held what the node's *opening* baseline
            // contained: a Session created after the relay connected lives entirely in
            // `projection` frames, so a client attaching later (a page reload, a second
            // window) would get a merged baseline that does not name it at all. Upstream's
            // client repairs that from `session/list`, which this Host cannot use for a
            // remote row — the list is a snapshot taken on the node, not a per-Session block.
            this.#absorb(frame)
            this.onFrame(this, frame)
          }
        },
        onEnd: () => {
          this.stream = undefined
          // A carrier ends whenever the resident host restarts (a plugin switch does it).
          // Without reopening, this node's projection blocks disappear from the merged
          // baseline for good: the title, the spinner, the pending-input flags all freeze.
          if (!this.closed) this.gateway.revive(() => { void this.open() })
        },
      })
      if (this.openingToken !== token || this.closed) {
        try { stream.close() } catch { /* already closing */ }
        return
      }
      this.stream = stream
    } catch {
      // A node that cannot stream control contributes no projections; the list
      // snapshot still carries whatever that node last reported. Retrying matters after a
      // restart: the resident host refuses the first upgrade while it is still coming up,
      // and a relay that gives up here leaves this node's blocks out of every merged
      // baseline until something else touches the node set.
      this.stream = undefined
      if (!this.closed) this.gateway.revive(() => { void this.open() })
    }
  }

  close() {
    this.closed = true
    try { this.stream?.close() } catch { /* already closing */ }
    this.stream = undefined
    this.projections = undefined
  }

  /**
   * Fold one `projection` frame into this node's block picture.
   *
   * The node's control baseline lists every Session it currently has **live**, and a remote
   * Session lives in the node's memory only while that Session is open — a restart, or
   * simply time, empties it. So the relay keeps its own picture instead of forwarding the
   * node's: a block is created on the first frame naming that Session, `asOfSeq` moves
   * forward with the frame's `seq`, and `changes` are merged key by key exactly as upstream's
   * client applies them. A date-less block is still useful — it is what makes the row's title
   * and spinner survive a reload.
   * @param {Record<string, unknown>} frame
   */
  #absorb(frame) {
    const sessionId = Reflect.get(frame, 'sessionId')
    const seq = Reflect.get(frame, 'seq')
    const changes = Reflect.get(frame, 'changes')
    if (typeof sessionId !== 'string' || !Array.isArray(changes)) return
    const blocks = this.projections ?? (this.projections = {})
    const previous = Reflect.get(blocks, sessionId)
    const values = { ...(Reflect.get(previous ?? {}, 'values') ?? {}) }
    for (const change of changes) {
      const key = Reflect.get(change ?? {}, 'key')
      if (typeof key !== 'string') continue
      values[key] = Reflect.get(change, 'val')
    }
    blocks[sessionId] = {
      asOfSeq: typeof seq === 'number' ? seq : Reflect.get(previous ?? {}, 'asOfSeq') ?? 0,
      values,
    }
  }
}

/** The merged projection picture across this Host and every connected node. */
export class RemoteControl {
  /**
   * @param {import('./rnh.js').Rnh} rnh
   * @param {import('./router.js').Router} router
   * @param {(message: string) => void} [log]
   */
  constructor(rnh, router, log = () => {}) {
    this.rnh = rnh
    this.router = router
    this.log = log
    /** @type {Map<string, NodeControl>} */
    this.nodes = new Map()
    /** @type {Set<(frame: unknown) => void>} */
    this.subscribers = new Set()
    this.disposed = false
  }

  /** Bring the node set in line with the plugin. */
  /**
   * Bring the node set in line with the plugin.
   *
   * A node whose control stream **ended** is reopened, not just kept in the map. The
   * stream dies whenever the resident host restarts (a plugin switch does exactly that),
   * and leaving the entry behind would mean that node's projections never come back: the
   * spinner and the per-Session activity block are what the sidebar reads them for.
   */
  sync() {
    if (this.disposed) return
    const routable = this.rnh.routable()
    const live = new Set(routable.map(runtime => runtime.record.id))
    let changed = false
    for (const [nodeId, node] of [...this.nodes]) {
      if (live.has(nodeId)) continue
      node.close()
      this.nodes.delete(nodeId)
      changed = true
    }
    for (const runtime of routable) {
      const nodeId = runtime.record.id
      const existing = this.nodes.get(nodeId)
      if (existing !== undefined) {
        if (!existing.live) void existing.open()
        continue
      }
      const node = new NodeControl(nodeId, runtime.gateway, (owner, frame) => this.#onNodeFrame(owner, frame))
      this.nodes.set(nodeId, node)
      void node.open()
      changed = true
    }
    if (changed) this.#publishBaseline()
  }

  /**
   * The union baseline: every node's blocks, keyed by wrapped identity.
   * @returns {{ type: 'baseline', value: { projections: Record<string, unknown> } }}
   */
  baselineFrame() {
    /** @type {Record<string, unknown>} */
    const projections = {}
    for (const node of this.nodes.values()) {
      if (node.projections === undefined) continue
      for (const [sessionId, block] of Object.entries(node.projections)) {
        projections[encodeRemoteId(node.nodeId, sessionId)] = this.router.toLocal(block, node.nodeId)
      }
    }
    return { type: 'baseline', value: { projections } }
  }

  /** Subscribe to merged frames; returns the unsubscribe. */
  subscribe(listener) {
    this.subscribers.add(listener)
    return () => { this.subscribers.delete(listener) }
  }

  /** Close every node stream. */
  dispose() {
    this.disposed = true
    for (const node of this.nodes.values()) node.close()
    this.nodes.clear()
    this.subscribers.clear()
  }

  #onNodeFrame(node, frame) {
    if (this.disposed) return
    // A node baseline replaces that node's blocks, so the whole union has to be
    // republished; a projection frame travels alone.
    if (Reflect.get(frame, 'type') === 'baseline') {
      this.#publishBaseline()
      return
    }
    this.#publish(this.router.toLocal(frame, node.nodeId))
  }

  #publishBaseline() {
    this.#publish(this.baselineFrame())
  }

  #publish(frame) {
    for (const listener of [...this.subscribers]) {
      try { listener(frame) } catch { /* a consumer must not break the feed */ }
    }
  }
}

/**
 * Merge this Host's own control stream with the remote projection picture.
 *
 * The trap here is that **both** halves speak `baseline`, and a client treats any
 * `baseline` frame as "this is now the whole picture". Emitting the remote baseline
 * and then the local one therefore leaves the remote rows wiped out — the picture
 * looks correct for one frame and empty afterwards, which reads as "remote
 * projections never worked".
 *
 * So exactly one baseline reaches the client: the local generation's own, with the
 * remote blocks folded into it under wrapped identities. A remote baseline change
 * (a node that connected or dropped mid-stream) re-emits that merged frame, using
 * the local blocks last seen — which is what upstream would do on reconnect.
 *
 * `projection` frames stream through unchanged in both directions: the local ones
 * are already local, and the remote ones were wrapped by `RemoteControl`.
 *
 * @param {AsyncIterable<unknown>} local
 * @param {import('./remote-control.js').RemoteControl} control
 * @param {AbortSignal | undefined} signal
 * @returns {AsyncIterable<unknown>}
 */
export function mergeControlStream(local, control, signal) {
  return mergedStream({
    local,
    signal,
    create: emit => {
      /** The local baseline's blocks, kept so a later remote change can re-merge. */
      let localBlocks = {}
      /** Whether the client has received its one and only opening baseline. */
      let opened = false

      /** One baseline frame: local blocks plus every node's wrapped blocks. */
      const merged = () => {
        const projections = { ...localBlocks }
        const remote = control.baselineFrame().value.projections
        for (const [sessionId, block] of Object.entries(remote)) projections[sessionId] = block
        return { type: 'baseline', value: { projections } }
      }

      return {
        subscribe: () => control.subscribe(frame => {
          // A remote baseline replaced that node's blocks, so the whole picture has
          // to be re-sent. Before the local baseline arrives there is nothing to
          // merge into, and the opening frame will carry the new blocks anyway.
          if (Reflect.get(frame ?? {}, 'type') === 'baseline') {
            if (opened) emit(merged())
            return
          }
          emit(frame)
        }),
        onLocalFrame: frame => {
          if (Reflect.get(frame ?? {}, 'type') !== 'baseline') {
            emit(frame)
            return
          }
          const value = Reflect.get(frame, 'value')
          const projections = Reflect.get(value ?? {}, 'projections')
          localBlocks = projections !== null && typeof projections === 'object' ? projections : {}
          // The first baseline is the interesting one: it becomes the single
          // merged frame. A later local baseline would carry a fresh local
          // picture, so it replaces `localBlocks` and re-merges too.
          opened = true
          emit(merged())
        },
      }
    },
  })
}

/** Whether an id names a Session this Host does not own. */
export function isRemoteSessionId(value) {
  return decodeRemoteId(value) !== undefined
}
