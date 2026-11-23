/**
 * A merged view of every connected node's workspace registry.
 *
 * The local sidebar renders one `workspace/follow` stream. To make remote
 * workspaces appear in it, the router needs a single authoritative picture of
 * every node's workspaces that is always current — not a snapshot taken at the
 * moment a client subscribes. This module owns that picture:
 *
 *   - it subscribes to each connected node's `workspace/follow` stream once,
 *   - keeps the latest baseline per node,
 *   - merges local and remote frames into one stream per local subscriber,
 *   - re-subscribes when a node connects, and drops a node's rows when it leaves.
 *
 * Workspace and Session identities are wrapped (`rnh_<node>_<id>`) so they can
 * never collide with a local one.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/remote-workspaces
 */
import { NodeStreamSet } from './node-stream-set.js'
import { isRemoteId, remapIds } from './routing.js'

/** One node's current workspace picture. */
class NodeWorkspaces {
  /**
   * @param {string} nodeId
   * @param {import('./remote-gateway.js').RemoteGateway} gateway
   */
  constructor(nodeId, gateway) {
    this.nodeId = nodeId
    this.gateway = gateway
    /** @type {null | { items: unknown[], archivedSessionIds: string[], pinnedSessionIds: string[] }} */
    this.baseline = null
    /** @type {{ close: () => void } | undefined} */
    this.stream = undefined
    this.closed = false
    /**
     * Whether the node this picture came from is currently unreachable.
     *
     * The rows stay (see `sync()`), and this flag is what lets a caller tell "this node has no
     * workspaces" from "this node is not answering right now".
     */
    this.offline = false
    this.readyWaiters = []
  }

  /**
   * Mark the picture as stale without dropping it.
   *
   * The stream is closed because a dead node's stream is dead too, and reopening it is what a
   * reconnect does. The baseline is kept on purpose — it is the last known truth about that
   * machine, and a sidebar row that can still be read is better than a row that vanished.
   */
  markOffline() {
    this.offline = true
    try { this.stream?.close() } catch { /* already closing */ }
    this.stream = undefined
  }

  /** Open the node's workspace stream, resolving once its baseline arrived. */
  async open() {
    if (this.stream !== undefined) return
    this.stream = await this.gateway.openStream('workspace/follow', {}, {
      onFrame: value => this.#onFrame(value),
      onEnd: () => {
        // The carrier ended. Keep the last baseline: a workspace row that is
        // still real should not blink out of the sidebar while the node
        // reconnects, and `sync()` reopens the stream on the next read.
        this.stream = undefined
      },
    })
    // A reopened stream means the node answers again.
    this.offline = false
  }

  /** Resolve once the baseline is available, or reject after `timeoutMs`. */
  ready(timeoutMs = 10_000) {
    if (this.baseline !== null) return Promise.resolve(this.baseline)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`node ${this.nodeId} workspace baseline timed out`)), timeoutMs)
      timer.unref?.()
      this.readyWaiters.push(value => { clearTimeout(timer); resolve(value) })
    })
  }

  close() {
    this.closed = true
    try { this.stream?.close() } catch { /* already closing */ }
    this.stream = undefined
    this.baseline = null
  }

  #onFrame(value) {
    const frame = value
    if (frame === null || typeof frame !== 'object') return
    const type = Reflect.get(frame, 'type')
    if (type === 'baseline') {
      this.baseline = this.#adoptBaseline(Reflect.get(frame, 'value'))
      for (const waiter of this.readyWaiters.splice(0)) waiter(this.baseline)
      return
    }
    if (this.baseline === null) return
    if (type === 'replace') {
      this.baseline = this.#adoptBaseline(Reflect.get(frame, 'value'))
      this.onReplaced?.(this)
      return
    }
    if (type === 'upsert') {
      const workspace = this.#wrapWorkspace(Reflect.get(frame, 'workspace'))
      if (workspace === undefined) return
      const index = this.baseline.items.findIndex(item => Reflect.get(item, 'workspaceId') === workspace.workspaceId)
      if (index === -1) this.baseline.items.push(workspace)
      else this.baseline.items[index] = workspace
      this.onIncrement?.(this, { type: 'upsert', workspace })
      return
    }
    if (type === 'remove') {
      const raw = Reflect.get(frame, 'workspaceId')
      if (typeof raw !== 'string') return
      const encoded = this.encode(raw)
      this.baseline.items = this.baseline.items.filter(item => Reflect.get(item, 'workspaceId') !== encoded)
      this.onIncrement?.(this, { type: 'remove', workspaceId: encoded })
      return
    }
    if (type === 'archived') {
      const list = Reflect.get(frame, 'archivedSessionIds')
      if (!Array.isArray(list)) return
      this.baseline.archivedSessionIds = list.filter(value => typeof value === 'string').map(id => this.encode(id))
      this.onIncrement?.(this, { type: 'archived', archivedSessionIds: this.baseline.archivedSessionIds })
      return
    }
    if (type === 'pinned') {
      const list = Reflect.get(frame, 'pinnedSessionIds')
      if (!Array.isArray(list)) return
      this.baseline.pinnedSessionIds = list.filter(value => typeof value === 'string').map(id => this.encode(id))
      this.onIncrement?.(this, { type: 'pinned', pinnedSessionIds: this.baseline.pinnedSessionIds })
    }
    // `order` is registry-global: a merged order across independent registries is
    // not meaningful, so the client keeps its own recency or manual order.
  }

  /** Wrap one remote id for local use. */
  encode(remoteId) {
    return remoteId.startsWith('rnh_') ? remoteId : `rnh_${this.nodeId}_${remoteId}`
  }

  #wrapWorkspace(workspace) {
    if (workspace === null || typeof workspace !== 'object') return undefined
    const workspaceId = Reflect.get(workspace, 'workspaceId')
    if (typeof workspaceId !== 'string') return undefined
    const sessionIds = Reflect.get(workspace, 'sessionIds')
    return {
      ...workspace,
      workspaceId: this.encode(workspaceId),
      sessionIds: Array.isArray(sessionIds)
        ? sessionIds.filter(value => typeof value === 'string').map(id => this.encode(id))
        : [],
    }
  }

  #adoptBaseline(value) {
    const items = Reflect.get(value ?? {}, 'items')
    const archived = Reflect.get(value ?? {}, 'archivedSessionIds')
    const pinned = Reflect.get(value ?? {}, 'pinnedSessionIds')
    return {
      items: Array.isArray(items)
        ? items.map(item => this.#wrapWorkspace(item)).filter(item => item !== undefined)
        : [],
      archivedSessionIds: Array.isArray(archived)
        ? archived.filter(value => typeof value === 'string').map(id => this.encode(id))
        : [],
      pinnedSessionIds: Array.isArray(pinned)
        ? pinned.filter(value => typeof value === 'string').map(id => this.encode(id))
        : [],
    }
  }
}

/**
 * The merged Workspace picture across this Host and every connected node.
 *
 * Subscribers receive the same frame vocabulary the local controller emits, so
 * neither the Gateway nor the sidebar can tell a merged stream from a local one.
 */
export class RemoteWorkspaces {
  /**
   * @param {import('./rnh.js').Rnh} rnh
   */
  constructor(rnh) {
    this.rnh = rnh
    this.streams = new NodeStreamSet(runtime => {
      const node = new NodeWorkspaces(runtime.record.id, runtime.gateway)
      node.onIncrement = (owner, frame) => this.#onNodeIncrement(owner, frame)
      node.onReplaced = () => this.#publish({ type: 'replace', value: this.baseline() })
      return node
    })
    /** @type {Set<(frame: unknown) => void>} */
    this.subscribers = new Set()
    this.disposed = false
  }

  /**
   * Bring the node set in line with the plugin.
   *
   * Called before any merged read so a node that connected since the last call
   * has its baseline available; a node that left has its rows dropped.
   *
   * A change here is **published**, and that is not a nicety: a subscriber that
   * attached before the node connected (`workspace/follow` opens its stream once)
   * otherwise keeps the picture it was handed, and its remote rows only appear
   * after a page reload. Measured: a node connected four seconds after the page
   * painted showed no workspaces in the sidebar, and reloading the same page
   * showed all of them. `mergeWorkspaceStream` turns this frame into a full
   * merged picture, so this publishes the remote half only.
   */
  async sync() {
    if (this.disposed) return
    const before = this.#signature()
    const plan = this.streams.plan(this.rnh)
    for (const nodeId of plan.left) {
      // A node that is **gone** (its record was removed) loses its rows; a node that is merely
      // unreachable keeps them, marked offline.
      //
      // Measured before this: dropping the rows on every drop made the sidebar lose a whole
      // machine's workspaces the moment the socket died, and get them back a minute later when
      // the reconnect ladder succeeded. A person reads that as "my work disappeared", and the
      // only way to tell it apart from a real deletion was to watch it happen. Keeping the rows
      // and saying they are offline is the honest version — and it is what the sidebar's own
      // greyed rows do for a closed window.
      //
      // This is the one caller where "left" does not mean "drop": the decision stays here,
      // which is why `plan()` reports what changed instead of applying anything.
      if (this.rnh.get(nodeId) === undefined) {
        this.streams.drop(nodeId)
        continue
      }
      const node = this.streams.get(nodeId)
      if (node === undefined || node.offline) continue
      node.markOffline()
      this.#publish({ type: 'replace', value: this.baseline() })
    }
    const opened = []
    for (const runtime of [...plan.arrived, ...plan.staying]) {
      let node = this.streams.get(runtime.record.id)
      if (node === undefined) node = this.streams.add(runtime)
      opened.push(node.open().then(() => node.ready()).catch(() => undefined))
    }
    await Promise.all(opened)
    // Once, after the awaits: a `replace` published mid-loop would race the
    // baseline it is meant to describe.
    if (this.#signature() !== before) this.#publish({ type: 'replace', value: this.baseline() })
  }

  /**
   * What the merged picture is made of right now.
   *
   * Node identity plus each node's row count is enough to tell "nothing changed"
   * from "a node arrived, left, or filled in its baseline", which is the only
   * distinction `sync()` needs. Comparing rows themselves would republish on
   * every ordered field change, and `sync()` runs on every merged read.
   *
   * @returns {string}
   */
  #signature() {
    const parts = []
    for (const [nodeId, node] of this.streams.nodes) {
      parts.push(
        `${nodeId}:${node.baseline === null ? '-' : String(node.baseline.items.length)}`
        + `${node.offline ? '!' : ''}`,
      )
    }
    return parts.join('|')
  }

  /**
   * The nodes whose rows are currently in the merged picture, and whether each is stale.
   *
   * A caller needs this to distinguish "the node has no workspaces" from "the node is not
   * answering"; the merged baseline alone cannot say which.
   * @returns {Array<{ nodeId: string, offline: boolean, rows: number }>}
   */
  nodeStates() {
    return [...this.streams.nodes].map(([nodeId, node]) => ({
      nodeId,
      offline: node.offline,
      rows: node.baseline?.items.length ?? 0,
    }))
  }

  /** Every local workspace id this module currently knows about. */
  remoteWorkspaceIds() {
    const ids = new Set()
    for (const node of this.streams.nodes.values()) {
      for (const item of node.baseline?.items ?? []) {
        const id = Reflect.get(item, 'workspaceId')
        if (typeof id === 'string') ids.add(id)
      }
    }
    return ids
  }

  /** The complete merged baseline. */
  baseline() {
    const items = []
    const archived = []
    const pinned = []
    for (const node of this.streams.nodes.values()) {
      if (node.baseline === null) continue
      items.push(...node.baseline.items)
      archived.push(...node.baseline.archivedSessionIds)
      pinned.push(...node.baseline.pinnedSessionIds)
    }
    return { items, archivedSessionIds: archived, pinnedSessionIds: pinned }
  }

  /** Merge one local baseline with every node's. */
  mergeBaseline(local) {
    const merged = this.baseline()
    const items = Reflect.get(local ?? {}, 'items')
    const archived = Reflect.get(local ?? {}, 'archivedSessionIds')
    const pinned = Reflect.get(local ?? {}, 'pinnedSessionIds')
    return {
      items: [...(Array.isArray(items) ? items : []), ...merged.items],
      archivedSessionIds: [
        ...(Array.isArray(archived) ? archived : []),
        ...merged.archivedSessionIds,
      ],
      pinnedSessionIds: [
        ...(Array.isArray(pinned) ? pinned : []),
        ...merged.pinnedSessionIds,
      ],
    }
  }

  /** Subscribe to merged increments; returns the unsubscribe. */
  subscribe(listener) {
    this.subscribers.add(listener)
    return () => { this.subscribers.delete(listener) }
  }

  /** Drop every node subscription. */
  dispose() {
    this.disposed = true
    this.streams.disposeAll()
    this.subscribers.clear()
  }

  #onNodeIncrement(node, frame) {
    if (this.disposed) return
    const type = Reflect.get(frame, 'type')
    if (type === 'upsert') {
      this.#publish({ type: 'upsert', workspace: Reflect.get(frame, 'workspace') })
      return
    }
    if (type === 'remove') {
      this.#publish({ type: 'remove', workspaceId: Reflect.get(frame, 'workspaceId') })
      return
    }
    if (type === 'archived' || type === 'pinned') {
      // Global sets: re-merge and republish both.
      const merged = this.baseline()
      this.#publish({ type: 'archived', archivedSessionIds: merged.archivedSessionIds })
      this.#publish({ type: 'pinned', pinnedSessionIds: merged.pinnedSessionIds })
    }
  }

  #publish(frame) {
    for (const listener of [...this.subscribers]) {
      try { listener(frame) } catch { /* a subscriber must not break the feed */ }
    }
  }
}

/** Whether an id names a workspace this Host does not own. */
export function isRemoteWorkspaceId(value) {
  return isRemoteId(value)
}

export { remapIds }
