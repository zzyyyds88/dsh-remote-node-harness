/**
 * One vocabulary for "why did this node not come up".
 *
 * A connect can fail in a dozen places — the handshake, the host key, the runtime install, the
 * resident host's own startup, the gateway probe — and each of them used to reach the settings
 * page as whatever sentence happened to be thrown. That is enough to read but not enough to
 * **act** on: "all configured authentication methods failed" and "no accelerator served the
 * linux-x64 artefact" both render as a red line with a retry button, and only one of them is
 * worth retrying.
 *
 * So every failure is classified once, here, into a stable code. The code carries two facts the
 * UI needs and the message does not:
 *
 * - **whether retrying can help** (`retryable`) — a wrong password will fail identically
 *   forever, and offering the same button reads as "the app is broken";
 * - **the one thing the person should do next** (`action`), as a key the client localises.
 *
 * The messages stay English and diagnostic: they are what a log line and a bug report carry.
 * The sentence a person reads is the client's job, because it is bilingual.
 *
 * @module @greatbaby/dsh-remote-node-harness/core/errors
 */

/**
 * Every failure this plugin reports, in one table.
 *
 * `action` is deliberately a small closed set — a person reading the card gets one button, not
 * a decision tree. `retryable` answers "would pressing Connect again change anything", which is
 * a fact about the cause, not about the error's shape.
 */
export const ERROR_CODES = Object.freeze({
  /** The machine refused the credential we hold. */
  'ssh-auth': Object.freeze({
    message: 'the machine refused this node\'s credential',
    action: 'fix-credential',
    retryable: false,
  }),
  /** The host key we recorded is not the key this machine presents now. */
  'ssh-host-key': Object.freeze({
    message: 'the machine presented a different SSH host key than the one recorded for it',
    action: 'review-host-key',
    retryable: false,
  }),
  /** The machine did not answer in time. */
  'ssh-timeout': Object.freeze({
    message: 'the machine did not answer in time',
    action: 'check-network',
    retryable: true,
  }),
  /** No route to the machine: refused, unreachable, DNS. */
  'ssh-network': Object.freeze({
    message: 'the machine could not be reached over the network',
    action: 'check-network',
    retryable: true,
  }),
  /** The connection dropped while it was in use. */
  'ssh-closed': Object.freeze({
    message: 'the connection to the machine was closed',
    action: 'retry',
    retryable: true,
  }),
  /** No stored credential at all. */
  'credential-missing': Object.freeze({
    message: 'this node has no stored credential',
    action: 'fix-credential',
    retryable: false,
  }),
  /** The machine's Node is older than the resident host supports. */
  'node-too-old': Object.freeze({
    message: 'the machine\'s Node.js is older than the resident host supports',
    action: 'upgrade-node',
    retryable: false,
  }),
  /** The runtime could not be installed by either route. */
  'runtime-install': Object.freeze({
    message: 'the node\'s runtime could not be installed',
    action: 'inspect-log',
    retryable: true,
  }),
  /** The node's DSH is newer than this desktop's. */
  'node-ahead': Object.freeze({
    message: 'the node runs a newer DSH than this desktop',
    action: 'upgrade-desktop',
    retryable: false,
  }),
  /** The node's state is not one this desktop can judge. */
  'node-unknown-version': Object.freeze({
    message: 'the node\'s installed version could not be read',
    action: 'reinstall',
    retryable: true,
  }),
  /** Provisioning (plugins, brain bundle, profile) failed. */
  provision: Object.freeze({
    message: 'the node\'s configuration could not be written',
    action: 'inspect-log',
    retryable: true,
  }),
  /** The resident host started but does not answer. */
  'host-start': Object.freeze({
    message: 'the resident host did not start',
    action: 'inspect-log',
    retryable: true,
  }),
  /** The resident host answers but the session channel does not. */
  'host-verify': Object.freeze({
    message: 'the resident host did not answer the session probe',
    action: 'inspect-log',
    retryable: true,
  }),
  /** Anything the table does not name. */
  unknown: Object.freeze({
    message: 'the node could not be connected',
    action: 'inspect-log',
    retryable: true,
  }),
})

/** Every action key a client may be asked to localise. */
export const ERROR_ACTIONS = Object.freeze([
  'fix-credential',
  'review-host-key',
  'check-network',
  'retry',
  'upgrade-node',
  'upgrade-desktop',
  'reinstall',
  'inspect-log',
])

/**
 * Which phase a failure came from, when the throw site does not say.
 *
 * The connect ladder is ordered (`probe` → `install` → `provision` → `start` → `verify`), so the
 * phase the node was in when it failed is already the most specific thing known about the
 * cause. Reading it here means a throw site that reports nothing useful still lands on a code
 * that names the stage — better than `unknown`, and honest about what is known.
 */
const PHASE_CODES = Object.freeze({
  probe: 'ssh-network',
  install: 'runtime-install',
  provision: 'provision',
  start: 'host-start',
  verify: 'host-verify',
})

/**
 * The sentence `ssh2` raises when a host verifier answers "no".
 *
 * This string belongs to the **dependency**, not to this project: ssh2 v1.17.0's
 * `lib/protocol/kex.js` hands it to `doFatalError(protocol, msg, 'handshake', …)` on both the
 * callback path (`kex.js:1206`, thrown at `kex.js:1210`) and the synchronous-return path
 * (`kex.js:1233`, thrown at `kex.js:1237`). `doFatalError` turns it into `new Error(msg)` with
 * `level = 'handshake'` (`lib/protocol/utils.js:171-192`, via `makeError` at 141-151) and emits
 * it from the client, so this project only ever receives the sentence — never the decision.
 *
 * It is matched as a **substring of the message**, tolerating a wrapper around it (`ssh handshake
 * failed: Host denied (verification failed)`), because the phrase is specific to this one
 * failure: grepping ssh2 v1.17.0 for it finds exactly the four lines above and nothing else, so
 * no unrelated failure can contain it by accident. Re-check this on every `ssh2` upgrade: a
 * reworded literal would put a refused host key back on the `check-network` path, which is a
 * retry button that cannot help.
 *
 * This is the fallback, not the main path. The normal case is a **structured** mark: this
 * project's own `hostVerifier` is the code that refused, so it stamps
 * `sshCategory: 'host-key'` and that mark outranks any sentence (see `ssh/connection.js`).
 */
const SSH2_HOST_KEY_REJECTION = 'Host denied (verification failed)'

/**
 * True when `error` is ssh2's host-key rejection.
 *
 * Kept separate from the category check so "who decided" (a structured mark) stays
 * distinguishable from "what it says" (a dependency's literal).
 * @param {unknown} error
 * @returns {boolean}
 */
export function isSsh2HostKeyRejection(error) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.includes(SSH2_HOST_KEY_REJECTION)
}

/**
 * Classify one connect failure.
 *
 * Order matters: an explicit `code` on the error wins (a throw site that knows exactly what
 * went wrong), then the SSH category (which `SshConnection` attaches, and which outranks text
 * because it comes from the code that decided), then ssh2's own host-key literal, then the
 * phase.
 *
 * The literal sits **after the mark and before the phase** on purpose. ssh2 raises it during
 * the handshake, when the node is in `probe`, whose fallback code is `ssh-network` — a
 * retryable network fault. A refused host key is neither a network fault nor retryable; it is
 * the one failure the person can only resolve by reviewing the key.
 *
 * @param {unknown} error
 * @param {{ phase?: string }} [context] - the phase the node was in when it threw.
 * @returns {{ code: string, message: string, action: string, retryable: boolean, detail: string }}
 */
export function classifyFailure(error, context = {}) {
  const detail = error instanceof Error ? error.message : String(error)
  const code = explicitCode(error)
    ?? codeFromSsh(error)
    ?? (isSsh2HostKeyRejection(error) ? 'ssh-host-key' : undefined)
    ?? PHASE_CODES[context.phase ?? '']
    ?? 'unknown'
  const entry = ERROR_CODES[code] ?? ERROR_CODES.unknown
  return {
    code: ERROR_CODES[code] === undefined ? 'unknown' : code,
    message: entry.message,
    action: entry.action,
    retryable: entry.retryable,
    detail,
  }
}

/** A `code` a throw site set explicitly, when it names one this table knows. */
function explicitCode(error) {
  const code = Reflect.get(error ?? {}, 'code')
  return typeof code === 'string' && ERROR_CODES[code] !== undefined ? code : undefined
}

/** The SSH category, mapped onto this table. */
function codeFromSsh(error) {
  const category = Reflect.get(error ?? {}, 'sshCategory') ?? Reflect.get(error ?? {}, 'category')
  if (category === 'auth') return 'ssh-auth'
  if (category === 'host-key') return 'ssh-host-key'
  if (category === 'timeout') return 'ssh-timeout'
  if (category === 'network') return 'ssh-network'
  if (category === 'closed') return 'ssh-closed'
  return undefined
}
