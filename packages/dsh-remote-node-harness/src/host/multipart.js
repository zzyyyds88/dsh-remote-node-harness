/**
 * Decode the Gateway's `multipart/form-data` answer into the value it stands for.
 *
 * A unary endpoint whose result contains bytes cannot travel as JSON: the Gateway
 * replaces every `Uint8Array` with `null`, records its JSON path, and ships the
 * bytes as a separate multipart part:
 *
 * ```
 * metadata   {"type":"server-response","rpcId":"…","result":{"ok":true,"value":{…}},
 *             "attachments":[{"path":["content"],"codec":"bytes","part":"bytes-0"}]}
 * bytes-0    <raw bytes>
 * ```
 *
 * A client that only JSON-parses sees `HTTP 200` with an unparseable body. That is
 * easy to misread as a broken node, so this module exists to make the distinction
 * explicit: `workspaceFiles/readBytes` (an image preview, a PDF, any binary file)
 * answers this way, and every one of those has to work on a remote workspace.
 *
 * @module @greatbaby/dsh-remote-node-harness/host/multipart
 */

/** The subset of an HTTP response this decoder needs. */
const BOUNDARY_PATTERN = /boundary=(?:"([^"]+)"|([^;]+))/iu

/**
 * How many parts one answer may carry.
 *
 * The Gateway writes one metadata part plus one part per byte attachment, so the
 * count is bounded by the attachments of a single result. Anything past this is not
 * a result this client produced, and decoding it costs one buffer per part.
 */
export const DEFAULT_MAX_PARTS = 64

/**
 * How many bytes each part may carry — and, therefore, how many the whole body may.
 *
 * The same ceiling as the response body itself (`httpOverSsh`'s
 * `DEFAULT_MAX_RESPONSE_BYTES`), stated here too because this function is also
 * reachable with a body a caller read some other way. A part larger than the whole
 * body can be is a corrupt answer, not a large one.
 */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024

const codedError = (code, message) => Object.assign(new Error(message), { code })

/**
 * Split one multipart body into its raw parts.
 * @param {Buffer} body
 * @param {string} boundary
 * @param {{ maxParts?: number, maxBytes?: number }} [options]
 * @returns {Array<{ name: string, body: Buffer }>}
 */
function splitParts(body, boundary, options = {}) {
  const maxParts = options.maxParts ?? DEFAULT_MAX_PARTS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const delimiter = Buffer.from(`--${boundary}`, 'latin1')
  const parts = []
  /** Summed across every part: one huge part and many medium ones are the same risk. */
  let total = 0
  let cursor = body.indexOf(delimiter)
  if (cursor === -1) return parts
  cursor += delimiter.length
  for (;;) {
    // `--` right after a delimiter closes the body.
    if (body.subarray(cursor, cursor + 2).toString('latin1') === '--') break
    // Skip the CRLF that follows the delimiter, then find the header terminator.
    if (body.subarray(cursor, cursor + 2).toString('latin1') === '\r\n') cursor += 2
    const headerEnd = body.indexOf('\r\n\r\n', cursor, 'latin1')
    if (headerEnd === -1) break
    const headers = body.subarray(cursor, headerEnd).toString('latin1')
    const start = headerEnd + 4
    const next = body.indexOf(delimiter, start, 'latin1')
    if (next === -1) break
    // The CRLF before the next delimiter belongs to the delimiter, not the body.
    const end = next >= 2 && body.subarray(next - 2, next).toString('latin1') === '\r\n' ? next - 2 : next
    const name = /name="([^"]*)"/iu.exec(headers)?.[1]
    const size = end - start
    if (size > maxBytes) {
      throw codedError(
        'rnh/too-large',
        `a multipart part is ${String(size)} bytes; the limit is ${String(maxBytes)}`,
      )
    }
    total += size
    if (total > maxBytes) {
      throw codedError(
        'rnh/too-large',
        `the multipart parts total ${String(total)} bytes; the limit is ${String(maxBytes)}`,
      )
    }
    if (name !== undefined) {
      if (parts.length >= maxParts) {
        throw codedError(
          'rnh/too-large',
          `the answer carries more than ${String(maxParts)} multipart parts`,
        )
      }
      parts.push({ name, body: body.subarray(start, end) })
    }
    cursor = next + delimiter.length
  }
  return parts
}

/**
 * Decode one Gateway answer, restoring any byte attachments in place.
 *
 * @param {Buffer} body
 * @param {string | undefined} contentType - the response `content-type`.
 * @param {{ maxParts?: number, maxBytes?: number }} [limits]
 * @returns {{ ok: boolean, value?: unknown, error?: { code: string, message: string, details?: unknown } }}
 * @throws {TypeError} when a multipart answer is malformed.
 */
export function decodeGatewayAnswer(body, contentType, limits = {}) {
  const type = (contentType ?? '').toLowerCase()
  if (!type.startsWith('multipart/form-data')) {
    const parsed = JSON.parse(body.toString('utf8'))
    const result = parsed?.result
    if (result === undefined || typeof result !== 'object') {
      throw Object.assign(new Error('the remote sent no result'), { code: 'rnh/carrier' })
    }
    return result
  }

  const boundary = BOUNDARY_PATTERN.exec(contentType)?.[1] ?? BOUNDARY_PATTERN.exec(contentType)?.[2]
  if (boundary === undefined) throw new TypeError('the remote answered multipart without a boundary')
  const parts = splitParts(body, boundary, limits)
  const metadataPart = parts.find(part => part.name === 'metadata')
  if (metadataPart === undefined) throw new TypeError('the remote answered multipart without metadata')
  const envelope = JSON.parse(metadataPart.body.toString('utf8'))
  const result = envelope?.result
  if (result === undefined || typeof result !== 'object' || result.ok !== true) return result
  const attachments = envelope.attachments
  if (!Array.isArray(attachments) || attachments.length === 0) {
    throw new TypeError('the remote answered multipart without attachments')
  }

  // `result.value` is where the Gateway put the nulled placeholders.
  const root = { value: result.value }
  for (const attachment of attachments) {
    if (attachment?.codec !== 'bytes' || typeof attachment.part !== 'string' || !Array.isArray(attachment.path)) {
      throw new TypeError('the remote sent an invalid byte attachment')
    }
    const part = parts.find(candidate => candidate.name === attachment.part)
    if (part === undefined) throw new TypeError(`the remote omitted part ${attachment.part}`)
    let parent = root
    let key = 'value'
    for (const segment of attachment.path) {
      const value = Reflect.get(parent, key)
      if (value === null || typeof value !== 'object') {
        throw new TypeError('the remote sent an invalid byte attachment path')
      }
      if (Array.isArray(value)) {
        if (!Number.isSafeInteger(segment) || segment < 0 || segment >= value.length) {
          throw new TypeError('the remote sent an invalid byte attachment path')
        }
      } else if (typeof segment !== 'string') {
        throw new TypeError('the remote sent an invalid byte attachment path')
      }
      if (!Object.hasOwn(value, segment)) throw new TypeError('the remote sent an invalid byte attachment path')
      parent = value
      key = segment
    }
    if (Reflect.get(parent, key) !== null) throw new TypeError('the remote sent an invalid byte placeholder')
    // A fresh copy, so the caller can hand it to a Response or a Blob without
    // sharing the response buffer.
    const bytes = new Uint8Array(part.body.length)
    bytes.set(part.body)
    Object.defineProperty(parent, key, { value: bytes, enumerable: true, writable: true, configurable: true })
  }
  return { ...result, value: root.value }
}
