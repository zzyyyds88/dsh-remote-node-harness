/**
 * The bookkeeping four `Remote*` classes used to carry a copy of each.
 *
 * Each of them had the same `Map` of node id → per-node stream, the same `sync()` that walks
 * `rnh.routable()`, and the same `dispose()`. What differed was only the *policy*: three close
 * a node that left, `RemoteWorkspaces` keeps its rows and marks them offline. That split is why
 * this class reports what changed instead of applying it — and it is what these tests pin:
 *
 * 1. `plan()` classifies the node set three ways (left / arrived / staying) and **touches
 *    nothing**, so a caller can apply a different policy to the same facts;
 * 2. a node is created exactly once, even across repeated `sync()`s;
 * 3. `drop()` closes the stream on the way out — a forgotten stream keeps a carrier open;
 * 4. `disposeAll()` closes everything and empties the set;
 * 5. a node that is merely unreachable still appears in `left`, which is what lets the
 *    workspace picture keep its rows without needing a second classification.
 *
 * @module @greatbaby/dsh-remote-node-harness/test/node-stream-set-unit
 */
import { NodeStreamSet } from '../src/host/node-stream-set.js'

let failed = 0
const log = message => process.stderr.write(`[node-stream-set-unit] ${message}\n`)
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}

/** A fake `rnh` whose routable set a test can change between calls. */
function fakeRnh(ids) {
  const runtime = id => ({ record: { id, name: id }, gateway: { id }, routable: true })
  let current = ids.map(runtime)
  return {
    routable: () => current,
    get: id => current.find(entry => entry.record.id === id),
    set: next => { current = next.map(runtime) },
    runtime,
  }
}

/** One node's stream object: records what happened to it. */
function fakeStream(runtime, calls) {
  return {
    nodeId: runtime.record.id,
    closed: 0,
    close() { this.closed += 1; calls.push(`close:${this.nodeId}`) },
  }
}

// ---- 1. plan() classifies and touches nothing -----------------------------
{
  const calls = []
  const set = new NodeStreamSet(runtime => fakeStream(runtime, calls))
  const rnh = fakeRnh(['a', 'b'])
  set.add(rnh.runtime('a'))
  set.add(rnh.runtime('b'))

  rnh.set(['b', 'c']) // `a` left, `c` arrived, `b` stayed
  const plan = set.plan(rnh)
  check(plan.left.join(',') === 'a', 'plan reports the node that left', plan.left.join(','))
  check(plan.arrived.map(runtime => runtime.record.id).join(',') === 'c',
    'and the node that arrived', plan.arrived.map(runtime => runtime.record.id).join(','))
  check(plan.staying.map(runtime => runtime.record.id).join(',') === 'b',
    'and the node that stayed', plan.staying.map(runtime => runtime.record.id).join(','))
  check(calls.length === 0, 'plan touches nothing — no stream was created or closed', calls.join(' '))
  check(set.has('a') && set.has('b') && !set.has('c'),
    'and the set itself is unchanged until the caller applies the plan')
}

// ---- 2. a node is created exactly once ------------------------------------
{
  const calls = []
  const created = []
  const set = new NodeStreamSet(runtime => {
    created.push(runtime.record.id)
    return fakeStream(runtime, calls)
  })
  const rnh = fakeRnh(['a'])
  const first = set.add(rnh.runtime('a'))
  const second = set.get('a')
  check(first === second, 'add() then get() returns the same object')
  check(created.join(',') === 'a', 'and the factory ran once', created.join(','))
  // Repeated sync shapes must not create a second object for a node that is still there.
  const plan = set.plan(rnh)
  check(plan.arrived.length === 0 && plan.staying.length === 1,
    'a node already in the set is "staying", never "arrived"')
}

// ---- 3. drop() closes on the way out -------------------------------------
{
  const calls = []
  const set = new NodeStreamSet(runtime => fakeStream(runtime, calls))
  const node = set.add(fakeRnh(['a']).runtime('a'))
  check(set.drop('a') === true, 'dropping a node that exists reports true')
  check(node.closed === 1, 'and closed its stream exactly once', String(node.closed))
  check(!set.has('a'), 'and forgot it')
  check(set.drop('a') === false, 'dropping it again reports false rather than closing a second time')
  check(node.closed === 1, 'so nothing was closed twice', String(node.closed))
}

// ---- 4. disposeAll() closes everything -----------------------------------
{
  const calls = []
  const set = new NodeStreamSet(runtime => fakeStream(runtime, calls))
  const rnh = fakeRnh(['a', 'b', 'c'])
  const nodes = ['a', 'b', 'c'].map(id => set.add(rnh.runtime(id)))
  set.disposeAll()
  check(nodes.every(node => node.closed === 1), 'every stream was closed once',
    nodes.map(node => node.closed).join(','))
  check(set.nodes.size === 0, 'and the set is empty')
  check(set.disposeAll() === undefined, 'disposing an empty set is harmless')
}

// ---- 5. an unreachable node still appears in `left` ----------------------
// The workspace picture keeps that node's rows and marks them offline; a projection block does
// not. Both decisions start from the same list, which is the whole point of the split.
{
  const set = new NodeStreamSet(runtime => fakeStream(runtime, []))
  const rnh = fakeRnh(['a'])
  set.add(rnh.runtime('a'))
  rnh.set([]) // the node is still recorded, just not routable
  const plan = set.plan(rnh)
  check(plan.left.join(',') === 'a',
    'a node that stopped being routable is reported as left', plan.left.join(','))
  check(rnh.get('a') === undefined,
    'while the record itself is a different question the caller answers', String(rnh.get('a')))
}

process.stdout.write(
  failed === 0
    ? '[node-stream-set-unit] all checks passed\n'
    : `[node-stream-set-unit] FAILED: ${String(failed)} check(s)\n`,
)
process.exitCode = failed === 0 ? 0 : 1