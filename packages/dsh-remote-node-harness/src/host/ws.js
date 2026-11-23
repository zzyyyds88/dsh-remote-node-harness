/**
 * Minimal RFC 6455 client over an arbitrary duplex stream.
 *
 * The remote Host's stream carrier (`/api/remote.mux`) is reachable only through
 * an SSH `direct-tcpip` channel, so there is no `WebSocket` global to use: Node's
 * built-in client insists on owning a TCP socket. This module implements just
 * enough of the protocol for the carrier — text frames, ping/pong, close — and
 * nothing else. No extensions, no fragmentation on send, no permessage-deflate.
 *
 * Frame encoding and decoding live in `ws-frame.js` as pure functions; what stays
 * here is the state a live connection has: the stream, the handler pair, the
 * partial frame buffer, and the single terminal event.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/ws
 */
import { randomBytes } from 'node:crypto'
import {
  CONTROL_MAX_PAYLOAD,
  DEFAULT_MAX_BUFFER_BYTES,
  DEFAULT_MAX_FRAME_BYTES,
  OPCODE,
  decodeFrames,
  encodeFrame,
} from './ws-frame.js'

/** Close-frame payload: 1000 (normal closure), two bytes big-endian. */
const CLOSE_NORMAL = Buffer.from([0x03, 0xe8])

/**
 * A live carrier connection.
 *
 * `onText` receives every complete text frame; `onClose` receives the single
 * terminal event. Callers own the underlying stream and close it through
 * {@link WebSocketClient#close}.
 */
export class WebSocketClient {
  /**
   * @param {import('node:stream').Duplex} stream - an already-upgraded duplex.
   * @param {{ onText: (text: string) => void, onClose: (reason?: string) => void }} handlers
   * @param {{ log?: (message: string) => void, maxFrameBytes?: number, maxBufferBytes?: number }} [options]
   */
  constructor(stream, handlers, options = {}) {
    this.stream = stream
    this.handlers = handlers
    this.log = options.log ?? (() => {})
    this.closed = false
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES
    /** @type {Buffer} */
    this.buffer = Buffer.alloc(0)
    this.onData = chunk => this.#consume(chunk)
    this.onStreamClose = () => this.#finish('the carrier stream closed')
    this.onStreamError = error => this.#finish(error instanceof Error ? error.message : String(error))
    stream.on('data', this.onData)
    stream.on('close', this.onStreamClose)
    stream.on('error', this.onStreamError)
  }

  /**
   * Send one text frame. A closed socket drops the write instead of throwing, and an
   * encoding refusal is reported on the same path: `encodeFrame` throws only for a frame
   * this client would have emitted damaged, and continuing to the next frame is the
   * caller's decision, not this one's.
   */
  send(text) {
    if (this.closed) return false
    try {
      this.stream.write(encodeFrame(OPCODE.TEXT, text))
      return true
    } catch {
      this.#finish('the carrier write failed')
      return false
    }
  }

  /** Send a close frame and destroy the stream. */
  close() {
    if (this.closed) return
    try { this.stream.write(encodeFrame(OPCODE.CLOSE, CLOSE_NORMAL)) } catch { /* closing anyway */ }
    this.#finish('closed by this plugin')
  }

  #finish(reason) {
    if (this.closed) return
    this.closed = true
    this.stream.off('data', this.onData)
    this.stream.off('close', this.onStreamClose)
    this.stream.off('error', this.onStreamError)
    try { this.stream.destroy() } catch { /* already gone */ }
    try { this.handlers.onClose(reason) } catch { /* a listener must not break teardown */ }
  }

  /**
   * Parse as many complete frames as the buffer holds.
   *
   * Both limits are enforced by `decodeFrames`: a declared frame over the per-frame
   * budget, and retained bytes over the buffer budget. The second one is the reason the
   * old code could be driven out of memory — it concatenated first and checked later, so a
   * peer that announced a huge length and then trickled bytes grew the buffer forever.
   */
  #consume(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    let decoded
    try {
      decoded = decodeFrames(this.buffer, {
        maxFrameBytes: this.maxFrameBytes,
        maxBufferBytes: this.maxBufferBytes,
      })
    } catch (error) {
      // A protocol violation is terminal, and the reason has to say which one: a
      // fragmented message used to arrive here as half a JSON document that the
      // Gateway silently dropped, which reads as "the node has no events".
      this.log(`ws: ${error instanceof Error ? error.message : String(error)}`)
      this.#finish(error instanceof Error ? error.message : String(error))
      return
    }
    this.buffer = decoded.rest
    for (const frame of decoded.frames) {
      if (frame.opcode === OPCODE.TEXT) {
        try {
          this.handlers.onText(frame.payload.toString('utf8'))
        } catch (error) {
          // The listener is the caller's code; a throw there used to leave no trace at
          // all, so a failing frame router looked like a node that sent nothing.
          this.log(`ws: a text listener threw: ${error instanceof Error ? error.message : String(error)}`)
        }
      } else if (frame.opcode === OPCODE.PING) {
        // RFC 6455 §5.5.3 requires the PONG to echo the PING payload. A PING may carry up
        // to 125 bytes and a PONG may carry no more, so an oversized PING cannot be echoed
        // faithfully; the spec's answer is to fail the connection. Truncating is the lesser
        // evil here: the echo still proves liveness, whereas failing would drop a working
        // carrier over a frame the peer should not have sent.
        const echo = frame.payload.length > CONTROL_MAX_PAYLOAD
          ? frame.payload.subarray(0, CONTROL_MAX_PAYLOAD)
          : frame.payload
        try { this.stream.write(encodeFrame(OPCODE.PONG, echo)) } catch { /* closing */ }
      } else if (frame.opcode === OPCODE.CLOSE) {
        this.#finish('the carrier closed')
        return
      }
    }
  }
}

/**
 * Perform a WebSocket upgrade over one duplex and hand back the live client.
 * @param {import('node:stream').Duplex} stream
 * @param {{ host: string, path: string, origin: string, cookie?: string, headers?: Record<string, string>, connectTimeoutMs?: number, log?: (message: string) => void, maxFrameBytes?: number, maxBufferBytes?: number }} options
 * @param {{ onText: (text: string) => void, onClose: (reason?: string) => void }} handlers
 * @returns {Promise<WebSocketClient>}
 */
export function upgradeWebSocket(stream, options, handlers) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    let head = Buffer.alloc(0)
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`the stream carrier did not answer within ${String(options.connectTimeoutMs ?? 20_000)} ms`))
    }, options.connectTimeoutMs ?? 20_000)
    timeout.unref?.()

    const cleanup = () => {
      clearTimeout(timeout)
      stream.off('data', onData)
      stream.off('error', onError)
      stream.off('close', onClose)
    }
    const fail = error => {
      if (settled) return
      settled = true
      cleanup()
      try { stream.destroy() } catch { /* already gone */ }
      reject(error)
    }
    const onError = error => fail(error instanceof Error ? error : new Error(String(error)))
    const onClose = () => fail(new Error('the carrier stream closed before the upgrade completed'))
    const onData = chunk => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) {
        if (head.length > 64 * 1024) fail(new Error('the carrier sent an oversized upgrade response'))
        return
      }
      const text = head.subarray(0, end).toString('utf8')
      const status = /^HTTP\/1\.1 (\d{3})/u.exec(text)
      if (status === null) return fail(new Error('the carrier sent a malformed upgrade response'))
      if (status[1] !== '101') {
        // The status travels with the error: an upgrade refused with 401 is the ordinary
        // way a restarted resident host answers with a cookie minted by the previous one,
        // and the caller can only tell that case apart if it knows the number.
        return fail(Object.assign(new Error(`the carrier refused the upgrade with HTTP ${status[1]}`), {
          status: Number(status[1]),
        }))
      }
      if (!/^upgrade:\s*websocket$/imu.test(text)) {
        return fail(new Error('the carrier answered 101 without a WebSocket upgrade'))
      }
      settled = true
      cleanup()
      const client = new WebSocketClient(stream, handlers, {
        log: options.log,
        maxFrameBytes: options.maxFrameBytes,
        maxBufferBytes: options.maxBufferBytes,
      })
      const rest = head.subarray(end + 4)
      resolve(client)
      if (rest.length > 0) stream.emit('data', rest)
    }

    stream.on('data', onData)
    stream.on('error', onError)
    stream.on('close', onClose)
    const lines = [
      `GET ${options.path} HTTP/1.1`,
      `Host: ${options.host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${key}`,
      `Origin: ${options.origin}`,
    ]
    if (options.cookie !== undefined && options.cookie.length > 0) lines.push(`Cookie: ${options.cookie}`)
    for (const [name, value] of Object.entries(options.headers ?? {})) lines.push(`${name}: ${value}`)
    try {
      stream.write(`${lines.join('\r\n')}\r\n\r\n`)
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
