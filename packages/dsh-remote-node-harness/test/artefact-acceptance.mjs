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
const { installScript, artefactUrls, rollbackScript, parseScriptResult, ROLLBACK_VERDICTS, SCRIPT_CODES }
  = await import('../src/remote/artefact.js')
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
// The script answers in **one JSON object on its last stdout line** on every exit path, and
// the exit code carries no meaning (see `parseScriptResult`). Reading the exit code and
// searching stderr was the old contract: a `set -e` abort or a killed `curl` exited with a
// number no branch knew, and `ARTEFACT_UNAVAILABLE` was found by substring — which meant a
// truncated stderr could silently change a failure's category.
const result = parseScriptResult(installed)
if (!result.parsed) {
  log(`the install printed no result line (exit ${String(installed.code)}${installed.timedOut ? ', cut off by this test\'s own limit' : ''})`)
  for (const line of `${installed.stdout}\n${installed.stderr}`.trim().split('\n').slice(-8)) log(`  output: ${line.trim()}`)
}
// `ARTEFACT_UNAVAILABLE` means this network could not get the artefact: the line failed the
// speed floor, or no candidate URL answered. That is a condition of *this deployment*, not a
// defect in the script — the same code installs fine on a node that can reach the release.
// Reporting it as a failure would make a network problem look like a broken plugin, and
// reporting it as a pass would be a lie, so it is a SKIP with the reason the runner prints.
if (result.code === SCRIPT_CODES.ARTEFACT_UNAVAILABLE) {
  log(`SKIP: this node could not download the release artefact — ${(result.detail || result.tail).replaceAll('\n', ' ').slice(-160)}`)
  await nodeExec(`rm -rf ${root}`)
  process.exit(3)
}
check(result.ok && result.code === SCRIPT_CODES.INSTALLED,
  'the install reports INSTALLED',
  `code=${result.code} stage=${result.stage}${result.detail === '' ? '' : ` detail=${result.detail}`}${result.tail === '' ? '' : ` tail=${result.tail.slice(-160)}`}`)
check(result.version === version,
  'and the version the tree it made live reports',
  `${String(result.version)} vs ${version}`)

// ---- what the install left behind -----------------------------------------
// Under the generation layout the live path is a **symlink** to `runtime.<n>`, and exactly one
// previous generation is kept beside it. The old assertions looked for `runtime.previous`,
// which this layout no longer creates: keeping a numbered generation is what makes the switch
// one `ln -sfn` instead of three renames with a window in the middle where no runtime exists.
const shape = await nodeExec(
  `test -L ${runtime} && echo link=yes || echo link=no; `
  + `echo target=$(readlink ${runtime} 2>/dev/null); `
  + `echo gens=$(cd ${root} && ls -d runtime.* 2>/dev/null | wc -l); `
  + `echo stamp=$(cat ${runtime}/.rnh-artefact.json 2>/dev/null)`,
)
const shapeField = name => shape.trim().split('\n')
  .map(line => line.trim())
  .find(line => line.startsWith(`${name}=`))
  ?.slice(name.length + 1)
check(shapeField('link') === 'yes',
  'the live runtime is a symlink to a numbered generation', shapeField('link'))
check(/^runtime\.\d+$/u.test(shapeField('target') ?? ''),
  'and it points at a generation, not at a path inside one', shapeField('target'))
check(Number(shapeField('gens')) <= 2,
  'at most two generations exist: the live one and the one before it',
  String(shapeField('gens')))
let stamp
try {
  stamp = JSON.parse(shapeField('stamp') ?? '')
} catch {
  stamp = undefined
}
check(stamp?.build !== undefined,
  'the tree carries the build stamp, without which every connect reinstalls', shapeField('stamp'))
// Each line is a labelled answer rather than a bare value: a failed `test` prints
// nothing, and an unlabelled empty line silently shifts every later field.
//
// `du` must **dereference**: since the install became a transaction, `runtime` is a symlink
// to a numbered generation (`runtime -> runtime.<n>`), and plain `du -sm` on a symlink reports
// 0 — it measures the link, not the tree. Measured: this check failed with `0 MiB` on a
// perfectly good 355 MiB install the first time the symlink layout ran end to end.
const tree = await nodeExec(
  `test -f ${cli} && echo cli=yes || echo cli=no; `
  + `test -d ${runtime}/node_modules/@deepseek-ai/dsh/node_modules && echo nested=yes || echo nested=no; `
  + `echo packages=$(ls ${runtime}/node_modules | wc -l); `
  + `echo size=$(du -smL ${runtime} | cut -f1)`,
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
// The floor is a **truncation detector**, not a size target. The upstream install is ~830 MiB
// unpacked, but this project ships a fork that is trimmed at build time (ADR-0007: 2014.6 MiB
// → 267.4 MiB unpacked), so the honest number on a node is a few hundred MiB — measured
// 354 MiB for `0.2.2-rc.5`. A hard-coded `> 500` from the upstream figure failed a perfectly
// good install and said nothing about whether the download was complete.
check(Number(field('size')) > 200, 'with the size the trimmed runtime really has',
  `${String(field('size'))} MiB (the fork trims the upstream tree; see ADR-0007)`)

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
const againRun = await nodeRun(`sh -c '${shellQuote(script)}'`, { timeoutMs: 1_900_000 })
const again = parseScriptResult(againRun)
if (!again.ok) log(`the second install reported ${again.code} at ${again.stage}: ${again.detail || again.tail}`)
check(again.ok && again.code === SCRIPT_CODES.INSTALLED,
  'a second install replaces the first cleanly',
  `code=${again.code} stage=${again.stage}${again.generation === undefined ? '' : ` generation=${again.generation}`}`)
const gensAfter = await nodeExec(`cd ${root} && ls -d runtime.* 2>/dev/null | sort -V | tr '\\n' ' '`)
const generationNames = gensAfter.trim().split(/\s+/u).filter(name => /^runtime\.\d+$/u.test(name))
check(generationNames.length === 2,
  'the replaced generation is kept beside the new one, and only it', gensAfter.trim())
// The tree that was live before this second install must still start: that is what makes it a
// usable fallback rather than a directory that merely exists.
const keptOk = generationNames.length === 2
  ? await nodeExec(`node ${root}/${generationNames[0]}/node_modules/@deepseek-ai/dsh/lib/bin.js --version 2>&1 | tail -1`)
  : ''
check(keptOk.trim().includes(version),
  'and that kept generation still starts', keptOk.trim())

// ---- rollback keeps the live tree when it still runs -----------------------
// The old assertion here was "rollback reports rolled-back". That was the defect in one line:
// after a *successful* second install the live tree starts perfectly, so a rollback must keep it.
// Unconditionally switching to the previous generation downgraded the node one release, and
// every failed download (checksum, unpack, shape, executable bit — all before the commit line)
// did exactly that.
const rolledRun = await nodeRun(`sh -c '${shellQuote(rollbackScript(runtime, cli))}'`, { timeoutMs: 120_000 })
const rolled = parseScriptResult(rolledRun)
check(rolled.code === ROLLBACK_VERDICTS.KEPT_CURRENT,
  'rollback keeps a live runtime that still starts', `${rolled.code} at ${rolled.stage}`)
const stillThere = await nodeExec(`test -f ${cli} && node ${cli} --version`)
check(stillThere.trim().includes(version), 'and the runtime is still the one that was installed', stillThere.trim())
const gensKept = await nodeExec(`cd ${root} && ls -d runtime.* 2>/dev/null | sort -V | tr '\\n' ' '`)
check(gensKept.trim() === gensAfter.trim(),
  'with the older generation untouched beside it', gensKept.trim())

await nodeExec(`rm -rf ${root}`)
log(`cleaned ${root}`)
if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
}
process.exit(failures.length === 0 ? 0 : 1)
