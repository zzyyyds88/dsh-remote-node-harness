/**
 * SSH transport for one node: a pooled `ssh2` client that answers exec, SFTP and
 * direct-tcpip (port-forward) requests.
 *
 * The whole plugin talks to a node through this one connection. That is the
 * single most important difference from a per-operation SSH design: a remote
 * tool call must never pay a handshake, and a forwarded HTTP request must be
 * able to ride the connection that is already warm.
 *
 * @module @greatbaby/dsh-remote-node-harness/ssh/connection
 */
import { createHash } from 'node:crypto'
import { Client } from 'ssh2'
import { ERROR_CODES, isSsh2HostKeyRejection } from '../core/errors.js'

const READY_TIMEOUT_MS = 20_000
const KEEPALIVE_INTERVAL_MS = 15_000
const KEEPALIVE_COUNT_MAX = 3
const MAX_RETRIES = 3
const BASE_DELAY_MS = 400
/** Attempts to re-open a channel while the server's per-connection budget is full. */
const CHANNEL_RETRIES = 4
/** How long each wait grows: 250, 500, 750, 1000 ms. */
const CHANNEL_BACKOFF_MS = 250

/**
 * The longest command line this layer will send, in bytes.
 *
 * OpenSSH's `PACKET_MAX_SIZE` is 256 KiB, and ssh2 writes an `exec` request as **one** packet
 * however long the command is (`Protocol.js:1273`, `alloc(1 + 4 + 4 + 4 + 1 + 4 + cmdLen)`).
 * A command over the server's ceiling is therefore not "a large exec", it is a packet the server
 * rejects — and it rejects it *after* accepting the bytes, so its stream position is wrong from
 * then on and every later packet is read as garbage.
 *
 * **Measured on a real node** (single connection, node's own `auth.log` counters):
 *
 *   command line 240,000 bytes → +0 connections, +0 corrupted
 *   command line 262,000 bytes → +0 connections, +0 corrupted
 *   command line 262,200 bytes → +6 connections, +6 corrupted
 *   command line 300,000 bytes → +6 connections, +6 corrupted
 *
 * That is the whole cause of the `Bad packet length 7923616.` / `Connection corrupted` bursts
 * this plugin used to produce: `writePluginBundle` built one command line containing an entire
 * plugin tree as base64, and 7,923,616 is that command's size for `dsh-whale-widget` to within
 * its script tail. Payloads belong on stdin (channel-data packets honour the negotiated
 * `packetSize`); see `writeBrainBundle`/`writePluginBundle`.
 *
 * The margin under 256 KiB is for the `cd … && exec …` prefix `posixCommand` may add.
 */
export const MAX_COMMAND_BYTES = 128 * 1024

/** Stable failure categories a caller can branch on without parsing text. */
export const SSH_FAILURE = Object.freeze({
  AUTH: 'auth',
  HOST_KEY: 'host-key',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  CLOSED: 'closed',
  /**
   * The server refused to open another channel on this connection.
   *
   * `sshd` limits **session** channels per connection (`MaxSessions`, default 10), and every
   * `exec` and every `direct-tcpip` forward is one. Measured on the reference node while one
   * long-lived session was held (the shape of `workspace/follow`):
   *
   *   5 concurrent execs → 5 ok
   *   8 concurrent execs → 8 ok
   *   10 concurrent execs → 8 ok, 2 refused (`Channel open failure: open failed`)
   *   12 concurrent execs → 8 ok, 4 refused
   *
   * So the ceiling is **real and reachable**: one long-lived session plus a burst of tool calls
   * or picker calls on the same node runs out of channels even though the connection is
   * healthy. The error is ssh2's `Channel open failure: open failed`, which classifies as
   * `unknown` unless it is named here — and an `unknown` failure is not retried, so it reached
   * the user as a bare "Unable to exec".
   */
  CHANNEL: 'channel',
  /**
   * A request this layer refused to send because it would break the protocol.
   *
   * Not retryable and not a network fault: the caller asked for something no server can accept,
   * and the only fix is at the call site. See `MAX_COMMAND_BYTES`.
   */
  PROTOCOL: 'protocol',
  UNKNOWN: 'unknown',
})

/** Every category a mark may carry, except `unknown` (which never says anything). */
const MARKABLE_CATEGORIES = new Set([
  SSH_FAILURE.AUTH,
  SSH_FAILURE.HOST_KEY,
  SSH_FAILURE.TIMEOUT,
  SSH_FAILURE.NETWORK,
  SSH_FAILURE.CLOSED,
  SSH_FAILURE.CHANNEL,
  SSH_FAILURE.PROTOCOL,
])

/**
 * The category an error already carries, when it names one this file knows.
 *
 * Two spellings are read because two writers exist: `toSshError` writes `category` and
 * `sshCategory`, and a throw site that knows better may write either one.
 * @param {unknown} error
 * @returns {string | undefined}
 */
function markedCategory(error) {
  const marked = Reflect.get(error ?? {}, 'sshCategory') ?? Reflect.get(error ?? {}, 'category')
  return typeof marked === 'string' && MARKABLE_CATEGORIES.has(marked) ? marked : undefined
}

/**
 * Classify one ssh2 error into a stable category.
 *
 * **A mark wins over any text.** The sentence is the weakest evidence available — ssh2 reuses
 * one message for a whole class of failures, and a single sentence can name two causes at once
 * (`Host denied (verification failed)` says nothing, while "host key … password …" says both).
 * The code that *decided* is always more precise: our own `hostVerifier` refuses on a
 * fingerprint mismatch and marks that failure `host-key`, and any throw site may set a mark.
 *
 * Only when nothing is marked does this read text, and the order below is load-bearing:
 * **host key before auth**, because the auth pattern matches the word "password", which can
 * appear in a host-key sentence too, and a refused host key must never be reported as a wrong
 * credential (that would offer the wrong button and retry forever).
 */
export function classifySshError(error) {
  const marked = markedCategory(error)
  if (marked !== undefined) return marked
  // ssh2's own rejection literal — the fallback for an error that carries no mark, i.e. one
  // raised by something other than this file's verifier (see `isSsh2HostKeyRejection`).
  if (isSsh2HostKeyRejection(error)) return SSH_FAILURE.HOST_KEY
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (/host key|hostkey|man-in-the-middle|fingerprint/u.test(text)) return SSH_FAILURE.HOST_KEY
  if (/all configured authentication methods failed|authentication|publickey|password|private key/u.test(text)) {
    return SSH_FAILURE.AUTH
  }
  // Before the network rule, and before `unknown`: this is the server declining a channel,
  // not the network failing, and it is the one refusal that a retry can fix.
  if (/channel open failure|open failed|unable to exec|unable to open shell|channel is not open|administratively prohibited/u.test(text)) {
    return SSH_FAILURE.CHANNEL
  }
  if (/timed out|timeout|ready timeout/u.test(text)) return SSH_FAILURE.TIMEOUT
  if (/econnrefused|econnreset|enotfound|ehostunreach|enetunreach|connect|network|socket hang up/u.test(text)) {
    return SSH_FAILURE.NETWORK
  }
  if (/not connected|connection closed|no response from server/u.test(text)) return SSH_FAILURE.CLOSED
  return SSH_FAILURE.UNKNOWN
}

/**
 * Wrap one error with its category and cause.
 *
 * An `ssh-*` code a throw site already set is carried through, because it is more specific than
 * the category it corresponds to: a refusal this connection made itself is marked
 * `ssh-host-key` at the source, and a re-wrap on the way out must not downgrade it to a bare
 * category. Only this layer's own `ssh-*` vocabulary is carried, so a `code` some other
 * library happened to set cannot leak into the panel's vocabulary.
 */
export function toSshError(error, category = classifySshError(error)) {
  const message = error instanceof Error ? error.message : String(error)
  const wrapped = Object.assign(new Error(message, { cause: error }), { category, sshCategory: category })
  const code = Reflect.get(error ?? {}, 'code')
  // `ssh-*` is this layer's half of the panel's vocabulary (`core/errors.js` owns the table);
  // anything else is another library's code and is not ours to forward.
  if (typeof code === 'string' && code.startsWith('ssh-') && ERROR_CODES[code] !== undefined) {
    wrapped.code = code
  }
  return wrapped
}

/**
 * Wrap one handshake failure that **this object's own `hostVerifier`** refused.
 *
 * The fingerprint comparison happens here, so the decision is known here — there is nothing to
 * infer from ssh2's message, and ssh2's message (`Host denied (verification failed)`, see
 * `isSsh2HostKeyRejection`) is deliberately not the evidence. Both marks are set so that either
 * reader finds it: `sshCategory`/`code` for `classifyFailure` and this file's classifier.
 * @param {unknown} cause - the error ssh2 raised because the verifier answered `false`.
 */
export function hostKeyRejection(cause) {
  return Object.assign(toSshError(cause, SSH_FAILURE.HOST_KEY), { code: 'ssh-host-key' })
}

/**
 * True for categories worth retrying.
 *
 * `CHANNEL` belongs here for a different reason than the rest: the connection is fine, it is
 * the server's per-connection channel budget that ran out. The retry that helps is therefore
 * a short wait on the **same** connection (see `#openWithChannelBudget`), not a new handshake —
 * a new handshake would drop the long-lived streams that are part of the reason the budget is
 * tight, and losing a `workspace/follow` to open one `exec` is a worse trade than waiting.
 */
export function isRetryable(category) {
  return category === SSH_FAILURE.NETWORK || category === SSH_FAILURE.TIMEOUT
    || category === SSH_FAILURE.CLOSED || category === SSH_FAILURE.CHANNEL
}

/**
 * One lazily established, reusable SSH client.
 *
 * Every entry point awaits {@link client}, so a caller never sees a partial
 * connection, and a failed handshake rejects the waiters of that attempt
 * instead of parking them forever.
 */
export class SshConnection {
  /** @type {import('ssh2').Client | undefined} */
  #client
  /** @type {Promise<import('ssh2').Client> | undefined} */
  #pending
  /** @type {Promise<import('ssh2').SFTPWrapper> | undefined} */
  #sftp
  #closed = false
  /**
   * Clients this object ended itself, so their `close` event is not reported as a drop.
   *
   * A WeakSet rather than a flag on the client: ssh2 owns that object, and a property added
   * to it would be one more thing a future version could disagree about.
   * @type {WeakSet<import('ssh2').Client>}
   */
  #ending = new WeakSet()

  /**
   * @param {object} target
   * @param {string} target.host
   * @param {number} target.port
   * @param {string} target.username
   * @param {{ kind: 'password' | 'key' | 'agent', password?: string, privateKey?: string | Buffer, passphrase?: string }} target.auth
   * @param {string} [target.label] - diagnostic label for logs.
   * @param {string} [target.hostFingerprint] - the host key recorded for this machine; absent
   *   means first use.
   * @param {(fingerprint: string) => void} [target.onFirstFingerprint] - first key seen.
   * @param {(expected: string, actual: string) => void} [target.onFingerprintMismatch] - the key
   *   changed, which refuses the handshake.
   * @param {() => void} [target.onDrop] - the socket closed without this object asking.
   * @param {(message: string) => void} [target.log]
   */
  constructor(target) {
    this.target = target
  }

  /** The label used in diagnostics. */
  get label() {
    return this.target.label ?? `${this.target.username}@${this.target.host}:${String(this.target.port)}`
  }

  /** Whether this connection was disposed. */
  get closed() {
    return this.#closed
  }

  /** Whether a live client is already established. */
  get ready() {
    return this.#client !== undefined
  }

  /**
   * The live client, connecting on first use.
   * @returns {Promise<import('ssh2').Client>}
   */
  async client() {
    if (this.#closed) throw toSshError(new Error('ssh connection was closed'), SSH_FAILURE.CLOSED)
    if (this.#client !== undefined) return this.#client
    if (this.#pending !== undefined) return this.#pending
    this.#pending = this.#connectWithRetry()
    try {
      return await this.#pending
    } finally {
      this.#pending = undefined
    }
  }

  /**
   * The SFTP subsystem, opening it once.
   * @returns {Promise<import('ssh2').SFTPWrapper>}
   */
  async sftp() {
    if (this.#sftp !== undefined) return this.#sftp
    const opening = (async () => {
      const client = await this.client()
      return await new Promise((resolve, reject) => {
        client.sftp((error, sftp) => {
          if (error) reject(toSshError(error))
          else resolve(sftp)
        })
      })
    })()
    this.#sftp = opening
    try {
      return await opening
    } catch (error) {
      this.#sftp = undefined
      throw error
    }
  }

  /**
   * Run one argv vector remotely and collect its output.
   *
   * `argv` never passes through a local shell: ssh2 sends the joined command to
   * the remote login shell, so the caller supplies already-safe tokens and this
   * method quotes each one for POSIX shells.
   * @param {object} request
   * @param {readonly string[]} request.argv - program and its arguments.
   * @param {string} [request.cwd] - absolute directory to run in.
   * @param {number} [request.timeoutMs] - ceiling for the whole transfer.
   * @param {string | Uint8Array} [request.stdin] - bytes written to the child.
   * @param {number} [request.maxBytes] - cap on each captured stream tail.
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<{ code: number | null, signal: string | undefined, stdout: string, stderr: string, truncated: boolean }>}
   */
  async exec(request) {
    const command = posixCommand(request.argv, request.cwd)
    const commandBytes = Buffer.byteLength(command, 'utf8')
    // Refuse here rather than on the server. Over the ceiling the server does not answer with an
    // error, it loses packet alignment and drops the connection — measured, see
    // `MAX_COMMAND_BYTES`. A local throw is the only outcome a caller can act on.
    if (commandBytes > MAX_COMMAND_BYTES) {
      throw toSshError(new Error(
        `ssh: the command line is ${String(commandBytes)} bytes, over the `
        + `${String(MAX_COMMAND_BYTES)}-byte ceiling (one exec request is one SSH packet, and `
        + 'OpenSSH rejects anything over 256 KiB by corrupting the stream); send the payload on '
        + 'stdin instead',
      ), SSH_FAILURE.PROTOCOL)
    }
    const maxBytes = request.maxBytes ?? 4 * 1024 * 1024
    const channel = await this.#openSession(command)
    return await new Promise((resolve, reject) => {
      const out = []
      const err = []
      let outBytes = 0
      let errBytes = 0
      let truncated = false
      const collect = (target, chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (target === out) {
          if (outBytes >= maxBytes) { truncated = true; return }
          const room = maxBytes - outBytes
          const slice = buffer.length <= room ? buffer : buffer.subarray(0, room)
          if (slice.length !== buffer.length) truncated = true
          out.push(slice)
          outBytes += slice.length
        } else {
          if (errBytes >= maxBytes) { truncated = true; return }
          const room = maxBytes - errBytes
          const slice = buffer.length <= room ? buffer : buffer.subarray(0, room)
          if (slice.length !== buffer.length) truncated = true
          err.push(slice)
          errBytes += slice.length
        }
      }
      let timer
      const abort = () => {
        try { channel.signal('KILL') } catch { /* the channel may already be gone */ }
        try { channel.close() } catch { /* idempotent */ }
        finish(toSshError(new Error('ssh exec was aborted'), SSH_FAILURE.CLOSED))
      }
      const finish = (failure) => {
        if (timer !== undefined) clearTimeout(timer)
        request.signal?.removeEventListener('abort', abort)
        if (failure !== undefined) reject(failure)
      }
      channel.on('data', chunk => { collect(out, chunk) })
      channel.stderr.on('data', chunk => { collect(err, chunk) })
      channel.on('exit', (code, signal) => { channel.__exit = { code, signal } })
      channel.on('close', (code, signal) => {
        const exit = channel.__exit ?? { code, signal }
        finish()
        resolve({
          code: exit.code ?? code ?? null,
          signal: exit.signal ?? signal ?? undefined,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          truncated,
        })
      })
      channel.on('error', error => {
        finish(toSshError(error))
        reject(toSshError(error))
      })
      if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
        timer = setTimeout(() => {
          try { channel.signal('KILL') } catch { /* best effort */ }
          try { channel.close() } catch { /* idempotent */ }
          finish(toSshError(new Error(`ssh exec timed out after ${String(request.timeoutMs)}ms`), SSH_FAILURE.TIMEOUT))
        }, request.timeoutMs)
      }
      request.signal?.addEventListener('abort', abort, { once: true })
      if (request.signal?.aborted === true) {
        abort()
        return
      }
      if (request.stdin !== undefined) channel.end(request.stdin)
      else channel.end()
    })
  }

  /**
   * Open one session channel, waiting out a full channel budget instead of failing.
   *
   * The ceiling is `MaxSessions` (default 10) per **connection**, and this Host holds
   * long-lived channels: one per `workspace/follow`, one per terminal, one per forwarded HTTP
   * exchange in flight. A burst therefore hits the ceiling on a connection that is perfectly
   * healthy, and ssh2 reports it as `Channel open failure: open failed`.
   *
   * **Measured: waiting is not enough, and that is the whole reason this method has two stages.**
   * Ten long-running execs fill the budget, and from then on *that connection* refuses every new
   * channel for as long as those ten run — `channel.close()` on a channel whose remote command is
   * still alive does not return its slot (`budget-recovery` probe: refusals persisted for the
   * full 40 s observation window, and `pgrep` showed the remote `sleep` processes still there).
   * So:
   *
   * 1. Retry on the same connection a few times with a short backoff. This covers the ordinary
   *    case — a channel frees up as soon as any in-flight exec finishes — and keeps every stream
   *    riding the connection alive.
   * 2. If the budget is still full, **drop the client and handshake again**. The new connection
   *    starts with an empty budget, so this always works. It costs the streams on the old
   *    connection, which is why it is the last resort rather than the first move: a connection
   *    that can no longer open a channel is useless anyway, and the alternative measured out to
   *    a node that answers nothing until the person reconnects by hand.
   *
   * @param {string} command
   * @returns {Promise<import('ssh2').Channel>}
   */
  async #openSession(command) {
    for (let attempt = 0; attempt <= CHANNEL_RETRIES; attempt += 1) {
      const client = await this.client()
      try {
        return await new Promise((resolve, reject) => {
          client.exec(command, (error, opened) => {
            if (error) reject(toSshError(error))
            else resolve(opened)
          })
        })
      } catch (error) {
        if (error?.sshCategory !== SSH_FAILURE.CHANNEL) throw error
        if (attempt === CHANNEL_RETRIES) break
        this.target.log?.(
          `ssh: the server's channel budget is full (${error.message}); `
          + `waiting ${String(CHANNEL_BACKOFF_MS)}ms before attempt ${String(attempt + 2)}`,
        )
        await new Promise(resolve => setTimeout(resolve, CHANNEL_BACKOFF_MS * (attempt + 1)))
      }
    }
    // The budget did not free up on this connection. Free it the only way that works.
    //
    // `invalidate()` marks the client as deliberately ended, so the reconnect this triggers is
    // not reported as a drop and does not start the recovery ladder — the node stays `connected`
    // and simply gets a fresh channel budget.
    this.target.log?.(
      `ssh: the channel budget is still full after ${String(CHANNEL_RETRIES + 1)} attempts; `
      + 'reconnecting to get a fresh budget',
    )
    this.invalidate()
    const fresh = await this.client()
    return await new Promise((resolve, reject) => {
      fresh.exec(command, (error, opened) => {
        if (error) reject(toSshError(error))
        else resolve(opened)
      })
    })
  }

  /**
   * Open one direct-tcpip channel to an address reachable from the remote host.
   * @param {string} host - destination as seen from the remote machine.
   * @param {number} port
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ stream: import('node:stream').Duplex, close: () => void }>}
   */
  async forwardOut(host, port, signal) {
    signal?.throwIfAborted()
    let stream
    for (let attempt = 0; attempt <= CHANNEL_RETRIES; attempt += 1) {
      const client = await this.client()
      try {
        stream = await new Promise((resolve, reject) => {
          client.forwardOut('127.0.0.1', 0, host, port, (error, channel) => {
            if (error) reject(toSshError(error))
            else resolve(channel)
          })
        })
        break
      } catch (error) {
        // A forwarded channel is a channel: the same ceiling, the same wait.
        if (error?.sshCategory !== SSH_FAILURE.CHANNEL || attempt === CHANNEL_RETRIES) throw error
        await new Promise(resolve => setTimeout(resolve, CHANNEL_BACKOFF_MS * (attempt + 1)))
      }
    }
    return {
      stream,
      close: () => {
        try { stream.destroy() } catch { /* idempotent */ }
      },
    }
  }

  /** Release the client and every borrowed channel. */
  dispose() {
    this.#closed = true
    this.#sftp = undefined
    const client = this.#client
    this.#client = undefined
    if (client !== undefined) {
      this.target.log?.('ssh: dispose() ends the connection')
      this.#ending.add(client)
      try { client.end() } catch { /* already gone */ }
    }
  }

  /** Drop a dead client so the next call performs a fresh handshake. */
  invalidate() {
    const client = this.#client
    this.#client = undefined
    this.#sftp = undefined
    if (client !== undefined) {
      // Whoever calls this kills every channel on the connection, including a `exec` another
      // step is waiting on. That is intentional for `disconnect()` and for a credential
      // change, but it is invisible in a log, so it is named here.
      this.target.log?.(`ssh: invalidate() drops the connection (${new Error('caller').stack?.split('\n')[2]?.trim() ?? ''})`)
      this.#ending.add(client)
      try { client.end() } catch { /* already gone */ }
    }
  }

  async #connectWithRetry() {
    let lastError
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (this.#closed) throw toSshError(new Error('ssh connection was closed'), SSH_FAILURE.CLOSED)
      try {
        const client = await this.#connectOnce()
        this.#client = client
        return client
      } catch (error) {
        lastError = error
        const category = error?.category ?? classifySshError(error)
        if (!isRetryable(category) || attempt === MAX_RETRIES) throw toSshError(error, category)
        await new Promise(resolve => setTimeout(resolve, BASE_DELAY_MS * 2 ** attempt))
      }
    }
    throw toSshError(lastError)
  }

  /**
   * The one place that reacts to a live client going away.
   *
   * Both `error` and `close` can report the same death, and ssh2 emits `error` first when a
   * socket fails. Two separate handlers therefore raced: whichever ran first cleared
   * `#client`, and the other saw `#client !== client` and returned — so a node could stay
   * `connected` over a socket that was already dead, and every later call failed with a
   * message naming a state the UI never showed.
   *
   * The guard is the client identity, not the event: whichever handler arrives first wins and
   * the other is a no-op. `deliberate` says the close was this object's own doing (see
   * `invalidate()`/`dispose()`), which is never a drop.
   *
   * @param {import('ssh2').Client} client
   * @param {string} reason
   * @param {boolean} [deliberate]
   */
  #onClientGone(client, reason, deliberate = this.#ending.has(client)) {
    if (this.#client !== client) return
    this.#client = undefined
    this.#sftp = undefined
    if (deliberate) return
    this.target.log?.(`ssh: the connection closed on its own (${reason})`)
    this.target.onDrop?.()
  }
  #connectOnce() {
    return new Promise((resolve, reject) => {
      const client = new Client()
      /**
       * Whether this attempt's own host verifier refused.
       *
       * The verifier cannot throw into ssh2's handshake — it answers `verify(false)` and ssh2
       * raises its own generic error — so the decision is recorded here and attached to that
       * error. Per attempt on purpose: a stale refusal must not mark a later, unrelated
       * handshake failure on a reconnect.
       */
      let hostKeyRefused = false
      let settled = false
      const settle = (fn) => {
        if (settled) return
        settled = true
        fn()
      }
      client.once('ready', () => {
        settle(() => {
          client.once('close', hadError => {
            this.#onClientGone(client, `closed, hadError=${String(hadError)}`)
          })
          client.once('error', error => {
            // An error on a live client is a drop: report it here, and mark the client as
            // ended so the `close` that follows does not report the same death again.
            this.#onClientGone(client, `failed: ${error.message}`, false)
            this.#ending.add(client)
            try { client.end() } catch { /* already gone */ }
          })
          resolve(client)
        })
      })
      client.on('error', error => {
        // Before `ready` there is no live connection to report: this is a handshake failure,
        // and rejecting the pending `client()` promise is the whole response.
        //
        // **`settled` matters.** A live client emits `error` too (a channel write can fail),
        // and once `ready` has run this handler is a no-op for the promise — but the `end()`
        // below used to run anyway. That made the open socket go away without being marked as
        // deliberately ended, so the `close` handler reported a **drop** for a connection this
        // process had just killed, and the node went `idle` for no reason while a config sync
        // was in flight. Measured: `plugin-switch` failed on its second POST every time, with
        // the report listing zero nodes. A live client's error is handled by the `error`
        // listener installed inside the `ready` branch.
        if (!settled) {
          try { client.end() } catch { /* already gone */ }
          settle(() => reject(
            // The refusal was this object's own decision (see `hostVerifier`), so it is reported
            // from that decision rather than from ssh2's wording of it.
            hostKeyRefused ? hostKeyRejection(error) : toSshError(error),
          ))
        }
      })
      // Temporary: name the caller whenever this process hangs up. The node's own `auth.log`
      // records `Received disconnect ... :11:` (BY_APPLICATION) for every drop, so the hang-up
      // is local; this says where it came from. Enabled with `RNH_TRACE_SSH=1`.
      if (process.env.RNH_TRACE_SSH === '1') {
        const realEnd = client.end.bind(client)
        client.end = (...args) => {
          this.target.log?.(`ssh: end() from\n${new Error('trace').stack?.split('\n').slice(2, 8).join('\n') ?? ''}`)
          return realEnd(...args)
        }
      }
      client.connect(this.#connectConfig(() => { hostKeyRefused = true }))
    })
  }

  /**
   * @param {() => void} [onHostKeyRefused] - called when the verifier below refuses, so the
   *   handshake failure that follows is reported from that decision instead of from ssh2's
   *   generic message.
   */
  #connectConfig(onHostKeyRefused) {
    const { host, port, username, auth } = this.target
    /** @type {import('ssh2').ConnectConfig} */
    const config = {
      host,
      port,
      username,
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      // The fence a browser deployment gets from a signed cookie, a node gets
      // from the SSH host key: record the first key seen per host:port and
      // refuse a silent change. `undefined` in target.hostFingerprint means this
      // node has never been verified — that is **first use**, not a failure, so the
      // key is recorded and the handshake proceeds. Every later handshake compares.
      //
      // **This callback is the deciding code**, so a refusal is recorded here (see
      // `#connectOnce`). ssh2's own reaction, `Host denied (verification failed)`, is a literal
      // it owns and says nothing; the fingerprint comparison above is what actually happened.
      hostVerifier: (key, verify) => {
        const fingerprint = fingerprintOf(key)
        const expected = this.target.hostFingerprint
        if (expected === undefined) {
          this.target.onFirstFingerprint?.(fingerprint)
          verify(true)
          return
        }
        const accepted = fingerprint === expected
        if (!accepted) {
          onHostKeyRefused?.()
          this.target.onFingerprintMismatch?.(expected, fingerprint)
        }
        verify(accepted)
      },
    }
    if (auth.kind === 'password') {
      if (typeof auth.password !== 'string' || auth.password.length === 0) {
        throw toSshError(new Error('this node has no stored password'), SSH_FAILURE.AUTH)
      }
      config.password = auth.password
    } else if (auth.kind === 'key') {
      if (auth.privateKey === undefined) {
        throw toSshError(new Error('this node has no stored private key'), SSH_FAILURE.AUTH)
      }
      config.privateKey = auth.privateKey
      if (typeof auth.passphrase === 'string' && auth.passphrase.length > 0) config.passphrase = auth.passphrase
    } else {
      config.agent = process.env.SSH_AUTH_SOCK ?? undefined
      if (config.agent === undefined) {
        throw toSshError(new Error('SSH_AUTH_SOCK is not set, so an agent-authenticated node cannot connect'), SSH_FAILURE.AUTH)
      }
    }
    return config
  }
}

/** sha256 of the host key in OpenSSH's colon-separated hex form. */
export function fingerprintOf(key) {
  const digest = createHash('sha256').update(key).digest('hex')
  return digest.match(/.{2}/gu)?.join(':') ?? digest
}

/**
 * Join one argv vector into a POSIX command line, quoting every token.
 * @param {readonly string[]} argv
 * @param {string} [cwd]
 */
export function posixCommand(argv, cwd) {
  if (argv.length === 0) throw new Error('rnh: an exec needs at least one argv element')
  const quoted = argv.map(quotePosixArgument).join(' ')
  return cwd === undefined ? quoted : `cd ${quotePosixArgument(cwd)} && exec ${quoted}`
}

/** Quote one token for a POSIX shell. */
export function quotePosixArgument(value) {
  if (value.length === 0) return "''"
  if (/^[\w@%+=:,./-]+$/u.test(value)) return value
  return `'${value.replaceAll("'", `'\\''`)}'`
}
