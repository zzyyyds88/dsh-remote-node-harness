/**
 * `core/errors.js` and `host/node-log.js` — the two pieces the settings page needs to say
 * *what* failed and let a person act on it, checked without a node.
 *
 * What this proves, and why each matters:
 *
 *   - every SSH category maps onto a code, and a code's `action` is one a client can localise;
 *   - a throw site that names a code wins over the phase guess (the more specific fact wins);
 *   - a phase with no explicit code still lands on a code naming the stage, not `unknown`;
 *   - `retryable` is a fact about the cause: a wrong password is not retryable, a dropped
 *     socket is — that is the difference between offering a button and lying;
 *   - the log redacts on **write**, so nothing that reached the buffer can leak through a
 *     copy, and it is bounded.
 *
 * Usage: node test/errors-unit.mjs
 */
import { ERROR_ACTIONS, ERROR_CODES, classifyFailure } from '../src/core/errors.js'
import { LOG_LINES, NodeLog, redact } from '../src/host/node-log.js'

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

if (failed > 0) {
  process.stdout.write(`\n[errors-unit] FAILED: ${String(failed)} check(s)\n`)
  process.exitCode = 1
} else {
  process.stdout.write('\n[errors-unit] all checks passed\n')
}
