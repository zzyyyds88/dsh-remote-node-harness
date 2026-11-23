/**
 * `host/ws-frame.js` — the pure RFC 6455 codec, table-driven.
 *
 * Everything here is offline: no socket, no SSH, no Host. The point is the three
 * families of defect the codec replaced:
 *
 *   - **a damaged control frame**: the old encoder wrote `0x80 | length` into one
 *     byte, so a 126-byte PONG went out declaring a different length entirely. The
 *     peer then died with nothing on either side to explain it. Encoding refuses now.
 *   - **fragmentation silently decoded as whole messages**: each fragment was handed
 *     to the Gateway as text, so a fragmented JSON frame arrived as two half documents
 *     and was dropped without a trace. Decoding refuses `unsupported-fragmentation`.
 *   - **an unbounded buffer**: nothing counted retained bytes, so a peer could grow
 *     the buffer without ever completing a frame.
 *
 * The RFC 6455 §5.7 examples are asserted verbatim, because a codec that agrees only
 * with itself is not a codec.
 *
 * Usage: node test/ws-frame-unit.mjs
 */
import {
  CONTROL_MAX_PAYLOAD,
  DEFAULT_MAX_BUFFER_BYTES,
  DEFAULT_MAX_FRAME_BYTES,
  FRAGMENTATION_CODE,
  OPCODE,
  decodeFrames,
  encodeFrame,
} from '../src/host/ws-frame.js'

const log = message => process.stderr.write(`[ws-frame-unit] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/** A payload of `length` bytes whose every byte is derivable, so a corruption shows. */
const payloadOf = length => Buffer.alloc(length, 0x61)

/** Join several chunks the way a stream delivers them. */
const join = (...chunks) => Buffer.concat(chunks)

// ---- 1. the constants are the protocol's, not local taste ------------------
check(CONTROL_MAX_PAYLOAD === 125, 'a control frame payload is capped at 125 by RFC 6455 §5.5', String(CONTROL_MAX_PAYLOAD))
check(DEFAULT_MAX_FRAME_BYTES === 64 * 1024 * 1024, 'the frame budget is 64 MiB', String(DEFAULT_MAX_FRAME_BYTES))
check(DEFAULT_MAX_BUFFER_BYTES === 64 * 1024 * 1024, 'the retained-buffer budget is 64 MiB', String(DEFAULT_MAX_BUFFER_BYTES))

// ---- 2. round trip across every length branch -----------------------------
// 125 is the largest 7-bit length; 126 and 65535 are the 16-bit branch's ends; 65536
// is where the 64-bit branch begins. Nothing here may lose or reshape a byte.
const LENGTHS = [
  [0, 'the empty payload (7-bit length branch)'],
  [1, 'a one-byte payload'],
  [125, 'the largest 7-bit length'],
  [126, 'the first 16-bit length'],
  [65_535, 'the largest 16-bit length'],
  [65_536, 'the first 64-bit length'],
  [1_048_576, 'a one-megabyte payload'],
]
for (const [length, label] of LENGTHS) {
  for (const mask of [true, false]) {
    const payload = payloadOf(length)
    const encoded = encodeFrame(OPCODE.BINARY, payload, { mask })
    const { frames, rest } = decodeFrames(encoded)
    const frame = frames[0]
    check(frames.length === 1 && rest.length === 0,
      `${label}${mask ? '' : ', unmasked'}: one whole frame and nothing left`,
      `${String(frames.length)} frames, ${String(rest.length)} bytes left`)
    check(frame?.fin === true, `${label}, ${mask ? 'masked' : 'unmasked'}: FIN is set`)
    check(frame?.opcode === OPCODE.BINARY, `${label}, ${mask ? 'masked' : 'unmasked'}: the opcode survives`, String(frame?.opcode))
    check(frame?.payload.length === length && Buffer.compare(frame.payload, payload) === 0,
      `${label}, ${mask ? 'masked' : 'unmasked'}: the payload is byte-identical`, String(frame?.payload.length))
  }
}

// ---- 3. the header bits are where the RFC puts them -----------------------
// A hand-written expectation, not this module's own encoder talking to itself.
{
  const text = encodeFrame(OPCODE.TEXT, Buffer.from('Hello'), { mask: false })
  check(text.toString('hex') === '810548656c6c6f', 'RFC 6455 §5.7 "Hello" encodes to 81 05 48 65 6c 6c 6f', text.toString('hex'))

  // Masked: the mask bit is set, the key is four bytes, and the body is XOR-ed with it.
  const masked = encodeFrame(OPCODE.TEXT, Buffer.from('Hello'))
  check(masked[1] === 0x85, 'a masked 5-byte frame sets the mask bit and keeps the length', masked[1].toString(16))
  check(masked.length === 2 + 4 + 5, 'a masked frame carries a four-byte key', String(masked.length))
  const key = masked.subarray(2, 6)
  const body = masked.subarray(6)
  const unmasked = Buffer.from([...body].map((byte, index) => byte ^ key[index % 4]))
  check(unmasked.toString('utf8') === 'Hello', 'the body XORs back with the frame\'s own key', unmasked.toString('utf8'))

  // 16-bit branch header: opcode+len byte, then the mask bit, then a big-endian length.
  const mid = encodeFrame(OPCODE.BINARY, payloadOf(300), { mask: false })
  check(mid[1] === 126 && mid.readUInt16BE(2) === 300, 'a 300-byte frame uses the 16-bit length branch',
    `${String(mid[1])}/${String(mid.readUInt16BE(2))}`)
  const wide = encodeFrame(OPCODE.BINARY, payloadOf(70_000), { mask: false })
  check(wide[1] === 127 && wide.readBigUInt64BE(2) === BigInt(70_000), 'a 70 000-byte frame uses the 64-bit branch',
    `${String(wide[1])}/${wide.readBigUInt64BE(2).toString()}`)
}

// ---- 4. a control frame that cannot be encoded is refused, not damaged ----
// This is the F4 fix. The old code produced a frame; the interesting fact is that
// `0x80 | 126` is 254, which the receiver reads as "mask bit set, length 126", i.e. it
// then consumes two length bytes that are actually the mask key.
{
  let refused
  try { encodeFrame(OPCODE.PONG, payloadOf(126)) } catch (error) { refused = error }
  check(refused !== undefined, 'a 126-byte control frame is refused rather than emitted damaged',
    refused === undefined ? 'no error thrown' : undefined)
  check(refused?.code === 'ws/control-too-large', 'and the refusal names the reason', String(refused?.code))

  const allowed = encodeFrame(OPCODE.PONG, payloadOf(125))
  check(allowed.length === 2 + 4 + 125, 'a 125-byte control frame is still allowed', String(allowed.length))
  const empty = encodeFrame(OPCODE.CLOSE, Buffer.alloc(0))
  check(empty.length === 6, 'an empty control frame is a header plus a mask key', String(empty.length))

  // Data frames have no such ceiling: only the transport budget bounds them.
  let dataThrew
  try { encodeFrame(OPCODE.TEXT, payloadOf(200)) } catch (error) { dataThrew = error }
  check(dataThrew === undefined, 'a 200-byte text frame is not a control frame and is allowed', dataThrew?.message)
}

// ---- 5. fragmentation and RSV are refused by name -------------------------
/** One frame's header bytes, assembled by hand so the encoder cannot be blamed. */
const header = (first, second, extra = Buffer.alloc(0)) => Buffer.concat([Buffer.from([first, second]), extra])

{
  // A continuation frame (opcode 0x0), FIN set: the old decoder treated it as a whole
  // message whose opcode matched nothing and silently dropped it.
  const continuation = join(header(0x80, 0x02), Buffer.from('ab'))
  let contError
  try { decodeFrames(continuation) } catch (error) { contError = error }
  check(contError?.code === FRAGMENTATION_CODE, 'a continuation frame is refused as unsupported fragmentation', String(contError?.code))

  // A first fragment: FIN clear on a text frame. Half a message is not a message.
  const firstFragment = join(header(0x01, 0x02), Buffer.from('ab'))
  let fragError
  try { decodeFrames(firstFragment) } catch (error) { fragError = error }
  check(fragError?.code === FRAGMENTATION_CODE, 'a FIN-clear text frame is refused as unsupported fragmentation', String(fragError?.code))

  // RSV1 set: something was negotiated that this client never asked for.
  const reserved = join(header(0xc1, 0x02), Buffer.from('ab'))
  let rsvError
  try { decodeFrames(reserved) } catch (error) { rsvError = error }
  check(rsvError?.code === FRAGMENTATION_CODE, 'a reserved bit is refused with the same code', String(rsvError?.code))

  // The refusal must be a *throw with a code*, not a silent truncation: the whole point
  // is that the caller can tell this apart from an ordinary end of stream.
  check(contError instanceof Error && typeof contError.message === 'string' && contError.message.length > 0,
    'the refusal is a real Error with a message', contError?.message)
}

// ---- 6. an incomplete frame is retained, never guessed -------------------
// RFC 6455 §5.7: the same "Hello" frame split across two reads is one frame, and this
// is the case the old per-fragment `onText` broke.
{
  const whole = encodeFrame(OPCODE.TEXT, Buffer.from('Hello'), { mask: false })
  const first = decodeFrames(whole.subarray(0, 3))
  check(first.frames.length === 0, 'a partial frame yields no frame', String(first.frames.length))
  check(first.rest.length === 3, 'and the bytes are handed back as rest', String(first.rest.length))
  const second = decodeFrames(join(first.rest, whole.subarray(3)))
  check(second.frames.length === 1 && second.frames[0].payload.toString('utf8') === 'Hello',
    'the rest plus the next chunk decodes to the whole message',
    second.frames[0]?.payload.toString('utf8'))
  check(second.rest.length === 0, 'with nothing left over', String(second.rest.length))

  // Two frames in one chunk both come out, in order.
  const pair = join(
    encodeFrame(OPCODE.TEXT, Buffer.from('one'), { mask: false }),
    encodeFrame(OPCODE.TEXT, Buffer.from('two'), { mask: false }),
  )
  const both = decodeFrames(pair)
  check(both.frames.length === 2, 'two frames in one read both decode', String(both.frames.length))
  check(both.frames[0]?.payload.toString('utf8') === 'one' && both.frames[1]?.payload.toString('utf8') === 'two',
    'in the order they arrived')

  // A header split mid-length-field must not be misread.
  const wideFrame = encodeFrame(OPCODE.BINARY, payloadOf(300), { mask: false })
  const headerOnly = decodeFrames(wideFrame.subarray(0, 3))
  check(headerOnly.frames.length === 0 && headerOnly.rest.length === 3,
    'a truncated 16-bit length header waits for more bytes', String(headerOnly.rest.length))
}

// ---- 7. bounds: per frame, and retained bytes ----------------------------
{
  // Per-frame: a declared 64-bit length over the budget is refused *before* buffering.
  const declared = Buffer.alloc(10)
  declared[0] = 0x82
  declared[1] = 127
  declared.writeBigUInt64BE(BigInt(DEFAULT_MAX_FRAME_BYTES + 1), 2)
  let frameError
  try { decodeFrames(declared) } catch (error) { frameError = error }
  check(frameError?.code === 'ws/frame-too-large', 'a frame declared over the budget is refused', String(frameError?.code))

  // A 16-bit-declared frame over a caller's smaller budget is refused too.
  const midDeclared = Buffer.from([0x82, 126, 0x01, 0x2c]) // 300 bytes
  let smallBudgetError
  try { decodeFrames(midDeclared, { maxFrameBytes: 100 }) } catch (error) { smallBudgetError = error }
  check(smallBudgetError?.code === 'ws/frame-too-large', 'so is a 16-bit one over a caller\'s budget', String(smallBudgetError?.code))

  // Retained bytes: a frame whose length is never satisfied keeps its bytes in the
  // buffer, so the buffer itself needs a ceiling. 100 bytes of headroom is enough to
  // prove the shape: the first two chunks fit, the third does not.
  {
    const trickleHeader = Buffer.concat([Buffer.from([0x82, 126]), Buffer.from([0x7f, 0xff])]) // declares 32767
    let retained = decodeFrames(trickleHeader, { maxBufferBytes: 100 })
    retained = decodeFrames(join(retained.rest, payloadOf(60)), { maxBufferBytes: 100 })
    check(retained.frames.length === 0 && retained.rest.length === 64,
      'an incomplete frame keeps its bytes in the buffer', String(retained.rest.length))
    let bufferError
    try {
      decodeFrames(join(retained.rest, payloadOf(60)), { maxBufferBytes: 100 })
    } catch (error) {
      bufferError = error
    }
    check(bufferError?.code === 'ws/buffer-too-large',
      'retained bytes over the buffer budget are refused', String(bufferError?.code))
    check(bufferError !== undefined, 'the buffer budget is enforced even when no frame completed')
  }

  // The default budget is not so small that a legitimate large frame trips it.
  const large = encodeFrame(OPCODE.BINARY, payloadOf(2_000_000), { mask: false })
  const largeDecoded = decodeFrames(large)
  check(largeDecoded.frames[0]?.payload.length === 2_000_000,
    'a two-megabyte frame passes the default budgets', String(largeDecoded.frames[0]?.payload.length))
}

// ---- 8. a masked server frame decodes (the client never sends one) -------
// The client speaks masked frames and the server unmasked, but decoding both is what
// lets a test round-trip. Refusing here would be a policy this layer has no business
// holding: the mask is removed either way.
{
  const masked = encodeFrame(OPCODE.TEXT, Buffer.from('server'), { mask: true })
  const decoded = decodeFrames(masked)
  check(decoded.frames[0]?.payload.toString('utf8') === 'server',
    'a masked frame decodes by removing its key', decoded.frames[0]?.payload.toString('utf8'))
}

// ---- 9. the client built on this codec: PONG truncation, refusal, logging --
// The codec is pure, but three fixes only exist in the stateful client, and each one is
// the difference between a silent failure and an observable one.
{
  const { Duplex } = await import('node:stream')
  const { WebSocketClient } = await import('../src/host/ws.js')

  /** A duplex that records what the client wrote and lets frames be pushed in. */
  const fakeStream = () => {
    const written = []
    const stream = new Duplex({
      read() {},
      write(chunk, _encoding, callback) { written.push(Buffer.from(chunk)); callback() },
      final(callback) { callback() },
    })
    return { stream, written }
  }

  // A PING may carry up to 125 bytes and a PONG may carry no more, so a 130-byte PING
  // cannot be echoed faithfully. The echo is truncated to the legal maximum; the old code
  // would have written a control frame whose length byte was a different number entirely.
  {
    const { stream, written } = fakeStream()
    const closes = []
    const logs = []
    const client = new WebSocketClient(stream, {
      onText: () => { throw new Error('a PING is not text') },
      onClose: reason => closes.push(reason),
    }, { log: message => logs.push(message) })

    const oversizedPing = Buffer.concat([
      Buffer.from([0x89, 126]),
      Buffer.from([0x00, 130]),
      payloadOf(130),
    ])
    stream.push(oversizedPing)
    await new Promise(resolve => setImmediate(resolve))
    const pong = written.find(frame => (frame[0] & 0x0f) === 0x0a)
    check(pong !== undefined, 'a PING is answered with a PONG', String(written.length))
    check(pong !== undefined && pong[1] === (0x80 | 125), 'the PONG declares 125 bytes, not a corrupted length',
      pong === undefined ? undefined : String(pong[1]))
    check(pong !== undefined && pong.length === 2 + 4 + 125, 'and carries exactly 125 bytes', String(pong?.length))
    check(closes.length === 0, 'the carrier is not torn down over a frame the peer should not have sent')
    client.close()
  }

  // A fragmented message is refused by name and *ends the carrier*: the old client fed
  // each fragment to `onText`, the Gateway discarded the half JSON silently, and the node
  // looked like it had no events.
  {
    const { stream } = fakeStream()
    const texts = []
    const closes = []
    const logs = []
    const client = new WebSocketClient(stream, {
      onText: text => texts.push(text),
      onClose: reason => closes.push(reason),
    }, { log: message => logs.push(message) })
    // FIN clear on a text frame: the first fragment of a fragmented message.
    stream.push(Buffer.concat([Buffer.from([0x01, 0x02]), Buffer.from('ab')]))
    await new Promise(resolve => setImmediate(resolve))
    check(texts.length === 0, 'a fragment is never handed to onText, so no half JSON is parsed', String(texts.length))
    check(closes.length === 1 && /fragment/iu.test(closes[0] ?? ''),
      'the carrier is closed with a reason naming fragmentation', String(closes[0]))
    check(logs.some(line => /fragment/iu.test(line)), 'and the reason is logged, not swallowed', logs.join(' | '))
  }

  // A listener that throws is the caller's bug, but it must leave a trace: it used to be
  // an empty `catch {}`, so a broken frame router looked like a node that sent nothing.
  {
    const { stream } = fakeStream()
    const logs = []
    let calls = 0
    const client = new WebSocketClient(stream, {
      onText: () => {
        calls += 1
        throw new Error('the router exploded')
      },
      onClose: () => {},
    }, { log: message => logs.push(message) })
    stream.push(encodeFrame(OPCODE.TEXT, Buffer.from('{}'), { mask: false }))
    await new Promise(resolve => setImmediate(resolve))
    check(calls === 1, 'the listener ran', String(calls))
    check(logs.some(line => line.includes('the router exploded')),
      'a throwing listener is logged instead of vanishing', logs.join(' | '))
    check(client.closed === false, 'and does not take the carrier down', String(client.closed))
    client.close()
  }
}

if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
  process.exitCode = 0
}
