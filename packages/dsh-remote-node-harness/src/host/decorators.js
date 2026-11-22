/**
 * The routing decorators plus the merged control stream: `session`, `workspace`,
 * `workspaceFiles`, `job`, `terminal`, `agentTeams`.
 *
 * Each factory takes the live upstream Service and the router, and returns an
 * undo function. Nothing here replaces a Loader row, imports from inside
 * app.asar, or changes a class: every replacement is an own property on the
 * instance, which the Gateway resolves at dispatch and never at discovery.
 *
 * A local call (an identity with no `rnh_` prefix) is forwarded verbatim to the
 * upstream method. A remote call is translated into the node's own identities,
 * dispatched, and translated back.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/decorators
 */
import { homedir, hostname } from 'node:os'
import { mergeControlStream } from './remote-control.js'
import {
  ensureRemoteDirectory,
  listLocal,
  listRemote,
  makeLocalDirectory,
  makeRemoteDirectory,
} from './browse.js'
import {
  PICKER_PREFIX,
  decodePickerPath,
  encodePickerPath,
  pruneShadow,
  shadowRoot,
} from './picker-paths.js'
import { AsyncQueue, decodeRemoteId, decorateMethods, remoteIterable } from './routing.js'

/** Read a nested request field without trusting its shape. */
function requestOf(value) {
  if (value === null || typeof value !== 'object') return undefined
  const request = Reflect.get(value, 'request')
  return request !== null && typeof request === 'object' ? request : undefined
}

/** Session identity carried by a request object. */
function sessionIdIn(request) {
  if (request === undefined) return undefined
  const direct = Reflect.get(request, 'sessionId')
  if (typeof direct === 'string') return direct
  const address = Reflect.get(request, 'address')
  if (address !== null && typeof address === 'object') {
    const kind = Reflect.get(address, 'kind')
    const id = kind === 'session'
      ? Reflect.get(address, 'sessionId')
      : Reflect.get(address, 'childSessionId')
    if (typeof id === 'string') return id
  }
  return undefined
}

/**
 * Install the `session` namespace router.
 *
 * Routed: `list`, `search`, `create`, `rename`, `fork`, `prompt`, `cancel`,
 * `updateQueue`, `attachment`, `page`, `events`, `state`, `wait`, `projections`,
 * `selectModel`, `modelCatalog`, the four per-Session streams, and `control`
 * (merged rather than forwarded — it is Host-wide, not per-Session). Everything
 * else (`openWorkspacePath`, `skills`, …) stays local.
 *
 * @param {object} service - the live upstream `SessionController`.
 * @param {import('./router.js').Router} router
 * @param {import('./remote-workspaces.js').RemoteWorkspaces} workspaces
 * @param {import('./remote-control.js').RemoteControl} control
 * @returns {() => void}
 */
export function decorateSessionController(service, router, workspaces, control) {
  /** The node a workspace belongs to, if the workspace is remote. */
  const nodeOfWorkspace = workspaceId => decodeRemoteId(workspaceId)

  /**
   * Route one Session stream endpoint.
   *
   * Two shapes differ from the unary endpoints and both matter:
   *   - the Gateway passes the request *positionally* (`(request, signal)`), not as
   *     `{ request }`, because a stream method's first parameter is the request;
   *   - the node's own parameter is named `request`, so the forwarded wire payload
   *     has to wrap it again as `{ args: { request } }`.
   */
  const streaming = (endpoint, local) => (request, signal) => {
    const decoded = decodeRemoteId(sessionIdIn(request))
    if (decoded === undefined) return local(request, signal)
    const payload = router.toRemote({ request: request ?? {} }, decoded.nodeId)
    return remoteIterable(
      router.node(decoded.nodeId).gateway,
      `session/${endpoint}`,
      payload,
      signal,
      value => router.toLocal(value, decoded.nodeId),
    )
  }

  return decorateMethods(service, {
    // --- list: merge local rows with every connected node's -----------------
    list: local => async function list(_request, signal) {
      const own = await local(_request, signal)
      const items = Array.isArray(Reflect.get(own ?? {}, 'items')) ? [...Reflect.get(own, 'items')] : []
      await workspaces.sync()
      for (const runtime of router.nodes()) {
        const nodeId = runtime.record.id
        try {
          const remote = await router.call(nodeId, 'session/list', { _request: {} }, signal)
          const remoteItems = Reflect.get(remote ?? {}, 'items')
          if (!Array.isArray(remoteItems)) continue
          for (const item of remoteItems) {
            const wrapped = router.toLocal(item, nodeId)
            const id = Reflect.get(wrapped ?? {}, 'sessionId')
            if (typeof id === 'string') items.push(wrapped)
          }
        } catch {
          // An offline or refusing node contributes no rows rather than failing
          // the whole sidebar.
        }
      }
      items.sort((left, right) => Number(Reflect.get(right, 'updatedAt') ?? 0) - Number(Reflect.get(left, 'updatedAt') ?? 0))
      return { items }
    },

    // --- create: a remote workspace creates on its node ---------------------
    create: local => async function create(request, signal) {
      const workspaceId = request === null || typeof request !== 'object'
        ? undefined
        : Reflect.get(request, 'workspaceId')
      const target = nodeOfWorkspace(workspaceId)
      if (target === undefined) return await local(request, signal)
      const payload = router.toRemote({ request: request ?? {} }, target.nodeId)
      const value = await router.call(target.nodeId, 'session/create', payload, signal)
      return router.toLocal(value, target.nodeId)
    },

    // --- the ordinary per-Session unary endpoints ---------------------------
    search: local => async function search(request, signal) {
      const own = await local(request, signal)
      const items = Array.isArray(Reflect.get(own ?? {}, 'items')) ? [...Reflect.get(own, 'items')] : []
      const query = request === null || typeof request !== 'object' ? undefined : Reflect.get(request, 'query')
      if (typeof query === 'string' && query.trim().length > 0) {
        for (const runtime of router.nodes()) {
          const nodeId = runtime.record.id
          try {
            const remote = await router.call(nodeId, 'session/search', { request: { query } }, signal)
            const remoteItems = Reflect.get(remote ?? {}, 'items')
            if (Array.isArray(remoteItems)) items.push(...remoteItems.map(item => router.toLocal(item, nodeId)))
          } catch { /* a node that cannot search contributes nothing */ }
        }
      }
      return { ...own, items, hasMore: Reflect.get(own ?? {}, 'hasMore') === true }
    },

    rename: local => router.sessionEndpoint('rename', local),
    fork: local => router.sessionEndpoint('fork', local),
    prompt: local => router.sessionEndpoint('prompt', local),
    cancel: local => router.sessionEndpoint('cancel', local),
    updateQueue: local => router.sessionEndpoint('updateQueue', local),
    attachment: local => router.sessionEndpoint('attachment', local),
    page: local => router.sessionEndpoint('page', local),
    events: local => router.sessionEndpoint('events', local),
    state: local => router.sessionEndpoint('state', local),
    wait: local => router.sessionEndpoint('wait', local),
    projections: local => router.sessionEndpoint('projections', local),
    selectModel: local => router.sessionEndpoint('selectModel', local),

    // `modelCatalog` and `initializeDefaultModel` take no arguments and describe
    // this Host's own provider roster, so they stay local by design.

    // --- the four per-Session streams --------------------------------------
    // A stream endpoint's first positional argument IS the request object; it is
    // not wrapped in `{ request }` the way a unary wire payload is. Forwarding
    // therefore re-wraps it, because the node's own parameter is called `request`.
    follow: local => streaming('follow', local),
    observeEvent: local => streaming('observeEvent', local),
    observeProjections: local => streaming('observeProjections', local),
    observeState: local => streaming('observeState', local),

    // --- the Host-wide control stream ---------------------------------------
    // Every attached client keeps a Session list from this stream, so a remote
    // Session's title, model selection and pending-input flags only move if its
    // frames reach the client. There is nothing to route here: the frame carries
    // the Session id, and the merged stream is per consumer, so `control` becomes
    // one merged stream instead of one forwarded call.
    //
    // The inner function must not be called `control`: it would shadow the
    // `RemoteControl` argument in its own body.
    control: local => function controlStream(signal) {
      return mergeControlStream(local(signal), control, signal)
    },
  })
}

/**
 * Install the `workspace` namespace router.
 *
 * `follow` becomes one merged stream: the local baseline plus every node's
 * workspaces, then live increments from both. Every mutation is routed to the
 * node that owns the workspace, and a mutation naming a remote Session (pin,
 * archive, ordering) goes to that Session's node.
 *
 * @param {object} service - the live upstream `WorkspaceController`.
 * @param {import('./router.js').Router} router
 * @param {import('./remote-workspaces.js').RemoteWorkspaces} workspaces
 * @returns {() => void}
 */
export function decorateWorkspaceController(service, router, workspaces) {
  /** The node that owns a workspace or session identity. */
  const ownerOf = request => {
    if (request === null || typeof request !== 'object') return undefined
    return decodeRemoteId(Reflect.get(request, 'workspaceId'))
      ?? decodeRemoteId(Reflect.get(request, 'sessionId'))
      ?? decodeRemoteId(Reflect.get(request, 'beforeSessionId'))
  }

  /**
   * Route a mutation whose owner is a node.
   *
   * Not `async`: every one of these upstream methods is synchronous, and the local
   * branch is a pass-through, so it has to return exactly what upstream returned and
   * throw exactly where upstream threw. See the `*Endpoint` comment in `router.js`.
   */
  const mutation = (endpoint, local) => function routed(request, signal) {
    const owner = ownerOf(request)
    if (owner === undefined) return local(request, signal)
    const payload = router.toRemote({ request: request ?? {} }, owner.nodeId)
    return router.call(owner.nodeId, `workspace/${endpoint}`, payload, signal).then(
      value => router.toLocalWorkspace(value, owner.nodeId),
    )
  }

  return decorateMethods(service, {
    follow: local => function follow(signal) {
      const own = local(signal)
      return mergeWorkspaceStream(own, workspaces, signal)
    },

    // Not `async`: `workspace/create` is synchronous upstream, so the local branch has to
    // stay synchronous. Only the branches that talk to a node return a promise. See the
    // `*Endpoint` comment in `router.js` for what shape loss cost.
    create: local => function create(request, signal) {
      const path = request === null || typeof request !== 'object' ? undefined : Reflect.get(request, 'path')
      const target = decodePickerPath(path)
      // `/@rnh/<id>/…` names one node unambiguously, so it never falls through to the
      // others: a path on the wrong machine must fail as "that node is offline", not
      // silently become a different machine's workspace.
      if (target !== undefined && target.kind === 'node') {
        return (async () => {
          try {
            const runtime = router.node(target.nodeId)
            // The node's `workspace/create` realpaths its folder and fails before making
            // anything, so a folder that is not there yet is created here first. This is
            // also the only way a Remote caller can open a new project: its own "new
            // folder" affordance is not in the phone client's endpoint allowlist.
            await ensureRemoteDirectory(runtime.connection, target.remotePath)
            const value = await router.call(target.nodeId, 'workspace/create', {
              request: { path: target.remotePath },
            }, signal)
            return router.toLocalWorkspace(value, target.nodeId)
          } finally {
            // The relay creates this directory on *this* machine before it dispatches
            // (see picker-paths.js): remove the empty chain it just made, and nothing
            // else. Failure is logged, never turned into a failed workspace.
            const pruned = pruneShadow(path, message => console.warn(message))
            if (pruned.removed.length > 0) {
              console.log(`rnh: removed ${String(pruned.removed.length)} shadow director${pruned.removed.length === 1 ? 'y' : 'ies'} under ${shadowRoot()}`)
            }
          }
        })()
      }
      // `/@rnh` on its own is the node list, not a directory anywhere — a workspace
      // cannot be created from it, and it must never fall through to a local `mkdir`.
      if (target !== undefined && target.kind === 'nodes') {
        throw Object.assign(
          new Error(`${PICKER_PREFIX} lists nodes; pick one of them first`),
          { code: 'rnh/path-reserved' },
        )
      }
      // A bare absolute POSIX path (typed by hand) still tries each node in turn: that is
      // the only meaning it can have, since this machine's own paths are not POSIX.
      if (typeof path === 'string' && path.startsWith('/')) {
        return (async () => {
          for (const runtime of router.nodes()) {
            const nodeId = runtime.record.id
            try {
              const value = await router.call(nodeId, 'workspace/create', { request: { path } }, signal)
              if (Reflect.get(value ?? {}, 'workspace') !== undefined) {
                return router.toLocalWorkspace(value, nodeId)
              }
            } catch { /* this node cannot see that path; try the next */ }
          }
          return local(request, signal)
        })()
      }
      return local(request, signal)
    },

    rename: local => mutation('rename', local),
    delete: local => mutation('delete', local),
    insertBefore: local => mutation('insertBefore', local),
    insertSessionBefore: local => mutation('insertSessionBefore', local),
    archiveSession: local => mutation('archiveSession', local),
    unarchiveSession: local => mutation('unarchiveSession', local),
    pinSession: local => mutation('pinSession', local),
    unpinSession: local => mutation('unpinSession', local),
  })
}

/**
 * Combine one local `workspace/follow` generation with the merged remote picture.
 *
 * Both sources are pumped into one queue, so a remote increment is delivered the
 * moment it arrives instead of waiting behind the local stream's idle read. The
 * local generation's opening baseline is the one that gets expanded with remote
 * rows; if the local stream ends first (the Host is shutting down) the merged
 * stream ends with it.
 *
 * The trap is `replace`, and it is the same one `mergeControlStream` documents:
 * a client reads **any** baseline-shaped frame as "this is now the whole
 * picture". `RemoteWorkspaces` publishes `replace` when its node set changes, so
 * forwarding that frame unchanged would hand the client a picture holding only
 * the remote rows — every local workspace would vanish from the sidebar the
 * moment a node connected. Measured: connecting a node to an open page left the
 * sidebar with no local rows at all until a reload.
 *
 * So exactly one baseline-shaped frame leaves this function per change: the
 * local picture last seen, re-expanded with the current remote rows. The remote
 * half's own picture is folded in through `mergeBaseline`, never forwarded.
 *
 * @param {AsyncIterable<unknown>} local
 * @param {import('./remote-workspaces.js').RemoteWorkspaces} workspaces
 * @param {AbortSignal | undefined} signal
 * @returns {AsyncIterable<unknown>}
 */
function mergeWorkspaceStream(local, workspaces, signal) {
  return {
    [Symbol.asyncIterator]() {
      const queue = new AsyncQueue()
      let opened = false
      let stopped = false
      /** The local half's last picture, kept so a remote change can re-merge. */
      let localBaseline
      const first = () => {
        opened = true
        return { type: 'baseline', value: workspaces.mergeBaseline(localBaseline) }
      }
      /**
       * A remote change, re-expanded over the local picture.
       *
       * Before the local baseline this is deliberately **not** forwarded: the
       * client's snapshot stream refuses a `replace` as its opening frame, and a
       * remote-only picture would flash empty rows for the local side. The
       * pending change is picked up by the opening baseline instead, which reads
       * the merged picture at that moment.
       */
      const remerge = () => {
        if (!opened) return
        queue.push({ type: 'replace', value: workspaces.mergeBaseline(localBaseline) })
      }
      const unsubscribe = workspaces.subscribe(frame => {
        if (stopped) return
        if (Reflect.get(frame ?? {}, 'type') === 'replace') {
          remerge()
          return
        }
        if (!opened) return
        queue.push(frame)
      })
      const onAbort = () => { stopped = true }
      signal?.addEventListener('abort', onAbort, { once: true })

      /** Fold one local frame into `localBaseline` so a later re-merge keeps it. */
      const adoptLocal = frame => {
        const type = Reflect.get(frame ?? {}, 'type')
        if (type === 'baseline' || type === 'replace') {
          const value = Reflect.get(frame, 'value')
          localBaseline = value !== null && typeof value === 'object' ? value : undefined
          return
        }
        if (localBaseline === undefined) return
        if (type === 'upsert') {
          const workspace = Reflect.get(frame, 'workspace')
          const id = Reflect.get(workspace ?? {}, 'workspaceId')
          if (typeof id !== 'string') return
          const items = Array.isArray(localBaseline.items) ? [...localBaseline.items] : []
          const index = items.findIndex(item => Reflect.get(item ?? {}, 'workspaceId') === id)
          if (index === -1) items.push(workspace)
          else items[index] = workspace
          localBaseline = { ...localBaseline, items }
          return
        }
        if (type === 'remove') {
          const id = Reflect.get(frame, 'workspaceId')
          const items = Array.isArray(localBaseline.items) ? localBaseline.items : []
          localBaseline = {
            ...localBaseline,
            items: items.filter(item => Reflect.get(item ?? {}, 'workspaceId') !== id),
          }
          return
        }
        if (type === 'archived') {
          localBaseline = { ...localBaseline, archivedSessionIds: Reflect.get(frame, 'archivedSessionIds') }
          return
        }
        if (type === 'pinned') {
          localBaseline = { ...localBaseline, pinnedSessionIds: Reflect.get(frame, 'pinnedSessionIds') }
        }
      }

      const pump = async () => {
        try {
          await workspaces.sync()
          for await (const frame of local) {
            if (stopped) return
            const type = Reflect.get(frame ?? {}, 'type')
            adoptLocal(frame)
            if (type === 'baseline' || type === 'replace') {
              opened = true
              queue.push({ type: 'baseline', value: workspaces.mergeBaseline(localBaseline) })
              continue
            }
            if (!opened) {
              // A remote change may have arrived before this baseline; it was
              // folded into `workspaces`, so the opening frame already has it.
              queue.push(first())
            }
            queue.push(frame)
          }
        } catch (error) {
          queue.fail(error)
          return
        } finally {
          unsubscribe()
          signal?.removeEventListener('abort', onAbort)
        }
        // The local feed ended: this Host is going away, so the merged stream
        // ends too rather than idling on a registry that no longer changes.
        if (!opened) queue.push(first())
        queue.end()
      }
      void pump()

      return {
        next: () => queue.next(),
        return: async () => {
          stopped = true
          unsubscribe()
          signal?.removeEventListener('abort', onAbort)
          queue.end()
          return { done: true, value: undefined }
        },
      }
    },
  }
}

/**
 * Install the `workspaceFiles` namespace router.
 *
 * Every endpoint takes a `workspaceFileScope` lookup object that the Host derives
 * from the Session id, so the Session identity is the only thing that has to be
 * translated: a remote Session's files live on that node and only that node can
 * read them.
 *
 * One wire detail matters here: several of these endpoints declare a parameter the
 * *caller* may omit (e.g. `read`'s `range`, `readBytes`'s `options`), and the strict
 * descriptor rejects a missing field. The routed payload therefore carries the
 * field only when the caller supplied it, so a three-argument `read` stays a
 * three-argument `read`.
 *
 * @param {object} service - the live upstream `WorkspaceFiles`.
 * @param {import('./router.js').Router} router
 * @returns {() => void}
 */
export function decorateWorkspaceFiles(service, router) {
  /**
   * Rewrite the lookup result the same way the Gateway would, then call the node.
   * The Gateway substitutes `workspaceFileScope` from `workspaceFileScopeId`, so a
   * decorated method receives the resolved object — this router must therefore
   * accept the same positional shape.
   */
  const fileMethod = (endpoint, indexed) => local => async function routed(...args) {
    const signal = args.at(-1)
    const scope = args[0]
    const sessionId = scope === null || typeof scope !== 'object'
      ? undefined
      : Reflect.get(scope, 'sessionId')
    const decoded = decodeRemoteId(sessionId)
    if (decoded === undefined) return await local(...args)
    const rest = args.slice(1, -1).map(value => router.toRemote(value, decoded.nodeId))
    /** Wire fields, with positionally-absent arguments left out entirely. */
    const fields = {}
    if (indexed) {
      rest.forEach((value, index) => {
        const name = indexed[index]
        if (name === undefined || value === undefined) return
        fields[name] = value
      })
    }
    const payload = { workspaceFileScopeId: decoded.remoteId, ...fields }
    const value = await router.call(decoded.nodeId, `workspaceFiles/${endpoint}`, payload, signal)
    return router.toLocal(value, decoded.nodeId)
  }

  return decorateMethods(service, {
    read: fileMethod('read', ['path', 'range']),
    readBytes: fileMethod('readBytes', ['path', 'options']),
    stat: fileMethod('stat', ['path']),
    list: fileMethod('list', ['path']),
    search: fileMethod('search', ['request']),
    changes: local => function changes(scope, path, signal) {
      const sessionId = scope === null || typeof scope !== 'object' ? undefined : Reflect.get(scope, 'sessionId')
      const decoded = decodeRemoteId(sessionId)
      if (decoded === undefined) return local(scope, path, signal)
      const payload = router.toRemote({ workspaceFileScopeId: decoded.remoteId, path }, decoded.nodeId)
      return remoteIterable(
        router.node(decoded.nodeId).gateway,
        'workspaceFiles/changes',
        payload,
        signal,
        value => router.toLocal(value, decoded.nodeId),
      )
    },
  })
}

/**
 * Install the `job` namespace router.
 *
 * A background job belongs to the Session that started it, and a remote Session's
 * jobs are processes on that node. Three endpoints, all addressed by Session id, so
 * all three route:
 *
 *   - `list` — the roster stream the session panel renders
 *   - `follow` — one job's output ring
 *   - `kill` — the human cancel
 *
 * `follow` takes an *optional* `sessionId` (an unowned job is visible to every
 * caller). Without one there is no node to pick, so that call stays local: this
 * Host cannot know which machine an id-only job belongs to, and guessing would
 * hand one node's output to another node's job id.
 *
 * A `JobView` carries the owning Session in `owner`, which `toLocal` wraps like
 * every other Session identity; the job id itself is not a Session id, so it is
 * left alone. The node's own failures do name a Session (`job/not-found` repeats
 * it in `details`), so those details get the same wrapping — a bare node identity
 * must never reach a browser that will treat it as local.
 *
 * @param {object} service - the live upstream `JobController`.
 * @param {import('./router.js').Router} router
 * @returns {() => void}
 */
export function decorateJobController(service, router) {
  return decorateMethods(service, {
    // A stream's first positional argument IS the request object, and the
    // forwarded wire payload wraps it again as `{ args: { request } }`.
    list: local => function list(request, signal) {
      const decoded = decodeRemoteId(sessionIdIn(request))
      if (decoded === undefined) return local(request, signal)
      const bare = { ...request, sessionId: decoded.remoteId }
      return remoteIterable(
        router.node(decoded.nodeId).gateway,
        'job/list',
        { request: bare },
        signal,
        value => router.toLocal(value, decoded.nodeId),
      )
    },
    follow: local => function follow(request, signal) {
      const decoded = decodeRemoteId(sessionIdIn(request))
      if (decoded === undefined) return local(request, signal)
      const bare = { ...request, sessionId: decoded.remoteId }
      return remoteIterable(
        router.node(decoded.nodeId).gateway,
        'job/follow',
        { request: bare },
        signal,
        value => router.toLocal(value, decoded.nodeId),
      )
    },
    // Not `async`: `job/kill` is synchronous upstream, so a local call has to return the
    // upstream value directly. See the `*Endpoint` comment in `router.js`.
    kill: local => function kill(request, signal) {
      const decoded = decodeRemoteId(sessionIdIn(request))
      if (decoded === undefined) return local(request, signal)
      const bare = { ...request, sessionId: decoded.remoteId }
      return router.call(decoded.nodeId, 'job/kill', { request: bare }, signal).catch(error => {
        // A node's `job/not-found` repeats the Session id in `details`. Left alone
        // that is a bare node identity reaching the browser, which would then be
        // used as if it named something local.
        if (error?.details !== undefined && typeof error.details === 'object') {
          error.details = router.toLocal(error.details, decoded.nodeId)
        }
        throw error
      })
    },
  })
}

/**
 * Install the `terminal` namespace router.
 *
 * A remote Session's terminals are PTYs on that node. Six of the nine endpoints
 * take an `Agent` object that the Gateway resolves from `agentId` on *this* Host —
 * which a remote Session has no local Agent for. `host/lookups.js` teaches that
 * lookup to hand back a placeholder for a wrapped identity, so this decorator can
 * route them like the rest.
 *
 * `attach` is the awkward one: it is `mode: 'stream'` **and** it consumes the
 * invocation's uplink, so this method owns two directions at once. Local browser
 * input is pumped to the node, node frames are pumped to the browser. The upstream
 * body is never reached, which is deliberate — it would call `uplink()` a second
 * time and throw.
 *
 * `readScreen` / `inspectActivity` / `openForAgent` are not `@Remote`, so the
 * browser cannot call them at all; nothing to route.
 *
 * @param {object} service - the live upstream `TerminalController`.
 * @param {import('./router.js').Router} router
 * @returns {() =\u003e void}
 */
export function decorateTerminalController(service, router) {
  /** The node a wrapped Session identity names, and the node's own id for it. */
  const target = sessionId => decodeRemoteId(sessionId)

  return decorateMethods(service, {
    list: local => function list(sessionId, signal) {
      const decoded = target(sessionId)
      if (decoded === undefined) return local(sessionId, signal)
      return router.call(decoded.nodeId, 'terminal/list', { sessionId: decoded.remoteId }, signal)
    },

    watch: local => function watch(sessionId, signal) {
      const decoded = target(sessionId)
      if (decoded === undefined) return local(sessionId, signal)
      return remoteIterable(
        router.node(decoded.nodeId).gateway,
        'terminal/watch',
        { sessionId: decoded.remoteId },
        signal,
      )
    },

    // `retain` is what the browser opens before it attaches; routing one without the
    // other leaves the window hold waiting forever.
    retain: local => function retain(sessionId, id, signal) {
      const decoded = target(sessionId)
      if (decoded === undefined) return local(sessionId, id, signal)
      return remoteIterable(
        router.node(decoded.nodeId).gateway,
        'terminal/retain',
        { sessionId: decoded.remoteId, id },
        signal,
      )
    },

    environment: local => function environment(agent, signal) {
      const decoded = target(agent?.id)
      if (decoded === undefined) return local(agent, signal)
      return router.call(decoded.nodeId, 'terminal/environment', { agentId: decoded.remoteId }, signal)
    },

    shells: local => function shells(agent, signal) {
      const decoded = target(agent?.id)
      if (decoded === undefined) return local(agent, signal)
      return router.call(decoded.nodeId, 'terminal/shells', { agentId: decoded.remoteId }, signal)
    },

    create: local => async function create(agent, request, signal) {
      const decoded = target(agent?.id)
      if (decoded === undefined) return await local(agent, request, signal)
      return await router.call(
        decoded.nodeId,
        'terminal/create',
        { agentId: decoded.remoteId, request },
        signal,
      )
    },

    rename: local => function rename(agent, id, title) {
      const decoded = target(agent?.id)
      if (decoded === undefined) return local(agent, id, title)
      return router.call(
        decoded.nodeId,
        'terminal/rename',
        { agentId: decoded.remoteId, id, title },
      ).then(value => (value === undefined ? undefined : router.toLocal(value, decoded.nodeId)))
    },

    close: local => function close(agent, id) {
      const decoded = target(agent?.id)
      if (decoded === undefined) return local(agent, id)
      return router.call(decoded.nodeId, 'terminal/close', { agentId: decoded.remoteId, id })
        .then(value => (value === undefined ? undefined : router.toLocal(value, decoded.nodeId)))
    },

    /**
     * Open a remote terminal attachment and pump both directions.
     *
     * The local uplink is taken exactly once, here, and its items are the node's
     * items verbatim: `TerminalInput` is plain JSON and its `sequence` numbers are
     * generated by the browser, so re-numbering or reordering would break the node's
     * gap check. The stream ends when the browser stops, when the node ends it, or
     * when either signal aborts.
     */
    attach: local => function attach(agent, id, signal) {
      const decoded = target(agent?.id)
      if (decoded === undefined) return local(agent, id, signal)
      const runtime = router.node(decoded.nodeId)
      // The Gateway runs this method on a view whose Context carries the call, so
      // `this.ctx.invocation` is *this* attachment. It is available once per call —
      // and because the upstream body below is never reached, it is ours alone.
      const invocation = this?.ctx?.invocation
      if (invocation === undefined) throw new Error('Terminal attachment requires a Remote invocation')
      const uplink = invocation.uplink()
      return {
        [Symbol.asyncIterator]() {
          const queue = new AsyncQueue()
          let remote
          let finished = false
          const finish = () => {
            if (finished) return
            finished = true
            try { remote?.close() } catch { /* already closing */ }
            queue.end()
          }
          void runtime.gateway.openStream(
            'terminal/attach',
            { agentId: decoded.remoteId, id },
            {
              onFrame: value => queue.push(router.toLocal(value, decoded.nodeId)),
              onEnd: failure => {
                if (failure === undefined) finish()
                else {
                  if (!finished) { finished = true; try { remote?.close() } catch { /* closing */ } }
                  queue.fail(failure)
                }
              },
            },
          ).then(
            handle => {
              remote = handle
              if (finished) { handle.close(); return }
              // Local → node. The uplink is the browser's items; half-closing it must
              // half-close the node's, not cancel the whole stream.
              void (async () => {
                try {
                  for await (const item of uplink) {
                    if (finished) return
                    if (!handle.send(item)) return
                  }
                  handle.endUplink()
                } catch {
                  // A rejected local item already failed the local stream.
                }
              })()
            },
            error => queue.fail(error),
          )
          const onAbort = () => finish()
          signal?.addEventListener('abort', onAbort, { once: true })
          return {
            next: () => queue.next(),
            return: async () => {
              signal?.removeEventListener('abort', onAbort)
              finish()
              return { done: true, value: undefined }
            },
          }
        },
      }
    },
  })
}

/**
 * Install the `agentTeams` namespace router.
 *
 * The composer's 智能体协作 switch is one `@Remote` method, `setEnabled(agent, enabled)`.
 * Its first parameter is an `Agent` the Gateway resolves from the wire's `agentId`
 * **before** the body runs, which `host/lookups.js` already answers for a wrapped id
 * with a placeholder. Upstream then asks `ctx.subagents.rootOf(agent)` for the tree
 * root, and that check requires the exact live caller — a placeholder is not one, so
 * the call died with `subagent tree access requires the exact live caller` and the
 * switch never reached the node. Routing it here is the whole fix: the agent's `id`
 * decodes to the node's own Session, the node answers for its own Agent, and the
 * reply is boolean-shaped either way.
 *
 * The read side needs nothing: `isEnabled` is not `@Remote`, so the browser reads Team
 * mode from the Session's own `agentTeam` projection, which already arrives through
 * the merged projection stream.
 *
 * @param {object} service - the live upstream `TeamService`.
 * @param {import('./router.js').Router} router
 * @returns {() => void}
 */
export function decorateTeamService(service, router) {
  return decorateMethods(service, {
    setEnabled: local => async function setEnabled(agent, enabled, signal) {
      const decoded = decodeRemoteId(agent?.id)
      if (decoded === undefined) return await local(agent, enabled, signal)
      await router.call(decoded.nodeId, 'agentTeams/setEnabled', { agentId: decoded.remoteId, enabled }, signal)
    },
  })
}

/**
 * Install the `sessionQuery` router.
 *
 * One route reads a Session's events without the browser asking for them: the card that
 * offers "open in file manager" resolves the declared file's **Host path** first, and it
 * does that through `sessionQuery.readEvent` on this Host. For a remote Session that read
 * raised `SESSION_QUERY_SESSION_NOT_FOUND`, the route answered 404, and the card said
 * 「无法在文件管理器中显示，请重试」 — a message that invites a retry which can never
 * work, because a file on the node has no local file manager to open in.
 *
 * Emulating the read here turns that into the honest answer: the event is found, the file
 * is resolved on the node, and the route then refuses for the real reason (no local path),
 * which the card renders as 「此文件没有可用的主机路径，请在侧边栏预览」. That is also
 * what the reference client decides for a remote workspace: it only offers a file-manager
 * reveal when the target is a local machine.
 *
 * The read is emulated from `session/page` pinned at the event's own seq, because
 * `readEvent` itself is Host-internal and has no wire endpoint on the node.
 *
 * @param {object} service - the live upstream `SessionQueryEngine`.
 * @param {import('./router.js').Router} router
 * @returns {() => void}
 */
export function decorateSessionQuery(service, router) {
  return decorateMethods(service, {
    readEvent: local => async function readEvent(request, signal) {
      const sessionId = request === null || typeof request !== 'object' ? undefined : Reflect.get(request, 'sessionId')
      const decoded = decodeRemoteId(typeof sessionId === 'string' ? sessionId : undefined)
      if (decoded === undefined) return await local(request, signal)
      const seq = Reflect.get(request, 'seq')
      const before = Reflect.get(request, 'before') ?? 0
      const after = Reflect.get(request, 'after') ?? 0
      if (!Number.isInteger(seq) || seq < 0) return await local(request, signal)
      const page = await router.call(decoded.nodeId, 'session/page', {
        request: {
          address: { kind: 'session', sessionId: decoded.remoteId },
          throughSeq: seq,
          maxMessages: 1,
        },
      }, signal)
      const records = Array.isArray(Reflect.get(page ?? {}, 'records')) ? Reflect.get(page, 'records') : []
      const events = records
        .map(record => Reflect.get(record ?? {}, 'event'))
        .filter(event => event !== null && typeof event === 'object')
      const target = events.find(event => Reflect.get(event, 'seq') === seq)
      if (target === undefined) {
        throw Object.assign(
          new Error(`session "${sessionId}" has no event at seq ${String(seq)}`),
          { code: 'SESSION_QUERY_EVENT_NOT_FOUND' },
        )
      }
      // The route reads `session.cwd` and decides the file's workspace root from it, so
      // the header has to be the node's own Session header. `session/list` is the one
      // place a remote header is already wrapped: take the unwrapped copy for the node.
      const listed = await router.call(decoded.nodeId, 'session/list', { _request: {} }, signal)
      const rows = Array.isArray(Reflect.get(listed ?? {}, 'items')) ? Reflect.get(listed, 'items') : []
      const row = rows.find(entry => Reflect.get(entry ?? {}, 'sessionId') === decoded.remoteId)
      const cwd = row === undefined ? undefined : Reflect.get(row, 'cwd')
      const start = Math.max(0, seq - before)
      const end = Math.min(seq + after, Number(Reflect.get(page ?? {}, 'cursor') ?? seq))
      return {
        // Only `cwd` is read by the route; the rest mirrors a header closely enough that a
        // different reader sees a Session rather than a partial object.
        session: {
          version: 1,
          id: sessionId,
          createdAt: Number(Reflect.get(row ?? {}, 'createdAt') ?? 0),
          ...(typeof cwd === 'string' ? { cwd } : {}),
          isSeeded: false,
        },
        inheritedEventCount: 0,
        target,
        events: events.filter(event => {
          const at = Reflect.get(event, 'seq')
          return typeof at === 'number' && at >= start && at <= end
        }),
        startSeq: start,
        endSeq: end,
      }
    },
  })
}

/**
 * Install the `directoryPicker` router — by **replacement**, not decoration.
 *
 * The upstream controller delegates both verbs to `ctx.directoryPicker.capability()`.
 * On a desktop with a display the auto backend resolves to `native`, whose capability
 * has no `list`/`createDirectory` at all: the call raises `directory-picker-unavailable`
 * and the relay falls back to *its own* `listRemoteDirectory`, so a decorated method is
 * never reached. Replacing the two methods removes that dependency entirely — this Host
 * answers for both machine kinds itself, and the OS chooser (`pick`) is left alone
 * because it opens a dialog on this machine's screen, which is not what a Remote caller
 * asked for.
 *
 * The node half is reached over the SSH connection rather than the node's Harness: a
 * folder listing is a filesystem question, and asking a running Host would make a node
 * have to be up before its own directories could be browsed.
 *
 * @param {object} service - the live upstream `DirectoryPickerController`.
 * @param {import('./router.js').Router} router
 * @returns {() => void}
 */
export function decorateDirectoryPickerController(service, router) {
  return decorateMethods(service, {
    /**
     * One directory level, for a Remote caller's in-app browser.
     *
     * The shape is the upstream `DirectoryListing`: `path`, `home`, `crumbs`,
     * `entries`, `truncated`, plus this plugin's `exists`. `home` is where the browser's
     * breadcrumb row starts, so a node listing roots it at the namespace instead of the
     * desktop's home.
     *
     * A node path that is legal but **not there yet** answers as an empty level with
     * `exists: false` rather than an error. That is what makes "open a project that does
     * not exist" reachable from a Remote caller at all: the phone can only confirm a level
     * it can see, its typed-path row resolves through this method, and
     * `directoryPicker/createDirectory` is not in its endpoint allowlist. Confirming such a
     * level runs `workspace/create`, whose decorator makes the directory on the node.
     *
     * A caller that names no path gets the **device layer**, not this machine's home: a
     * phone opens its folder browser with no path at all and can only tap a row, so
     * "which machine" has to be a level it can reach. Every row on that level is a path
     * this same method accepts back — an absolute local path for this machine, a
     * `PICKER_PREFIX/<id>` path for a node — which is what keeps "open" a plain
     * recursive call.
     */
    list: local => async function list(path, signal) {
      const target = decodePickerPath(path)
      if (target === undefined) {
        // `undefined`, `''` and whitespace all mean "no path named yet". Any other
        // non-path value can only mean the same thing, because the alternatives are this
        // machine's tree (a string) or the namespace (decoded above).
        if (typeof path !== 'string' || path.trim().length === 0) return deviceListing(router)
        // Not ours: the desktop's own tree, answered from the filesystem directly so the
        // result does not depend on which picker backend this composition resolved.
        const listing = await listLocal(path)
        return {
          path: listing.path,
          home: listing.home,
          // The device layer sits above every local tree. Without this crumb a caller
          // that entered this machine could never reach a node again, because `home`
          // here is the local home by definition (that is what "this machine" means).
          crumbs: [
            { name: PICKER_PREFIX, path: PICKER_PREFIX, hidden: false },
            ...listing.crumbs,
          ],
          entries: listing.entries.map(entry => ({ name: entry.name, path: entry.path, hidden: false })),
          truncated: listing.truncated,
        }
      }
      // The namespace itself and an absent path are the same screen: the phone's
      // breadcrumb can only come back here by naming it, and a level it cannot reach is
      // a dead end for the one row ("this machine") that is not a node.
      if (target.kind === 'nodes') return deviceListing(router)
      const runtime = router.node(target.nodeId)
      const listing = await listRemote(runtime.connection, target.remotePath)
      const prefix = encodePickerPath(target.nodeId, '/')
      // Every path this listing exposes names a node, so the browser's "open" and
      // "choose" actions only ever hand back something this Host can decode again.
      const spell = value => (value === '/' ? prefix : encodePickerPath(target.nodeId, value))
      return {
        path: spell(listing.path),
        home: PICKER_PREFIX,
        crumbs: [
          { name: PICKER_PREFIX, path: PICKER_PREFIX, hidden: false },
          ...listing.crumbs.map(crumb => ({ name: crumb.name, path: spell(crumb.path), hidden: false })),
        ],
        entries: listing.entries.map(entry => ({ name: entry.name, path: spell(entry.path), hidden: false })),
        truncated: listing.truncated,
        // A path on the node that is legal but not there yet answers as an empty level, and
        // this flag is the only thing that says so. It travels on every answer, so a caller
        // branches on the field rather than on which machine it happens to be looking at.
        exists: listing.exists !== false,
      }
    },

    createDirectory: local => async function createDirectory(path, name) {
      const target = decodePickerPath(path)
      if (target === undefined) return await local(path, name)
      if (target.kind === 'nodes') {
        throw Object.assign(
          new Error(`${PICKER_PREFIX} lists nodes; a folder cannot be created in it`),
          { code: 'directory-create-failed', path: PICKER_PREFIX },
        )
      }
      const runtime = router.node(target.nodeId)
      const created = await makeRemoteDirectory(runtime.connection, target.remotePath, name)
      return encodePickerPath(target.nodeId, created)
    },
  })
}

/**
 * One row per connected node, addressed by its own namespace root.
 *
 * Only routable nodes are listed: an offline machine cannot be browsed, and showing it
 * would turn "open a folder" into an error the caller cannot act on.
 *
 * @param {import('./router.js').Router} router
 * @returns {{ path: string, crumbs: Array<{name: string, path: string, hidden: false}>, entries: Array<{name: string, path: string, hidden: false}>, truncated: false }}
 */
function nodeListing(router) {
  const entries = router.nodes().map(runtime => ({
    name: runtime.record.name,
    path: encodePickerPath(runtime.record.id, '/'),
    hidden: false,
  }))
  entries.sort((left, right) => left.name.localeCompare(right.name))
  return {
    path: PICKER_PREFIX,
    crumbs: [{ name: PICKER_PREFIX, path: PICKER_PREFIX, hidden: false }],
    entries,
    truncated: false,
  }
}

/**
 * The level a browser opens on when it has named no path: this machine, then every
 * connected node.
 *
 * It exists because a caller can only tap a row. The phone's folder browser opens with
 * no path at all, and the answer to "no path" used to be this machine's home — a level
 * nothing above which is a machine, so a node was unreachable from the screen no matter
 * how well its path decoded. Making "which machine" the first level is what turns
 * `PICKER_PREFIX` from a path somebody has to know into a screen somebody can reach.
 *
 * This machine is a row rather than a header for the same reason the nodes are: `entries`
 * is the only part of a listing a browser renders. Its path is an ordinary absolute local
 * path, which `list` already answers — so opening it is the same recursive call as
 * opening a node, and the caller needs no second kind of "open".
 *
 * **The row's name is the machine's own hostname, not "此设备".** The Host half has no
 * locale: it cannot know whether the phone that will render this list speaks Chinese, and
 * a name is the one part of a listing that is not a path, so getting it wrong is the only
 * mistake here that cannot be fixed by asking again. A hostname is also more useful on a
 * screen that is choosing between several machines — "this device" only says which one is
 * nearest, not which one it is.
 *
 * @param {import('./router.js').Router} router
 * @returns {{ path: string, home: string, crumbs: Array<{name: string, path: string, hidden: false}>, entries: Array<{name: string, path: string, hidden: false}>, truncated: false }}
 */
function deviceListing(router) {
  const nodes = nodeListing(router)
  return {
    path: PICKER_PREFIX,
    home: PICKER_PREFIX,
    // One crumb, at the namespace: no caller can walk above the machine list, and the
    // browser's "home" action lands here rather than on this machine's home directory.
    crumbs: nodes.crumbs,
    entries: [
      // The same directory an empty path means (see `normalizeLocal`), spelled out: a
      // row has to carry the path a caller sends back, not "the default".
      { name: localMachineName(), path: homedir(), hidden: false },
      ...nodes.entries,
    ],
    truncated: false,
  }
}

/**
 * How this machine is named on the device layer.
 *
 * The hostname, because it is the only name this Host already has and it is the same word
 * the machine answers to everywhere else. A failure to read it is not worth a failed
 * listing: the row still has to exist, and `localhost` is what an unnamed machine is.
 *
 * @returns {string}
 */
function localMachineName() {
  try {
    const name = hostname()
    return name.length > 0 ? name : 'localhost'
  } catch {
    return 'localhost'
  }
}
