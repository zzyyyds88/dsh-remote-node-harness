/**
 * `remote/transfer-progress.js` — the numbers shown while a runtime archive downloads.
 *
 * The polling itself needs a node, but the arithmetic does not, and the arithmetic is where
 * this goes wrong silently: a rate computed from one stalled sample reads as "0 B/s" on a
 * healthy link, a negative remainder prints "-3s left", and a percentage against a total the
 * source never sent is a fabricated number under the one thing a person is watching.
 *
 * What this proves:
 *
 *   1. a single sample reports bytes and nothing it cannot know;
 *   2. the rate is averaged over the window, so one stalled tick does not read as a dead link;
 *   3. an ETA appears only when both a total and a rate exist, and never negative;
 *   4. a finished transfer does not claim time remaining;
 *   5. the archive path is derived the same way the install script derives it;
 *   6. `watchTransfer` reports, then stops reporting after it is stopped.
 *
 * Usage: node test/transfer-unit.mjs
 */
import { archiveFor, summarise, totalBytes, watchTransfer } from '../src/remote/transfer-progress.js'

let failed = 0
const check = (ok, label, detail) => {
  if (ok) {
    process.stdout.write(`[transfer-unit] ok   ${label}\n`)
    return
  }
  failed += 1
  process.stdout.write(`[transfer-unit] FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

const MiB = 1024 * 1024

// ---- 1. one sample says only what it knows -------------------------------
{
  const only = summarise([{ at: 1_000, bytes: 5 * MiB }], undefined)
  check(only.bytes === 5 * MiB, 'one sample reports the bytes it measured', String(only.bytes))
  check(only.total === undefined, 'and invents no total')
  check(only.bytesPerSecond === undefined, 'and no rate: one sample is not a speed')
  check(only.etaMs === undefined, 'and no ETA')

  const withTotal = summarise([{ at: 1_000, bytes: 5 * MiB }], 58 * MiB)
  check(withTotal.total === 58 * MiB, 'a known total is carried through')
  check(withTotal.etaMs === undefined, 'but a total without a rate is still not a prediction')

  check(summarise([], 10).bytes === 0, 'no samples reads as zero bytes, not as undefined')
}

// ---- 2. the rate is averaged, so one stalled tick is not a dead link ------
{
  const samples = [
    { at: 0, bytes: 0 },
    { at: 1_000, bytes: 2 * MiB },
    { at: 2_000, bytes: 4 * MiB },
    // A stalled second: nothing arrived between 2 s and 3 s.
    { at: 3_000, bytes: 4 * MiB },
    { at: 4_000, bytes: 6 * MiB },
  ]
  const live = summarise(samples, 58 * MiB)
  check(live.bytesPerSecond !== undefined, 'a rate is reported while bytes are arriving')
  check(Math.abs(live.bytesPerSecond - 1.5 * MiB) < 0.01 * MiB,
    'and it is the average over the window, not the last tick',
    `${(live.bytesPerSecond / MiB).toFixed(2)} MiB/s`)
  check(live.etaMs !== undefined && live.etaMs > 0, 'with a positive ETA', String(live.etaMs))
  check(live.etaMs === Math.round(((58 - 6) * MiB / (1.5 * MiB)) * 1000),
    'computed from the bytes still missing', String(live.etaMs))

  // A link that really has died: several samples, no growth at all.
  const dead = summarise([
    { at: 0, bytes: 4 * MiB },
    { at: 1_000, bytes: 4 * MiB },
    { at: 2_000, bytes: 4 * MiB },
  ], 58 * MiB)
  check(dead.bytesPerSecond === undefined, 'a link that moves nothing reports no rate')
  check(dead.etaMs === undefined, 'and therefore no ETA, rather than an infinite one')
}

// ---- 3. a finished transfer does not claim time remaining ----------------
{
  const done = summarise([
    { at: 0, bytes: 50 * MiB },
    { at: 1_000, bytes: 58 * MiB },
  ], 58 * MiB)
  check(done.bytes === 58 * MiB, 'the finished size is reported')
  check(done.etaMs === undefined, 'and nothing is left, so no ETA is claimed')
}

// ---- 4. the archive path is derived the way the installer derives it -----
{
  const layout = { runtime: '/root/.dsh-fleet/runtime' }
  check(archiveFor(layout, '0.2.2-rc.5', '/root') === '/root/.dsh-fleet/runtime-0.2.2-rc.5.tar.gz',
    'the watched archive is beside the runtime, as the install script writes it',
    archiveFor(layout, '0.2.2-rc.5', '/root'))
  // The script does `archive="$base/runtime-${version}.tar.gz"` with `base` already absolute, so
  // a runtime with a trailing separator must not produce a doubled slash — the watch would then
  // look at a path the download never touches and report a permanent zero.
  const trailing = { runtime: '/root/.dsh-fleet/runtime/' }
  check(!archiveFor(trailing, '1', '/root').includes('//'),
    'a trailing separator does not double the slash', archiveFor(trailing, '1', '/root'))

  // ---- the `~` that made every progress bar read 0 B --------------------------
  // The layout is written the way a person types it, and the watcher used to build
  // `'~/…/runtime-x.tar.gz'` and send it inside single quotes — where `~` is a literal tilde.
  // `stat` therefore answered "no such file" for the whole download and the card showed
  // `0 B` on a link that was working. The path is now absolute before it is quoted, using the
  // home the probe reported.
  const tilde = { runtime: '~/.dsh-remote-node-harness/runtime' }
  check(archiveFor(tilde, '0.2.2') === undefined,
    'a ~-rooted layout with no known home gives no path rather than a literal tilde',
    String(archiveFor(tilde, '0.2.2')))
  check(archiveFor(tilde, '0.2.2', '/home/deploy') === '/home/deploy/.dsh-remote-node-harness/runtime-0.2.2.tar.gz',
    'with the home known it becomes an absolute path', archiveFor(tilde, '0.2.2', '/home/deploy'))
  check(archiveFor(tilde, '0.2.2', '/home/deploy/') === '/home/deploy/.dsh-remote-node-harness/runtime-0.2.2.tar.gz',
    'and a home with a trailing separator does not double the slash',
    archiveFor(tilde, '0.2.2', '/home/deploy/'))
  check(archiveFor(tilde, '0.2.2', '') === undefined,
    'an empty home is unknown, not "the current directory"')
  check(archiveFor(tilde, '0.2.2', 'relative/home') === undefined,
    'a home that is not absolute is refused: the node reports $HOME as an absolute path')
  check(!String(archiveFor(tilde, '0.2.2', '/home/deploy')).includes('~'),
    'no path that reaches a single-quoted shell word ever contains a tilde')

  // A watch on an unresolvable path is a no-op, not a stream of `0 B` updates: reporting zero
  // is the one answer that looks like a stalled download when it is really a path bug.
  let called = 0
  const stop = watchTransfer({ exec: async () => { called += 1; throw new Error('must not run') } }, {
    archive: undefined, intervalMs: 5, onUpdate: () => { called += 1 },
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  stop()
  check(called === 0, 'a watch with no resolvable archive measures nothing at all', String(called))
}

// ---- 5. a source that will not say its size gives no total ---------------
{
  // A stand-in connection whose `sh` prints nothing, which is what a mirror without
  // `content-length` does.
  const silent = { exec: async () => ({ code: 0, stdout: '', stderr: '', truncated: false }) }
  check(await totalBytes(silent, ['https://example.invalid/a.tar.gz']) === undefined,
    'no content-length means no total, so the card shows bytes only')

  const loud = { exec: async () => ({ code: 0, stdout: '61071397\n', stderr: '', truncated: false }) }
  check(await totalBytes(loud, ['https://example.invalid/a.tar.gz']) === 61_071_397,
    'a content-length is read as the total')

  const broken = { exec: async () => { throw new Error('connection lost') } }
  check(await totalBytes(broken, ['https://example.invalid/a.tar.gz']) === undefined,
    'a probe that throws is not a failure of the transfer it was measuring')
  check(await totalBytes(loud, []) === undefined, 'no URL means nothing to measure')

  // `-L` is what makes a CNB total exist at all: the anonymous GET answers 302, and a HEAD
  // without follow prints the redirect's headers, which carry no `content-length`. The tradeoff
  // is unchanged — no total still means no ETA — so this is only about not answering
  // "unknown" for a source that does say.
  const seen = []
  const recorder = { exec: async request => { seen.push(request.argv.at(-1) ?? ''); return { code: 0, stdout: '', stderr: '', truncated: false } } }
  await totalBytes(recorder, ['https://cnb.cool/x/a.tar.gz'])
  check(seen.some(script => /curl -sIL/u.test(script)),
    'the size probe follows redirects, because the source answers 302 first',
    seen.join('\n').split('\n').find(line => line.includes('curl')) ?? '(none)')
}

// ---- 6. the watch reports, then stops ------------------------------------
{
  let size = 0
  const connection = {
    exec: async () => ({ code: 0, stdout: `${String(size)}\n`, stderr: '', truncated: false }),
  }
  const seen = []
  let clock = 0
  const stop = watchTransfer(connection, {
    archive: '/tmp/x.tar.gz',
    total: 10,
    intervalMs: 10,
    now: () => (clock += 1_000),
    onUpdate: progress => seen.push(progress),
  })
  // First sample is taken synchronously by the watcher; the rest need a tick to land.
  await new Promise(resolve => setTimeout(resolve, 60))
  size = 5
  await new Promise(resolve => setTimeout(resolve, 60))
  stop()
  const after = seen.length
  await new Promise(resolve => setTimeout(resolve, 60))
  check(seen.length > 0, 'the watch reports progress', `${String(seen.length)} update(s)`)
  check(seen.at(-1).bytes >= 0, 'each update carries a byte count', String(seen.at(-1)?.bytes))
  check(seen.length === after, 'and stops reporting once stopped',
    `${String(seen.length)} vs ${String(after)}`)
  stop()
  check(true, 'stopping twice is harmless')
}

process.stdout.write(
  failed === 0
    ? '[transfer-unit] all checks passed\n'
    : `[transfer-unit] FAILED: ${String(failed)} check(s)\n`,
)
process.exitCode = failed === 0 ? 0 : 1
