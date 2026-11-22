/**
 * The artefact install, executed for real on a node — no Host, no npm.
 *
 * This is the piece `version-unit` cannot prove: that the generated shell script
 * actually downloads 169 MB, verifies it, unpacks it into a working runtime, and that
 * the runtime it leaves behind **starts**. A unit test can only check the script's text;
 * the failure modes here (tar flags, a staging directory that already exists, a
 * checksum file with CRLF, `node bin.js --version` exiting non-zero on a fresh tree) are
 * all things that only appear when it runs.
 *
 * It installs into a scratch directory so a node's live runtime is never touched:
 *
 *   ~/.dsh-remote-node-harness/.artefact-test/runtime   ← becomes the runtime
 *   ~/.dsh-remote-node-harness/.artefact-test/run       ← removed afterwards
 *
 * Exit codes: 0 all checks passed, 1 a check failed, 3 **this node cannot download the
 * release artefact** — the install script's own `ARTEFACT_UNAVAILABLE`. That is a property
 * of the network this deployment happens to sit behind, not of the code under test, so the
 * runner records it as SKIP with the reason rather than as a failure. Measured here: the
 * accelerator is unreachable and the direct GitHub URL sustains ~41 KiB/s, so a 165 MiB
 * artefact needs about 68 minutes — far past the script's own 30-minute ceiling, which is
 * the ceiling doing its job.
 *
 * Run:
 *   RNH_TEST_HOST=… RNH_TEST_USER=… RNH_TEST_PASSWORD=… \
 *   node test/artefact-acceptance.mjs [--version <dsh version>] [--platform linux-x64]
 *
 * Without `--version` the version comes from the running Host (`/rnh/api/nodes` reports it
 * as `local.version`), which is the version a node actually has to be able to run. A
 * hard-coded default went stale once — `0.2.2-rc.3` was deleted from CNB, every run then
 * answered 404 and the suite reported SKIP — and a test that skips itself forever is worse
 * than one that fails.
 */
import { nodeExec, nodeRun } from './node.mjs'
import { platformTag } from '../src/remote/artefact.js'

const log = message => process.stdout.write(`[artefact-acceptance] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

/**
 * The DSH version the node must be able to run: this Host's own.
 *
 * `run-all` passes `<base> <token>` to every suite, and `/rnh/api/nodes` answers with the
 * running version. Falling back to the environment keeps the script usable on its own.
 *
 * @returns {Promise<string | undefined>}
 */
async function runningVersion() {
  const explicit = process.env.DSH_INSTALL_VERSION
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const [base, token] = process.argv.slice(2).filter(part => !part.startsWith('--'))
  if (base === undefined || token === undefined || !/^https?:/u.test(base)) return undefined
  try {
    const { authenticate } = await import('./carrier.mjs')
    const cookie = await authenticate(base, token)
    const body = await fetch(`${base}/rnh/api/nodes`, { headers: { cookie } }).then(response => response.json())
    return typeof body?.local?.version === 'string' ? body.local.version : undefined
  } catch {
    return undefined
  }
}

const version = value('version', await runningVersion())
const platform = value('platform', 'linux-x64')
if (version === undefined) {
  log('no DSH version to install: pass --version, set DSH_INSTALL_VERSION, or run through run-all')
  process.exit(3)
}
log(`installing DSH ${version} for ${platform}`)

/**
 * Quote one string so `sh -c` receives it unchanged.
 *
 * The install script contains single quotes of its own (it is shell), and a naive
 * `replaceAll` turns those into a quoting bug that reads as a truncated download: the
 * script is cut short, `tar` sees a partial archive, and every later check fails for a
 * reason that has nothing to do with the code under test. The POSIX rule is to close the
 * quote, emit an escaped quote, and reopen it.
 * @param {string} text
 * @returns {string}
 */
function shellQuote(text) {
  return text.replaceAll("'", `'\\''`)
}

// The plugin builds the tag from the node's own uname; use the same rule here so this
// test would notice if the mapping drifted.
const probe = await nodeExec('uname -s; uname -m; command -v curl; command -v tar; command -v sha256sum')
const [os, arch, curl, tar, sha] = probe.trim().split('\n').map(line => line.trim())
check(curl !== '', 'the node has curl', curl)
check(tar !== '', 'the node has tar', tar)
check(sha !== '', 'the node has sha256sum', sha)
check(platformTag({ os, arch }) === platform,
  `the node's own uname maps to ${platform}`, `${os}/${arch} → ${String(platformTag({ os, arch }))}`)

const root = '~/.dsh-remote-node-harness/.artefact-test'
const runtime = `${root}/runtime`
const cli = `${runtime}/node_modules/@deepseek-ai/dsh/lib/bin.js`

// Import the real script generator: the test must run the bytes the plugin would.
const { installScript, artefactUrls, rollbackScript } = await import('../src/remote/artefact.js')
const urls = artefactUrls({ version, platform })
const script = installScript({ version, runtime, cli, urls })

await nodeExec(`rm -rf ${root} && mkdir -p ${root}`)
log(`installing ${version} on ${platform} into ${root}`)
const started = Date.now()
// The script's own limit is 1800 s per download; this outer one only exists so a wedged
// SSH channel cannot hold the suite forever.
const installed = await nodeRun(`sh -c '${shellQuote(script)}'`, { timeoutMs: 1_900_000 })
const elapsed = Math.round((Date.now() - started) / 1000)
log(`install took ${String(elapsed)}s`)
// The script reports its own failures on stderr — `ARTEFACT_UNAVAILABLE` (the download
// never completed), `ARTEFACT_CHECKSUM_MISMATCH`, `ARTEFACT_SHAPE_UNEXPECTED` (the archive
// does not hold the tree the script expects). Reading only stdout made a 465 s truncated
// download look like a silent success that left an empty directory, which is why this
// branch reports the exit code and stderr first.
if (installed.code !== 0 || installed.stderr.trim().length > 0) {
  log(`install exited ${String(installed.code)}${installed.timedOut ? ' (it was cut off by this test\'s own limit)' : ''}`)
  for (const line of installed.stderr.trim().split('\n').slice(-6)) log(`  stderr: ${line.trim()}`)
}
// Exit 3 is the script's own vocabulary for "this network cannot get the artefact"
// (`ARTEFACT_UNAVAILABLE`): the line failed the speed floor, or no candidate URL answered.
// That is a condition of *this deployment*, not a defect in the script — the same code
// installs fine on a node that can reach the release. Reporting it as a failure would make
// a network problem look like a broken plugin, and reporting it as a pass would be a lie,
// so it is a SKIP with the reason the runner prints.
if (installed.code === 3 && /ARTEFACT_UNAVAILABLE/u.test(installed.stderr)) {
  log(`SKIP: this node could not download the release artefact — ${installed.stderr.trim().replaceAll('\n', ' ').slice(-160)}`)
  await nodeExec(`rm -rf ${root}`)
  process.exit(3)
}
const lastLine = installed.stdout.trim().split('\n').at(-1) ?? ''
check(installed.code === 0 && lastLine.includes(version),
  'the installed CLI reports the requested version',
  `exit ${String(installed.code)}: ${lastLine || installed.stderr.trim().split('\n').at(-1) || 'no output'}`)

// ---- what the install left behind -----------------------------------------
// Each line is a labelled answer rather than a bare value: a failed `test` prints
// nothing, and an unlabelled empty line silently shifts every later field.
const tree = await nodeExec(
  `test -f ${cli} && echo cli=yes || echo cli=no; `
  + `test -d ${runtime}/node_modules/@deepseek-ai/dsh/node_modules && echo nested=yes || echo nested=no; `
  + `echo packages=$(ls ${runtime}/node_modules | wc -l); `
  + `echo size=$(du -sm ${runtime} | cut -f1)`,
)
const field = name => tree.trim().split('\n')
  .map(line => line.trim())
  .find(line => line.startsWith(`${name}=`))
  ?.slice(name.length + 1)
check(field('cli') === 'yes', 'the runtime has a CLI to start', field('cli'))
check(field('nested') === 'no',
  'the tree is flat the way npm installs into a project, not nested as published', field('nested'))
// `ls node_modules | wc -l` counts top-level entries, so 200-ish is the real number for
// a ~830-package install: the rest live under the `@scope` directories.
check(Number(field('packages')) > 150, 'and it carries the full dependency set',
  `${String(field('packages'))} top-level entries`)
check(Number(field('size')) > 500, 'with the size a real install has', `${String(field('size'))} MiB`)

// The natives have to be the node's own platform, which is the whole reason the
// artefact is per-platform.
const natives = await nodeExec(
  `ls ${runtime}/node_modules | grep -E '^(sherpa-onnx|node-pty|sharp)' ; `
  + `ls ${runtime}/node_modules/@img 2>/dev/null | head -4`,
)
check(/sherpa-onnx-linux-x64/u.test(natives), 'native speech support is the Linux build',
  natives.trim().split('\n').slice(0, 3).join(','))
check(!/win-x64|darwin/u.test(natives), 'and no foreign-platform native came along',
  natives.trim().split('\n').slice(0, 3).join(','))
check(/sharp-linux-x64/u.test(natives), 'image support is the Linux build too')

// ---- the payloads the runtime spawns directly ------------------------------
// The defect this exists for, measured on a real node on 2026-11-21: a Windows packer cannot
// record an executable bit, the installer used to restore only `spawn-helper`, and a Linux
// tree has no `spawn-helper` — so `@vscode/ripgrep-linux-x64/bin/rg` landed at 0666 and every
// `glob`/`grep` call answered "ripgrep provider failure" while the gate said "in step".
// Checking the mode is not enough: what matters is that the binary runs.
const payloads = await nodeExec(
  `rg=${runtime}/node_modules/@vscode/ripgrep-linux-x64/bin/rg; `
  + `test -f "$rg" && echo rg=present || echo rg=absent; `
  + `test -x "$rg" && echo rgexec=yes || echo rgexec=no; `
  + `"$rg" --version 2>&1 | head -1 | cut -d' ' -f1-2 | sed 's/^/rgversion=/'; `
  + `ll=${runtime}/node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run; `
  + `test -x "$ll" && echo landlockexec=yes || echo landlockexec=no`,
)
const payloadField = name => payloads.trim().split('\n')
  .map(line => line.trim())
  .find(line => line.startsWith(`${name}=`))
  ?.slice(name.length + 1)
check(payloadField('rg') === 'present', 'the runtime ships the ripgrep it spawns',
  payloadField('rg'))
check(payloadField('rgexec') === 'yes',
  'and that binary is executable after unpack — this is what glob/grep die without',
  payloadField('rgexec'))
check(/^ripgrep/u.test(payloadField('rgversion') ?? ''),
  'it actually runs, which is the only proof the mode is right',
  payloadField('rgversion'))
check(payloadField('landlockexec') === 'yes',
  'the Linux sandbox launcher is executable too', payloadField('landlockexec'))

// ---- the runtime actually starts -----------------------------------------
// `--version` is the cheapest thing that imports the real entry point; if a native
// module were missing or the wrong ABI this is where it fails.
const version_ = await nodeExec(`node ${cli} --version 2>&1 | tail -2`)
check(version_.trim() === version, 'the runtime runs and reports its version', version_.trim())
const helped = await nodeExec(`node ${cli} --help 2>&1 | head -3`)
check(helped.trim().length > 0 && !/Error|Cannot find/u.test(helped),
  'and its CLI resolves its own dependencies', helped.trim().split('\n')[0])

// ---- a second install is idempotent --------------------------------------
const again = await nodeRun(`sh -c '${shellQuote(script)}'`, { timeoutMs: 1_900_000 })
if (again.code !== 0) log(`the second install exited ${String(again.code)}: ${again.stderr.trim().split('\n').at(-1) ?? ''}`)
check(again.code === 0 && (again.stdout.trim().split('\n').at(-1) ?? '').includes(version),
  'a second install replaces the first cleanly',
  `exit ${String(again.code)}: ${again.stdout.trim().split('\n').at(-1) ?? again.stderr.trim().split('\n').at(-1) ?? 'no output'}`)
const previous = await nodeExec(`test -d ${runtime}.previous && echo kept || echo none`)
check(previous.trim() === 'kept', 'the replaced tree is kept for rollback', previous.trim())

// ---- rollback restores it ------------------------------------------------
const rolled = await nodeRun(`sh -c '${shellQuote(rollbackScript(runtime))}'`)
check(rolled.code === 0 && rolled.stdout.trim().includes('rolled-back'), 'rollback reports what it did',
  rolled.code === 0 ? rolled.stdout.trim() : `exit ${String(rolled.code)}: ${rolled.stderr.trim()}`)
const stillThere = await nodeExec(`test -f ${cli} && node ${cli} --version`)
check(stillThere.trim().includes(version), 'and the runtime still runs after it', stillThere.trim())

await nodeExec(`rm -rf ${root}`)
log(`cleaned ${root}`)
if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
}
process.exit(failures.length === 0 ? 0 : 1)
