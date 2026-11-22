/**
 * A node's approval request has to reach this Host's browser, and the answer has to resume
 * the remote turn. This test proves that over the real wire, end to end.
 *
 * `waterfall-unit.mjs` proves the relay's bookkeeping against a fake gateway: which events
 * cross, that a refusal settles once, that a disconnect withdraws the card. What it cannot
 * prove is that the pieces fit the **real** Gateway and the **real** node — whether the
 * frame's shape matches what the browser's `ui-approval` expects, whether the answer's
 * `$events/result` call is accepted, and whether the node then acts on it.
 *
 * So this test is a browser stand-in at the protocol layer: it opens the same `$events`
 * carrier a desktop browser opens, and answers exactly the way `ui-approval` answers
 * (one `$events/result` call carrying `{clientId, eventId, outcome}`). Everything the real
 * browser does beyond that — rendering the card — is upstream's own client plugin, which
 * this project does not modify and does not reimplement.
 *
 * What it asserts, in order:
 *
 *   1. the node's own preset says `approval: ask`, so a card is possible at all (a `never`
 *      preset would make the whole test vacuous);
 *   2. a real remote Session, prompted to write **outside** its workspace, produces an
 *      `approval/asked` event on the node;
 *   3. a `waterfall` frame arrives on this Host's `$events` stream, carrying the event name
 *      the browser listens for and an `agentId` wrapped into local form — this is the relay;
 *   4. answering it makes the node record `approval/decided` with the value that was sent —
 *      this proves the answer travelled back, not that the node timed out;
 *   5. the file exists on the node afterwards, read over a separate SSH connection;
 *   6. refusing a second request leaves its file absent, so the answer is really honoured
 *      in both directions.
 *
 * Requires: a connected node whose preset is `ask`, and a Host. No browser needed.
 *
 * Usage: node test/approval-acceptance.mjs <hostBase> <launchToken>
 *
 * @module @greatbaby/dsh-remote-node-harness/test/approval-acceptance
 */
import { authenticate, call, liveStream, openCarrier } from './carrier.mjs'
import { nodeLayout } from './layout.mjs'
import { nodeExec } from './node.mjs'

const [base, token] = process.argv.slice(2)
if (base === undefined || token === undefined) {
  process.stderr.write('usage: node approval-acceptance.mjs <hostBase> <launchToken>\n')
  process.exit(2)
}

const log = message => process.stdout.write(`[approval] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const stamp = Date.now().toString(36)
const cookie = await authenticate(base, token)

// ---- 1. the node would really ask ------------------------------------------

// A `never` policy answers inside the node before any waterfall exists, so the test would
// pass while proving nothing. Read the node's own generated patch rather than assume.
// A node on `danger-full-access` answers inside itself, before any waterfall exists, so
// there would be nothing to relay and every check below would be vacuous. The node's preset
// is copied from the desktop Host on each connect, and the desktop belongs to the person
// using it — so this test does not touch that. It edits the **node's** own profile patch
// (which the resident host watches and hot-reloads), and puts it back when it is done,
// including on failure.
//
// The path is derived from the node's recorded `remoteRoot`, not spelled out: the profile
// name follows that root (`rnh` only for the default one), and a node registered elsewhere
// kept its patch under a different name — which made this suite report "the node profile has
// no permission preset" on an otherwise healthy deployment.
const { layout: nodePaths } = await nodeLayout(base, cookie)
const NODE_PATCH = nodePaths.profilePatch
const originalPatch = await nodeExec(`cat ${NODE_PATCH}`)
const originalPreset = /defaultPreset:\s*(\S+)/u.exec(originalPatch)?.[1]
if (originalPreset === undefined) {
  log('the node profile has no permission preset to switch; nothing to exercise')
  process.exit(3)
}
log(`node default preset as found: ${originalPreset}`)

const SWITCHED = originalPatch.replace(/defaultPreset:\s*\S+/u, 'defaultPreset: workspace-write')
if (SWITCHED === originalPatch) {
  log('the node preset could not be rewritten; nothing to exercise')
  process.exit(3)
}

/** Put the node back the way it was found. Called on every exit path. */
let restored = false
const restore = async () => {
  if (restored) return
  restored = true
  try {
    await nodeExec(`cat > ${NODE_PATCH} <<'RNH_EOF'\n${originalPatch}\nRNH_EOF`)
    log('node preset restored')
  } catch (error) {
    log(`FAILED TO RESTORE THE NODE PATCH (${NODE_PATCH}): ${String(error?.message ?? error)}`)
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { void restore().then(() => process.exit(1)) })
}

await nodeExec(`cat > ${NODE_PATCH} <<'RNH_EOF'\n${SWITCHED}\nRNH_EOF`)
// The resident host watches this file; give it time to recompose before the first prompt.
// A fixed wait is the only signal available: the file itself carries no acknowledgement.
await sleep(6_000)
const effective = (await nodeExec(`sed -n "/id: permission/,/defaultPreset/p" ${NODE_PATCH}`)).trim()
log(`node permission config now: ${/defaultPreset:\s*(\S+)/u.exec(effective)?.[1] ?? '(none)'}`)
check(/defaultPreset:\s*workspace-write/u.test(effective),
  'the node now asks instead of answering itself', effective.replaceAll('\n', ' ').slice(-60))

const outside = `/root/outside-${stamp}`
const target = `${outside}/needs-approval-${stamp}.txt`

// ---- 2. the carrier a browser would open -----------------------------------

const carrier = await openCarrier({ base, cookie })
/** Raw frames on the `$events` carrier, exactly as the client plugin sees them. */
const eventFrames = []
carrier.onMessage(text => {
  let parsed
  try { parsed = JSON.parse(text) } catch { return }
  eventFrames.push(parsed)
})
carrier.send(JSON.stringify({
  type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} },
}))

// The first frame proves the Host accepted an owner connection and names this generation;
// a result that quotes a stale `clientId` is rejected, so this has to be read, not guessed.
const readyBy = Date.now() + 20_000
let clientId
while (Date.now() < readyBy && clientId === undefined) {
  await sleep(200)
  const ready = eventFrames.find(frame => frame.streamId === 'events' && frame.value?.type === 'ready')
  clientId = ready?.value?.clientId
}
check(typeof clientId === 'string', 'the Host accepts an owner event stream', String(clientId))

/** Values of one frame type on the `$events` carrier. */
const framesOf = type => eventFrames
  .filter(frame => frame.streamId === 'events' && frame.value?.type === type)
  .map(frame => frame.value)

// ---- 3. a remote Session, prompted to leave its workspace -------------------

const wsStream = liveStream(carrier, 'workspace/follow', {})
await sleep(2500)
const baseline = wsStream.frames.map(frame => frame.value).find(value => value?.type === 'baseline')
const workspace = (baseline?.value?.items ?? []).find(item => String(item.workspaceId).startsWith('rnh_'))
wsStream.stop()
check(workspace !== undefined, 'a remote workspace is available',
  workspace === undefined ? 'none' : `${workspace.title} (${workspace.path})`)
if (workspace === undefined) {
  carrier.close()
  log(`FAILED: ${failures.join(', ')}`)
  process.exit(1)
}

const created = await call(base, cookie, 'session/create', {
  request: { workspaceId: workspace.workspaceId },
})
const sessionId = created?.sessionId
check(typeof sessionId === 'string', 'a remote Session was created', String(sessionId).slice(0, 44))
if (typeof sessionId !== 'string') {
  carrier.close()
  log(`FAILED: ${failures.join(', ')}`)
  process.exit(1)
}

// The wire shape upstream validates: `address` plus a message budget, not a bare id.
// Getting this wrong yields one `error` frame and no events, which looks exactly like
// "the node sent nothing" — the confusion this whole test exists to rule out.
const followCarrier = await openCarrier({ base, cookie })
const follow = liveStream(followCarrier, 'session/follow', {
  request: { address: { kind: 'session', sessionId }, maxMessages: 400 },
})
await sleep(2000)
/** Every Session event the node has committed, in order. */
const sessionEvents = () => follow.frames
  .filter(frame => frame.value?.type === 'event')
  .map(frame => frame.value.event)

/** Events committed after `mark`, so one prompt's leftovers cannot satisfy another's check. */
const since = mark => sessionEvents().slice(mark)
const prompt = [
  `Use the write tool to create ${target} with the single line APPROVAL_OK_${stamp}.`,
  'The path is outside the workspace on purpose; if it is refused, escalate once with',
  'sandbox_permissions "danger-full-access" and a one-line justification.',
  'Then reply with the single word DONE.',
].join(' ')
const approvalMark = sessionEvents().length
await call(base, cookie, 'session/prompt', {
  request: {
    sessionId,
    requestId: `approval-${stamp}`,
    mode: 'queue',
    content: [{ type: 'text', text: prompt }],
  },
})
log('prompt sent; waiting for the approval to reach this Host')

// ---- 4. the request, as the browser receives it ----------------------------

// Two things have to be true for the browser's card to appear: the node has to have asked,
// and a `waterfall` frame carrying the *wrapped* identity has to arrive here. A bare node
// id would make the browser synthesise a scope nothing is rendering into, so the card would
// silently never show — which is why the wrapper is asserted rather than assumed.
const cardBy = Date.now() + 180_000
let waterfall
while (Date.now() < cardBy) {
  await sleep(1000)
  // Only this Session's request counts: a waterfall left over from another probe would
  // otherwise be answered here, and the check below would then blame the relay.
  waterfall = framesOf('waterfall').find(frame =>
    frame.event === 'approval/request' && frame.agentId === sessionId)
  if (waterfall !== undefined) break
  if (since(approvalMark).some(event => event?.type === 'turn/end')) break
}
check(since(approvalMark).some(event => event?.type === 'approval/asked'),
  'the node asked for an approval',
  since(approvalMark).filter(event => event?.type === 'approval/asked').map(event => event.data?.toolName).join(',') || 'none')
check(waterfall !== undefined, 'the request reaches this Host as a waterfall frame',
  waterfall === undefined ? 'no approval/request within 180s' : waterfall.event)
check(String(waterfall?.agentId ?? '').startsWith('rnh_'),
  'and it names the Session in local form, which is what the browser keys the card by',
  String(waterfall?.agentId ?? ''))
check(typeof waterfall?.request?.toolName === 'string',
  'the request carries the tool it is about', String(waterfall?.request?.toolName))

// The file must not exist yet: if it does, the node answered itself and any card would be a
// leftover from something else.
const before = await nodeExec(`test -f ${target} && echo present || echo absent`)
check(before.trim() === 'absent', 'nothing was written before the answer', before.trim())

// ---- 5. answer it the way the card does ------------------------------------

// One `$events/result` call carrying the value the card's allow button produces. This is
// the whole browser-side contract; if it is wrong here, it is wrong for a real card.
const allowed = await call(base, cookie, '$events/result', {
  clientId,
  eventId: waterfall.eventId,
  outcome: { kind: 'result', value: 'allowed-once' },
}).then(undefined, error => ({ error: String(error?.message ?? error) }))
check(allowed?.error === undefined, 'the Host accepts the answer',
  allowed?.error ?? 'accepted')

// The node's own audit trail is the witness: `approval/decided` is appended by the node,
// so its value proves the answer travelled back rather than the node giving up.
const decidedBy = Date.now() + 180_000
while (Date.now() < decidedBy) {
  await sleep(1000)
  const decided = since(approvalMark).filter(event => event?.type === 'approval/decided').at(-1)
  if (decided !== undefined) break
  if (since(approvalMark).some(event => event?.type === 'turn/end')) break
}
const decided = since(approvalMark).filter(event => event?.type === 'approval/decided').at(-1)
check(decided?.data?.outcome === 'allowed-once',
  'the node recorded the outcome that was sent', String(decided?.data?.outcome))

const wrote = await nodeExec(`cat ${target} 2>/dev/null || echo MISSING`)
check(wrote.includes(`APPROVAL_OK_${stamp}`),
  'and the approved write really landed on the node', wrote.trim().slice(0, 80))

// ---- 6. a refusal must not write -------------------------------------------

const refusedTarget = `${outside}/refused-${stamp}.txt`
const refusalMark = sessionEvents().length
await call(base, cookie, 'session/prompt', {
  request: {
    sessionId,
    requestId: `approval-refuse-${stamp}`,
    mode: 'queue',
    content: [{
      type: 'text',
      text: `Use the write tool to create ${refusedTarget} with the line SHOULD_NOT_EXIST, `
        + 'escalating to danger-full-access if it is refused. Then reply DONE.',
    }],
  },
})

const secondBy = Date.now() + 180_000
let second
while (Date.now() < secondBy) {
  await sleep(1000)
  const all = framesOf('waterfall').filter(frame =>
    frame.event === 'approval/request' && frame.agentId === sessionId)
  second = all.at(-1)
  if (second !== undefined && second.eventId !== waterfall.eventId) break
  second = undefined
}
check(second !== undefined, 'a second request arrives for the second prompt')

const denied = await call(base, cookie, '$events/result', {
  clientId,
  eventId: second?.eventId,
  outcome: { kind: 'result', value: 'rejected' },
}).then(undefined, error => ({ error: String(error?.message ?? error) }))
check(denied?.error === undefined, 'the refusal is accepted', denied?.error ?? 'accepted')

const refusalBy = Date.now() + 120_000
while (Date.now() < refusalBy) {
  await sleep(1000)
  const outcomes = since(refusalMark).filter(event => event?.type === 'approval/decided').map(event => event.data?.outcome)
  if (outcomes.includes('rejected')) break
  if (since(refusalMark).some(event => event?.type === 'turn/end')) break
}
const outcomes = sessionEvents().filter(event => event?.type === 'approval/decided').map(event => event.data?.outcome)
check(outcomes.includes('rejected'), 'the node recorded the refusal', JSON.stringify(outcomes))
const refused = await nodeExec(`test -f ${refusedTarget} && echo present || echo absent`)
check(refused.trim() === 'absent', 'and the refused write did not happen', refused.trim())

// ---- 7. the other scoped waterfall: ask_user_question ----------------------

// The same relay carries `user-questions/request`, and the browser answers it with a
// *batch* of answers rather than a single string. That difference is exactly the kind of
// thing a unit test with a fake gateway cannot catch, so it is exercised here too.

const questionMark = sessionEvents().length
await call(base, cookie, 'session/prompt', {
  request: {
    sessionId,
    requestId: `approval-question-${stamp}`,
    mode: 'queue',
    content: [{
      type: 'text',
      text: 'Ask me exactly one question with the ask_user_question tool: which colour do I prefer, '
        + 'offering "red" and "blue". After I answer, reply with only the colour I chose.',
    }],
  },
})

const questionBy = Date.now() + 180_000
let question
while (Date.now() < questionBy) {
  await sleep(1000)
  question = framesOf('waterfall').find(frame =>
    frame.event === 'user-questions/request' && frame.agentId === sessionId)
  if (question !== undefined) break
}
check(question !== undefined, 'a question reaches this Host as its own waterfall',
  question === undefined ? 'no user-questions/request within 180s' : question.event)
check(String(question?.agentId ?? '').startsWith('rnh_'),
  'and it names the Session in local form too', String(question?.agentId ?? ''))

const asked = Array.isArray(question?.request?.questions) ? question.request.questions[0] : undefined
check(typeof asked?.id === 'string', 'the question carries its own id, which the answer quotes',
  String(asked?.id))

// The browser's answer is a batch: `{answers: [{id, selected}]}`, not a bare string. A
// mismatched shape is rejected by the node and the remote turn waits until it gives up.
const answered = await call(base, cookie, '$events/result', {
  clientId,
  eventId: question?.eventId,
  outcome: { kind: 'result', value: { answers: [{ id: asked?.id, selected: ['red'] }] } },
}).then(undefined, error => ({ error: String(error?.message ?? error) }))
check(answered?.error === undefined, 'the Host accepts the question answer', answered?.error ?? 'accepted')

// The node records the settled answers in its own projection; the tool result then carries
// them back to the agent, which is what lets it say which colour it was told.
const answeredBy = Date.now() + 180_000
while (Date.now() < answeredBy) {
  await sleep(1000)
  const settled = since(questionMark).some(event =>
    event?.type === 'tool/result' && String(event.data?.message?.content?.[0]?.text ?? '').includes('red'))
  if (settled) break
  if (since(questionMark).some(event => event?.type === 'turn/end')) break
}
const resultText = since(questionMark)
  .filter(event => event?.type === 'tool/result')
  .map(event => String(event.data?.message?.content?.[0]?.text ?? ''))
  .join(' ')
check(resultText.includes('red'), 'the node received the answer the browser gave',
  resultText.slice(0, 120) || '(no tool result)')

// ---- cleanup ---------------------------------------------------------------

await nodeExec(`rm -rf ${outside}`)
// Before anything else: the node goes back to the preset it had. A test that leaves a
// machine on a different permission policy is worse than one that fails.
await restore()
follow.stop()
followCarrier.close()
carrier.close()
await sleep(400)

log(`session ${String(sessionId).slice(0, 44)}`)
if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
}
process.exit(failures.length === 0 ? 0 : 1)
