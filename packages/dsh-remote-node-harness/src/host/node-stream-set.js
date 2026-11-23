/**
 * The per-node stream bookkeeping four `Remote*` classes kept writing out.
 *
 * `RemoteControl`, `RemoteEvents`, `RemoteWorkspaces` and `RemoteWaterfalls` are different
 * things — a projection fan-out, an event relay, a merged workspace picture, an
 * approval/question relay. What they shared is the *shape* of their lifetime, verbatim, four
 * times: a `Map` from node id to one per-node stream object, a `sync()` that walks
 * `rnh.routable()` and closes what left, and a `dispose()` that closes everything.
 *
 * The **policy** is where they genuinely differ, and that is deliberately not in here:
 * `RemoteWorkspaces` keeps the rows of a node that is merely unreachable and marks them
 * offline (dropping them made a whole machine's workspaces vanish the moment a socket died),
 * while the other three close the node's stream. So this class computes *what changed* and
 * lets each caller decide what to do about it.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/node-stream-set
 */

/**
 * @typedef {{ record: { id: string }, gateway: object, routable: boolean }} NodeRuntime
 */

export class NodeStreamSet {
  /**
   * @param {(runtime: NodeRuntime) => object} create - make one node's stream object. Called
   *   only for a node that has none, so a per-node object is created exactly once.
   */
  constructor(create) {
    this.create = create
    /** @type {Map<string, object>} */
    this.nodes = new Map()
  }

  /**
   * What a `sync()` has to react to, without touching anything.
   *
   * Returned as data rather than applied here because "a node left" means opposite things to
   * two of the four callers: a workspace row outlives its node, a projection block does not.
   *
   * @param {{ routable: () => NodeRuntime[] }} rnh
   * @returns {{ routable: NodeRuntime[], left: string[], arrived: NodeRuntime[], staying: NodeRuntime[] }}
   */
  plan(rnh) {
    const routable = rnh.routable()
    const live = new Set(routable.map(runtime => runtime.record.id))
    const left = [...this.nodes.keys()].filter(nodeId => !live.has(nodeId))
    const arrived = routable.filter(runtime => !this.nodes.has(runtime.record.id))
    const staying = routable.filter(runtime => this.nodes.has(runtime.record.id))
    return { routable, left, arrived, staying }
  }

  /** The stream object for one node, if it has one. */
  get(nodeId) {
    return this.nodes.get(nodeId)
  }

  /** Whether this set holds one node. */
  has(nodeId) {
    return this.nodes.has(nodeId)
  }

  /**
   * Create and remember one node's stream object.
   * @param {NodeRuntime} runtime
   * @returns {object}
   */
  add(runtime) {
    const node = this.create(runtime)
    this.nodes.set(runtime.record.id, node)
    return node
  }

  /**
   * Close one node's stream and forget it.
   *
   * `close()` is called on the way out, not left to the caller: a forgotten stream keeps a
   * carrier open and, for the event relay, keeps reconnecting after `dispose()`.
   * @param {string} nodeId
   * @returns {boolean} whether anything was dropped.
   */
  drop(nodeId) {
    const node = this.nodes.get(nodeId)
    if (node === undefined) return false
    node.close()
    this.nodes.delete(nodeId)
    return true
  }

  /** Close every stream and forget them all. */
  disposeAll() {
    for (const node of this.nodes.values()) node.close()
    this.nodes.clear()
  }
}
