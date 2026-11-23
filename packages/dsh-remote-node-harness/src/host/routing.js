/**
 * Identity translation and stream plumbing shared by the routing decorators.
 *
 * A remote Host speaks its own identities: `session-<uuid>`, a bare Workspace
 * uuid. The local Host must never confuse those with its own, so every remote
 * identity crosses this boundary wrapped in a name that carries the node it came
 * from: `rnh_<nodeId>_<remoteId>`. The wrapper is the whole routing table —
 * decoding it names the node and the remote identity behind one local id, and no
 * separate registry can drift out of sync with what the UI holds.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/routing
 */

/** Prefix every remote identity carries locally. */
const PREFIX = 'rnh_'

/** A node identity: `n` plus twelve lowercase hex characters. */
const NODE_ID = /^n[0-9a-f]{12}$/u

/** Node identities are fixed width — `n` plus twelve hex characters — so the
 * split point is a constant rather than a parse. */
const NODE_LENGTH = 13
const NODE_END = PREFIX.length + NODE_LENGTH

/**
 * Wrap one remote identity for local use.
 * @param {string} nodeId
 * @param {string} remoteId
 * @returns {string}
 */
export function encodeRemoteId(nodeId, remoteId) {
  return `${PREFIX}${nodeId}_${remoteId}`
}

/**
 * Split one local identity back into its node and remote halves.
 * @param {unknown} value
 * @returns {{ nodeId: string, remoteId: string } | undefined}
 */
export function decodeRemoteId(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return undefined
  const nodeId = value.slice(PREFIX.length, NODE_END)
  if (!NODE_ID.test(nodeId)) return undefined
  if (value[NODE_END] !== '_') return undefined
  const remoteId = value.slice(NODE_END + 1)
  return remoteId === '' ? undefined : { nodeId, remoteId }
}

/** Whether a value names a remote identity. */
export function isRemoteId(value) {
  return decodeRemoteId(value) !== undefined
}

/**
 * Rewrite every occurrence of the keys of `map` inside one JSON value.
 *
 * Remote payloads name their Session in many places — `header.id`, an event's
 * `sessionId`, a projection's `workingDirectory` neighbours, addresses, queue
 * entries. Rather than enumerate them (and silently miss the next one DSH adds),
 * this replaces an exact string match wherever it appears. Identity strings are
 * unique enough that a false positive is not possible, and a visited-node budget
 * keeps a pathological payload from stalling the route.
 * @param {unknown} value
 * @param {ReadonlyMap<string, string>} map
 * @param {number} [budget]
 * @returns {unknown}
 */
export function remapIds(value, map, budget = 400_000) {
  if (map.size === 0) return value
  const walk = (node, remaining) => {
    if (remaining.n <= 0) return node
    remaining.n -= 1
    if (typeof node === 'string') return map.get(node) ?? node
    if (node === null || typeof node !== 'object') return node
    if (Array.isArray(node)) {
      const out = new Array(node.length)
      for (let index = 0; index < node.length; index += 1) out[index] = walk(node[index], remaining)
      return out
    }
    const prototype = Object.getPrototypeOf(node)
    if (prototype !== Object.prototype && prototype !== null) return node
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const key of Object.keys(node)) out[key] = walk(node[key], remaining)
    return out
  }
  return walk(value, { n: budget })
}

/** A single-consumer queue turning push callbacks into an async iterable. */
export class AsyncQueue {
  constructor() {
    /** @type {unknown[]} */
    this.values = []
    /** @type {Array<{ resolve: (result: IteratorResult<unknown>) => void, reject: (error: unknown) => void }>} */
    this.waiters = []
    this.closed = false
    /** @type {unknown} */
    this.error = undefined
  }

  push(value) {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value })
      return
    }
    this.values.push(value)
  }

  end() {
    if (this.closed) return
    this.closed = true
    // Settling happens on the next microtask, not inline, and that delay is the fix.
    //
    // The callers of this class reported the end of a stream and the reason for it as two
    // separate calls in the same tick (`onEnd()` then `onEnd(error)`). Resolving the
    // pending waiter inline settled that race before the reason was known: the consumer
    // saw `done: true`, its `for await` stopped, and the error — recorded a moment later —
    // had no one left to reach. Deferring the settle lets a failure reported in the same
    // tick turn the waiter into a rejection instead, which is the only way a pending read
    // can hear it.
    const waiters = this.waiters.splice(0)
    if (waiters.length === 0) return
    queueMicrotask(() => {
      for (const waiter of waiters) {
        if (this.error === undefined) waiter.resolve({ done: true, value: undefined })
        else waiter.reject(this.error)
      }
    })
  }

  fail(error) {
    if (this.closed) {
      // The stream was already closed when the real reason arrived. That is the shape of
      // the worst bug in this file's callers: the end path runs first and the failure is
      // reported second, so the queue had already been told "clean end" and the failure was
      // discarded on the floor. Keep the first error — `next()` drains whatever is buffered
      // and then rejects with it, which is strictly more informative than an EOF.
      if (this.error === undefined) this.error = error
      return
    }
    this.error = error
    this.end()
  }

  /** @returns {Promise<IteratorResult<unknown>>} */
  next() {
    if (this.values.length > 0) return Promise.resolve({ done: false, value: this.values.shift() })
    if (this.closed) {
      return this.error === undefined
        ? Promise.resolve({ done: true, value: undefined })
        : Promise.reject(this.error)
    }
    const pending = new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
    // A consumer can abandon a pending read (an iterator nobody advances again). Rejecting
    // that waiter with the stream's failure is the whole point of this class, and a
    // rejection nobody handles would terminate the Host — so the failure is claimed here
    // too. The consumer that *is* waiting still receives it.
    pending.catch(() => {})
    return pending
  }
}

/**
 * Turn one remote logical stream into a local async iterable.
 *
 * The remote carrier pushes frames; a Remote stream method must return an async
 * iterable. This adapts one to the other and owns the remote stream's lifetime:
 * the remote stream is cancelled when the local consumer finishes or the
 * consumer's signal aborts.
 * @param {{ openStream: (endpoint: string, args: Record<string, unknown>, handlers: { onFrame: (value: unknown) => void, onEnd: (failure?: unknown) => void }) => Promise<{ close: () => void }> }} gateway
 * @param {string} endpoint
 * @param {Record<string, unknown>} args
 * @param {AbortSignal | undefined} signal
 * @param {(value: unknown) => unknown} [transform]
 * @returns {AsyncIterable<unknown>}
 */
export function remoteIterable(gateway, endpoint, args, signal, transform) {
  return {
    [Symbol.asyncIterator]() {
      const queue = new AsyncQueue()
      /** @type {{ close: () => void } | undefined} */
      let remote
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        try { remote?.close() } catch { /* already closing */ }
        queue.end()
      }
      void gateway.openStream(endpoint, args, {
        onFrame: value => queue.push(transform === undefined ? value : transform(value)),
        onEnd: failure => {
          if (failure === undefined) finish()
          else {
            if (!finished) { finished = true; try { remote?.close() } catch { /* closing */ } }
            queue.fail(failure)
          }
        },
      }).then(
        handle => {
          remote = handle
          if (finished) handle.close()
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
}

/**
 * Decorate live Service methods without disturbing the Remote descriptor.
 *
 * The Gateway discovers endpoints from the class prototype descriptor and reads
 * parameter names by walking prototypes, then invokes `Reflect.get(view, name)`.
 * An own property on the service instance is therefore invisible to discovery but
 * wins at dispatch — exactly the seam a router needs, and one that leaves the
 * upstream class, its `static inject`, and every other endpoint untouched.
 *
 * @param {object} target - the live Service instance.
 * @param {Record<string, (original: (...args: never[]) => unknown) => (...args: never[]) => unknown>} factories
 * @returns {() => void} restores every original method.
 */
export function decorateMethods(target, factories) {
  /** @type {Array<[string, unknown]>} */
  const restored = []
  for (const [name, make] of Object.entries(factories)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name)
    if (descriptor !== undefined && descriptor.configurable === false) continue
    const original = Reflect.get(target, name)
    if (typeof original !== 'function') continue
    const bound = original.bind(target)
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: make(bound),
    })
    restored.push([name, descriptor?.value])
  }
  return () => {
    for (const [name, value] of restored) {
      if (value === undefined) delete target[name]
      else {
        Object.defineProperty(target, name, {
          configurable: true,
          enumerable: false,
          writable: true,
          value,
        })
      }
    }
  }
}
