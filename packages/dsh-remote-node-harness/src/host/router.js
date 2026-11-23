/**
 * Route `session`, `workspace`, `workspaceFiles` and `terminal` Remote endpoints
 * between this Host and every configured node.
 *
 * The mechanism is one own property per routing endpoint on the live Service
 * instance. The Gateway discovers endpoints from the class prototype descriptor,
 * so its declared surface does not change, while `Reflect.get(view, name)` at
 * dispatch resolves the instance property first. Every endpoint this module does
 * not replace keeps working untouched — including the upstream class's
 * `static inject`, config schema, and every non-routed method.
 *
 * A remote identity never leaks into local state. It crosses the boundary as
 * `rnh_<nodeId>_<remoteId>`, so one string answers all three questions a router
 * asks: is this remote, which node, and what is it called there.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/router
 */
import {
  AsyncQueue,
  decodeRemoteId,
  encodeRemoteId,
  isRemoteId,
  remapIds,
} from './routing.js'

/**
 * Every `*Endpoint` wrapper below hands a **local** call straight to `local(...)`, and
 * the wrapper function itself is deliberately **not** `async`.
 *
 * The local half of a router is a pass-through, so it has to keep the upstream method's
 * *shape* and not only its value. Several routed services are synchronous and their
 * in-process callers depend on that: `dsh-tool-goal` evaluates
 * `goalValue(ctx.goals.create(agent, …))` without awaiting, and `goals.create` throws
 * synchronously when a goal already exists. Wrapping that in `async` produced two
 * failures at once:
 *
 *   - the created goal came back as a promise, so every field `goalValue` read was
 *     `undefined` and the tool answered "invalid output";
 *   - the synchronous throw became a rejected promise nobody awaited, which the Host's
 *     `unhandledRejection` handler turned into
 *     `dsh: fatal load failure: GoalError: goal "goal-…" already exists with phase
 *     "active"` followed by `process.exit(1)` — the whole desktop app exited.
 *
 * Measured 2026-11-19 on `0.2.2-rc.5`. The remote half stays a promise because the wire
 * is a promise; that asymmetry is inherent to routing, and no in-process caller here
 * ever passes a remote Agent.
 */

/**
 * One Session identity as DSH mints it: `session-` followed by a uuid.
 *
 * The exact shape matters. A looser `startsWith('session-')` test also matches
 * Session *event types* like `session-log-deepseek/delivery-accepted`, and
 * rewriting those would silently corrupt every event the client renders.
 */
const SESSION_ID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/**
 * A Session identity with no `session-` marker.
 *
 * A subagent's own Session is stored as a bare uuid, so a client that lists one gets
 * `sessionId: "93f9…"` and builds a `{kind:'subagent', parentSessionId, childSessionId}`
 * address from it. Left unwrapped, that child id names nothing on this Host, the route
 * falls through to the local implementation, and opening the child's history answers
 * `subagent/not-found`. A bare uuid is only ever a subagent Session here, and only a
 * Session field can hold one, so the field name is what makes wrapping safe.
 */
const BARE_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** Fields whose value is a Session identity even when it carries no `session-` marker. */
const SESSION_FIELDS = Object.freeze(new Set(['sessionId', 'childSessionId', 'parentSessionId']))

/**
 * Relayed Host events whose **first positional argument** is a Session identity.
 *
 * `toLocal` decides whether to wrap a bare uuid by the field name it sits under,
 * which is right for a snapshot (`{ sessionId: '…' }`) and useless for a
 * positional argument — there is no field name to read.
 *
 * That distinction is not academic. `api-session/status` is emitted as
 * `(sessionId, running)`, and a **subagent's** Session has no `session-` marker,
 * so the first argument arrived here as a bare uuid, fell through unwrapped, and
 * was re-emitted with an id the sidebar does not know:
 *
 *   node sends   ["84a0d391-8ee9-46e4-b8af-1ea0ea998d91", true]
 *   session/list rnh_n00a5f7394401_84a0d391-…
 *
 * The row looked its children up by the wrapped id (`tree.ts` in the workspace UI:
 * `statuses.get(child.id)?.running`), found nothing, and a parent row sat at
 * "0 subagents running" for the whole turn. Measured on a real remote turn.
 */
const SESSION_FIRST_ARGUMENT = Object.freeze(new Set([
  'api-session/activity',
  'api-session/error',
  'api-session/removed',
  'api-session/status',
]))

/**
 * The caller's `AbortSignal`, if the last positional argument is one.
 *
 * `args.at(-1)` looked right for endpoints that do take a signal, but most do not:
 * `agentPresets/select(agent, agentPreset)` ends with a preset name, and passing
 * that to `router.call` as the signal crashed inside the Gateway with
 * `signal?.throwIfAborted is not a function`. A shape test is the honest one.
 *
 * @param {unknown[]} args
 * @returns {AbortSignal | undefined}
 */
function signalOf(args) {
  const last = args.at(-1)
  if (last === null || typeof last !== 'object') return undefined
  return typeof Reflect.get(last, 'throwIfAborted') === 'function' ? last : undefined
}

/**
 * Pull the Session identity out of one request object.
 * @param {Record<string, unknown> | undefined} request
 * @returns {string | undefined}
 */
function sessionIdOf(request) {
  if (request === undefined || request === null || typeof request !== 'object') return undefined
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

/** A failure shaped like the Gateway's own Remote failure, so the client sees one protocol. */
class RoutedFailure extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'RemoteError'
    this.code = code
    this.details = details
    this.isDSHRemoteError = true
  }
}

/** Translate one gateway failure into a Remote failure. */

/**
 * Everything the routing layer needs from the running Host.
 *
 * Kept explicit rather than reached through `ctx` so a test can drive a router
 * with a fake rnh and a fake gateway.
 */
export class Router {
  /**
   * @param {object} options
   * @param {import('./rnh.js').Rnh} options.rnh
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    this.rnh = options.rnh
    this.log = options.log ?? (() => {})
    /** @type {Set<() => void>} */
    this.disposers = new Set()
  }

  /** A live node, or a failure naming the one that is missing. */
  node(nodeId) {
    const runtime = this.rnh.get(nodeId)
    if (runtime === undefined) throw new RoutedFailure('rnh/node-unknown', `no node ${nodeId}`, { nodeId })
    if (!runtime.routable) {
      throw new RoutedFailure('rnh/node-offline', `${runtime.record.name} is not connected`, { nodeId })
    }
    return runtime
  }

  /** Every connected node. */
  nodes() {
    return this.rnh.routable()
  }

  /**
   * Local id for a remote Session, recording the reverse direction.
   * @param {string} nodeId
   * @param {string} remoteId
   */
  encode(nodeId, remoteId) {
    return encodeRemoteId(nodeId, remoteId)
  }

  /**
   * Turn one local request into the request a node must receive: every remote
   * identity it carries becomes the node's own identity again.
   * @param {unknown} value
   * @param {string} nodeId
   */
  toRemote(value, nodeId) {
    const map = new Map()
    const walk = node => {
      if (typeof node === 'string') {
        const decoded = decodeRemoteId(node)
        if (decoded !== undefined && decoded.nodeId === nodeId) {
          map.set(node, decoded.remoteId)
          return decoded.remoteId
        }
        return node
      }
      if (node === null || typeof node !== 'object') return node
      if (Array.isArray(node)) return node.map(walk)
      const prototype = Object.getPrototypeOf(node)
      if (prototype !== Object.prototype && prototype !== null) return node
      const out = {}
      for (const key of Object.keys(node)) out[key] = walk(node[key])
      return out
    }
    return walk(value)
  }

  /**
   * Turn one node's answer into the local form: its own identities become the
   * wrapped ones.
   *
   * A marked `session-<uuid>` string is rewritten wherever it appears. A plain
   * `session-` prefix test would also catch event types such as
   * `session-log-deepseek/delivery-accepted` and corrupt them, so the match is the
   * full identity shape.
   *
   * A **subagent's own Session has no marker**: the node stores and lists it as a
   * bare uuid. Only the field name says it is an identity, so `sessionId`,
   * `childSessionId` and `parentSessionId` are wrapped by name. Without that a
   * listed child row reached the client as a bare uuid, the client built a
   * subagent address from it, nothing on this Host decoded it, and opening that
   * child's history fell through to the local Host and answered
   * `subagent/not-found`.
   *
   * @param {unknown} value
   * @param {string} nodeId
   */
  toLocal(value, nodeId) {
    const map = new Map()
    const wrapString = node => {
      if (isRemoteId(node)) return node
      if (!SESSION_ID_PATTERN.test(node) && !BARE_SESSION_ID_PATTERN.test(node)) return node
      const encoded = encodeRemoteId(nodeId, node)
      map.set(node, encoded)
      return encoded
    }
    const wrap = (node, key) => {
      if (typeof node === 'string') {
        if (!SESSION_FIELDS.has(key) && !SESSION_ID_PATTERN.test(node)) return node
        return wrapString(node)
      }
      if (node === null || typeof node !== 'object') return node
      if (Array.isArray(node)) return node.map(entry => wrap(entry, key))
      const prototype = Object.getPrototypeOf(node)
      if (prototype !== Object.prototype && prototype !== null) return node
      const out = {}
      for (const field of Object.keys(node)) out[field] = wrap(node[field], field)
      return out
    }
    const walked = wrap(value, undefined)
    return map.size === 0 ? walked : remapIds(walked, map)
  }

  /**
   * Turn one node's Workspace answer into the local form.
   *
   * Session identities are recognisable by their `session-` prefix, but a
   * Workspace identity is a bare uuid with no marker, so it can only be wrapped
   * from its field name. This wraps `workspaceId`/`workspaceIds` (and the nested
   * `workspace` projection) on top of {@link Router#toLocal}.
   * @param {unknown} value
   * @param {string} nodeId
   */
  toLocalWorkspace(value, nodeId) {
    const encode = id => (isRemoteId(id) ? id : encodeRemoteId(nodeId, id))
    const walk = node => {
      if (node === null || typeof node !== 'object') return node
      if (Array.isArray(node)) return node.map(walk)
      const prototype = Object.getPrototypeOf(node)
      if (prototype !== Object.prototype && prototype !== null) return node
      const out = {}
      for (const key of Object.keys(node)) {
        const item = node[key]
        if ((key === 'workspaceId' || key === 'beforeWorkspaceId') && typeof item === 'string') {
          out[key] = encode(item)
        } else if (key === 'workspaceIds' && Array.isArray(item)) {
          out[key] = item.map(entry => (typeof entry === 'string' ? encode(entry) : walk(entry)))
        } else {
          out[key] = walk(item)
        }
      }
      return out
    }
    return this.toLocal(walk(value), nodeId)
  }

  /**
   * Turn one relayed Host event's positional arguments into the local form.
   *
   * For the events in {@link SESSION_FIRST_ARGUMENT} the first argument is a Session
   * identity by position, so it is wrapped whether or not it carries a marker — that
   * is the only way a subagent's bare-uuid id arrives wrapped. Every other event
   * keeps `toLocal`'s field-name rule, which is what the rest of the pipeline relies
   * on.
   *
   * @param {string} event - the Host event name, e.g. `api-session/status`.
   * @param {unknown[]} args
   * @param {string} nodeId
   * @returns {unknown[]}
   */
  toLocalEventArgs(event, args, nodeId) {
    const sessionFirst = SESSION_FIRST_ARGUMENT.has(event)
    return args.map((argument, index) => {
      if (sessionFirst && index === 0 && typeof argument === 'string') {
        return isRemoteId(argument) ? argument : encodeRemoteId(nodeId, argument)
      }
      return this.toLocal(argument, nodeId)
    })
  }

  /**
   * Call one unary endpoint on a node and unwrap its result.
   * @param {string} nodeId
   * @param {string} endpoint
   * @param {Record<string, unknown>} args
   * @param {AbortSignal} [signal]
   */
  async call(nodeId, endpoint, args, signal) {
    const runtime = this.node(nodeId)
    const result = await runtime.gateway.call(endpoint, args, signal)
    if (result.ok !== true) {
      const failure = result.error ?? {}
      throw new RoutedFailure(
        typeof failure.code === 'string' ? failure.code : 'rnh/remote-failure',
        typeof failure.message === 'string' ? failure.message : `${endpoint} failed on the node`,
        typeof failure.details === 'object' && failure.details !== null ? failure.details : { endpoint },
      )
    }
    return result.value
  }

  /**
   * Route one Session endpoint: local calls reach the upstream implementation,
   * remote calls reach the node that owns the Session.
   *
   * @param {string} endpoint - the wire endpoint name, e.g. `prompt`.
   * @param {(request: Record<string, unknown>, signal?: AbortSignal) => unknown} local
   * @param {{ args?: 'request' | 'raw' }} [options] - how the Gateway passes arguments.
   * @returns {(request: Record<string, unknown>, signal?: AbortSignal) => unknown}
   */
  sessionEndpoint(endpoint, local, options = {}) {
    const router = this
    const wrapArgs = options.args ?? 'request'
    return function routed(request, signal) {
      const id = wrapArgs === 'request' ? sessionIdOf(request) : sessionIdOf({ sessionId: request })
      const decoded = decodeRemoteId(id)
      if (decoded === undefined) return local(request, signal)
      const payload = router.toRemote({ request: request ?? {} }, decoded.nodeId)
      return router.call(decoded.nodeId, `session/${endpoint}`, payload, signal).then(
        value => router.toLocal(value, decoded.nodeId),
      )
    }
  }

  /**
   * Route one endpoint whose identity is an `agent: Agent` **first positional argument**.
   *
   * The Gateway resolves that argument from the wire's `agentId` before the body runs, and
   * `host/lookups.js` already teaches it to hand back a placeholder for a wrapped Session
   * identity — so by the time a decorator sees the call, `agent.id` decodes to the node and
   * the node's own Session id. Forwarding is therefore just "rewrite `agentId`, keep the
   * rest".
   *
   * `rest` names the remaining positional arguments in order, so the payload this builds is
   * exactly what the node's descriptor expects. A method whose trailing argument is the
   * caller's `AbortSignal` does not list it: the signal is forwarded out of band.
   *
   * @param {string} endpoint - the wire endpoint, e.g. `goals/edit`.
   * @param {readonly string[]} rest - names of the remaining positional arguments.
   * @param {(agent: object, ...rest: never[]) => unknown} local
   * @param {{ wrapResult?: boolean }} [options] - `wrapResult:false` for a value that holds
   *   no identities (a boolean, a plain descriptor list).
   * @returns {(agent: object, ...rest: never[]) => unknown}
   */
  agentEndpoint(endpoint, rest, local, options = {}) {
    const router = this
    const wrap = options.wrapResult !== false
    return function routed(agent, ...args) {
      const decoded = decodeRemoteId(agent?.id)
      if (decoded === undefined) return local(agent, ...args)
      /** @type {Record<string, unknown>} */
      const payload = { agentId: decoded.remoteId }
      for (const [index, name] of rest.entries()) {
        const value = args[index]
        if (value === undefined) continue
        payload[name] = name === 'request' ? router.toRemote(value, decoded.nodeId) : value
      }
      return router.call(decoded.nodeId, endpoint, payload, signalOf(args)).then(
        value => (wrap ? router.toLocal(value, decoded.nodeId) : value),
      )
    }
  }

  /**
   * Route one endpoint whose identity is a request field, for a namespace other than
   * `session`.
   *
   * `messageFeedback/*` and `subagents/*` name a Session in their request; `schedule/*`
   * names a schedule entry, which this Host wraps in a local identity so the browser has
   * one string per entry across every node.
   *
   * @param {string} endpoint - the wire endpoint, e.g. `messageFeedback/put`.
   * @param {string} field - the request field that carries the identity.
   * @param {(request: Record<string, unknown>, signal?: AbortSignal) => unknown} local
   * @returns {(request: Record<string, unknown>, signal?: AbortSignal) => unknown}
   */
  fieldEndpoint(endpoint, field, local) {
    const router = this
    return function routed(request, signal) {
      const raw = request === null || typeof request !== 'object' ? undefined : Reflect.get(request, field)
      const decoded = decodeRemoteId(typeof raw === 'string' ? raw : undefined)
      if (decoded === undefined) return local(request, signal)
      const payload = router.toRemote({ request: request ?? {} }, decoded.nodeId)
      // Only the identity this endpoint routes on is unwrapped; other identities inside the
      // request stay wrapped, so a field this module never heard of still cannot leak a bare
      // node id to the browser.
      payload.request[field] = decoded.remoteId
      return router.call(decoded.nodeId, endpoint, payload, signal).then(
        value => router.toLocal(value, decoded.nodeId),
      )
    }
  }

  /**
   * Route one endpoint whose identity is its **first positional argument**, as a plain string.
   *
   * `subagents/interruptByUser(childSessionId)` is the shape: the argument is the identity
   * itself, not a request object and not an `Agent`. The wire field is named by the
   * descriptor, so the caller passes it — guessing `sessionId` here produced
   * `args fields do not match the descriptor: missing "childSessionId"`.
   *
   * @param {string} endpoint
   * @param {string} field - the wire field the node's descriptor expects.
   * @param {(id: string, ...rest: never[]) => unknown} local
   * @returns {(id: string, ...rest: never[]) => unknown}
   */
  firstArgEndpoint(endpoint, field, local) {
    const router = this
    return function routed(id, ...args) {
      const decoded = decodeRemoteId(typeof id === 'string' ? id : undefined)
      if (decoded === undefined) return local(id, ...args)
      return router.call(decoded.nodeId, endpoint, { [field]: decoded.remoteId }).then(
        value => router.toLocal(value, decoded.nodeId),
      )
    }
  }

  /** Release everything this router registered. */
  dispose() {
    for (const dispose of this.disposers) {
      try { dispose() } catch { /* already disposed */ }
    }
    this.disposers.clear()
  }
}
