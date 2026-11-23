/**
 * `core/errors.js` and `host/node-log.js` — the two pieces the settings page needs to say
 * *what* failed and let a person act on it, plus the SSH failure categories they are fed.
 * No node is needed: a loopback `ssh2` server stands in for the one handshake that matters.
 *
 * What this proves, and why each matters:
 *
 *   - every SSH category maps onto a code, and a code's `action` is one a client can localise;
 *   - a throw site that names a code wins over the phase guess (the more specific fact wins);
 *   - a refused host key stays a host key even though ssh2 says nothing recognisable and the
 *     node is in `probe` (whose fallback is a **retryable** network fault) — the one failure
 *     where a wrong answer is a retry loop with no way out;
 *   - a phase with no explicit code still lands on a code naming the stage, not `unknown`;
 *   - `retryable` is a fact about the cause: a wrong password is not retryable, a dropped
 *     socket is — that is the difference between offering a button and lying;
 *   - the log redacts on **write**, so nothing that reached the buffer can leak through a
 *     copy, and it is bounded.
 *
 * Usage: node test/errors-unit.mjs
 */
import ssh2 from 'ssh2'
import { ERROR_ACTIONS, ERROR_CODES, classifyFailure } from '../src/core/errors.js'
import { LOG_LINES, NodeLog, redact } from '../src/host/node-log.js'
import { SshConnection, classifySshError, hostKeyRejection, toSshError } from '../src/ssh/connection.js'

let failed = 0
const check = (ok, label, detail) => {
  if (ok) {
    process.stdout.write(`[errors-unit] ok   ${label}\n`)
    return
  }
  failed += 1
  process.stdout.write(`[errors-unit] FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

// ---- 1. the table is well formed -------------------------------------------
{
  for (const [code, entry] of Object.entries(ERROR_CODES)) {
    check(ERROR_ACTIONS.includes(entry.action), `${code} names an action a client can localise`, entry.action)
    check(typeof entry.message === 'string' && entry.message.length > 0, `${code} has a message`)
    check(typeof entry.retryable === 'boolean', `${code} says whether retrying can help`)
  }
  check(ERROR_CODES['ssh-auth'].retryable === false,
    'a refused credential is not retryable — pressing Connect again produces the same refusal')
  check(ERROR_CODES['ssh-closed'].retryable === true,
    'a dropped socket is retryable — that is what the reconnect ladder relies on')
}

// ---- 2. SSH categories map onto codes --------------------------------------
{
  const cases = [
    ['auth', 'ssh-auth'],
    ['host-key', 'ssh-host-key'],
    ['timeout', 'ssh-timeout'],
    ['network', 'ssh-network'],
    ['closed', 'ssh-closed'],
  ]
  for (const [category, expected] of cases) {
    const error = Object.assign(new Error(`ssh said ${category}`), { sshCategory: category })
    const classified = classifyFailure(error)
    check(classified.code === expected, `ssh category ${category} becomes ${expected}`, classified.code)
    check(classified.detail === `ssh said ${category}`, 'the original message is kept as detail', classified.detail)
  }
  // `category` (not `sshCategory`) is what `toSshError` writes; both have to work.
  const viaCategory = classifyFailure(Object.assign(new Error('x'), { category: 'network' }))
  check(viaCategory.code === 'ssh-network', 'the `category` spelling works too', viaCategory.code)
}

// ---- 2b. a refused host key is never a retryable network fault --------------
// The reported bug: a machine whose key changed was rendered as "cannot reach the machine /
// check the network / retry", with a retry that looped forever. Three independent facts have
// to hold, and only the first one is about ssh2's text:
//
//   - the literal ssh2 raises when its verifier says no classifies as a host key;
//   - a structured mark (what this project's own verifier sets) does too, without any text;
//   - the mark outranks text, so a sentence naming both causes cannot be misread.
{
  // ssh2 v1.17.0, `lib/protocol/kex.js:1206/1210/1233/1237`: `level = 'handshake'`, message is
  // this literal and nothing else. It is the dependency's string, so the test pins the exact
  // spelling: a reworded ssh2 must fail here rather than silently become `ssh-network`.
  const literal = Object.assign(new Error('Host denied (verification failed)'), { level: 'handshake' })
  const byLiteral = classifyFailure(literal, { phase: 'probe' })
  check(byLiteral.code === 'ssh-host-key',
    'ssh2\'s own "Host denied (verification failed)" is a host key, not a network fault', byLiteral.code)
  check(byLiteral.action === 'review-host-key', 'so the card offers to review the key', byLiteral.action)
  check(byLiteral.retryable === false, 'and no retry button that cannot help', String(byLiteral.retryable))
  check(classifySshError(literal) === 'host-key', 'the SSH layer agrees', classifySshError(literal))

  // A wrapper around the same message must not lose it: the panel is told a host key was
  // refused, not that the reconnect ladder should try again.
  const wrapped = Object.assign(new Error('ssh handshake failed: Host denied (verification failed)'), {})
  check(classifyFailure(wrapped, { phase: 'probe' }).code === 'ssh-host-key',
    'a wrapper around ssh2\'s rejection still classifies as a host key',
    classifyFailure(wrapped, { phase: 'probe' }).code)

  // The structured path, with a message that says nothing at all. This is what our own
  // `hostVerifier` produces (see `hostKeyRejection`), and it must work purely off the mark.
  const marked = hostKeyRejection(new Error('whatever ssh2 said'))
  check(classifySshError(marked) === 'host-key', 'a marked error needs no text to classify', classifySshError(marked))
  const byMark = classifyFailure(marked, { phase: 'probe' })
  check(byMark.code === 'ssh-host-key', 'and classifyFailure reads the mark', byMark.code)
  check(byMark.action === 'review-host-key', 'with the review action', byMark.action)
  check(byMark.retryable === false, 'and not retryable', String(byMark.retryable))

  // The mark wins over contradictory text: the sentence below names a credential, and the
  // auth pattern would have claimed it. A refusal decided by the verifier is not a refusal of
  // the credential, however the sentence reads.
  const markedWithAuthWords = Object.assign(
    hostKeyRejection(new Error('publickey authentication failed: Host denied (verification failed)')),
    {},
  )
  check(classifySshError(markedWithAuthWords) === 'host-key',
    'a host-key mark outranks auth-looking text', classifySshError(markedWithAuthWords))

  // Old ordering bug, without any mark: the auth pattern contains the word `password`, and it
  // used to be tested before the host-key pattern, so this sentence became `auth` and offered
  // "fix the credential". Host key must win.
  const ambiguous = new Error('Host key verification failed; the password authentication step was not reached')
  check(classifySshError(ambiguous) === 'host-key',
    'text naming both a host key and a password is a host key', classifySshError(ambiguous))
  const ambiguousWrapped = toSshError(ambiguous)
  check(classifyFailure(ambiguousWrapped, { phase: 'probe' }).code === 'ssh-host-key',
    'and the panel is told so', classifyFailure(ambiguousWrapped, { phase: 'probe' }).code)

  // The rest of the text rules still work — moving the host-key rule must not swallow them.
  // Each is checked through the real pipeline (`toSshError` reads the sentence and attaches the
  // category; `classifyFailure` reads the category), because that is the path a live failure
  // travels. `classifyFailure` alone sees no sentence by design: text classification belongs to
  // the SSH layer, and duplicating it in `core/errors.js` would be a second, drifting copy.
  const textCases = [
    [new Error('All configured authentication methods failed'), 'auth', 'ssh-auth'],
    [new Error('Timed out while waiting for handshake'), 'timeout', 'ssh-timeout'],
    [new Error('connect ECONNREFUSED 127.0.0.1:22'), 'network', 'ssh-network'],
    // A full channel budget is retried inside the SSH layer; it has no panel code of its own,
    // so only the category is asserted for it.
    [new Error('Channel open failure: open failed'), 'channel', undefined],
    [new Error('No response from server'), 'closed', 'ssh-closed'],
  ]
  for (const [error, category, expectedCode] of textCases) {
    check(classifySshError(error) === category,
      `"${error.message}" classifies as ${category}`, classifySshError(error))
    if (expectedCode !== undefined) {
      const classified = classifyFailure(toSshError(error), { phase: 'probe' })
      check(classified.code === expectedCode,
        `  and the panel code is ${expectedCode}`, classified.code)
      check(classified.detail === error.message, '  with the original sentence kept', classified.detail)
    }
  }

  // A throw site's own precise ssh code survives a re-wrap: `toSshError` is called again on
  // the way out of the retry loop, and a downgrade there would put the bug back.
  const rewrapped = toSshError(marked)
  check(rewrapped.code === 'ssh-host-key', 're-wrapping keeps the explicit ssh code', String(rewrapped.code))
  check(classifyFailure(rewrapped, { phase: 'probe' }).code === 'ssh-host-key',
    'so the panel still sees a host key after the retry ladder', classifyFailure(rewrapped, { phase: 'probe' }).code)
}

// ---- 3. an explicit code wins over the phase -------------------------------
{
  const explicit = Object.assign(new Error('node is 22'), { code: 'node-too-old' })
  const classified = classifyFailure(explicit, { phase: 'probe' })
  check(classified.code === 'node-too-old',
    'a throw site that names a code wins over the phase guess', classified.code)
  check(classified.action === 'upgrade-node', 'and brings its own action', classified.action)

  // A code this table does not know is not passed through: a typo must not reach the client as
  // a key it has no sentence for.
  const bogus = Object.assign(new Error('x'), { code: 'not-a-real-code' })
  check(classifyFailure(bogus, { phase: 'start' }).code === 'host-start',
    'an unknown code falls back to the phase', classifyFailure(bogus, { phase: 'start' }).code)
}

// ---- 4. the phase names the stage when nothing else does -------------------
{
  const phases = [
    ['install', 'runtime-install'],
    ['provision', 'provision'],
    ['start', 'host-start'],
    ['verify', 'host-verify'],
  ]
  for (const [phase, expected] of phases) {
    const classified = classifyFailure(new Error('boom'), { phase })
    check(classified.code === expected, `a failure during ${phase} is reported as ${expected}`, classified.code)
  }
  check(classifyFailure(new Error('boom')).code === 'unknown',
    'with no code and no phase it is `unknown` rather than a guess')
  check(classifyFailure(new Error('boom'), { phase: 'nonsense' }).code === 'unknown',
    'an unrecognised phase is not treated as a code')
}

// ---- 5. redaction happens before storage ----------------------------------
{
  const cases = [
    ['password=hunter2 connecting', 'hunter2'],
    ['passphrase: "correct horse"', 'correct horse'],
    ['Authorization: Bearer abc.def', 'abc.def'],
    ['token=ghp_1234567890', 'ghp_1234567890'],
    ['api-key: sk-live-999', 'sk-live-999'],
    ['ssh://root:s3cret@10.0.0.1:22', 's3cret'],
  ]
  for (const [line, secret] of cases) {
    const cleaned = redact(line)
    check(!cleaned.includes(secret), `redact removes ${JSON.stringify(secret)}`, cleaned)
    check(cleaned.length > 0, `redact keeps the line readable for ${JSON.stringify(line)}`, cleaned)
  }
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----'
  check(!redact(`key is ${key}`).includes('AAAA'), 'a private key block is replaced whole')
  check(redact('connecting to 10.0.0.1') === 'connecting to 10.0.0.1',
    'an ordinary line is untouched')
}

// ---- 5b. every action leads somewhere -------------------------------------
// The card offers one control per action, and the client's `FailureBlock` switches on exactly
// these keys. An action with no control is the bug this table cannot see by itself: the
// settings page showed "fix the credential" as a link that opened the log, which reads as
// having no button at all. The set is closed on purpose — a new code has to reuse one.
{
  const ACTIONS = [
    'fix-credential', 'review-host-key', 'check-network', 'retry',
    'upgrade-node', 'upgrade-desktop', 'reinstall', 'inspect-log',
  ]
  for (const [code, entry] of Object.entries(ERROR_CODES)) {
    check(ACTIONS.includes(entry.action), `${code}'s action is one the card can render`, entry.action)
  }
  // The two that are worth a primary button: one acts inside this surface, the other changes
  // what the next connect will accept. The rest either explain or open the log.
  const primary = Object.entries(ERROR_CODES)
    .filter(([, entry]) => ['retry', 'reinstall', 'check-network', 'fix-credential', 'review-host-key']
      .includes(entry.action))
    .map(([code]) => code)
  check(primary.length > 0, 'at least one code gets an actionable control', primary.join(','))
  // `ssh-auth` must not be retryable — pressing Connect with the same wrong password is the
  // definition of a button that cannot help.
  check(ERROR_CODES['ssh-auth'].retryable === false, 'a refused credential offers no plain retry')
  check(ERROR_CODES['ssh-auth'].action === 'fix-credential',
    'and it offers the form that can change the credential')
  check(ERROR_CODES['ssh-host-key'].action === 'review-host-key',
    'a changed host key offers to forget the recorded one')
  check(ERROR_CODES['ssh-network'].action === 'check-network',
    'an unreachable machine offers a probe rather than a full reconnect')
}

// ---- 6. the log is bounded, ordered and redacted --------------------------
{
  const log = new NodeLog()
  log.push('first line')
  log.push('password=hunter2')
  log.push('   ')
  const lines = log.lines()
  check(lines.length === 2, 'a blank line is not stored', String(lines.length))
  check(lines[0].text === 'first line', 'lines keep their order', lines[0].text)
  check(!lines[1].text.includes('hunter2'), 'a secret never reaches the buffer', lines[1].text)
  check(typeof lines[0].at === 'number' && lines[0].at > 0, 'each line carries a timestamp')

  for (let index = 0; index < LOG_LINES + 25; index += 1) log.push(`line ${String(index)}`)
  check(log.lines().length === LOG_LINES,
    `the buffer holds ${String(LOG_LINES)} lines and no more`, String(log.lines().length))
  check(log.lines().at(-1).text === `line ${String(LOG_LINES + 24)}`,
    'the newest line is the one kept last', log.lines().at(-1).text)
  check(log.lines()[0].text === `line ${String(25)}`, 'the oldest lines are the ones dropped', log.lines()[0].text)

  const text = log.text()
  check(text.includes('INFO'), 'the copied text names the level')
  check(/^\d{4}-\d{2}-\d{2}T/u.test(text), 'and starts each line with an ISO timestamp', text.slice(0, 40))

  log.clear()
  check(log.lines().length === 0, 'clear empties it', String(log.lines().length))
}

// ---- 7. the same failure over a real handshake ------------------------------
// Sections 2-2b use hand-crafted errors. This one is end to end, and it is placed last because
// it is the only check that opens a socket and awaits. Two reasons it is worth a socket:
//
//   - it proves the `hostVerifier` this project writes actually marks the refusal (2b only
//     proves a hand-made mark is *read*), so the fix is not "we classified a string we wrote";
//   - it pins what the panel is told from a real refusal: `review-host-key`, not retryable.
//     Measured before the fix on this same loopback server: the panel got
//     `{code: ssh-network, action: check-network, retryable: true}` — a Retry button for a
//     changed key, which can only ever fail again.
//
// The server is a loopback `ssh2` server, so nothing external is contacted.
{
  const { private: hostKey } = ssh2.utils.generateKeyPairSync('ed25519')
  // How many TCP connections the server saw. A host-key refusal must not be retried, so the
  // three attempts below must be exactly three dials: if the refusal were ever reclassified
  // into a retryable category, `#connectWithRetry` would dial again and this would grow.
  let connections = 0
  const server = new ssh2.Server({ hostKeys: [hostKey] }, client => {
    connections += 1
    client.on('authentication', context => context.accept())
    client.on('error', () => undefined)
  })
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address()
  const target = extra => ({
    host: '127.0.0.1',
    port,
    username: 'root',
    auth: { kind: 'password', password: 'x' },
    log: () => undefined,
    ...extra,
  })

  // First use: the key is recorded and the handshake proceeds (trust on first use).
  let recorded
  const first = new SshConnection(target({ onFirstFingerprint: fingerprint => { recorded = fingerprint } }))
  let firstUseError
  try {
    await first.client()
  } catch (error) {
    firstUseError = error
  }
  check(firstUseError === undefined, 'a first-use key is recorded and accepted', firstUseError?.message)
  check(typeof recorded === 'string' && recorded.length > 0, 'and the fingerprint was handed back', recorded)
  check(connections === 1, 'that took exactly one handshake', String(connections))
  first.dispose()

  // The recorded key is accepted on the next handshake.
  const second = new SshConnection(target({ hostFingerprint: recorded }))
  let matchError
  try {
    await second.client()
  } catch (error) {
    matchError = error
  }
  check(matchError === undefined, 'the recorded key is accepted', matchError?.message)
  check(connections === 2, 'and that is a second handshake', String(connections))
  second.dispose()

  // The key changed. This is the reported failure, and this is where it used to come out as
  // `ssh-network` (retryable) with a Retry button that looped.
  let mismatchCallbacks = 0
  const third = new SshConnection(target({
    hostFingerprint: 'de:ad:be:ef',
    onFingerprintMismatch: () => { mismatchCallbacks += 1 },
  }))
  let refusal
  try {
    await third.client()
  } catch (error) {
    refusal = error
  }
  check(refusal !== undefined, 'a changed key refuses the handshake')
  // A guard, not the red-before-the-fix check: a refusal must never be retried, and this is the
  // only place the retry ladder (`MAX_RETRIES`) can be observed from outside. Before the fix the
  // SSH layer said `unknown` (not retryable either), so this number was already 3 — the bug was
  // one layer up, in what the panel was told; see the assertions below.
  check(connections === 3, 'the refusal is not retried — one dial per attempt', String(connections))
  check(mismatchCallbacks === 1, 'the mismatch is reported once', String(mismatchCallbacks))
  check(refusal?.sshCategory === 'host-key',
    'the refusal carries the structured mark, not just ssh2\'s sentence', String(refusal?.sshCategory))
  check(refusal?.code === 'ssh-host-key', 'and the panel code is set at the source', String(refusal?.code))
  const live = classifyFailure(refusal, { phase: 'probe' })
  check(live.code === 'ssh-host-key', 'so a real handshake lands on ssh-host-key', live.code)
  check(live.action === 'review-host-key', 'which is the review-the-key control', live.action)
  check(live.retryable === false, 'and is not retried', String(live.retryable))
  third.dispose()

  await new Promise(resolve => { server.close(resolve) })
}

if (failed > 0) {
  process.stdout.write(`\n[errors-unit] FAILED: ${String(failed)} check(s)\n`)
  process.exitCode = 1
} else {
  process.stdout.write('\n[errors-unit] all checks passed\n')
}
