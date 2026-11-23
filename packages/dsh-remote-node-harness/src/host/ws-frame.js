/**
 * RFC 6455 frame codec, as pure functions.
 *
 * The carrier client (`ws.js`) owns a duplex stream and the handshake; this module
 * owns the bytes. Keeping the codec state-free is what makes the boundaries
 * testable offline — every length branch, both mask directions, and the three
 * protocol violations the client refuses can be asserted without a socket.
 *
 * The client speaks the *client* half of the protocol: it sends masked frames and
 * receives unmasked ones. Decoding still accepts both, because a test that
 * round-trips an encoded frame must not depend on the mask having been stripped,
 * and because refusing a masked server frame is a connection-fatal detail this
 * layer has no reason to own.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/ws-frame
 */
import { randomBytes } from 'node:crypto'

/** Opcode table. Continuation (0x0) exists only so it can be *named* in a refusal. */
export const OPCODE = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
})

/**
 * The largest payload a control frame may carry (RFC 6455 §5.5).
 *
 * A control frame's length shares its byte with the mask bit, so the old encoder
 * wrote `0x80 | length` and, for length ≥126, produced a frame whose length field
 * said something entirely different — an interop bug that only appears on the
 * receiving side. Encoding refuses instead. Decoding tolerates an oversized control
 * frame (the client truncates its PONG echo rather than tear the carrier down).
 */
export const CONTROL_MAX_PAYLOAD = 125

/** A single frame larger than this is refused rather than buffered. */
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024

/**
 * Retained bytes are bounded too.
 *
 * A single frame may legitimately fill the whole frame budget, so the accumulated
 * buffer needs its own ceiling: without one, a peer that sends a length header and
 * then trickles bytes forever grows `Buffer.concat` until the desktop runs out of
 * memory, long before the per-frame check can fire.
 */
export const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024

/**
 * The largest RFC 6455 header: 2 bytes plus the 8-byte extended length and a 4-byte
 * mask key. A buffer budget counts payload, so a fully-buffered frame that is legal
 * under the frame budget may legitimately retain this many bytes more.
 */
const FRAME_HEADER_MAX = 14

/** Error code for a frame this client cannot read without inventing a message. */
export const FRAGMENTATION_CODE = 'unsupported-fragmentation'

const codedError = (code, message) => Object.assign(new Error(message), { code })

/**
 * Encode one unfragmented frame.
 *
 * `fin` is always set: this client only ever sends whole messages. Control frames
 * are length-checked first, because a damaged frame on the wire is worse than a
 * local throw — the peer parses it as a different length and the connection dies
 * with no explanation on either side.
 *
 * @param {number} opcode
 * @param {Buffer | Uint8Array | string} payload
 * @param {{ mask?: boolean }} [options] - mask defaults to true, as a client must.
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload, options = {}) {
  const mask = options.mask ?? true
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  if (opcode >= 0x8 && body.length > CONTROL_MAX_PAYLOAD) {
    throw codedError(
      'ws/control-too-large',
      `a control frame payload must be at most ${String(CONTROL_MAX_PAYLOAD)} bytes; got ${String(body.length)}`,
    )
  }
  // The mask bit shares the length byte, so the header is built after the mask
  // decision is known, never by OR-ing a length into a fixed byte.
  let header
  if (body.length < 126) {
    header = Buffer.alloc(2)
    header[0] = 0x80 | opcode
    header[1] = (mask ? 0x80 : 0) | body.length
  } else if (body.length < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = (mask ? 0x80 : 0) | 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = (mask ? 0x80 : 0) | 127
    header.writeBigUInt64BE(BigInt(body.length), 2)
  }
  if (!mask) return Buffer.concat([header, body])
  const maskKey = randomBytes(4)
  const masked = Buffer.allocUnsafe(body.length)
  for (let index = 0; index < body.length; index += 1) masked[index] = body[index] ^ maskKey[index % 4]
  return Buffer.concat([header, maskKey, masked])
}

/**
 * Decode every complete frame at the front of `buffer`.
 *
 * Pure: the caller keeps `rest` and passes it back with the next chunk. Three
 * things are refused with `code: 'unsupported-fragmentation'` — a continuation
 * frame, RSV bits, and a frame without FIN — because the alternative is the bug
 * this module replaces: treating each fragment as a whole message handed the
 * Gateway half a JSON document, which it then discarded without a trace.
 *
 * @param {Buffer} buffer
 * @param {{ maxFrameBytes?: number, maxBufferBytes?: number }} [options]
 * @returns {{ frames: Array<{ fin: boolean, opcode: number, payload: Buffer }>, rest: Buffer }}
 */
export function decodeFrames(buffer, options = {}) {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES
  /** @type {Array<{ fin: boolean, opcode: number, payload: Buffer }>} */
  const frames = []
  let offset = 0
  for (;;) {
    const available = buffer.length - offset
    if (available < 2) break
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const fin = (first & 0x80) !== 0
    const rsv = first & 0x70
    const opcode = first & 0x0f
    if (opcode === OPCODE.CONTINUATION) {
      throw codedError(
        FRAGMENTATION_CODE,
        'the carrier sent a continuation frame; this client decodes unfragmented messages only',
      )
    }
    if (rsv !== 0) {
      throw codedError(FRAGMENTATION_CODE, `the carrier set reserved bits (0x${rsv.toString(16)}) this client does not negotiate`)
    }
    if (!fin) {
      throw codedError(
        FRAGMENTATION_CODE,
        'the carrier began a fragmented message; this client decodes unfragmented messages only',
      )
    }
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let headerEnd = offset + 2
    if (length === 126) {
      if (available < 4) break
      length = buffer.readUInt16BE(offset + 2)
      headerEnd = offset + 4
    } else if (length === 127) {
      if (available < 10) break
      const wide = buffer.readBigUInt64BE(offset + 2)
      // Compare in BigInt space: converting first would lose precision above
      // 2^53 and could turn a huge declared length into a small in-range one.
      if (wide > BigInt(maxFrameBytes)) {
        throw codedError('ws/frame-too-large', `the carrier declared a ${wide.toString()} byte frame; the limit is ${String(maxFrameBytes)}`)
      }
      length = Number(wide)
      headerEnd = offset + 10
    }
    if (length > maxFrameBytes) {
      throw codedError('ws/frame-too-large', `the carrier declared a ${String(length)} byte frame; the limit is ${String(maxFrameBytes)}`)
    }
    const maskBytes = masked ? 4 : 0
    const frameEnd = headerEnd + maskBytes + length
    if (buffer.length < frameEnd) break
    let payload = buffer.subarray(headerEnd + maskBytes, frameEnd)
    if (masked) {
      const maskKey = buffer.subarray(headerEnd, headerEnd + 4)
      const unmasked = Buffer.allocUnsafe(length)
      for (let index = 0; index < length; index += 1) unmasked[index] = payload[index] ^ maskKey[index % 4]
      payload = unmasked
    }
    frames.push({ fin, opcode, payload })
    offset = frameEnd
  }
  const rest = offset === 0 ? buffer : buffer.subarray(offset)
  // The allowance is for one frame's header: a frame exactly at the payload budget needs
  // its header buffered before the frame can complete, and refusing that would make the
  // frame budget unreachable by exactly fourteen bytes.
  if (rest.length > maxBufferBytes + FRAME_HEADER_MAX) {
    throw codedError(
      'ws/buffer-too-large',
      `the carrier left ${String(rest.length)} unparsed bytes buffered; the limit is ${String(maxBufferBytes)}`,
    )
  }
  return { frames, rest }
}
