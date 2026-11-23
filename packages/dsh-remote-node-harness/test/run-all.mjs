/**
 * Run the whole acceptance matrix with one command, and report honestly.
 *
 * The three layers answer three different questions and none of them substitutes for
 * another: pure logic proves a branch, the seam tests prove the plugin still fits inside
 * the installed DSH, and the end-to-end tests prove that a user's click reaches a real
 * node. A green unit run says nothing about whether a remote Session can write a file, and
 * a green end-to-end run says nothing about which release it ran against. So this runner
 * keeps them separate, prints one row per suite, and **fails if any suite fails**.
 *
 * It is also the only place that knows how to launch what the end-to-end layer needs:
 * the seam tests must run under Electron's Node (they read `app.asar`), and the end-to-end
 * tests need a Host of their own plus a connected node. Discovering that by hand is the
 * step people skip, and a skipped step here reads exactly like a passing one.
 *
 * Usage:
 *   node test/run-all.mjs                     # everything it can run here
 *   node test/run-all.mjs --layer offline     # no Host, no node: seconds
 *   node test/run-all.mjs --layer contract    # seam tests under Electron's Node
 *   node test/run-all.mjs --layer e2e         # launches a Host and a node
 *   node test/run-all.mjs --host <base> --token <t>   # reuse a running Host
 *   node test/run-all.mjs --skip artefact,browser     # the slow / external ones
 *   node test/run-all.mjs --list
 *
 * Options:
 *   --layer <a,b>`     offline | contract | e2e      (default: all three)
 *   --host/--token     reuse a running Host instead of spawning one
 *   --profile <name>   profile to launch the Host with (default: rnhtest)
 *   --skip <a,b>`      suite names to skip, e.g. browser,artefact
 *   --only <a,b>`      run just these suite names
 *   --keep-host        do not stop a Host this run started (for debugging)
 *   --list             print the matrix and exit
 *
 * A suite that cannot run is reported as SKIP with the reason — never as a pass. A suite
 * that fails prints its own last lines, because the interesting part of a failure is
 * almost never the exit code.
 *
 * @module @greatbaby/dsh-remote-node-harness/test/run-all
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE = resolve(HERE, '..')
const REPO = resolve(PACKAGE, '..', '..')
const LOGS = join(REPO, '.scratch', 'run-all')

// ---- arguments ------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = name => argv.includes(`--${name}`)
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const list = name => (value(name, '') === '' ? undefined : value(name).split(',').map(part => part.trim()).filter(Boolean))

const layers = list('layer') ?? ['offline', 'contract', 'e2e']
const only = list('only')
const skipped = list('skip') ?? []
const keepHost = flag('keep-host')
const reuseHost = value('host')
const reuseToken = value('token')
const profile = value('profile', 'rnhtest')

// ---- the matrix -----------------------------------------------------------

/**
 * One suite.
 *
 * `needs` is what decides whether it can run here, and it is checked rather than assumed:
 * reporting an end-to-end suite as skipped-because-there-is-no-node is honest, reporting
 * it as passed because the process exited 0 after bailing early is not.
 *
 * @typedef {object} Suite
 * @property {string} name
 * @property {'offline' | 'contract' | 'e2e'} layer
 * @property {string[]} file - path parts under the repository root.
 * @property {'node' | 'electron'} runtime - which Node has to execute it.
 * @property {number} timeoutMs
 * @property {'host' | 'node' | 'chrome' | 'release' | undefined} needs
 * @property {string} proves - one line, for the matrix printout.
 */

/** @type {Suite[]} */
const SUITES = [
  // ---- pure logic: no Host, no node, no Electron --------------------------
  {
    name: 'routing',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'routing-unit.mjs'],
    runtime: 'node',
    timeoutMs: 120_000,
    proves: 'identity round-trip, stream fan-out, workspace merge, local passthrough, job endpoints',
  },
  {
    name: 'routing-extra',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'routing-extra-unit.mjs'],
    runtime: 'node',
    timeoutMs: 120_000,
    proves: 'the remaining identity-carrying namespaces route by their own shape: goals/userQuestions by Agent, feedback by request field, subagents by child uuid, and schedule merges while its per-entry verbs route',
  },
  {
    name: 'multipart',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'multipart-unit.mjs'],
    runtime: 'node',
    timeoutMs: 120_000,
    proves: 'a multipart reply decodes into bytes at the right JSON path; malformed parts are rejected, and the part count and byte total are bounded',
  },
  {
    name: 'ws-frame',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'ws-frame-unit.mjs'],
    runtime: 'node',
    timeoutMs: 120_000,
    // Three defects live here and none of them is visible from a working node: a damaged
    // control frame, a fragmented message decoded as whole text, and a buffer with no
    // ceiling.
    proves: 'the RFC 6455 codec: every length branch round-trips, a control frame over 125 bytes is refused instead of sent damaged, fragmentation and RSV bits are refused by code, and both buffer budgets hold',
  },
  {
    name: 'http-over-ssh',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'http-over-ssh-unit.mjs'],
    runtime: 'node',
    timeoutMs: 120_000,
    // `asSocket` used to make `setTimeout` a no-op, so this is the layer that had no
    // deadline at all; the fake channel is a real `Duplex`, so `node:http` drives the same
    // path a node does.
    proves: 'one exchange over a forwarded channel: a normal answer, a deadline that fires with rnh/timeout, a body over the ceiling with rnh/too-large, and an abort that reaches forwardOut',
  },
  {
    name: 'error-frame',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'error-frame-unit.mjs'],
    runtime: 'node',
    timeoutMs: 120_000,
    // The worst silent failure in the repository: `finish()` reached the consumer before the
    // error did, and `AsyncQueue.fail` dropped an error arriving after `end()`.
    proves: 'a node error frame reaches the browser as an error rather than an end of stream, through the real carrier, the real AsyncQueue and the real gateway',
  },
  {
    name: 'provision',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'provision-unit.mjs'],
    runtime: 'electron',
    timeoutMs: 180_000,
    proves: 'what is written onto a node: provider rows copied, account rows not, the result parses as YAML',
  },
  {
    name: 'waterfall',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'waterfall-unit.mjs'],
    runtime: 'node',
    timeoutMs: 120_000,
    proves: 'approval/question relay: only allowed waterfalls cross, refusal and timeout each settle once',
  },
  {
    name: 'version',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'version-unit.mjs'],
    runtime: 'node',
    timeoutMs: 120_000,
    proves: 'version gate branches, artefact URLs, install script, per-node layout, switch semantics',
  },
  {
    name: 'fork-runtime',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'fork-runtime-unit.mjs'],
    runtime: 'node',
    timeoutMs: 60_000,
    proves: 'the fork trim rules: what a node keeps, what it drops and why, and that the build and the publisher strip the same residue list',
  },
  {
    name: 'node-patches',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'node-patches-unit.mjs'],
    runtime: 'node',
    timeoutMs: 60_000,
    proves: 'the source-patch chain: every patch follows NNNN-slug.patch, applies through git apply --3way, and has a complete row in the deviation ledger',
  },
  {
    name: 'fork-base',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'fork-base-unit.mjs'],
    runtime: 'node',
    timeoutMs: 120_000,
    proves: 'the build refuses a fork whose commits above the pinned tag are unrecorded, and a hand-edited file no patch touches — the two ways an archive stops matching its ledger',
  },
  {
    name: 'rnh-lifecycle',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'rnh-lifecycle-unit.mjs'],
    runtime: 'node',
    timeoutMs: 60_000,
    proves: 'a dropped socket becomes idle with a timestamp, the reconnect ladder arms and a deliberate disconnect cancels it, the first host key is recorded and handed back, a failed connect keeps its phase, and an unreachable node keeps its workspace rows',
  },
  {
    name: 'errors',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'errors-unit.mjs'],
    runtime: 'node',
    timeoutMs: 60_000,
    proves: 'a connect failure becomes a code with one action and a retryable flag, and a node\'s own log redacts secrets before storing them and stays bounded',
  },
  {
    name: 'picker-paths',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'picker-paths-unit.mjs'],
    runtime: 'node',
    timeoutMs: 60_000,
    proves: 'the /@rnh namespace round-trips through both path normalisers, and the shadow cleanup cannot delete a directory with anything in it',
  },
  {
    name: 'install',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'install-unit.mjs'],
    runtime: 'node',
    timeoutMs: 60_000,
    proves: 'the manifest a bundle is installed from is self-consistent: every patch file exists, files covers every runtime artefact, the detail page is real',
  },
  {
    name: 'autoconnect',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'autoconnect-unit.mjs'],
    runtime: 'node',
    timeoutMs: 60_000,
    proves: 'a restarted Host connects its nodes without a click: autoConnect adopts the stored credential first, and still skips nodes that have none',
  },
  {
    name: 'rnh-control',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'rnh-control-unit.mjs'],
    runtime: 'node',
    timeoutMs: 60_000,
    proves: 'the node-control surface: a pasted secret is refused, a reference is read locally, and a result can never carry authentication material',
  },
  {
    name: 'relay-patch',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'relay-patch-unit.mjs'],
    runtime: 'node',
    timeoutMs: 120_000,
    proves: 'the edit that lets a routed Session read files lands exactly once, refuses an unknown relay bundle whole, is idempotent across Host restarts, breaks no hard-linked sibling, and can be reverted byte for byte',
  },
  {
    name: 'transfer',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'transfer-unit.mjs'],
    runtime: 'node',
    timeoutMs: 120_000,
    proves: 'the download numbers shown during a first connect: a rate averaged over a window rather than one tick, an ETA only when both a total and a rate exist and never negative, and nothing invented when the source will not say its size',
  },
  {
    name: 'composition',
    layer: 'offline',
    file: ['packages', 'rnh-brain', 'scripts', 'check-composition.mjs'],
    runtime: 'electron',
    timeoutMs: 180_000,
    proves: 'the node composition is still a brain: Remote controllers in, no client-UI rows, YAML parses',
  },
  {
    name: 'generated',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'generated-sync-unit.mjs'],
    runtime: 'node',
    timeoutMs: 60_000,
    // `composition` reads the SOURCE files only, so a source edit whose `embed-into-rnh`
    // rebuild was skipped passes it and ships the old composition to the node. This one
    // compares the embedded copy against the sources, which is the missing half.
    proves: 'the embedded brain bundle is the files on disk: same set, same bytes, and a header that names them',
  },
  {
    name: 'capabilities',
    layer: 'offline',
    file: ['packages', 'rnh-brain', 'scripts', 'check-capabilities.mjs'],
    runtime: 'node',
    timeoutMs: 120_000,
    // The single-source gate. Everything a node's capability implies — composed rows, preset
    // rows, kept packages, dropped packages, the provisioning whitelist, the bundle names —
    // is asserted against `capabilities.mjs`, so a declaration changed in one place and not the
    // others fails here instead of on a node at the first tool call. `--strict` is what turns
    // its report into a failure; without it the script only prints.
    args: ['--strict'],
    proves: 'every place that declares what a node can do agrees with capabilities.mjs: rows, presets, kept and dropped packages, the provisioning whitelist, the bundle names',
  },
  {
    name: 'packet',
    layer: 'offline',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'packet-unit.mjs'],
    runtime: 'node',
    timeoutMs: 60_000,
    proves: 'no payload rides a command line: one exec request is one SSH packet, and OpenSSH drops the connection over 256 KiB',
  },

  // ---- contract seams: must run under Electron's Node ---------------------
  {
    name: 'descriptor',
    layer: 'contract',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'descriptor-smoke.mjs'],
    runtime: 'electron',
    timeoutMs: 180_000,
    proves: 'the upstream descriptors and `static inject` are readable from the installed release',
  },
  {
    name: 'dispatch',
    layer: 'contract',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'dispatch-seam.mjs'],
    runtime: 'electron',
    timeoutMs: 180_000,
    proves: 'the Gateway still dispatches to an own property on the instance, and the endpoint set is unchanged',
  },
  {
    name: 'upstream',
    layer: 'contract',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'upstream-smoke.mjs'],
    runtime: 'electron',
    timeoutMs: 180_000,
    proves: 'the upstream controllers the decorators wrap still export what the wrappers expect',
  },

  // ---- end to end: a real Host, a real node -------------------------------
  // `needs: 'host'`, not `'node'`: this suite reads the node's `status.json` and insists the
  // pid in it is alive, and that file only names a live process when **this Host** has
  // connected the node (`ensureServing` starts it). Declared `'node'` it ran first on a cold
  // start, before any host-backed suite, and read a status file left behind by an earlier run
  // whose process was gone — a red "the resident host is not running" that says nothing about
  // the code. Measured: on a cold `run-all.mjs` it failed for exactly that reason, and passed
  // in 878 ms as soon as a Host had connected the node.
  {
    name: 'gateway',
    layer: 'e2e',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'gateway-smoke.mjs'],
    runtime: 'node',
    timeoutMs: 300_000,
    needs: 'host',
    proves: 'cookie, unary RPC and the stream carrier work over SSH against a resident node',
  },
  {
    name: 'host-routing',
    layer: 'e2e',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'host-routing.mjs'],
    runtime: 'node',
    timeoutMs: 600_000,
    needs: 'host',
    proves: 'every routed endpoint through the local `/api`, plus one binary read; unprompted endpoints stay local',
  },
  {
    name: 'workspace-flow',
    layer: 'e2e',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'workspace-flow.mjs'],
    runtime: 'node',
    timeoutMs: 600_000,
    needs: 'host',
    proves: 'add remote workspace → new Session → send a prompt → the node runs it → the file is on the node disk',
  },
  {
    name: 'workspace-browse',
    layer: 'e2e',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'workspace-browse.mjs'],
    runtime: 'node',
    timeoutMs: 600_000,
    needs: 'host',
    proves: 'the folder dialog lists this machine and a node in one shape, and a picked node folder becomes a workspace',
  },
  {
    name: 'picker-flow',
    layer: 'e2e',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'picker-flow.mjs'],
    runtime: 'node',
    timeoutMs: 600_000,
    needs: 'host',
    proves: 'the phone\'s view of a node: /@rnh lists nodes, a node\'s folders come back spelled in the namespace, and the folder the relay created on this desktop is removed again',
  },
  {
    name: 'plugin-switch',
    layer: 'e2e',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'plugin-switch.mjs'],
    runtime: 'node',
    timeoutMs: 900_000,
    needs: 'host',
    proves: 'a per-plugin switch installs or copies the plugin onto the node, composes it before the brain, and the node keeps working',
  },
  {
    name: 'tool-parity',
    layer: 'e2e',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'tool-parity.mjs'],
    runtime: 'node',
    timeoutMs: 900_000,
    needs: 'host',
    proves: 'the agent\'s own read/write/edit/grep/glob hit node paths; no Windows path leaks into the transcript',
  },
  {
    name: 'tool-git-image',
    layer: 'e2e',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'tool-git-image.mjs'],
    runtime: 'node',
    timeoutMs: 900_000,
    needs: 'host',
    proves: 'git against a real repo, `read_image` on a real PNG, grep on a real file — the three a mirror scheme breaks',
  },
  {
    name: 'client-bundle',
    layer: 'e2e',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'client-bundle.mjs'],
    runtime: 'node',
    timeoutMs: 300_000,
    needs: 'host',
    proves: 'the desktop really serves this client code and the three slots are registered and render',
  },
  {
    name: 'event-relay',
    layer: 'e2e',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'event-relay.mjs'],
    runtime: 'node',
    timeoutMs: 300_000,
    needs: 'host',
    proves: 'a Session created on the node reaches the browser wrapped, with no bare node id leaking',
  },
  {
    name: 'session',
    layer: 'e2e',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'session-acceptance.mjs'],
    runtime: 'node',
    timeoutMs: 900_000,
    needs: 'host',
    proves: 'drive a real remote turn (write/bash/grep), read `session/follow`, then witness the bytes over a separate SSH',
  },
  {
    name: 'terminal',
    layer: 'e2e',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'terminal-acceptance.mjs'],
    runtime: 'node',
    timeoutMs: 600_000,
    needs: 'host',
    proves: 'a real PTY on the node: environment, shells, create, attach snapshot, echo round-trip, close',
  },
  {
    name: 'multi-node',
    layer: 'e2e',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'multi-node-acceptance.mjs'],
    runtime: 'node',
    timeoutMs: 900_000,
    needs: 'host',
    proves: 'two nodes at once: distinct ids, sessions land on the right one, removing one leaves the other intact',
  },
  {
    name: 'artefact',
    layer: 'e2e',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'artefact-acceptance.mjs'],
    runtime: 'node',
    // The suite installs twice (the second install proves replacement + rollback), and each
    // install downloads a ~165 MiB archive. On a fast mirror that is 70 s; measured on a slow
    // one it was 653 s per install. Two downloads at the script's own 1800 s ceiling plus
    // unpack and `node --version` is the honest upper bound, so this budget is 45 minutes.
    // It is network-bound, not CPU-bound: it is the one suite worth `--skip artefact` for a
    // quick loop, and the one whose runtime says nothing about the plugin's own speed.
    timeoutMs: 2_700_000,
    needs: 'release',
    proves: 'the real install script on the real node: download, checksum, unpack, replace, version, rollback',
  },
  {
    name: 'approval',
    layer: 'e2e',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'approval-acceptance.mjs'],
    runtime: 'node',
    timeoutMs: 900_000,
    needs: 'host',
    proves: 'a node approval reaches this Host as a waterfall, the answer resumes the remote turn, and a refusal is honoured',
  },
  {
    name: 'node-control',
    layer: 'e2e',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'node-control.mjs'],
    runtime: 'node',
    timeoutMs: 600_000,
    needs: 'host',
    // Its own `node_config` is not needed: this suite manages nodes, it does not drive one.
    proves: 'the node-control preset is registered with two rows, a Session from it can call rnh_nodes and no other tool at all, and the answer is the real roster',
  },
  {
    name: 'browser',
    layer: 'e2e',
    file: ['packages', 'dsh-remote-node-harness', 'test', 'browser-acceptance.mjs'],
    runtime: 'node',
    timeoutMs: 600_000,
    needs: 'chrome',
    proves: 'a real Chrome renders the remote workspaces in the ordinary sidebar, and the plugin entry is reachable',
  },
]

if (flag('list')) {
  for (const suite of SUITES) {
    process.stdout.write(`${suite.layer.padEnd(9)} ${suite.name.padEnd(16)} ${suite.runtime.padEnd(9)} ${suite.proves}\n`)
  }
  process.exit(0)
}

// ---- environment ----------------------------------------------------------

/**
 * Where DSH is installed, for the seam tests and for the desktop binary.
 *
 * Two constraints make this less obvious than it looks. First, the plugin runs under
 * Electron's Node, which can stat paths *inside* `app.asar`; this runner runs under plain
 * Node, which cannot — so the layout is discovered from things that really exist on disk
 * (the desktop executable, the `app.asar` file) rather than by probing the install
 * directory, which would report "not found" for a perfectly good installation. Second,
 * when the plugin passes `DSH_INSTALL_DIR` in, it is trusted as-is for the same reason.
 *
 * @returns {{ installDir: string | undefined, electron: string | undefined, why: string }}
 */
function locateInstall() {
  const fromEnv = process.env.DSH_INSTALL_DIR
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return { installDir: fromEnv, electron: electronFor(fromEnv), why: 'DSH_INSTALL_DIR' }
  }
  // The CLI ships inside the desktop app; that is the only instance whose `app.asar` the
  // plugin is written against, so there is nothing to look for besides this one app.
  const executables = [
    'C:\\Program Files\\DSH\\DeepSeek Harness.exe',
    'C:\\Program Files (x86)\\DSH\\DeepSeek Harness.exe',
    '/opt/DSH/DeepSeek Harness',
    '/opt/DSH/deepseek-harness',
    '/usr/lib/DSH/DeepSeek Harness',
  ].filter(candidate => existsSync(candidate))
  if (executables.length === 0) {
    return { installDir: undefined, electron: undefined, why: 'the desktop app was not found' }
  }
  const electron = executables[0]
  const asar = join(dirname(electron), 'resources', 'app.asar')
  const installDir = join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
  // `app.asar` is a real file, so this check works under plain Node; the directory inside
  // it is not stat-able here, which is fine — Electron will find it.
  return {
    installDir,
    electron,
    why: existsSync(asar) ? 'discovered next to the desktop app' : 'the desktop app has no app.asar',
  }
}

/** The desktop executable that can act as a Node (`ELECTRON_RUN_AS_NODE=1`). */
function electronFor(installDir) {
  // …/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh → …/resources → <app>
  const resources = resolve(installDir, '..', '..', '..', '..', '..')
  const app = dirname(resources)
  for (const name of ['DeepSeek Harness.exe', 'DeepSeek Harness', 'dsh-desktop']) {
    const candidate = join(app, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const install = locateInstall()
if (install.installDir !== undefined) process.env.DSH_INSTALL_DIR = install.installDir

/** The SSH node the end-to-end suites need, if it was configured at all. */
const nodeConfigured = typeof process.env.RNH_TEST_HOST === 'string'
  && process.env.RNH_TEST_HOST.length > 0
  && typeof process.env.RNH_TEST_USER === 'string'
  && process.env.RNH_TEST_USER.length > 0

// ---- reporting ------------------------------------------------------------

const rows = []
const paint = (text, code) => (process.stdout.isTTY ? `\u001B[${code}m${text}\u001B[0m` : text)
const PASS = text => paint(text, '32')
const FAIL = text => paint(text, '31')
const SKIP = text => paint(text, '33')
const DIM = text => paint(text, '2')

/**
 * Run one suite to completion, capturing its output in a file.
 *
 * Output goes to a file rather than a pipe on purpose: a pipe this process does not drain
 * fast enough would block the child, and an end-to-end suite that stalls because its own
 * log filled up looks exactly like a broken route. A file also leaves the evidence behind.
 *
 * @param {Suite} suite
 * @param {string[]} extraArgs
 * @returns {Promise<{ status: 'PASS' | 'FAIL' | 'TIMEOUT', ms: number, log: string }>}
 */
async function runSuite(suite, extraArgs = []) {
  mkdirSync(LOGS, { recursive: true })
  const logPath = join(LOGS, `${suite.name}.log`)
  const target = join(REPO, ...suite.file)
  if (!existsSync(target)) {
    writeFileSync(logPath, `${target} does not exist\n`, 'utf8')
    return { status: 'FAIL', ms: 0, log: logPath }
  }

  const electronMode = suite.runtime === 'electron'
  if (electronMode && install.electron === undefined) {
    writeFileSync(logPath, 'the desktop executable was not found; cannot run under Electron\'s Node\n', 'utf8')
    return { status: 'FAIL', ms: 0, log: logPath }
  }

  const executable = electronMode ? install.electron : process.execPath
  // `--expose-internals` is what the seam tests need to require upstream internals; it is
  // only meaningful under the desktop binary, so the plain-Node path does not get it.
  // `suite.args` carries flags the suite itself parses (`check-capabilities --strict` turns its
  // report into a gate). Declared per suite rather than appended to `extraArgs`, because those
  // are the Host coordinates handed to the end-to-end suites and would be nonsense here.
  const suiteArgs = Array.isArray(suite.args) ? suite.args : []
  const args = electronMode
    ? ['--expose-internals', target, ...suiteArgs, ...extraArgs]
    : [target, ...suiteArgs, ...extraArgs]
  // The third argument to `openSync` is the **mode**, and it only applies when `O_CREAT` is
  // set. Passing the flags value there by habit made every log file read-only on Windows
  // (mode 577 has no owner-write bit), so the next run could not truncate its own log and
  // died with EPERM before running a single suite — measured, and it looked like a
  // sandbox denial rather than a mistake in this file.
  const fd = openSync(logPath, 'w', 0o644)
  const env = { ...process.env }
  // Clear a caller's value first: an inherited `ELECTRON_RUN_AS_NODE=1` would make the
  // plain-Node suites run under the desktop binary and a stale `=0` would break the seams.
  delete env.ELECTRON_RUN_AS_NODE
  if (electronMode) env.ELECTRON_RUN_AS_NODE = '1'

  const started = Date.now()
  const child = spawn(executable, args, {
    cwd: REPO,
    // No pipes: see the doc comment. `stdio: 'ignore'` for stdin keeps an interactive
    // prompt from silently swallowing the run.
    stdio: ['ignore', fd, fd],
    env,
    windowsHide: true,
  })
  closeSync(fd)

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, suite.timeoutMs)

  const code = await new Promise(resolveCode => {
    child.on('error', error => {
      writeFileSync(logPath, `spawn failed: ${String(error?.message ?? error)}\n`, 'utf8')
      resolveCode(-1)
    })
    child.on('close', exitCode => resolveCode(exitCode ?? -1))
  })
  clearTimeout(timer)

  const ms = Date.now() - started
  if (timedOut) return { status: 'TIMEOUT', ms, log: logPath }
  // A suite that finds this deployment cannot exercise it exits 3 and says why in its own
  // output. That is a SKIP, not a pass: reporting it as PASS would let a deployment that
  // can never ask for approval look fully accepted.
  if (code === 3) return { status: 'SKIP', ms, log: logPath, reason: tail(logPath, 1)[0] }
  return { status: code === 0 ? 'PASS' : 'FAIL', ms, log: logPath }
}

/** The last few lines of a failure, which is where the reason always is. */
function tail(logPath, lines = 8) {
  try {
    return readFileSync(logPath, 'utf8').trim().split('\n').slice(-lines)
  } catch {
    return ['(the log could not be read)']
  }
}

const duration = ms => (ms < 1000 ? `${String(ms)}ms` : `${(ms / 1000).toFixed(1)}s`)

// ---- a Host for the end-to-end layer -------------------------------------

/**
 * Launch the Host this run will talk to, and read its one-time launch token.
 *
 * The token is the browser's only way in and it is different on every start, so it has to
 * be scraped from the log the Host writes — that log line is the documented way a real
 * desktop gets its URL too.
 *
 * @returns {Promise<{ base: string, token: string, stop: () => void } | { error: string }>}
 */
async function launchHost() {
  if (install.electron === undefined || install.installDir === undefined) {
    return { error: 'the desktop executable was not found, so no Host can be launched' }
  }
  // This path is *inside* `app.asar`, and plain Node cannot stat anything in there — an
  // `existsSync` here answers "missing" for a file Electron opens fine, which is exactly
  // how the first version of this runner skipped all ten end-to-end suites while claiming
  // a clean run. So the file is not checked: Electron is the one that can read it, and if
  // it really cannot, the Host exits and the log says why.
  const cli = join(install.installDir, '..', 'dsh-desktop-host', 'lib', 'cli.js')

  mkdirSync(LOGS, { recursive: true })
  const logPath = join(LOGS, 'host.log')
  const fd = openSync(logPath, 'w', 0o644)
  /**
   * The provider key travels in the child's environment, never in a file.
   *
   * The suites that drive a model (`workspace-flow`, `session`, `approval`, `tool-parity`,
   * `tool-git-image`) need one, and a Host launched here would otherwise have to be
   * configured by hand — which is exactly the setup gap that produced nine "no API key"
   * failures in the last full run. The credentials provider ranks the managed store above
   * the process environment, so this only fills a gap; it never overrides a saved key.
   */
  const providerKey = providerKeyFromHome()
  const child = spawn(install.electron, [
    '--expose-internals', cli,
    '--profile', profile,
    '--host', '127.0.0.1',
    '--port', '0',
    '--no-open',
  ], {
    cwd: REPO,
    stdio: ['ignore', fd, fd],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ...(providerKey === undefined ? {} : { DEEPSEEK_API_KEY: providerKey }),
    },
    windowsHide: true,
  })
  closeSync(fd)

  const stop = () => { try { child.kill() } catch { /* already gone */ } }
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return { error: `the Host exited with ${String(child.exitCode)}; see ${logPath}` }
    }
    let text = ''
    try {
      text = readFileSync(logPath, 'utf8')
    } catch { /* not written yet */ }
    const match = /dsh web: (http:\/\/\S+)/u.exec(text)
    if (match !== null) {
      const url = new URL(match[1])
      return { base: `${url.protocol}//${url.host}`, token: url.searchParams.get('token') ?? '', stop }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  stop()
  return { error: `the Host did not print a URL within 90s; see ${logPath}` }
}

/**
 * Read `DEEPSEEK_API_KEY` out of the real home's credential store, for the test Host.
 *
 * The end-to-end suites that drive a model need a provider key, and this Host is launched
 * with an isolated profile inside the same `DSH_HOME` — the store is shared, so the value is
 * already here. It is handed to the child **through the environment**, which the credentials
 * provider ranks below the file but above `.env`; nothing is written to disk, printed, or
 * copied into `.scratch`.
 *
 * Returns `undefined` when the store has no such ref, which is a real state (a machine that
 * has never signed in) and turns into a named SKIP rather than a failure.
 *
 * @returns {string | undefined}
 */
function providerKeyFromHome() {
  const fromEnv = process.env.DEEPSEEK_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  try {
    const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const match = /DEEPSEEK_API_KEY:\s*(\S+)\s*\}/u.exec(text)
    return match?.[1]
  } catch {
    return undefined
  }
}

/**
 * Bring every recorded node to `connected`, seeding one from `RNH_TEST_*` when there is none.
 *
 * A recorded node already holds its credentials, so nothing has to be passed in; a node
 * that is merely idle is a setup gap this runner can close, and one that is failing is a
 * real failure the end-to-end layer should be told about rather than silently skip past.
 *
 * The seeding half used to be a promise in this function's own error message and no code:
 * `/rnh/api/nodes` answered `[]` and the message told the reader to "set
 * RNH_TEST_HOST/USER/PASSWORD" — which changed nothing, because nothing read those
 * variables. It does now: with the three set, one node is registered, which is what makes
 * a fresh profile runnable without opening the settings surface by hand.
 *
 * @param {string} base
 * @param {string} cookie
 * @returns {Promise<string | undefined>} a reason, when the nodes could not be brought up
 */
async function connectNodes(base, cookie) {
  const headers = { cookie, 'content-type': 'application/json' }
  let nodes = []
  try {
    nodes = (await fetch(`${base}/rnh/api/nodes`, { headers }).then(response => response.json())).nodes ?? []
  } catch (error) {
    return `the node list could not be read: ${String(error?.message ?? error)}`
  }
  if (nodes.length === 0) {
    const host = process.env.RNH_TEST_HOST
    const user = process.env.RNH_TEST_USER
    const password = process.env.RNH_TEST_PASSWORD
    if (host === undefined || host.length === 0 || user === undefined || user.length === 0) {
      return 'no node is recorded in this profile, and RNH_TEST_HOST/USER are not set'
    }
    // The name is what the sidebar shows; it must not be the host address, which never
    // belongs in this repository's output.
    const created = await fetch(`${base}/rnh/api/nodes`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        node: {
          name: process.env.RNH_TEST_NAME ?? 'acceptance-node',
          host,
          port: Number(process.env.RNH_TEST_PORT ?? 22),
          username: user,
          remoteRoot: process.env.RNH_TEST_ROOT ?? undefined,
          ...(password === undefined || password.length === 0 ? {} : { password }),
        },
      }),
    })
    if (!created.ok) {
      return `the node could not be registered: HTTP ${String(created.status)} ${(await created.text()).slice(0, 200)}`
    }
    nodes = (await fetch(`${base}/rnh/api/nodes`, { headers }).then(response => response.json())).nodes ?? []
    if (nodes.length === 0) return 'a node was registered but the Host does not list it'
    process.stdout.write(`${DIM(`  seeded   ${String(nodes[0].name)} from RNH_TEST_*`)}\n`)
  }

  for (const node of nodes) {
    if (node.state === 'connected') continue
    await fetch(`${base}/rnh/api/nodes/${node.id}/connect`, { method: 'POST', headers, body: '{}' })
    const deadline = Date.now() + 300_000
    while (Date.now() < deadline) {
      await new Promise(resolveWait => setTimeout(resolveWait, 2000))
      const current = (await fetch(`${base}/rnh/api/nodes`, { headers }).then(r => r.json()))
        .nodes?.find(candidate => candidate.id === node.id)
      if (current?.state === 'connected') break
      if (current?.state === 'failed') return `node ${node.name} failed to connect: ${String(current.error ?? '')}`
    }
  }

  const after = (await fetch(`${base}/rnh/api/nodes`, { headers }).then(r => r.json())).nodes ?? []
  const down = after.filter(node => node.state !== 'connected')
  if (down.length === after.length) return 'no node reached `connected`'
  // Hand the recorded root down to every suite through the environment. `gateway-smoke`
  // reads it to find the node's `run/status.json`; the suites that can ask the API do so
  // instead, but a script run by hand has no API to ask.
  const connected = after.find(node => node.state === 'connected')
  if (typeof connected?.remoteRoot === 'string') process.env.RNH_TEST_REMOTE_ROOT = connected.remoteRoot
  return undefined
}

// ---- main -----------------------------------------------------------------

const RUNNABLE = s => (only === undefined ? layers.includes(s.layer) : only.includes(s.name))
const WANTED = s => RUNNABLE(s) && !skipped.includes(s.name)

if (SUITES.filter(WANTED).length === 0) {
  process.stdout.write(`nothing to run: layers=${layers.join(',')} only=${String(only)} skip=${skipped.join(',')}\n`)
  process.stdout.write('see --list for the matrix\n')
  process.exit(2)
}

process.stdout.write(`${DIM('dsh-remote-node-harness acceptance')}\n`)
process.stdout.write(`${DIM(`  install  ${String(install.installDir ?? '(not found)')}`)}\n`)
process.stdout.write(`${DIM(`  electron ${String(install.electron ?? '(not found)')}`)}\n`)
process.stdout.write(`${DIM(`  node     ${nodeConfigured ? 'RNH_TEST_* is set' : 'RNH_TEST_* is not set'}`)}\n`)
process.stdout.write('\n')

/** Suites that need a Host and therefore have to wait for one. */
const hostSuites = SUITES.filter(suite => WANTED(suite) && suite.needs === 'host')

let host
/** One Host for the whole end-to-end layer; launching one per suite would reconnect the
 *  node a dozen times and turn a fast run into a slow one for no extra proof. */
async function ensureHost() {
  if (host !== undefined) return host
  const { authenticate } = await import('./carrier.mjs')
  if (reuseHost !== undefined && reuseToken !== undefined) {
    // A reused Host still has to have its nodes up: `host-routing` and `workspace-flow`
    // assert on merged remote rows, and a node left `idle` makes them fail with "0 of N
    // rows" — a false failure that reads exactly like a routing regression. Measured:
    // reusing a freshly launched Host without connecting first failed those two suites,
    // and both passed on the same Host seconds later.
    let reusedCookie
    try {
      reusedCookie = await authenticate(reuseHost, reuseToken)
    } catch (error) {
      host = { error: `the reused Host refused the launch token: ${String(error?.message ?? error)}` }
      return host
    }
    const reusedProblem = await connectNodes(reuseHost, reusedCookie)
    host = {
      base: reuseHost, token: reuseToken, cookie: reusedCookie, stop: () => {}, reused: true,
      ...(reusedProblem === undefined ? {} : { error: reusedProblem }),
    }
    return host
  }
  const launched = await launchHost()
  if (launched.error !== undefined) {
    host = { error: launched.error }
    return host
  }
  let cookie
  try {
    cookie = await authenticate(launched.base, launched.token)
  } catch (error) {
    launched.stop()
    host = { error: `the Host refused the launch token: ${String(error?.message ?? error)}` }
    return host
  }
  const problem = await connectNodes(launched.base, cookie)
  host = { ...launched, cookie, ...(problem === undefined ? {} : { error: problem }) }
  return host
}

/** Why a suite cannot run here, or `undefined` when it can. */
function blocked(suite) {
  if (suite.needs === 'node' || suite.needs === 'host' || suite.needs === 'release') {
    if (!nodeConfigured) return 'RNH_TEST_HOST/USER are not set'
  }
  if (suite.needs === 'release') {
    // The artefact test downloads from the public release; it is the one suite whose
    // result depends on something this machine does not control.
    if (process.env.RNH_SKIP_RELEASE === '1') return 'RNH_SKIP_RELEASE=1'
  }
  if (suite.needs === 'chrome') {
    if (process.env.DSH_BROWSER_DEBUG_PORT === undefined) {
      return 'no Chrome with --remote-debugging-port (set DSH_BROWSER_DEBUG_PORT)'
    }
  }
  if (suite.needs === 'host' || suite.needs === 'chrome') {
    if (host?.error !== undefined) return host.error
  }
  return undefined
}

const results = []
const started = Date.now()

for (const suite of SUITES) {
  if (!WANTED(suite)) continue
  const label = `${suite.layer}/${suite.name}`

  // The seam tests need the install to read from; without it they would fail with a
  // confusing module error rather than the real reason.
  const needsInstall = suite.runtime === 'electron' || suite.needs === 'host'
  if (needsInstall && install.installDir === undefined) {
    process.stdout.write(`${SKIP('SKIP')} ${label.padEnd(26)} ${DIM(install.why)}\n`)
    results.push({ label, status: 'SKIP', reason: install.why })
    continue
  }

  if (suite.needs === 'host' || suite.needs === 'chrome' || suite.needs === 'release') await ensureHost()
  const reason = blocked(suite)
  if (reason !== undefined) {
    process.stdout.write(`${SKIP('SKIP')} ${label.padEnd(26)} ${DIM(reason)}\n`)
    results.push({ label, status: 'SKIP', reason })
    continue
  }

  const extraArgs = []
  if (suite.needs === 'host' || suite.needs === 'chrome' || suite.needs === 'release') {
    // The release suite also takes the Host's address: it installs the version that Host is
    // running, which is the version a node really has to be able to run. A hard-coded
    // default went stale once and turned the suite into a permanent SKIP.
    extraArgs.push(host.base, host.token)
  }
  // The in-progress line exists to say which suite is currently slow, so it is written on a
  // terminal and skipped when the report goes to a file. The escape sequence is what makes
  // the verdict replace that line; without a terminal it would be noise in the middle of
  // the report.
  const tty = process.stdout.isTTY === true
  if (tty) process.stdout.write(`${DIM('....')} ${label.padEnd(26)} ${DIM(suite.proves)}\r`)
  const outcome = await runSuite(suite, extraArgs)
  const verdict = outcome.status === 'PASS' ? PASS('PASS') : outcome.status === 'SKIP' ? SKIP('SKIP') : FAIL(outcome.status)
  results.push({ label, ...outcome })
  const note = outcome.status === 'SKIP' ? ` ${DIM(`— ${String(outcome.reason ?? '').slice(0, 90)}`)}` : ''
  process.stdout.write(`${tty ? '\u001B[2K\r' : ''}${verdict} ${label.padEnd(26)} ${duration(outcome.ms).padStart(7)}  ${DIM(suite.proves)}${note}\n`)
  if (outcome.status !== 'PASS') {
    for (const line of tail(outcome.log)) process.stdout.write(`     ${DIM('│')} ${line}\n`)
    process.stdout.write(`     ${DIM('│')} ${DIM(`full log: ${outcome.log}`)}\n`)
  }
}

if (host?.stop !== undefined && !keepHost && host.reused !== true) host.stop()

// ---- the verdict ----------------------------------------------------------

const failed = results.filter(row => row.status === 'FAIL' || row.status === 'TIMEOUT')
const skippedRows = results.filter(row => row.status === 'SKIP')
const passed = results.filter(row => row.status === 'PASS')

process.stdout.write(`\n${DIM('─'.repeat(72))}\n`)
process.stdout.write(`${String(passed.length)} passed, ${String(failed.length)} failed, `
  + `${String(skippedRows.length)} skipped in ${duration(Date.now() - started)}\n`)
if (failed.length > 0) {
  process.stdout.write(`\n${FAIL('failed')}:\n`)
  for (const row of failed) process.stdout.write(`  ${row.label}  ${row.log ?? ''}\n`)
}
if (skippedRows.length > 0) {
  process.stdout.write(`\n${SKIP('skipped')} (not a pass):\n`)
  for (const row of skippedRows) process.stdout.write(`  ${row.label.padEnd(26)} ${row.reason ?? ''}\n`)
}

// A run in which everything was skipped proves nothing, and must not exit 0 just because
// nothing failed. The end-to-end layer is the part a user actually feels, so a request for
// it that could not run at all is a failure of the run, not a quiet success.
const askedE2e = layers.includes('e2e') && SUITES.some(suite => suite.layer === 'e2e' && WANTED(suite))
const noE2eRan = askedE2e && results.every(row => !row.label.startsWith('e2e/') || row.status === 'SKIP')
if (askedE2e && noE2eRan) {
  process.stdout.write(`\n${FAIL('no end-to-end suite could run')} — the layer that proves a user can work was not exercised\n`)
  process.exit(1)
}

process.exit(failed.length === 0 ? 0 : 1)
