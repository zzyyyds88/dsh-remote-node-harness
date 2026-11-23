/**
 * HTTP and WebSocket plumbing over one SSH `direct-tcpip` channel.
 *
 * A node's resident Host listens on its loopback interface only. Every request
 * this plugin makes therefore rides a forwarded channel on the pooled SSH
 * connection; there is no second transport and no listening port on either side.
 *
 * Every exchange is bounded on three axes, because all three were missing and each
 * one fails differently on a slow or hostile node:
 *
 *   - **time**: a channel or a response that never completes held the caller forever
 *     (a unary call has no other deadline above it);
 *   - **bytes**: a `workspaceFiles/readBytes` of a large file was concatenated whole,
 *     with nothing asking how large it was before the desktop ran out of memory;
 *   - **cancellation**: the `signal` a caller passed stopped being consulted the
 *     moment the channel opened.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/ssh-http
 */
import { request as httpRequest } from 'node:http'

/** How long one whole exchange (channel open + request + response body) may take. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000

/**
 * The largest response body this client will hold in memory.
 *
 * 64 MiB is above every legitimate unary answer — a `readBytes` preview, a PDF, a
 * multipart attachment — and far below what would hurt the desktop. A stream
 * endpoint does not travel this path at all, so this is a bound on whole values.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024

/** Failure codes this transport can add to a caller's error. */
export const HTTP_FAILURE = Object.freeze({
  TIMEOUT: 'rnh/timeout',
  TOO_LARGE: 'rnh/too-large',
})

const codedError = (code, message) => Object.assign(new Error(message), { code })

/**
 * Adapt one SSH channel to the socket shape `node:http` expects.
 *
 * `setTimeout` is deliberately **left undefined**, and that is the fix. It used to be
 * defined as a chainable no-op, which is the worst of both worlds: the object looked
 * like a socket with a timeout armed, while no timer existed anywhere, so an exchange
 * that never answered could not be stopped by anything. Two honest options existed —
 * implement a real timer on a duplex that has none, or remove the pretence — and this
 * takes the second: the deadline for a request lives in `httpOverSsh`'s `timeoutMs`
 * (one timer for channel open + request + body, cleared on every exit), and a second,
 * invisible timer would be a competing authority over the same thing.
 *
 * It is safe to remove because `node:http` does not require it on this path: a request
 * with the `timeout` option over a `createConnection` duplex never calls
 * `socket.setTimeout` (measured on Node 24.15, 0 calls), and this module never passes
 * that option. A caller that does expect a socket timeout will get a loud
 * `setTimeout is not a function` instead of a silent non-deadline.
 *
 * @param {import('node:stream').Duplex} stream
 */
export function asSocket(stream) {
  stream.ref ??= () => stream
  stream.unref ??= () => stream
  stream.setKeepAlive ??= () => stream
  stream.setNoDelay ??= () => stream
  return stream
}

/**
 * Open one forwarded channel to a port on the remote loopback.
 *
 * `signal` is forwarded, so an aborted call stops waiting for the channel as well as
 * for the response — the two waits used to be one, and only the second one was
 * cancellable.
 *
 * @param {import('../ssh/connection.js').SshConnection} connection
 * @param {number} port
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ stream: import('node:stream').Duplex, close: () => void }>}
 */
export function openChannel(connection, port, signal) {
  return connection.forwardOut('127.0.0.1', port, signal)
}

/**
 * Perform one complete HTTP/1.1 exchange over a fresh forwarded channel.
 *
 * The returned promise settles exactly once: on a response whose body ended, on the
 * timeout, on an abort, on an oversized body, or on a transport error. Whatever
 * happens, the channel is closed before the caller sees the outcome.
 *
 * @param {import('../ssh/connection.js').SshConnection} connection
 * @param {number} port
 * @param {{
 *   path: string,
 *   method?: string,
 *   headers?: Record<string, string>,
 *   body?: string | Buffer,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   maxResponseBytes?: number,
 * }} init
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: Buffer }>}
 */
export async function httpOverSsh(connection, port, init) {
  const timeoutMs = init.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  const maxResponseBytes = init.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const { signal } = init
  signal?.throwIfAborted()
  const channel = await openChannel(connection, port, signal)
  let settled = false
  let timer
  /** The promise's own reject, reachable from the abort listener installed below. */
  let rejectExercise
  /** Closed by every exit path, so a channel never outlives its exchange. */
  const abandon = () => {
    try { channel.close() } catch { /* already gone */ }
  }
  const abortError = () => {
    const reason = signal?.reason
    if (reason instanceof Error) return reason
    return Object.assign(new Error('the HTTP exchange was aborted'), { code: 'ABORT_ERR', cause: reason })
  }
  const onAbort = () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    abandon()
    rejectExercise(abortError())
  }
  try {
    return await new Promise((resolve, rejectInner) => {
      rejectExercise = rejectInner
      if (signal?.aborted === true) {
        settled = true
        abandon()
        rejectInner(abortError())
        return
      }
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        // **Not** `unref()`ed. An unref'd timer does not keep the event loop alive, so in a
        // process whose only pending work is this request, Node simply exits with the
        // promise unsettled — a deadline that only fires when something else happens to be
        // running is not a deadline. The timer is cleared on every exit path.
        timer = setTimeout(() => {
          if (settled) return
          settled = true
          abandon()
          rejectInner(codedError(
            HTTP_FAILURE.TIMEOUT,
            `the remote did not answer ${init.path} within ${String(timeoutMs)} ms`,
          ))
        }, timeoutMs)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const upstream = httpRequest({
        host: '127.0.0.1',
        port,
        method: init.method ?? 'GET',
        path: init.path,
        headers: { host: `127.0.0.1:${String(port)}`, connection: 'close', ...init.headers },
        createConnection: () => asSocket(channel.stream),
      })
      const fail = error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        rejectInner(error)
      }
      upstream.on('error', fail)
      upstream.on('response', response => {
        const chunks = []
        let received = 0
        response.on('data', chunk => {
          if (settled) return
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          received += buffer.length
          if (received > maxResponseBytes) {
            // Destroying the request tears the channel down mid-body, which is what makes
            // the refusal cheap: the alternative is finishing the concatenation of a body
            // this client has already decided not to keep.
            fail(codedError(
              HTTP_FAILURE.TOO_LARGE,
              `the remote answered ${init.path} with more than ${String(maxResponseBytes)} bytes`,
            ))
            try { upstream.destroy() } catch { /* already gone */ }
            return
          }
          chunks.push(buffer)
        })
        response.on('end', () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) })
        })
        response.on('error', fail)
      })
      if (init.body !== undefined) upstream.write(init.body)
      upstream.end()
    })
  } finally {
    signal?.removeEventListener('abort', onAbort)
    clearTimeout(timer)
    abandon()
  }
}

/**
 * Read every `Set-Cookie` header as a `name=value` list.
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @returns {string[]}
 */
export function cookiesOf(headers) {
  const raw = headers['set-cookie']
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  return list.map(cookie => cookie.split(';')[0].trim()).filter(cookie => cookie.length > 0)
}
