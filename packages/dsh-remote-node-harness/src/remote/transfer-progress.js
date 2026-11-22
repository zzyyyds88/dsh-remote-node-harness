/**
 * Byte-level progress for the one step of a connect that has a measurable one.
 *
 * Everything else in a connect is either instant or a single round trip, but the first
 * connect to a fresh node downloads a 58.2 MiB runtime archive, and on a slow link that is
 * minutes with nothing on screen. A person watching a spinner for four minutes cannot tell
 * "working" from "hung", and the honest fix is a number.
 *
 * ## Why this polls instead of reading a stream
 *
 * `SshConnection.exec` buffers its reply and resolves when the channel closes — one exec is
 * one reply, deliberately, because that is what keeps a payload off the command line. So
 * `curl` cannot report progress *during* the download: whatever it prints arrives after it
 * finishes. The node's filesystem can be asked in the meantime, though: the archive grows
 * while `curl` writes it, so a one-second `stat` on a second channel is a real measurement
 * rather than a simulation.
 *
 * That also decides what this module refuses to do. If the source does not say how big the
 * archive is, there is no total and therefore no percentage and no ETA — it reports the
 * bytes transferred and nothing else, because a made-up denominator would be a lie about
 * the one number a person is watching.
 *
 * @module @greatbaby/dsh-remote-node-harness/remote/transfer-progress
 */

/** How often the archive is measured. One second is the granularity a person can read. */
export const TRANSFER_INTERVAL_MS = 1_000

/**
 * How much history the rate is averaged over.
 *
 * A single 1-second sample is far too noisy — one stalled write reads as "0 B/s" and one
 * burst as "40 MB/s", and an ETA built on either is worse than none. Five samples is a
 * compromise that still reacts within seconds to a link that really has died.
 */
const RATE_WINDOW = 5

/** Quote one string for `sh`, so a path with a quote cannot become part of the script. */
const quote = text => `'${text.replaceAll("'", `'\\''`)}'`

/**
 * The archive path the install script writes.
 *
 * Derived from the layout the same way `installScript` derives it (`$(dirname "$runtime")`),
 * so the watcher cannot look at a path the download never touches.
 *
 * @param {{ runtime: string }} layout
 * @param {string} version
 * @returns {string}
 */
export function archiveFor(layout, version) {
  const runtime = layout.runtime
  const at = runtime.lastIndexOf('/')
  const base = at < 0 ? runtime : runtime.slice(0, at)
  return `${base}/runtime-${version}.tar.gz`
}

/**
 * How big the archive is, when the source will say.
 *
 * `undefined` is a normal answer: a mirror behind a redirect may omit `content-length`, and
 * a `HEAD` may be refused while `GET` works. The caller then shows bytes and no percentage.
 *
 * @param {import('../ssh/connection.js').SshConnection} connection
 * @param {readonly string[]} urls - candidates, in the order the installer will try them.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<number | undefined>}
 */
export async function totalBytes(connection, urls, options = {}) {
  const url = urls[0]
  if (url === undefined) return undefined
  // `tr -d '\r'` because a HEAD reply is CRLF-terminated even over SSH, and `awk` because
  // `content-length` may sit at any position in the header block.
  const script = `
set -u
if command -v curl >/dev/null 2>&1; then
  curl -sI --connect-timeout 8 --max-time 15 ${quote(url)} 2>/dev/null \\
    | tr -d '\\r' | awk 'tolower($1) == "content-length:" { print $2; exit }'
fi
`.trim()
  try {
    const result = await connection.exec({
      argv: ['sh', '-c', script],
      timeoutMs: options.timeoutMs ?? 20_000,
      maxBytes: 4096,
    })
    const value = Number(result.stdout.trim())
    return Number.isFinite(value) && value > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The current size of the archive, or `0` while it does not exist yet.
 *
 * GNU `stat -c %s` first, then BSD `stat -f %z`: the node's platform is not known here, and
 * a wrong guess would read as a stalled download.
 *
 * @param {import('../ssh/connection.js').SshConnection} connection
 * @param {string} archive
 * @returns {Promise<number | undefined>}
 */
async function archiveSize(connection, archive) {
  const path = quote(archive)
  const script = `
set -u
if [ -f ${path} ]; then
  stat -c %s ${path} 2>/dev/null || stat -f %z ${path} 2>/dev/null || echo 0
else
  echo 0
fi
`.trim()
  try {
    const result = await connection.exec({ argv: ['sh', '-c', script], timeoutMs: 10_000, maxBytes: 1024 })
    const value = Number(result.stdout.trim())
    return Number.isFinite(value) && value >= 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Turn a series of byte samples into the numbers a person reads.
 *
 * Kept separate from the polling so the arithmetic can be tested without a node: an ETA is
 * the one thing here that goes visibly wrong (a negative remainder, a rate computed from a
 * single stalled sample) and it goes wrong silently.
 *
 * @param {Array<{ at: number, bytes: number }>} samples - oldest first.
 * @param {number | undefined} total
 * @returns {{ bytes: number, total?: number, bytesPerSecond?: number, etaMs?: number }}
 */
export function summarise(samples, total) {
  const last = samples.at(-1)
  if (last === undefined) return { bytes: 0, ...(total === undefined ? {} : { total }) }
  const first = samples.at(-Math.min(samples.length, RATE_WINDOW + 1))
  const seconds = first === undefined ? 0 : (last.at - first.at) / 1000
  const moved = first === undefined ? 0 : last.bytes - first.bytes
  const bytesPerSecond = seconds > 0 && moved > 0 ? moved / seconds : undefined
  const result = {
    bytes: last.bytes,
    ...(total === undefined ? {} : { total }),
    ...(bytesPerSecond === undefined ? {} : { bytesPerSecond }),
  }
  // Only when both halves are known: a total without a rate, or a rate with nothing left to
  // cover, is not a prediction.
  if (total !== undefined && bytesPerSecond !== undefined) {
    const remaining = total - last.bytes
    if (remaining > 0) result.etaMs = Math.round((remaining / bytesPerSecond) * 1000)
  }
  return result
}

/**
 * Report the archive's growth while an install runs.
 *
 * @param {import('../ssh/connection.js').SshConnection} connection
 * @param {object} options
 * @param {string} options.archive
 * @param {number} [options.total]
 * @param {(progress: { bytes: number, total?: number, bytesPerSecond?: number, etaMs?: number }) => void} options.onUpdate
 * @param {number} [options.intervalMs]
 * @param {() => number} [options.now] - injectable for tests.
 * @returns {() => void} stops the watch; safe to call more than once.
 */
export function watchTransfer(connection, options) {
  const { archive, onUpdate } = options
  const total = options.total
  const intervalMs = options.intervalMs ?? TRANSFER_INTERVAL_MS
  const now = options.now ?? (() => Date.now())
  /** @type {Array<{ at: number, bytes: number }>} */
  const samples = []
  let stopped = false
  let inFlight = false
  let timer

  const tick = async () => {
    // One measurement at a time: a `stat` that outlives its interval must not pile up
    // channels on a connection that is already carrying the download.
    if (stopped || inFlight) return
    inFlight = true
    const bytes = await archiveSize(connection, archive)
    inFlight = false
    if (stopped || bytes === undefined) return
    samples.push({ at: now(), bytes })
    if (samples.length > RATE_WINDOW + 1) samples.shift()
    try {
      onUpdate(summarise(samples, total))
    } catch {
      // A surface that throws while rendering must not abort the transfer it is watching.
    }
  }

  void tick()
  timer = setInterval(() => { void tick() }, intervalMs)
  // `unref` so a watch that is never stopped cannot hold a process open; the install always
  // stops it, but a failed connect path may not.
  if (typeof timer.unref === 'function') timer.unref()

  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }
}
