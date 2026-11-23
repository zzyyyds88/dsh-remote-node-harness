/**
 * The error-frame path, end to end through the real `AsyncQueue`, the real `ws.js`
 * carrier and the real `RemoteGateway` — the three pieces whose interaction turned a
 * node-side failure into an ordinary end of stream.
 *
 * The bug had a precise shape, and it is worth restating because the test mirrors it
 * step for step:
 *
 *   1. the carrier delivers `{type:"error"}`;
 *   2. `#onCarrierText` called `stream.finish()`, whose only effect was `onEnd()` — the
 *      consumer's `queue.end()`;
 *   3. the same handler then called `handlers.onEnd(frame.error)` — the consumer's
 *      `queue.fail(error)`;
 *   4. `fail()` saw `closed === true` and returned, dropping the reason.
 *
 * A `for await` consumer sees `done: true` in step 2 and never asks again, so the error
 * was not merely late — it was structurally unobservable. These checks fail on the old
 * code in step 4 and pass on the convergent one.
 *
 * Nothing here talks to SSH: the carrier is a fake `Duplex` shaped exactly like the one
 * `forwardOut` hands over, so the frames travel through `ws-frame.js` and `ws.js` for
 * real and only the socket is simulated.
 *
 * Usage: node test/error-frame-unit.mjs
 */
import { Duplex } from 'node:stream'
import { AsyncQueue, remoteIterable } from '../src/host/routing.js'
import { RemoteGateway } from '../src/host/remote-gateway.js'
import { OPCODE, encodeFrame } from '../src/host/ws-frame.js'

const log = message => process.stderr.write(`[error-frame-unit] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const NODE_FAILURE = { code: 'workspace-file/not-found', message: 'no entry at "x"' }

// ---- 1. AsyncQueue: a failure recorded after the queue closed is kept ----
// This is the minimal shape of the bug, with no stream involved. The order of the two
// calls is exactly what `#onCarrierText` used to produce.
{
  const queue = new AsyncQueue()
  queue.end()
  queue.fail(NODE_FAILURE)
  let caught
  try { await queue.next() } catch (error) { caught = error }
  check(caught === NODE_FAILURE, 'a failure recorded after end() is what next() rejects with',
    JSON.stringify(caught ?? null))
}

// ---- 2. AsyncQueue: a waiter that was already pending hears the failure ---
// `for await` on a live stream has a `next()` outstanding when the error frame arrives.
// Answering that waiter with `done: true` is what made the failure invisible even though
// it had been recorded.
{
  const queue = new AsyncQueue()
  const pending = queue.next()
  queue.end()
  queue.fail(NODE_FAILURE)
  let caught
  try { await pending } catch (error) { caught = error }
  check(caught === NODE_FAILURE, 'a pending next() rejects with the failure, not a tidy EOF',
    caught === undefined ? 'it resolved as done' : JSON.stringify(caught))
}

// ---- 3. AsyncQueue: the buffers are drained before the failure -----------
// Order matters for a real stream: frames that arrived before the failure are the
// consumer's to read, and the failure comes after them — not instead of them.
{
  const queue = new AsyncQueue()
  queue.push('frame-1')
  queue.push('frame-2')
  queue.fail(NODE_FAILURE)
  const seen = []
  let caught
  try {
    for (;;) seen.push((await queue.next()).value)
  } catch (error) {
    caught = error
  }
  check(seen.length === 2, 'frames pushed before the failure are still delivered', String(seen.length))
  check(caught === NODE_FAILURE, 'and the failure follows them', JSON.stringify(caught ?? null))
}

// ---- 4. AsyncQueue: a clean end still ends cleanly -----------------------
// The other direction has to keep working: no error recorded, no rejection invented.
{
  const queue = new AsyncQueue()
  queue.push(1)
  queue.end()
  check((await queue.next()).value === 1, 'a clean end still delivers its buffered value')
  check((await queue.next()).done === true, 'and then reports done')
  const second = new AsyncQueue()
  const pending = second.next()
  second.end()
  check((await pending).done === true, 'a pending next() on a clean end resolves as done')
}

// ---- 5. AsyncQueue: the first error wins ---------------------------------
// A second failure cannot overwrite the first: the first is the one that explains what
// went wrong, and swapping it for a later, vaguer one is how a diagnosis is lost.
{
  const queue = new AsyncQueue()
  queue.fail(NODE_FAILURE)
  queue.fail(new Error('a later, less specific failure'))
  let caught
  try { await queue.next() } catch (error) { caught = error }
  check(caught === NODE_FAILURE, 'the first recorded failure is the one that surfaces', caught?.message)
}

/**
 * A duplex that behaves like an already-forwarded SSH channel.
 *
 * The first write is the WebSocket upgrade request; it is answered with a 101 plus a
 * `Sec-WebSocket-Accept` the client does not verify (it checks the status and the
 * `Upgrade` header only). Everything after that is a frame both ways.
 */
function fakeCarrierChannel() {
  /** @type {Buffer[]} */
  const written = []
  let upgraded = false
  const channel = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      written.push(Buffer.from(chunk))
      if (!upgraded) {
        upgraded = true
        // The upgrade response and nothing else: a frame in the same write would be
        // exercised by `ws-frame-unit`, and keeping them apart is what makes this test
        // about the error path.
        channel.push(Buffer.from(
          'HTTP/1.1 101 Switching Protocols\r\n'
          + 'Upgrade: websocket\r\n'
          + 'Connection: Upgrade\r\n'
          + '\r\n',
          'latin1',
        ))
      }
      callback()
    },
    final(callback) { callback() },
  })
  return {
    channel,
    /** Push one unmasked text frame, as a server sends it. */
    sendText(text) { channel.push(encodeFrame(OPCODE.TEXT, Buffer.from(text, 'utf8'), { mask: false })) },
    /** Every JSON frame this side sent, decoded from the text frames it wrote. */
    frames() {
      const out = []
      for (const chunk of written) {
        if (chunk.length < 2 || (chunk[0] & 0x0f) !== OPCODE.TEXT) continue
        try {
          // The client masks: skip the 2-byte header and the 4-byte key, then unmask.
          const length = chunk[1] & 0x7f
          if (length === 126 || length === 127) continue
          const key = chunk.subarray(2, 6)
          const body = chunk.subarray(6, 6 + length)
          const plain = Buffer.from([...body].map((byte, index) => byte ^ key[index % 4]))
          out.push(JSON.parse(plain.toString('utf8')))
        } catch { /* not a frame this test needs */ }
      }
      return out
    },
  }
}

/**
 * A gateway whose SSH connection hands out one fake carrier channel.
 *
 * `cookieValue` is pre-seeded so the cookie exchange (which is a plain HTTP request over
 * its own channel) does not need a second fake — it is a separate concern, covered by
 * `http-over-ssh-unit`.
 */
function gatewayWithFakeCarrier() {
  const carrier = fakeCarrierChannel()
  const gateway = new RemoteGateway({
    connection: {
      async forwardOut() {
        return { stream: carrier.channel, close: () => carrier.channel.destroy() }
      },
    },
    serving: () => ({ port: 4_310, token: 'launch' }),
    log: message => log(`  gateway: ${message}`),
  })
  gateway.cookieValue = 'sid=test'
  return { gateway, carrier }
}

// ---- 6. an error frame reaches the consumer as an error ------------------
// The whole chain, with only the socket faked: `openStream` opens a carrier through
// `upgradeWebSocket`, sends its open frame as a masked text frame, receives an item
// frame and then an error frame, and the consumer's `onEnd` must receive the error.
{
  const { gateway, carrier } = gatewayWithFakeCarrier()
  /** @type {Array<{ frame?: unknown, end?: unknown, ended: boolean }>} */
  const deliveries = []
  const handle = await gateway.openStream('session/follow', {}, {
    onFrame: value => deliveries.push({ frame: value, ended: false }),
    onEnd: failure => deliveries.push({ end: failure, ended: true }),
  })
  const opened = carrier.frames().find(frame => frame.type === 'open')
  check(opened?.endpoint === 'session/follow', 'the stream opened over a real carrier frame',
    JSON.stringify(opened?.endpoint ?? null))

  // One item, then the node's failure. The stream id comes from the open frame the
  // gateway just sent, exactly as the node learns it.
  carrier.sendText(JSON.stringify({ type: 'item', streamId: opened.streamId, value: { type: 'snapshot' } }))
  carrier.sendText(JSON.stringify({ type: 'error', streamId: opened.streamId, error: NODE_FAILURE }))
  await sleep(20)

  check(deliveries.length === 2, 'one item and one terminal event reached the consumer',
    String(deliveries.length))
  check(deliveries[0]?.frame?.type === 'snapshot', 'the item arrived first',
    JSON.stringify(deliveries[0]?.frame ?? null))
  const terminals = deliveries.filter(entry => entry.ended)
  check(terminals.length === 1, 'the stream settled exactly once', String(terminals.length))
  check(terminals[0]?.end?.code === NODE_FAILURE.code && terminals[0]?.end?.message === NODE_FAILURE.message,
    'the terminal event carries the node\'s error, not undefined',
    JSON.stringify(terminals[0]?.end ?? null))
  check(gateway.streams.size === 0, 'the stream is no longer registered', String(gateway.streams.size))

  // A close after the error must not produce a second terminal event or a cancel frame
  // that would tell a node about a stream it already failed.
  handle.close()
  await sleep(10)
  check(deliveries.filter(entry => entry.ended).length === 1,
    'a later close cannot produce a second terminal event',
    String(deliveries.filter(entry => entry.ended).length))
  check(!carrier.frames().some(frame => frame.type === 'cancel'),
    'and cannot send a cancel for a stream the node already ended',
    JSON.stringify(carrier.frames().map(frame => frame.type)))
}

// ---- 7. an ordinary end frame still ends cleanly -------------------------
// The fix must not turn every stream end into an error.
{
  const { gateway, carrier } = gatewayWithFakeCarrier()
  const deliveries = []
  await gateway.openStream('session/follow', {}, {
    onFrame: value => deliveries.push({ frame: value }),
    onEnd: failure => deliveries.push({ end: failure }),
  })
  const opened = carrier.frames().find(frame => frame.type === 'open')
  carrier.sendText(JSON.stringify({ type: 'item', streamId: opened.streamId, value: { type: 'baseline' } }))
  carrier.sendText(JSON.stringify({ type: 'end', streamId: opened.streamId }))
  await sleep(20)
  const terminals = deliveries.filter(entry => 'end' in entry)
  check(terminals.length === 1, 'an end frame settles the stream once', String(terminals.length))
  check(terminals[0]?.end === undefined, 'with no failure attached', JSON.stringify(terminals[0]?.end ?? null))
}

// ---- 8. `remoteIterable` throws the failure out of `for await` -----------
// The layer the browser actually consumes. A node stream that fails must throw out of
// the loop with the node's own error, which is the difference between "this Session
// shows nothing" and "this Session could not be read: workspace-file/not-found".
{
  const { gateway, carrier } = gatewayWithFakeCarrier()
  const seen = []
  let caught
  const iterate = async () => {
    for await (const frame of remoteIterable(gateway, 'session/follow', {}, undefined, value => value)) {
      seen.push(frame)
    }
  }
  const running = iterate().catch(error => { caught = error })
  // Give the carrier a moment to open, then deliver the frame and the failure.
  await sleep(20)
  const opened = carrier.frames().find(frame => frame.type === 'open')
  carrier.sendText(JSON.stringify({ type: 'item', streamId: opened.streamId, value: { type: 'baseline' } }))
  carrier.sendText(JSON.stringify({ type: 'error', streamId: opened.streamId, error: NODE_FAILURE }))
  await running
  check(seen.length === 1, 'the frame before the failure is yielded', String(seen.length))
  check(caught?.code === NODE_FAILURE.code && caught?.message === NODE_FAILURE.message,
    'and the failure is thrown out of the loop',
    JSON.stringify(caught ?? null))
}

// ---- 9. a clean end still ends cleanly through remoteIterable ------------
{
  const { gateway, carrier } = gatewayWithFakeCarrier()
  const seen = []
  let caught
  const iterate = async () => {
    for await (const frame of remoteIterable(gateway, 'session/follow', {}, undefined, value => value)) {
      seen.push(frame)
    }
  }
  const running = iterate().catch(error => { caught = error })
  await sleep(20)
  const opened = carrier.frames().find(frame => frame.type === 'open')
  carrier.sendText(JSON.stringify({ type: 'item', streamId: opened.streamId, value: { type: 'baseline' } }))
  carrier.sendText(JSON.stringify({ type: 'end', streamId: opened.streamId }))
  await running
  check(seen.length === 1 && caught === undefined, 'a clean end yields its frames and stops',
    `${String(seen.length)} frame(s)`)
}

if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
  process.exitCode = 0
}
