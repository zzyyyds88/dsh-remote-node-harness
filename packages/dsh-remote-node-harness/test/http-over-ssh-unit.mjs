/**
 * `host/ssh-http.js` — the bounds on one HTTP exchange, and the lie that turned them off.
 *
 * Every request this plugin makes rides an SSH `direct-tcpip` channel, so there is no
 * real TCP socket underneath and none of `net.Socket`'s behaviour. That is exactly why
 * three separate bound-less paths went unnoticed:
 *
 *   - the channel was opened without the caller's `signal`, and `gateway.call` only
 *     checked it once, before the request — so nothing could stop a call that hung;
 *   - `asSocket` replaced `setTimeout` with a no-op, which reads as "a timeout was
 *     configured" while guaranteeing none ever fired;
 *   - the response body was concatenated whole, so a large `workspaceFiles/readBytes`
 *     was held in memory in its entirety before anyone could object.
 *
 * The fake channel below is a real `Duplex`: `node:http` drives it through
 * `createConnection` exactly as it drives a socket, so these checks exercise the same
 * code path a node does.
 *
 * Usage: node test/http-over-ssh-unit.mjs
 */
import { Duplex } from 'node:stream'
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  HTTP_FAILURE,
  asSocket,
  cookiesOf,
  httpOverSsh,
  openChannel,
} from '../src/host/ssh-http.js'

const log = message => process.stderr.write(`[http-over-ssh-unit] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * One forwarded channel whose far end is a function.
 *
 * `respond` is called once, after the request has been fully flushed (the client calls
 * `end()` on the channel once the body is written), and may write bytes back at any
 * time — including never, which is how the timeout and abort cases are built.
 *
 * `raw` is everything the client wrote, unframed: `node:http` chooses chunked encoding
 * when the caller sets no `content-length`, and reassembling that here would be
 * testing `node:http` rather than this module.
 *
 * @param {(request: { head: string, raw: Buffer }, write: (bytes: Buffer) => void, end: () => void) => void} respond
 * @returns {{ channel: import('node:stream').Duplex, closeCount: () => number }}
 */
function fakeChannel(respond) {
  /** @type {Buffer[]} */
  const chunks = []
  let answered = false
  let closeCount = 0
  const respondOnce = () => {
    if (answered) return
    answered = true
    const raw = Buffer.concat(chunks)
    const end = raw.indexOf('\r\n\r\n')
    respond({ head: end === -1 ? '' : raw.subarray(0, end).toString('latin1'), raw }, bytes => {
      try { channel.push(bytes) } catch { /* the client already left */ }
    }, () => {
      try { channel.push(null) } catch { /* the client already left */ }
    })
  }
  /**
   * Whether the request is complete.
   *
   * `node:http` never ends the duplex it was handed by `createConnection` (it is the
   * caller's socket, and the caller may reuse it), so a half-close cannot be waited
   * for. The observable end of a request is instead: headers, then `content-length`
   * bytes of body — or no `content-length` at all, which is a body-less request.
   */
  const complete = () => {
    const raw = Buffer.concat(chunks)
    const end = raw.indexOf('\r\n\r\n')
    if (end === -1) return false
    const head = raw.subarray(0, end).toString('latin1')
    const declared = /content-length:\s*(\d+)/iu.exec(head)
    if (declared === null) return true
    return raw.length >= end + 4 + Number(declared[1])
  }
  const channel = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      if (complete()) setImmediate(respondOnce)
      callback()
    },
    final(callback) {
      setImmediate(respondOnce)
      callback()
    },
  })
  channel.on('close', () => { closeCount += 1 })
  return { channel, closeCount: () => closeCount }
}

/** A connection stand-in: it hands out fake channels and records how they were asked for. */
function fakeConnection(respond) {
  /** @type {Array<{ host: string, port: number, signal: AbortSignal | undefined, channel: import('node:stream').Duplex }>} */
  const opened = []
  const connection = {
    async forwardOut(host, port, signal) {
      signal?.throwIfAborted()
      const { channel } = fakeChannel(respond)
      opened.push({ host, port, signal, channel })
      return { stream: channel, close: () => channel.destroy() }
    },
  }
  return { connection, opened }
}

/** One complete HTTP/1.1 response. */
function response(status, body, extraHeaders = [], reason = 'OK') {
  const head = [
    `HTTP/1.1 ${String(status)} ${reason}`,
    ...extraHeaders,
    `content-length: ${String(Buffer.byteLength(body))}`,
    'connection: close',
    '',
    '',
  ].join('\r\n')
  return Buffer.concat([Buffer.from(head, 'latin1'), Buffer.from(body)])
}

// ---- 1. the defaults are stated, not implied by silence ------------------
check(DEFAULT_HTTP_TIMEOUT_MS === 30_000, 'the default exchange deadline is 30 s', String(DEFAULT_HTTP_TIMEOUT_MS))
check(DEFAULT_MAX_RESPONSE_BYTES === 64 * 1024 * 1024, 'the default response ceiling is 64 MiB', String(DEFAULT_MAX_RESPONSE_BYTES))
check(HTTP_FAILURE.TIMEOUT === 'rnh/timeout' && HTTP_FAILURE.TOO_LARGE === 'rnh/too-large',
  'the two failure codes are the ones a caller can switch on', JSON.stringify(HTTP_FAILURE))

// ---- 2. a normal exchange, including the request that was sent -----------
{
  const { connection, opened } = fakeConnection((request, write, end) => {
    write(response(200, 'hello', ['set-cookie: sid=abc; Path=/', 'set-cookie: theme=dark; Path=/']))
    end()
  })
  const answer = await httpOverSsh(connection, 4310, { path: '/api/session/list' })
  check(answer.status === 200, 'a 200 answer comes back', String(answer.status))
  check(answer.body.toString('utf8') === 'hello', 'with its body', answer.body.toString('utf8'))
  check(opened.length === 1 && opened[0].port === 4310, 'over one channel to the requested port',
    `${String(opened.length)} channel(s), port ${String(opened[0]?.port)}`)
  const cookies = cookiesOf(answer.headers)
  check(cookies.length === 2 && cookies[1] === 'theme=dark', 'the cookie list still parses',
    cookies.join(' | '))
  check(opened[0].channel.destroyed === true, 'the channel is closed after the exchange')
}

// ---- 3. a POST's body and headers reach the far end ----------------------
{
  const payload = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session/list' })
  let seen
  const { connection } = fakeConnection((request, write, end) => {
    seen = request
    write(response(200, '{}'))
    end()
  })
  await httpOverSsh(connection, 4310, {
    path: '/api/session/list',
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'sid=abc', 'content-length': String(Buffer.byteLength(payload)) },
    body: payload,
  })
  check(seen?.head.startsWith('POST /api/session/list HTTP/1.1'), 'the method and path travel in the request line',
    seen?.head.split('\r\n')[0])
  check(/cookie: sid=abc/iu.test(seen?.head ?? ''), 'the cookie header travels')
  check(seen?.raw.toString('utf8').endsWith(payload), 'the body is the caller\'s bytes exactly',
    String(seen?.raw.length))
}

// ---- 4. a remote that never answers is a deadline, not a hang ------------
// This is F3's first half. Before the fix the promise simply never settled; nothing
// above it had a deadline, and `setTimeout` on the not-a-socket was a no-op.
{
  const { connection, opened } = fakeConnection(() => { /* never answers */ })
  const started = Date.now()
  let caught
  try {
    await httpOverSsh(connection, 4310, { path: '/api/session/list', timeoutMs: 60 })
  } catch (error) {
    caught = error
  }
  const elapsed = Date.now() - started
  check(caught?.code === 'rnh/timeout', 'a silent remote rejects with rnh/timeout', String(caught?.code))
  check(elapsed < 2_000, 'and it rejects at its own deadline, not much later', `${String(elapsed)}ms`)
  check(opened[0]?.channel.destroyed === true, 'the channel is destroyed at the deadline')
}

// ---- 5. a response larger than the ceiling is refused, not concatenated ---
// This is F3's second half: a 500 MB `readBytes` used to be assembled whole.
{
  const body = Buffer.alloc(4_096, 0x7a)
  const { connection, opened } = fakeConnection((_request, write, end) => {
    write(response(200, body))
    end()
  })
  let caught
  try {
    await httpOverSsh(connection, 4310, { path: '/api/workspaceFiles/readBytes', maxResponseBytes: 1_000 })
  } catch (error) {
    caught = error
  }
  check(caught?.code === 'rnh/too-large', 'an oversized body rejects with rnh/too-large', String(caught?.code))
  check(opened[0]?.channel.destroyed === true, 'and the channel is torn down mid-body, not drained')

  // The same body is fine when the caller allows it, so the check is a ceiling and not
  // a refusal of large answers in general.
  const { connection: lenient } = fakeConnection((_request, write, end) => {
    write(response(200, body))
    end()
  })
  const accepted = await httpOverSsh(lenient, 4310, { path: '/x', maxResponseBytes: 1_000_000 })
  check(accepted.body.length === 4_096, 'the same body is accepted under a larger ceiling', String(accepted.body.length))
}

// ---- 6. an abort stops the exchange, and stops it early ------------------
{
  const controller = new AbortController()
  const { connection, opened } = fakeConnection(() => { /* never answers */ })
  const pending = httpOverSsh(connection, 4310, { path: '/api/session/list', signal: controller.signal })
  await sleep(20)
  controller.abort(new Error('the user cancelled'))
  let caught
  try { await pending } catch (error) { caught = error }
  check(caught?.message === 'the user cancelled', 'aborting rejects with the signal\'s own reason', caught?.message)
  check(opened[0]?.channel.destroyed === true, 'and the channel is destroyed')
  check(opened[0]?.signal === controller.signal, 'the signal reached forwardOut, so the channel open is cancellable too')

  // Abort before the call: no channel is opened at all.
  const already = new AbortController()
  already.abort(new Error('too late'))
  const second = fakeConnection(() => { /* never answers */ })
  let early
  try {
    await httpOverSsh(second.connection, 4310, { path: '/x', signal: already.signal })
  } catch (error) {
    early = error
  }
  check(early?.message === 'too late', 'an already-aborted signal rejects', early?.message)
  check(second.opened.length === 0, 'and no channel is opened', String(second.opened.length))

  // `openChannel` itself forwards the signal; that is the seam the routing layer uses.
  const third = fakeConnection(() => { /* never answers */ })
  const signal = new AbortController().signal
  const handle = await openChannel(third.connection, 4310, signal)
  check(third.opened[0]?.signal === signal, 'openChannel hands the signal to forwardOut')
  check(typeof handle.close === 'function', 'and returns a closable handle')
  handle.close()
}

// ---- 7. `asSocket` no longer pretends to own a socket timeout ------------
// The choice, stated as a test: `setTimeout` is *absent* rather than a chainable no-op.
// A caller that believed a timer was armed was the reason nothing ever timed out. The
// deadline lives in `httpOverSsh` (`timeoutMs`), one timer for the whole exchange.
//
// Removing it is safe on this path, and that is asserted rather than assumed: a request
// over a `createConnection` duplex does not require `setTimeout` — the exchange above
// completed without it. The other tuning methods stay chainable so `node:http` is not
// disturbed.
{
  const { channel } = fakeChannel(() => { /* never answers */ })
  const socket = asSocket(channel)
  check(socket.setNoDelay() === socket && socket.setKeepAlive() === socket && socket.ref() === socket,
    'the tuning methods stay chainable, so node:http is not disturbed')
  check(socket.setTimeout === undefined,
    'setTimeout is not faked: there is no socket timer to arm', String(socket.setTimeout))
  // A caller that does reach for one gets a loud TypeError instead of a silent non-deadline.
  let caught
  try { socket.setTimeout(1_000) } catch (error) { caught = error }
  check(caught instanceof TypeError, 'and calling it fails loudly', caught?.message)

  // The real proof it is not needed: an exchange completes with it absent, which the
  // section above already did — asserted here so the reasoning is pinned.
  const { connection } = fakeConnection((_request, write, end) => {
    write(response(200, 'no-timeout'))
    end()
  })
  const answer = await httpOverSsh(connection, 4310, { path: '/' })
  check(answer.body.toString('utf8') === 'no-timeout',
    'an exchange completes with no socket setTimeout at all', answer.body.toString('utf8'))
  channel.destroy()
}

// No long-lived handle is left: the fake channels are destroyed by every exit path.
await sleep(50)
if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
log('all checks passed')
process.exit(0)
