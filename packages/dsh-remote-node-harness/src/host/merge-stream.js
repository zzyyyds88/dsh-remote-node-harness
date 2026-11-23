/**
 * The stream lifecycle two merged feeds kept re-implementing.
 *
 * `mergeControlStream` (remote-control.js) and `mergeWorkspaceStream` (decorators.js) merge a
 * remote picture into a local one. Their **payload** strategies genuinely differ — control
 * replaces one block map, workspaces folds incremental `upsert`/`remove`/`archived`/`pinned`
 * frames into a local baseline — and pretending otherwise would be the wrong abstraction.
 *
 * What was byte-for-byte identical is the **lifecycle around** that payload work: create a
 * queue, subscribe to the remote half, guard with a `stopped` flag, hook the abort signal, pump
 * the local feed in a `try/catch/finally` that unsubscribes and detaches, fail the queue on a
 * throw, end it when the local feed ends, and expose `next`/`return`. That is ~40 lines twice,
 * and it is the part where a fix in one copy silently leaves the other broken — which is the
 * defect class this project keeps paying for.
 *
 * So the lifecycle lives here once and the payload strategies stay in their own modules.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/merge-stream
 */
import { AsyncQueue } from './routing.js'

/**
 * Build one merged async iterable.
 *
 * @param {object} spec
 * @param {AsyncIterable<unknown>} spec.local - this Host's own generation.
 * @param {AbortSignal} [spec.signal] - the consumer's signal.
 * @param {(emit: (frame: unknown) => void) => {
 *   subscribe: () => () => void,
 *   onLocalFrame: (frame: unknown, emit: (frame: unknown) => void) => void,
 *   prelude?: () => Promise<void>,
 *   onFinish?: (emit: (frame: unknown) => void) => void,
 * }} spec.create
 *   Called **once per iteration**, so every piece of merge state (the local baseline, the
 *   "have I sent the opening frame" flag) is scoped to the consumer that owns it. `emit` is
 *   already guarded against a stopped stream.
 * @returns {AsyncIterable<unknown>}
 */
export function mergedStream(spec) {
  const { local, signal, create } = spec
  return {
    [Symbol.asyncIterator]() {
      const queue = new AsyncQueue()
      let stopped = false
      /** Push one frame, unless the consumer has already gone away. */
      const emit = frame => {
        if (!stopped) queue.push(frame)
      }
      const state = create(emit)
      const unsubscribe = state.subscribe()
      const onAbort = () => { stopped = true }
      signal?.addEventListener('abort', onAbort, { once: true })
      // Released from two places — the pump's `finally` and the consumer's `return()` — and
      // whichever runs first wins. Making it idempotent here means a caller's unsubscribe does
      // not have to be, which is a property the two payload strategies should not each have to
      // remember.
      let detached = false
      const detach = () => {
        if (detached) return
        detached = true
        unsubscribe()
        signal?.removeEventListener('abort', onAbort)
      }

      const pump = async () => {
        try {
          // The remote half must be current before the local baseline is merged into it,
          // otherwise the opening frame would carry a picture the node set has outgrown.
          if (state.prelude !== undefined) await state.prelude()
          for await (const frame of local) {
            if (stopped) return
            state.onLocalFrame(frame, emit)
          }
        } catch (error) {
          queue.fail(error)
          return
        } finally {
          detach()
        }
        // The local generation ended: this Host is going away. A consumer that never got an
        // opening frame still gets one, so it is not left waiting on a stream that has ended.
        if (state.onFinish !== undefined) state.onFinish(emit)
        queue.end()
      }
      void pump()

      return {
        next: () => queue.next(),
        return: async () => {
          stopped = true
          detach()
          queue.end()
          return { done: true, value: undefined }
        },
      }
    },
  }
}
