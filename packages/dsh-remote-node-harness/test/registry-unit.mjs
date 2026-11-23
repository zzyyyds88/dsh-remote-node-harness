/**
 * `core/registry.js` — the one file whose failure mode is "your nodes disappear".
 *
 * What this proves, and why each case is here:
 *
 *   1. a healthy `nodes.json` reads back unchanged;
 *   2. a missing file is first run, not damage — it must never be reported as corrupt;
 *   3. a file that is not JSON is `corrupt`, its original bytes are renamed aside, and the
 *      next save does not erase them (that is the whole bug: the file used to be emptied
 *      and then overwritten by the next `put`);
 *   4. one bad record does not take the table with it — the rest survive, the dropped ones
 *      are reported, and their bytes are preserved before the first save rewrites the list;
 *   5. the validation failures carry `code: 'node-invalid'` and serialize to HTTP 400, so a
 *      typo in a name is not answered with "server error" — asserted through the real
 *      `apply()` route, not only through the serializer.
 *
 * Usage: node test/registry-unit.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

// `NodeRegistry` writes to `$DSH_HOME/rnh/nodes.json`. Point that at a private sandbox
// before anything can load the real file — the same rule `rnh-lifecycle-unit.mjs` uses.
const sandbox = mkdtempSync(join(tmpdir(), 'rnh-registry-'))
process.env.DSH_HOME = sandbox

const { NodeRegistry, normalizeNode } = await import('../src/core/registry.js')
const { describeFailure } = await import('../src/core/http-error.js')

let failed = 0
const check = (ok, label, detail) => {
  const mark = ok ? 'ok  ' : 'FAIL'
  console.log(`[registry-unit] ${mark} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

const home = () => join(sandbox, 'rnh')
const file = () => join(home(), 'nodes.json')
const reset = () => rmSync(home(), { recursive: true, force: true })
/** A valid record; `overrides` is how a test makes exactly one field wrong. */
const node = (overrides = {}) => ({
  id: 'n0123456789ab',
  name: 'alpha',
  host: 'example.test',
  username: 'root',
  ...overrides,
})
const writeRaw = text => {
  mkdirSync(home(), { recursive: true })
  writeFileSync(file(), text)
}
const writeList = list => writeRaw(`${JSON.stringify(list, null, 2)}\n`)
const backups = () => (existsSync(home())
  ? readdirSync(home()).filter(name => name.startsWith('nodes.json.corrupt-')).map(name => join(home(), name))
  : [])

// ---- 1. a healthy file reads back -------------------------------------------
{
  reset()
  const stored = node()
  writeList([stored])
  const registry = new NodeRegistry()
  const list = registry.list()
  check(list.length === 1, 'a stored node is read back', String(list.length))
  check(list[0]?.id === stored.id && list[0]?.name === stored.name,
    'with its identity and label intact', JSON.stringify(list[0]))
  const state = registry.loadState()
  check(state.corrupt === false, 'a healthy load is not corrupt', String(state.corrupt))
  check(state.skipped.length === 0, 'and drops nothing', String(state.skipped.length))
  check(backups().length === 0, 'and leaves no backup behind', backups().join(','))
}

// ---- 2. no file at all is first run, not damage -----------------------------
{
  reset()
  const registry = new NodeRegistry()
  check(registry.list().length === 0, 'a missing file gives an empty table')
  const state = registry.loadState()
  check(state.corrupt === false, 'and is NOT reported as corrupt', String(state.corrupt))
  check(state.reason === undefined, 'with no reason attached', String(state.reason))
  check(backups().length === 0, 'and no backup is invented', backups().join(','))
  check(!existsSync(file()), 'reading does not create the file', String(existsSync(file())))
}

// ---- 3. a file that is not JSON is preserved, not consumed ------------------
let corruptOriginal
{
  reset()
  corruptOriginal = 'this is not json, it is a truncated write'
  writeRaw(corruptOriginal)
  const registry = new NodeRegistry()
  check(registry.list().length === 0, 'an unreadable file degrades to an empty table')
  const state = registry.loadState()
  check(state.corrupt === true, 'and says the load was corrupt', String(state.corrupt))
  check(typeof state.reason === 'string' && /JSON/u.test(state.reason),
    'naming the reason, so a person knows what to fix', state.reason)
  check(typeof state.backupPath === 'string' && state.backupPath.length > 0,
    'and naming where the original went', String(state.backupPath))
  const kept = state.backupPath === undefined ? '' : readFileSync(state.backupPath, 'utf8')
  check(kept === corruptOriginal, 'the backup holds the original bytes exactly', `${String(kept.length)} bytes`)
  const backupName = state.backupPath?.split(/[\\/]/u).at(-1) ?? ''
  check(/^nodes\.json\.corrupt-[0-9TZ.\-]+(?:-\d+)?$/u.test(backupName),
    'the backup name is the readable `nodes.json.corrupt-<timestamp>` form', backupName)
  // The whole point of the rename is that the name is a legal Windows filename, and a raw
  // `toISOString()` contains colons, which are not.
  check(!backupName.includes(':'), 'with no colons, so it is writable on Windows', backupName)
}

// ---- 4. one invalid record does not erase the others -----------------------
{
  reset()
  const good = node({ id: 'n0123456789ab', name: 'alpha' })
  const bad = node({ id: 'n0123456789ac', name: '' })
  writeList([good, bad])
  const registry = new NodeRegistry()
  const list = registry.list()
  check(list.length === 1, 'the valid records still load', `${String(list.length)} of 2`)
  check(list[0]?.id === good.id, 'and it is the valid one', String(list[0]?.id))
  const state = registry.loadState()
  check(state.corrupt === false, 'a partial load is not a corrupt file', String(state.corrupt))
  check(state.skipped.length === 1, 'one record is reported as skipped', String(state.skipped.length))
  check(state.skipped[0]?.id === bad.id, 'with the identity a person can search for', String(state.skipped[0]?.id))
  check(state.skipped[0]?.index === 1, 'and its position in the stored list', String(state.skipped[0]?.index))
  check(/node name/u.test(state.skipped[0]?.reason ?? ''),
    'the reason is the validator sentence', state.skipped[0]?.reason)

  // A value that parses but is not a node list is damage too, not an empty registry.
  reset()
  writeRaw('{"nodes": "not a list"}\n')
  const wrongShape = new NodeRegistry()
  check(wrongShape.list().length === 0, 'a JSON document of the wrong shape loads empty')
  check(wrongShape.loadState().corrupt === true,
    'and is reported as corrupt rather than as "no nodes"', String(wrongShape.loadState().corrupt))
}

// ---- 5. the save after a corrupt load cannot bury the evidence -------------
{
  // A fresh corrupt file, then the write that used to publish the empty table over the
  // only copy. The registry must not need the backup path from case 3 to be reused.
  reset()
  const original = 'half a file: {"nodes":[{"id":"n0123456789ab","name"'
  writeRaw(original)
  const registry = new NodeRegistry()
  check(registry.list().length === 0, 'the corrupt fixture starts empty', String(registry.list().length))

  const added = registry.put(node({ id: 'n0123456789ad', name: 'replacement' }))
  check(added.id === 'n0123456789ad', 'a new node can be added after a corrupt load', String(added.id))
  const onDisk = JSON.parse(readFileSync(file(), 'utf8'))
  check(Array.isArray(onDisk) && onDisk.length === 1, 'the new table is written on its own', JSON.stringify(onDisk.length))

  const saved = backups()
  check(saved.length === 1, 'exactly one backup exists', String(saved.length))
  const kept = saved[0] === undefined ? '' : readFileSync(saved[0], 'utf8')
  check(kept === original,
    'and the original bytes are still there, so the damage stays repairable',
    `${String(kept.length)} bytes`)
}

// ---- 5b. a partial load is backed up before the first rewrite --------------
{
  reset()
  const good = node({ id: 'n0123456789ab', name: 'alpha' })
  const bad = node({ id: 'n0123456789ac', name: '' })
  const original = `${JSON.stringify([good, bad], null, 2)}\n`
  writeRaw(original)
  const registry = new NodeRegistry()
  check(registry.list().length === 1, 'the fixture loads one of two records', String(registry.list().length))
  check(backups().length === 0, 'a partial load alone writes nothing — a restart must not lose records')

  registry.put(node({ id: 'n0123456789ae', name: 'beta' }))
  const saved = backups()
  check(saved.length === 1, 'the first save preserves the file it is about to replace', String(saved.length))
  const preserved = saved[0] === undefined ? '' : readFileSync(saved[0], 'utf8')
  check(preserved === original,
    'including the record that failed validation, byte for byte', `${String(preserved.length)} bytes`)
  const onDisk = JSON.parse(readFileSync(file(), 'utf8'))
  check(onDisk.length === 2, 'while the live table holds the surviving records', String(onDisk.length))
}

// ---- 5c. `remove()` is the other path that used to publish the empty table ----
{
  reset()
  const good = node({ id: 'n0123456789ab', name: 'alpha' })
  const bad = node({ id: 'n0123456789ac', name: '' })
  const original = `${JSON.stringify([good, bad], null, 2)}\n`
  writeRaw(original)
  const registry = new NodeRegistry()
  const removed = registry.remove(good.id)
  check(removed === true, 'a node can still be removed after a partial load', String(removed))
  const saved = backups()
  check(saved.length === 1, 'and that write preserves the file it replaced', String(saved.length))
  check(saved[0] === undefined ? false : readFileSync(saved[0], 'utf8') === original,
    'including the record the validator rejected', String(saved[0]))
  check(JSON.parse(readFileSync(file(), 'utf8')).length === 0,
    'while the live table keeps only what was left', String(registry.list().length))
}

// ---- 6. validation failures are routable, not "server error" ---------------
{
  const cases = [
    ['not an object', null],
    ['a bad id', node({ id: 'nope' })],
    ['an empty name', node({ name: '' })],
    ['a name over 120 characters', node({ name: 'x'.repeat(121) })],
    ['an empty host', node({ host: '' })],
    ['a host with whitespace', node({ host: 'two words' })],
    ['a port out of range', node({ port: 70_000 })],
    ['an empty username', node({ username: '' })],
    ['an unknown auth kind', node({ auth: { kind: 'telepathy' } })],
  ]
  for (const [label, input] of cases) {
    let thrown
    try {
      normalizeNode(input)
    } catch (error) {
      thrown = error
    }
    check(thrown?.code === 'node-invalid', `${label} is a node-invalid error`, String(thrown?.code))
    check(typeof thrown?.message === 'string' && thrown.message.length > 0,
      `${label} still carries its diagnostic sentence`, String(thrown?.message))
  }

  // What the HTTP layer does with it. This is the assertion that used to be impossible:
  // a bare Error serialized to 500 / `rnh-failed`, which is what the settings page showed
  // for a one-character typo. Checked here through the real serializer, so 400 is not a
  // number this test invented.
  let thrown
  try {
    normalizeNode(node({ name: '' }))
  } catch (error) {
    thrown = error
  }
  const failure = describeFailure(thrown)
  check(failure.status === 400, 'the HTTP layer answers a validation failure with 400', String(failure.status))
  check(failure.code === 'node-invalid', 'and a stable code a client can branch on', String(failure.code))
  check(failure.error === 'rnh: node name must be 1-120 characters',
    'with the diagnostic text unchanged', String(failure.error))
}

// ---- 7. the route itself answers 400, not just the serializer --------------
// A Host is not needed for this: `apply()` registers one prefix handler on
// `ctx.webServer`, and the 500→400 decision lives in that handler's `guard`. The context
// below is the smallest object `apply()` actually touches, so the assertion runs against
// the real route code rather than a copy of it.
{
  let probe
  try {
    const { apply } = await import('../src/index.js')
    let handler
    const ctx = {
      logger: { info: () => {} },
      credentials: {
        readRecord: () => undefined,
        modifyRecord: (_key, mutate) => mutate(undefined),
        deleteRecord: () => {},
        describeRecord: () => undefined,
      },
      provide: () => () => {},
      get: () => undefined,
      on: () => {},
      effect: () => () => {},
      inject: () => {},
      webServer: { register: route => { handler = route.handler; return () => {} } },
    }
    apply(ctx, { relayPatch: false, autoConnect: false })
    if (handler === undefined) throw new Error('apply() registered no web route')
    const call = async (method, url, payload) => {
      const state = { status: 0, body: '' }
      const res = { writeHead: status => { state.status = status }, end: body => { state.body = body } }
      const req = Object.assign(
        Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]),
        { method, url },
      )
      await handler(req, res)
      return { status: state.status, body: state.body.length === 0 ? {} : JSON.parse(state.body) }
    }
    const bad = await call('POST', '/rnh/api/nodes', { name: '', host: 'example.test', username: 'root' })
    const good = await call('POST', '/rnh/api/nodes', { name: 'alpha', host: 'example.test', username: 'root' })
    const patched = good.body.node?.id === undefined
      ? { status: 0, body: {} }
      : await call('PATCH', `/rnh/api/nodes/${good.body.node.id}`, { name: '' })
    probe = { bad, good, patched }
  } catch (error) {
    // Importing the plugin pulls in `ssh2`, a declared dependency of this package. If that
    // import fails the checkout is not installed, and saying so is better than a silent pass.
    check(false, 'the plugin route can be loaded in this checkout',
      error instanceof Error ? error.message : String(error))
  }
  if (probe !== undefined) {
    check(probe.bad.status === 400, 'POST /nodes with an empty name answers 400', String(probe.bad.status))
    check(probe.bad.body.code === 'node-invalid', 'with the stable code on the wire', String(probe.bad.body.code))
    check(probe.bad.body.error === 'rnh: node name must be 1-120 characters',
      'and the same diagnostic sentence', String(probe.bad.body.error))
    check(probe.good.status === 200, 'a valid node still answers 200', String(probe.good.status))
    check(probe.patched.status === 400, 'PATCH /nodes/:id is mapped the same way', String(probe.patched.status))
  }
}

// ---- 8. remoteRoot is a path, not a shell fragment -------------------------
// `remoteRoot` is interpolated into `sh -c` text in ~35 places, so an unvalidated value is a
// remote command-injection surface. It used to be validated as "a non-empty string" and
// nothing else. These cases are the injection attempts themselves, not proxies for them.
{
  const { normalizeRemoteRoot } = await import('../src/core/registry.js')
  const allowed = ['~/.dsh-remote-node-harness', '/root/fleet', '~', '', undefined]
  for (const value of allowed) {
    check(normalizeRemoteRoot(value).ok === true,
      `${JSON.stringify(value)} is accepted as a remote root`, JSON.stringify(normalizeRemoteRoot(value)))
  }
  const refused = [
    '~/x; touch /tmp/pwned',
    '/tmp/$(id)',
    '/tmp/`id`',
    '/tmp/a"b',
    "~/it's",
    '/tmp/a\nb',
    '/tmp/a b',
    '/tmp/a\\b',
    'relative/path',
    '/tmp/a/../b',
    '/tmp/.',
  ]
  for (const value of refused) {
    const result = normalizeRemoteRoot(value)
    check(result.ok === false, `${JSON.stringify(value)} is refused as a remote root`,
      JSON.stringify(result))
  }
  // The one shape that must still work: the default, because every existing node has it.
  check(normalizeRemoteRoot('~/.dsh-remote-node-harness').root === '~/.dsh-remote-node-harness',
    'the default root survives validation unchanged')
  check(normalizeRemoteRoot('').root === '~/.dsh-remote-node-harness',
    'and an absent one becomes the default rather than an error')
}

rmSync(sandbox, { recursive: true, force: true })
if (failed > 0) {
  console.log(`\n[registry-unit] FAILED: ${String(failed)} check(s)`)
  process.exitCode = 1
} else {
  console.log('\n[registry-unit] all checks passed')
}
