/**
 * The merged-stream lifecycle, tested once instead of twice.
 *
 * `mergeControlStream` and `mergeWorkspaceStream` used to carry byte-for-byte identical
 * lifecycle code — queue, subscribe, `stopped` flag, abort hook, pump with `try/catch/finally`,
 * `next`/`return` — and their own tests each only exercised their payload half. A fix applied to
 * one copy would leave the other broken with every test still green.
 *
 * So this file tests the lifecycle itself, against a payload strategy that does nothing. The
 * properties are the ones a merged feed must have whatever it merges:
 *
 * 1. the local feed is pumped, and every frame reaches the consumer;
 * 2. a throw inside the local feed reaches the consumer as a rejection, not as a clean end;
 * 3. the local feed ending ends the merged stream;
 * 4. the consumer's `return()` stops the pump and unsubscribes from the remote half;
 * 5. the consumer's abort signal stops the pump and unsubscribes;
 * 6. the `prelude` runs before the first local frame is read (the node set has to be current);
 * 7. `onFinish` runs when the local feed ends, so a consumer that never got an opening frame
 *    still gets one.
 *
 * @module @greatbaby/dsh-remote-node-harness/test/merge-stream-unit
 */
import { mergedStream } from '../src/host/merge-stream.js'

let failed = 0
const log = message => process.stderr.write(`[merge-stream-unit] ${message}\n`)
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** An async iterable that yields the given frames and then ends (or throws). */
function feed(frames, options = {}) {
  return {
    async * [Symbol.asyncIterator]() {
      for (const frame of frames) {
        if (options.awaitBeforeYield !== undefined) await options.awaitBeforeYield
        yield frame
      }
      if (options.throwAfter !== undefined) throw options.throwAfter
      if (options.hangAfter === true) await new Promise(() => {})
    },
  }
}

/** Collect `count` frames from a merged stream, then close it. */
async function take(stream, count) {
  const frames = []
  const iterator = stream[Symbol.asyncIterator]()
  try {
    while (frames.length < count) {
      const next = await iterator.next()
      if (next.done === true) break
      frames.push(next.value)
    }
  } finally {
    await iterator.return?.()
  }
  return frames
}

/** The minimal strategy: pass everything through, record the calls the lifecycle makes. */
function passthrough(calls, options = {}) {
  return () => ({
    subscribe: () => {
      calls.push('subscribe')
      if (options.subscribe !== undefined) options.subscribe()
      return () => calls.push('unsubscribe')
    },
    prelude: () => {
      calls.push('prelude')
      return options.prelude?.() ?? Promise.resolve()
    },
    onLocalFrame: (frame, emit) => {
      calls.push(`local:${String(frame?.type ?? frame)}`)
      emit(frame)
    },
    onFinish: emit => {
      calls.push('finish')
      if (options.finishFrame !== undefined) emit(options.finishFrame)
    },
  })
}

// ---- 1. the local feed reaches the consumer --------------------------------
{
  const calls = []
  const frames = await take(mergedStream({
    local: feed([{ type: 'a' }, { type: 'b' }]),
    create: passthrough(calls, { finishFrame: { type: 'opening' } }),
  }), 3)
  check(frames.map(frame => frame.type).join(',') === 'a,b,opening',
    'every local frame reaches the consumer, then the finish frame', frames.map(f => f.type).join(','))
  check(calls.includes('subscribe') && calls.includes('unsubscribe'),
    'the remote half is subscribed and released', calls.join(' '))
  check(calls.filter(call => call === 'unsubscribe').length === 1,
    'and released exactly once — the pump and the consumer both try, and it is idempotent',
    calls.join(' '))
  check(calls.includes('prelude') && calls.includes('finish'),
    'the prelude ran and the finish hook ran', calls.join(' '))
  check(calls.indexOf('prelude') < calls.indexOf('local:a'),
    'the prelude runs before the first local frame', calls.join(' '))
}

// ---- 2. a throw in the local feed rejects, it does not end cleanly ---------
{
  const calls = []
  const boom = new Error('the local generation died')
  const iterator = mergedStream({
    local: feed([{ type: 'a' }], { throwAfter: boom }),
    create: passthrough(calls),
  })[Symbol.asyncIterator]()
  const first = await iterator.next()
  check(first.done === false && first.value?.type === 'a', 'the frame before the throw arrives')
  let rejected
  try {
    await iterator.next()
  } catch (error) {
    rejected = error
  }
  check(rejected === boom, 'the failure reaches the consumer as the same error object',
    String(rejected?.message))
  check(calls.includes('unsubscribe'),
    'and the remote subscription is released even on the failure path', calls.join(' '))
  check(!calls.includes('finish'),
    'while the finish hook does not run — a failed feed is not a clean end', calls.join(' '))
}

// ---- 3. the consumer's return() stops the pump and unsubscribes -----------
{
  const calls = []
  const iterator = mergedStream({
    local: feed([{ type: 'a' }, { type: 'b' }, { type: 'c' }], { hangAfter: false }),
    create: passthrough(calls),
  })[Symbol.asyncIterator]()
  const first = await iterator.next()
  check(first.value?.type === 'a', 'the stream produces before it is closed')
  const closed = await iterator.return()
  check(closed.done === true, 'return() reports the stream as done')
  check(calls.includes('unsubscribe'), 'and unsubscribes from the remote half', calls.join(' '))
  // A frame pushed after the close must not resurrect the stream.
  const after = await iterator.next()
  check(after.done === true, 'a read after return() is done, not a queued frame',
    JSON.stringify(after))
}

// ---- 4. the consumer's abort signal stops the pump ------------------------
{
  const calls = []
  const controller = new AbortController()
  const iterator = mergedStream({
    local: feed([{ type: 'a' }], { awaitBeforeYield: sleep(20) }),
    signal: controller.signal,
    create: passthrough(calls),
  })[Symbol.asyncIterator]()
  const pending = iterator.next()
  controller.abort()
  await sleep(60)
  // The pump saw `stopped` and returned; the queue was ended by return() below.
  await iterator.return()
  const settled = await pending.then(value => ({ done: value.done }), error => ({ error }))
  check(settled.done === true || settled.error !== undefined,
    'an aborted consumer does not hang forever', JSON.stringify(settled))
  check(calls.includes('unsubscribe'), 'and the remote subscription is released', calls.join(' '))
}

// ---- 5. a prelude that fails rejects the stream --------------------------
{
  const calls = []
  const boom = new Error('the node set could not be read')
  const iterator = mergedStream({
    local: feed([{ type: 'a' }]),
    create: passthrough(calls, { prelude: () => Promise.reject(boom) }),
  })[Symbol.asyncIterator]()
  let rejected
  try {
    await iterator.next()
  } catch (error) {
    rejected = error
  }
  check(rejected === boom, 'a failing prelude rejects rather than silently producing nothing',
    String(rejected?.message))
  check(calls.includes('unsubscribe'), 'and the subscription made before it is released',
    calls.join(' '))
}

// ---- 6. the payload strategies still behave as their own tests expect ----
// The lifecycle extraction must not change either merge's contract. `routing-unit` covers the
// control half; this covers the invariant both share: exactly ONE baseline-shaped frame leaves
// a merged stream per local baseline, no matter how many remote baselines arrive meanwhile.
{
  const remoteListeners = []
  const remote = {
    baselineFrame: () => ({ type: 'baseline', value: { projections: { r: { title: 'remote' } } } }),
    subscribe: listener => {
      remoteListeners.push(listener)
      return () => {
        const at = remoteListeners.indexOf(listener)
        if (at !== -1) remoteListeners.splice(at, 1)
      }
    },
  }
  const { mergeControlStream } = await import('../src/host/remote-control.js')
  const local = feed([{ type: 'baseline', value: { projections: { l: { title: 'local' } } } }])
  const iterator = mergeControlStream(local, remote, undefined)[Symbol.asyncIterator]()
  const opening = await iterator.next()
  const blocks = opening.value?.value?.projections ?? {}
  check(opening.value?.type === 'baseline' && Object.keys(blocks).length === 2,
    'the opening frame is one baseline carrying both halves', JSON.stringify(blocks))
  // A remote baseline after the opening frame re-emits the merged whole.
  for (const listener of remoteListeners) listener({ type: 'baseline' })
  const remerged = await iterator.next()
  check(remerged.value?.type === 'baseline',
    'a remote baseline change re-emits a baseline, not a bare replace',
    JSON.stringify(remerged.value?.type))
  await iterator.return()
  check(remoteListeners.length === 0, 'and closing the merged stream unsubscribes',
    String(remoteListeners.length))
}

process.stdout.write(
  failed === 0
    ? '[merge-stream-unit] all checks passed\n'
    : `[merge-stream-unit] FAILED: ${String(failed)} check(s)\n`,
)
process.exitCode = failed === 0 ? 0 : 1
