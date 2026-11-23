/**
 * Version arithmetic, the release-artefact plan, and the per-plugin sync switches —
 * pure logic, no Host and no node.
 *
 * These three belong together because they answer one question from three angles:
 * *given this desktop and that node, what has to change over there?* Keeping them out
 * of the connection path means the rules can be tested exhaustively (every ordering,
 * every missing field) without a 1.3 GB install or a real SSH session.
 *
 * Run: `node test/version-unit.mjs`
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  GATE,
  compareVersions,
  decideGate,
  parseVersion,
  requiresProvisioning,
} from '../src/core/version.js'
import {
  ARTEFACT_EXECUTABLE_NAMES,
  BUILD_STAMP,
  ROLLBACK_VERDICTS,
  RUNTIME_BUILD,
  artefactExecutableFind,
  artefactName,
  artefactUrls,
  DEFAULT_SOURCES,
  FETCH_CEILING_SECONDS,
  FETCH_FLOOR_BYTES,
  FETCH_FLOOR_SECONDS,
  inspectRuntime,
  installScript,
  isArtefactExecutable,
  parseStamp,
  platformTag,
  rollbackScript,
  stampJson,
} from '../src/remote/artefact.js'
import { detectLibc, pluginInstallScript, remoteLayout } from '../src/remote/daemon.js'
import {
  installedPlugins,
  isLocalSpec,
  isNeverSynced,
  isThirdParty,
  nodeBundles,
  parseSwitches,
  resolvePlugins,
} from '../src/core/plugin-sync.js'

const log = message => process.stdout.write(`[version-unit] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/**
 * Run a generated shell script the way a node does: as a **file**, not as `-c` text.
 *
 * This matters on the machine running the tests. The `sh`/`bash` here is an MSYS2 binary
 * (Git for Windows), and its command-line-to-argv conversion rewrites backslashes inside a
 * `-c` argument — `we'ird\name` arrives as `we'irdname`. Writing the bytes the plugin would
 * send to a file and executing that file removes the conversion from the comparison, so a
 * check about the script's own quoting is about the script.
 *
 * @param {string} shell - the interpreter found by the caller.
 * @param {string} directory - a scratch directory; the file is written there.
 * @param {string} text - the generated script.
 */
const runShellScript = (shell, directory, text) => {
  const path = join(directory, 'rnh-check.sh')
  writeFileSync(path, `${text}\n`)
  return spawnSync(shell, [path.split('\\').join('/')], { encoding: 'utf8' })
}

// ---- semver precedence, including the pre-release rules DSH actually uses ------
{
  const order = (a, b) => compareVersions(parseVersion(a), parseVersion(b))
  check(order('0.2.2', '0.2.2') === 0, 'equal versions compare equal')
  check(order('0.2.3', '0.2.2') === 1, 'a patch bump is newer')
  check(order('0.3.0', '0.2.9') === 1, 'a minor bump is newer')
  check(order('1.0.0', '0.99.99') === 1, 'a major bump is newer')
  // A release candidate sorts before its release: this is the case that bites.
  check(order('0.2.2-rc.3', '0.2.2') === -1, 'a release candidate is older than its release')
  check(order('0.2.2-rc.3', '0.2.2-rc.4') === -1, 'rc numbers compare numerically, not as text')
  check(order('0.2.2-rc.10', '0.2.2-rc.9') === 1, 'rc.10 is newer than rc.9 (text order would say otherwise)')
  check(order('0.2.2-rc.3', '0.2.2-beta.1') === 1, 'an rc is newer than a beta')
  check(order('v22.20.0', '22.20.0') === 0, 'a leading v is ignored')
  check(parseVersion('not-a-version') === undefined, 'an unreadable version parses to undefined')
  check(parseVersion(undefined) === undefined, 'a missing version parses to undefined')
  check(parseVersion('0.2.2-rc.3')?.text === '0.2.2-rc.3', 'the text is kept for messages')
}

// ---- the gate: every ordering of host vs node -------------------------------
{
  const at = (host, node, hostBrain = '0.3.0', nodeBrain = '0.3.0') =>
    decideGate({ hostVersion: host, hostBrain, nodeVersion: node, nodeBrain })

  check(at('0.2.2', undefined).action === GATE.INSTALL, 'a node with no runtime gets an install')
  check(at('0.2.2', '0.2.1').action === GATE.INSTALL, 'an older node runtime gets an upgrade')
  check(at('0.2.2', '0.2.1').reason === 'node-runtime-behind', 'and says so',
    at('0.2.2', '0.2.1').reason)
  check(at('0.2.2', '0.2.2').action === GATE.CURRENT, 'a matching pair needs nothing')
  check(at('0.2.2', '0.2.3').action === GATE.AHEAD, 'a newer node runtime is refused')
  check(at('0.2.2', '0.2.3').message.includes('Upgrade the desktop app'),
    'with an instruction the user can act on')
  // A node ahead in *brain build* rather than runtime: another desktop provisioned it.
  check(at('0.2.2', '0.2.2', '0.3.0', '0.4.0').action === GATE.AHEAD,
    'a newer node brain build is refused')
  check(at('0.2.2', '0.2.2', '0.3.0', '0.3.0').action === GATE.CURRENT,
    'an equal brain build is current')
  check(at('0.2.2', '0.2.2', '0.3.0', '0.2.0').action === GATE.REFRESH,
    'an older brain build is refreshed')
  // A missing brain build is the ordinary case right after the desktop upgrades: the
  // node has the runtime but not this plugin's bundle.
  check(decideGate({
    hostVersion: '0.2.2', hostBrain: '0.3.0', nodeVersion: '0.2.2', nodeBrain: undefined,
  }).action === GATE.REFRESH, 'a node with no brain build is refreshed')
  check(at('0.2.2', '0.2.2', '0.3.0', '0.3.0-rc.1').action === GATE.REFRESH,
    'a release candidate brain is older than its release')
  check(at(undefined, '0.2.2').action === GATE.UNKNOWN,
    'an unreadable host version is reported, not guessed')
  check(requiresProvisioning(GATE.INSTALL) && requiresProvisioning(GATE.REFRESH),
    'install and refresh are the provisioning actions')
  check(!requiresProvisioning(GATE.CURRENT) && !requiresProvisioning(GATE.AHEAD),
    'current and ahead are not')
  // Every decision carries a message: the settings page shows it verbatim.
  for (const [host, node] of [['0.2.2', undefined], ['0.2.2', '0.1.0'], ['0.2.2', '0.9.9'], ['0.2.2', '0.2.2']]) {
    const decision = at(host, node)
    check(typeof decision.message === 'string' && decision.message.length > 0,
      `every decision explains itself (${String(node)})`, decision.message.slice(0, 60))
  }
}

// ---- the artefact is per-platform, and the URL goes through the accelerator -----
{
  // The platform tag comes from the *node's* uname, translated to npm's spelling: a
  // runtime packed on Windows cannot run on Linux, because node-pty, sharp and
  // sherpa-onnx ship native binaries.
  check(platformTag({ os: 'Linux', arch: 'x86_64' }) === 'linux-x64',
    'uname says Linux/x86_64; the tag is linux-x64', platformTag({ os: 'Linux', arch: 'x86_64' }))
  check(platformTag({ os: 'Linux', arch: 'aarch64' }) === 'linux-arm64',
    'aarch64 maps to arm64')
  check(platformTag({ os: 'Darwin', arch: 'arm64' }) === 'darwin-arm64', 'Darwin maps to darwin')
  // Linux splits its prebuilds by C library, and the artefact name has to carry that split:
  // `koffi` and `sharp` publish both a glibc and a musl build of the same package, and
  // handing an Alpine node the glibc tree installs a library that cannot be loaded. The
  // packer already accepts `linux-x64-musl`; before this, the tag never asked for it.
  check(platformTag({ os: 'Linux', arch: 'x86_64', libc: 'musl' }) === 'linux-x64-musl',
    'a musl node asks for the musl archive', platformTag({ os: 'Linux', arch: 'x86_64', libc: 'musl' }))
  check(platformTag({ os: 'Linux', arch: 'aarch64', libc: 'glibc' }) === 'linux-arm64',
    'a glibc node asks for the plain tag, which is what the packer defaults to')
  check(platformTag({ os: 'Linux', arch: 'x86_64' }) === 'linux-x64',
    'and an unknown libc is treated as glibc, the one the nodes in service run')
  check(platformTag({ os: 'Darwin', arch: 'arm64', libc: 'musl' }) === 'darwin-arm64',
    'a Mac is never given a Linux libc suffix')
  check(platformTag({ os: 'Linux', arch: 'mips' }) === undefined,
    'an unknown architecture has no tag rather than a wrong one')
  check(platformTag({}) === undefined, 'a missing probe result has no tag')
  // Windows is not a tag, which is why the win32-x64 archive was pulled: the probe reads
  // `uname -s`, and Windows answers `MINGW64_NT-10.0-19045` (Git Bash) or has no `uname` at
  // all. Both shapes have to stay untaggable — a tag here would send a Windows machine
  // looking for a tree the node side (21 `sh -c` calls, `setsid`, SSH only) cannot run.
  check(platformTag({ os: 'MINGW64_NT-10.0-19045', arch: 'x86_64' }) === undefined,
    'a Git Bash node has no tag, so no Windows archive is ever requested')
  check(platformTag({ os: 'Windows_NT', arch: 'AMD64' }) === undefined,
    'and neither does a bare Windows_NT probe answer')
  check(artefactName('0.2.2', 'linux-x64') === 'dsh-0.2.2-linux-x64.tar.gz',
    'the file name carries version and platform', artefactName('0.2.2', 'linux-x64'))

  // A node reaches the artefact through a **source list**, and that list is one entry long:
  // CNB. The GitHub accelerators were removed, not reordered — every one of them measured
  // between 0.2 and 9.6 MB/s on the same 172 683 323-byte archive (a 40× spread, which is
  // the difference between "connecting" and "hanging"), and the machines this project serves
  // cannot reach GitHub at all.
  //
  // There is deliberately **no direct-GitHub candidate** either: "try GitHub anyway" is the
  // one fallback guaranteed to be worse than reporting, so an empty source list is a
  // configuration error that throws instead of a quiet slow download.
  const urls = artefactUrls({ version: '0.2.2-rc.3', platform: 'linux-x64' })
  check(urls.length === DEFAULT_SOURCES.length && urls.length === 1,
    'exactly one candidate, because there is exactly one source', String(urls.length))
  check(urls[0] === 'https://cnb.cool/serendipity-archive/dsh-fleet/-/releases/download/v0.2.2-rc.3/dsh-0.2.2-rc.3-linux-x64.tar.gz',
    'CNB, filled into its own URL shape rather than prefixed', urls[0])
  check(!urls.some(url => url.startsWith('https://github.com/')),
    'GitHub direct is never a candidate — a slow fallback reads as a hang', urls.at(-1))
  check(urls.every(url => url.includes('/releases/download/v0.2.2-rc.3/dsh-0.2.2-rc.3-linux-x64.tar.gz')),
    'every candidate points at the same tag and file name')
  check(new Set(urls).size === urls.length, 'the candidates are distinct')
  let emptyThrew = ''
  try { artefactUrls({ version: '1.0.0', platform: 'linux-x64', sources: [] }) }
  catch (error) { emptyThrew = String(error.message) }
  check(emptyThrew.includes('no artefact source configured'),
    'no sources is a named error, not a silent direct download', emptyThrew.slice(0, 80))
  // A private mirror is still one configuration value away, which is why the `prefix` kind
  // survives even though nothing in the defaults uses it.
  check(artefactUrls({ version: '1.0.0', platform: 'linux-x64', sources: [{ kind: 'prefix', prefix: 'https://m.example/' }] })[0]
    .startsWith('https://m.example/https://github.com/'), 'a configured accelerator is used verbatim')
  check(artefactUrls({ version: '1.0.0', platform: 'linux-x64', sources: [{ kind: 'prefix', prefix: 'https://a/' }, { kind: 'prefix', prefix: '' }] })
    .length === 1, 'an empty prefix is not a candidate of its own')
  check(artefactUrls({ version: '1.0.0', platform: 'linux-x64', sources: [{ kind: 'prefix', prefix: 'https://m.example/' }], repository: 'a/b', tag: 'nightly' })[0]
    .includes('/a/b/releases/download/nightly/'), 'the repository and tag are configurable')
  // A template source is a general mechanism, not a hard-coded CNB special case.
  check(artefactUrls({
    version: '1.0.0', platform: 'linux-x64',
    sources: [{ kind: 'template', template: 'https://x/{version}/{platform}/{tag}/{file}' }],
  })[0] === 'https://x/1.0.0/linux-x64/v1.0.0/dsh-1.0.0-linux-x64.tar.gz',
  'a template fills in version, platform, tag and file name')
  let kindThrew = ''
  try { artefactUrls({ version: '1.0.0', platform: 'linux-x64', sources: [{ kind: 'ftp' }] }) }
  catch (error) { kindThrew = String(error.message) }
  check(kindThrew.includes('unknown artefact source kind'),
    'an unknown source kind is reported, not skipped into a shorter list', kindThrew.slice(0, 80))
}

// ---- the install script: what it must contain to be safe --------------------
{
  const script = installScript({
    version: '0.2.2',
    runtime: '/root/.dsh-remote-node-harness/runtime',
    cli: '/root/.dsh-remote-node-harness/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
    urls: ['https://mirror/x.tar.gz', 'https://github/x.tar.gz'],
  })
  check(script.startsWith('set -eu'), 'the install fails fast and stops on error')
  check(script.includes('curl') && script.includes('wget'),
    'it works with either downloader, since a node may have only one')
  check(script.includes('--connect-timeout 15'), 'a hanging download cannot hang the connect')
  // A dead fallback must give up on its own: measured on the test node, the mirror pulled
  // the whole 170 MiB archive in 4 s while the direct GitHub fallback managed 925 KB in
  // 30 s. Without a floor the install sat there for over an hour, which the user sees as
  // "connecting hangs" with nothing to report.
  check(script.includes(`--speed-limit ${FETCH_FLOOR_BYTES}`)
    && script.includes(`--speed-time ${FETCH_FLOOR_SECONDS}`),
  'and a download that stalls gives up instead of running forever')
  check(script.includes(`--max-time ${FETCH_CEILING_SECONDS}`),
    'while a slow but working line still gets a real budget')
  check(script.includes('sha256sum') && script.includes('shasum'),
    'it verifies the checksum on either flavour of coreutils')
  check(script.includes('ARTEFACT_CHECKSUM_MISMATCH'), 'and reports a mismatch by name')
  // **No sidecar is a failure, not a skip.** It used to be `if fetch …; then` — a missing
  // `.sha256` silently skipped the comparison and unpacked unverified bytes, which is exactly
  // the "half-installed runtime that fails at first use" the checksum exists to prevent.
  check(script.includes('ARTEFACT_CHECKSUM_UNAVAILABLE') && script.includes('exit 6'),
    'an archive whose .sha256 cannot be fetched is refused, not unpacked unverified')
  check(!script.includes('if fetch ') || script.includes('ARTEFACT_CHECKSUM_UNAVAILABLE'),
    'the checksum step is unconditional, not an `if fetch …` that can fall through')
  // The script is a template, so the CLI path is already substituted into it: the
  // assertion has to look for the substituted form.
  check(script.includes('node "/root/.dsh-remote-node-harness/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" --version'),
    'and the result is verified by running the installed CLI')
  check(script.includes('.incoming'), 'it unpacks into a staging directory')

  const rollback = rollbackScript('/root/.dsh-remote-node-harness/runtime')
  // Old semantics: `.previous` existed → restore it. That is still one of the answers, but it is
  // no longer the *first* question. The script must ask whether the **live** tree still starts
  // before it touches anything — otherwise a failed download (checksum, unpack, shape,
  // executable-bit checks all happen before the rename) downgrades a healthy node to the
  // release before it. Measured on a real node: runtime=v2-good, runtime.previous=v1-old, one
  // rollback later the node ran v1-old.
  check(rollback.includes('node "$cli" --version'),
    'the rollback starts the live tree before deciding anything', rollback.split('\n').find(line => line.includes('--version')))
  check(rollback.indexOf('node "$cli" --version') < rollback.indexOf('rm -rf "$runtime"'),
    'and it decides before it removes the live tree — that ordering is the whole fix')
  check(rollback.includes('.previous') && rollback.includes('rolled-back'),
    'a failed install that did replace the tree can still be rolled back')
  check(rollback.includes('nothing-to-roll-back'),
    'and reports when there was nothing to roll back to')
  // The third answer is the ordinary one now: the live tree was never touched, so the failure
  // cost nothing. JS needs to tell the three apart to say which happened, hence ROLLBACK_VERDICTS.
  check(rollback.includes('kept-current'),
    'and reports when the live tree was kept because it still runs')
  for (const [name, value] of Object.entries(ROLLBACK_VERDICTS)) {
    check(rollback.includes(value), `the ${name} verdict is the string daemon.js branches on`, value)
  }
  const verdicts = Object.values(ROLLBACK_VERDICTS)
  check(new Set(verdicts).size === verdicts.length,
    'the three verdicts are distinct, so the caller cannot confuse them', verdicts.join(' '))

  // The other half of A1 is on the install side: `.previous` must not be created or overwritten
  // before the last verification, or a rejected archive still leaves a rollback that "restores"
  // an older tree over a live one. Exit codes 4/5/6/7 all come before the swap.
  const swapAt = script.indexOf('rm -rf "$previous"')
  const lastCheckAt = script.indexOf('ARTEFACT_NOT_EXECUTABLE')
  check(swapAt > 0 && lastCheckAt > 0 && swapAt > lastCheckAt,
    'the previous tree is only replaced after every verification has passed',
    `${String(lastCheckAt)} < ${String(swapAt)}`)
  check(script.indexOf('mv "$staging" "$runtime"') > swapAt,
    'and the live tree is only moved aside at the swap itself')
}

// ---- files that must be executable after unpack -----------------------------
// The defect this covers, measured on a real node on 2026-11-21: every `glob` and `grep` call
// answered "ripgrep provider failure" because `@vscode/ripgrep-linux-x64/bin/rg` arrived mode
// 0666. The installer repaired only `spawn-helper`, which a Linux tree does not even contain,
// and `dsh-util-ripgrep` spawns its bundled binary by path with no system-rg fallback — so the
// whole search surface was dead on a tree the gate called "in step".
{
  // A rule by shape, not a list of paths: the ripgrep binary is one dependency bump away from
  // a different path, and a hand-maintained list would fail silently when it moved.
  check(isArtefactExecutable('/s/node_modules/@vscode/ripgrep-linux-x64/bin/rg'),
    'the bundled ripgrep is executable — every glob/grep on a node spawns it')
  check(isArtefactExecutable('/s/node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run'),
    'and so is the Linux sandbox launcher')
  check(isArtefactExecutable('/s/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'),
    'spawn-helper is matched by name, because it is not under a bin/')
  check(isArtefactExecutable('node_modules\\which\\bin\\node-which'),
    'a backslash path is the same path — the packer walks Windows-shaped entries')
  check(isArtefactExecutable('/s/node_modules/node-pty/prebuilds/linux-x64/pty.node'),
    'native addons keep the bit they always had, so this rule is not a regression')
  check(!isArtefactExecutable('/s/node_modules/x/lib/index.js'),
    'ordinary JavaScript stays non-executable')
  // `node_modules/.bin` is npm's shim directory. Matching it would mark 26 `.cmd`/`.ps1`
  // shims a Linux node never runs, and nothing resolves them (checked in both consumers).
  check(!isArtefactExecutable('/s/node_modules/.bin/node-which'),
    'npm`s own .bin shims are not matched — no consumer resolves them')
  check(!isArtefactExecutable('/s/node_modules/.bin/acorn'), 'including the extensionless one')
  check(ARTEFACT_EXECUTABLE_NAMES.includes('spawn-helper') && ARTEFACT_EXECUTABLE_NAMES.length === 1,
    'the by-name list stays the one file that needs it', String(ARTEFACT_EXECUTABLE_NAMES.length))

  const expression = artefactExecutableFind()
  check(expression.includes('-path') && expression.includes("-name 'spawn-helper'"),
    'the installer finds payloads by path pattern and by name, not by a hard-coded list',
    expression.slice(0, 120))

  // The `find` expression is where this rule actually runs on a node, and a `find` expression
  // one parenthesis away from matching nothing looks exactly like a working one in a diff.
  // A POSIX `find` cannot be proved on Windows without one, so the shell is looked for rather
  // than assumed: `sh` first because that is what the node runs the installer with, then Git's
  // bash, which is the only POSIX shell a Windows dev machine has. When neither is there the
  // check is skipped out loud — a silent pass would be worse than a stated gap.
  const candidates = ['sh', 'bash']
  if (process.platform === 'win32') {
    candidates.push(join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'))
  }
  const shell = candidates.find(candidate => {
    const probe = spawnSync(candidate, ['-c', 'command -v find >/dev/null 2>&1 && echo yes'], { encoding: 'utf8' })
    return probe.status === 0 && probe.stdout.trim() === 'yes'
  })
  if (shell !== undefined) {
    const root = mkdtempSync(join(tmpdir(), 'rnh-exec-'))
    try {
      const tree = [
        'node_modules/@vscode/ripgrep-linux-x64/bin/rg',
        'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
        'node_modules/node-pty/prebuilds/linux-x64/pty.node',
        'node_modules/x/lib/index.js',
        'node_modules/.bin/node-which',
      ]
      for (const path of tree) {
        mkdirSync(join(root, dirname(path)), { recursive: true })
        writeFileSync(join(root, path), 'x')
      }
      // `.` as the find root: the same relative shape the installer uses, so a `bin` segment
      // in the caller's root cannot inflate the match.
      const found = spawnSync(shell, ['-c', `cd ${JSON.stringify(root)} && ${expression} | sort`], { encoding: 'utf8' })
      const names = found.stdout.split('\n').map(line => line.trim()).filter(Boolean)
      check(names.includes('./node_modules/@vscode/ripgrep-linux-x64/bin/rg'),
        'the generated find expression selects the ripgrep binary', String(names.length))
      check(names.includes('./node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'),
        'and spawn-helper')
      check(names.includes('./node_modules/node-pty/prebuilds/linux-x64/pty.node'), 'and the addon')
      check(!names.includes('./node_modules/x/lib/index.js'), 'and no ordinary JavaScript')
      check(!names.some(name => name.includes('node_modules/.bin/')),
        'and no npm .bin shims', names.filter(name => name.includes('/.bin/')).join(' '))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  } else {
    log('skip the find-expression probe: no POSIX shell on this machine to run a find')
  }

  // The script has to *verify* the result, not just attempt the chmod: an unexecutable payload
  // must fail the install (rollback) instead of producing a node whose search silently dies.
  const script = installScript({
    version: '0.2.2-rc.5',
    runtime: '/root/.dsh-remote-node-harness/runtime',
    cli: '/root/.dsh-remote-node-harness/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
    urls: ['https://mirror/x.tar.gz'],
  })
  check(script.includes('ARTEFACT_NOT_EXECUTABLE') && script.includes('exit 7'),
    'an unpacked tree with a non-executable payload fails the install by name')
  check(/\[ ! -x "\$candidate" \]/u.test(script),
    'and it decides that by testing the executable bit, not by trusting chmod')
  check(script.includes('ripgrep-linux-x64/bin/rg'),
    'the verification names the file whose absence broke search')
  // Order matters: the check must run before the staging tree is renamed into place, or the
  // rollback has nothing to restore and the broken tree is already serving.
  const verifyAt = script.indexOf('ARTEFACT_NOT_EXECUTABLE')
  const swapAt = script.indexOf('mv "$staging" "$runtime"')
  check(verifyAt > 0 && swapAt > verifyAt,
    'the verification runs before the staging tree replaces the live runtime',
    `${String(verifyAt)} < ${String(swapAt)}`)
}

// ---- the plugin install script: peers must not drag DSH onto the node -------
// A third-party bundle's `peerDependencies` name `@deepseek-ai/dsh-*`, and npm satisfies
// a peer by *installing* it into the profile, where it resolves ahead of the runtime
// tree. Measured: one plugin install put `dsh-session@0.2.0-rc.2` beside a 0.2.2-rc.3
// runtime, and the resident host then refused to activate rows and printed no URL — a
// node that looks connected from the desktop and is dead on the machine.
//
// The other defect here is the manifest itself (B5, reproduced on a real node): the
// `printf` that writes `package.json` was written inside a JS template string, so the
// escaping collapsed and the file got the literal characters `\` `n` instead of a newline.
// `npm install` answered `EJSONPARSE … Unexpected non-whitespace character after JSON at
// position 65`, so the first connect of every new node failed to install its plugins and
// only the *second* connect worked — because `writeProfileBundles` had rewritten the file.
// These checks are about that one line, because nothing else in the script can make a
// manifest that is not JSON.
{
  const script = pluginInstallScript({
    profile: '/root/.dsh/profiles/rnh',
    profileName: 'rnh',
    targets: ['dsh-pet@^0.3.8', '@vectorize-io/hindsight-coding-agents@^0.8.7'],
  })
  check(script.includes('--legacy-peer-deps'),
    'the install never resolves a peer from the registry, so no DSH copy lands in the profile')
  check(script.includes('cd /root/.dsh/profiles/rnh'),
    'it runs in the node profile, not in the runtime tree')
  check(script.includes('"dsh-pet@^0.3.8"') && script.includes('"@vectorize-io/hindsight-coding-agents@^0.8.7"'),
    'every target is quoted, so a spec with a range cannot be split by the shell')
  check(script.includes('RNH_NPM_EXIT=$?'),
    'and the exit status is reported separately from npm output, which `2>&1` interleaves')

  // The shape of the line, asserted as text first: the old form was `…{}}` followed by four
  // backslashes and an `n`, and no amount of reading it as shell makes that a newline.
  const manifestLine = script.split('\n').find(line => line.includes('package.json') && line.includes('printf'))
  check(manifestLine !== undefined, 'the script writes the profile manifest', script.split('\n').find(line => line.includes('> package.json')))
  check(manifestLine?.includes("printf '%s\\n'") === true,
    'the newline comes from printf`s own format, not from an escape inside the JSON',
    manifestLine)
  check(manifestLine?.includes("}}\\\\n'") !== true && manifestLine?.includes('}}') === true,
    'the manifest is no longer a printf format string ending in a literal backslash-n',
    manifestLine)
  // One backslash before the n in the *script text*: printf expands it to one newline. Four
  // would reach the shell as four, which is exactly the bug.
  check(!/[^\\]\\\\{2,}n/u.test(manifestLine ?? ''),
    'the format carries exactly one backslash-n, which printf turns into a newline',
    JSON.stringify(manifestLine))

  // A syntactically valid script is the cheapest proof that the quoting is balanced, and
  // `sh -n` needs no node, no npm and no network. The interpreter is looked for rather than
  // assumed; when none exists the check is skipped out loud instead of passing silently.
  const shell = ['sh', 'bash']
    .concat(process.platform === 'win32'
      ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')]
      : [])
    .find(candidate => {
      const probe = spawnSync(candidate, ['-n'], { input: 'echo ok\n', encoding: 'utf8' })
      return probe.status === 0
    })
  if (shell !== undefined) {
    const syntax = spawnSync(shell, ['-n'], { input: `${script}\n`, encoding: 'utf8' })
    check(syntax.status === 0, 'the generated install script parses as shell',
      syntax.stderr?.trim().split('\n').at(-1) ?? '')
    // The syntax check has to be able to fail, or it proves nothing.
    const broken = spawnSync(shell, ['-n'], { input: "if [ -f x ]; then\n", encoding: 'utf8' })
    check(broken.status !== 0, 'and that check does reject an unterminated if')
    // Run the manifest half for real and parse the result: this is the actual defect, and a
    // string assertion alone would still pass on a file that is one character short.
    const scratch = mkdtempSync(join(tmpdir(), 'rnh-plugin-'))
    try {
      const profile = scratch.split('\\').join('/')
      const own = pluginInstallScript({ profile, profileName: 'rnh', targets: ['dsh-pet@1'] })
      const head = own.split('\n').slice(0, own.split('\n').findIndex(line => line.startsWith('npm install'))).join('\n')
      const ran = runShellScript(shell, scratch, head)
      const written = ran.status === 0 ? readFileSync(join(scratch, 'package.json'), 'utf8') : ''
      check(ran.status === 0, 'the manifest-writing half of the script runs', ran.stderr.trim().split('\n').at(-1))
      let parsed
      try { parsed = JSON.parse(written) } catch { parsed = undefined }
      check(parsed !== undefined, 'and the file it leaves is valid JSON, not JSON plus a literal \\n',
        JSON.stringify(written.slice(-14)))
      check(parsed?.name === 'dsh-profile-rnh' && parsed?.dependencies !== undefined,
        'with the name and dependency map npm needs', JSON.stringify(parsed))
      check(written.endsWith('\n') && !written.endsWith('\\n'),
        'the file ends with a real newline and not with backslash-n', JSON.stringify(written.slice(-8)))
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  } else {
    log('skip the shell checks of pluginInstallScript: no POSIX shell on this machine')
  }

  // A profile name is `[A-Za-z0-9-]` today, derived from the node's root. The escaper must not
  // depend on that: a quote or a backslash in the name must not truncate the shell word.
  //
  // The script is written to a file and executed from there rather than passed with `-c`: on
  // Windows the `sh`/`bash` available to this test is an MSYS2 binary, and its startup parsing
  // eats backslashes out of a `-c` argument, which would make this check fail for a reason that
  // does not exist on a Linux node. Running the generated text is the faithful comparison.
  const hostile = "we'ird\\name"
  const quoted = pluginInstallScript({ profile: '/p', profileName: hostile, targets: ['x'] })
  check(quoted.includes("'\\''"),
    'a quote in the profile name is escaped the POSIX way, not left to break the word')
  if (shell !== undefined) {
    const scratch = mkdtempSync(join(tmpdir(), 'rnh-plugin-quote-'))
    try {
      const profile = scratch.split('\\').join('/')
      const own = pluginInstallScript({ profile, profileName: hostile, targets: ['x'] })
      const head = own.split('\n').slice(0, own.split('\n').findIndex(line => line.startsWith('npm install'))).join('\n')
      const ran = runShellScript(shell, scratch, head)
      let parsed
      try { parsed = JSON.parse(readFileSync(join(scratch, 'package.json'), 'utf8')) } catch { parsed = undefined }
      check(ran.status === 0 && parsed?.name === `dsh-profile-${hostile}`,
        'and a hostile profile name still writes a correct manifest',
        `${String(ran.status)} ${JSON.stringify(parsed?.name)}`)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
}

// ---- per-plugin switches ---------------------------------------------------
// ---- which of your plugins a node loads ------------------------------------
// The unit of a switch is a **bundle**, not a row. The row list this used to test had
// 207 entries — one per internal service — and only a handful of them were decisions a
// person could make. A node composes a bundle list, so one switch per installed bundle is
// the model that can actually be carried out.
{
  const manifest = {
    dependencies: {
      '@deepseek-ai/dsh-base': '0.2.2-rc.3',
      '@local/rnh-brain': '0.1.0',
      'dsh-pet': '^0.4.9',
      '@artenx/dshb': '^1.2.0',
      'left-pad': '^1.0.0',
    },
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          'dsh-pet',
          '@local/rnh-brain',
          '@artenx/dshb',
        ],
      },
    },
  }

  check(isThirdParty('dsh-pet'), 'a bare npm package is a plugin you installed')
  check(isThirdParty('@artenx/dshb'), 'so is a scoped third party')
  check(!isThirdParty('@deepseek-ai/dsh-base'), 'an upstream bundle is not a choice')
  check(!isThirdParty('@deepseek-ai/dsh-web-app'), 'a node is a subtraction from dsh-web-app')
  check(!isThirdParty('@local/rnh-brain'), 'the brain bundle is how a node becomes one')
  check(!isThirdParty('@greatbaby/dsh-remote-node-harness'), 'and this desktop half is not something to send')
  check(!isThirdParty(''), 'an empty name is not a plugin')

  // Never-sync is its own answer: it asks "may this reach a node at all", which the
  // product/third-party question cannot decide. Each name is here for a different reason,
  // so a prefix rule would be wrong in one direction or the other.
  check(isNeverSynced('@greatbaby/dsh-remote-node-harness'),
    'this desktop half holds the node-management tool: a node that ran it could manage other nodes')
  // A profile installed before 0.6.0 lists one of the old spellings until it is reinstalled,
  // and "the previous name of me" is not a reason to send this plugin's preset to a node.
  check(isNeverSynced('@greatbaby/dsh-fleet'),
    'and so is the name it had between 0.5.0 and 0.6.0, which an upgraded profile still lists')
  check(isNeverSynced('@local/dsh-fleet'),
    'and the name it had before 0.5.0, which an even older profile still lists')
  check(isNeverSynced('ds-harness-remote'), 'a relay plugin on a node would open a second way in')
  check(isNeverSynced('@dsh-remote/plugin'), 'and the older name for the same thing')
  check(isNeverSynced('@local/rnh-brain'), 'the brain bundle is already the node side')
  check(!isNeverSynced('dsh-pet'), 'an ordinary plugin is not on the list')
  check(!isNeverSynced(undefined), 'and neither is a missing name')

  // A desktop whose profile lists the relay must not offer it as a switch, and must not
  // report it as "installed but not loaded" either: the name never becomes a row.
  const relayed = installedPlugins({
    dependencies: { 'dsh-pet': '^0.4.9', 'ds-harness-remote': '^0.6.5', '@greatbaby/dsh-remote-node-harness': 'link:packages/dsh-remote-node-harness' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-pet', 'ds-harness-remote', '@greatbaby/dsh-remote-node-harness'] } },
  })
  check(relayed.map(row => row.bundle).join(',') === 'dsh-pet',
    'the hard exclusions never reach the switch list', relayed.map(row => row.bundle).join(','))

  // Loaded bundles first, then installed-but-not-loaded: a person reads "what a node
  // gets" at the top, and a package that is downloaded but not loaded here keeps its row
  // instead of vanishing from the page.
  const plugins = installedPlugins(manifest, name => (name === 'dsh-pet' ? ['dsh-pet'] : []))
  check(plugins.map(plugin => plugin.bundle).join(',') === 'dsh-pet,@artenx/dshb,left-pad',
    'installed plugins are listed, upstream and the brain excluded', plugins.map(p => p.bundle).join(','))
  check(plugins[0].loaded === true, 'a bundle in the profile list is marked as loaded here')
  check(plugins[0].spec === '^0.4.9', 'its install spec comes from the manifest, not from a guess')
  check(JSON.stringify(plugins[0].rows) === '["dsh-pet"]',
    'and the rows it contributes are read from its own patch', JSON.stringify(plugins[0].rows))
  check(plugins[2].loaded === false, 'a dependency that is not in the bundle list is not loaded here')
  check(plugins[2].rows.length === 0, 'and contributes no rows, because it was never read')

  // The default is **on**. A switch means "this plugin also runs on that machine", and a
  // person who installed a plugin here and connected a node asked for one working
  // environment rather than a second one that silently differs. The exclusions above are
  // what keep "on" from meaning "and so does the desktop half of this plugin".
  const defaults = resolvePlugins(plugins, {})
  check(defaults.every(row => row.sync === true), 'your plugins are sent by default')
  check(defaults.every(row => row.source === 'default'), 'with no overrides, every answer is a default')
  check(defaults[0].reason.includes('sent unless turned off'),
    'a loaded plugin explains what happens by default', defaults[0].reason)
  check(defaults[2].reason.includes('not loaded'), 'an unloaded one says so', defaults[2].reason)

  // Turning one off is the only thing to undo, exactly as turning one on used to be.
  const chosen = resolvePlugins(plugins, { '@artenx/dshb': { sync: false } })
  check(chosen.find(row => row.bundle === '@artenx/dshb')?.sync === false, 'an explicit off is honoured')
  check(chosen.find(row => row.bundle === '@artenx/dshb')?.source === 'explicit',
    'and says the person decided it')
  check(chosen.find(row => row.bundle === 'dsh-pet')?.sync === true,
    'a plugin nobody touched keeps the default')

  // The node's bundle list keeps the brain last: bundles compose in order and the brain
  // patch has to land over upstream's. The chosen plugins sit between them, so a plugin
  // extends the brain rather than replace it.
  const list = nodeBundles(['@deepseek-ai/dsh-base', '@local/rnh-brain'], chosen)
  check(JSON.stringify(list) === JSON.stringify([
    '@deepseek-ai/dsh-base', 'dsh-pet', 'left-pad', '@local/rnh-brain',
  ]), 'the node list is base, then your plugins, then the brain', JSON.stringify(list))
  check(nodeBundles(['@deepseek-ai/dsh-base', '@local/rnh-brain'],
    resolvePlugins([], {})).length === 2,
  'with no plugins installed a node is exactly the brain')

  // A corrupt switches file means "no opinions yet", never "send everything".
  const parsed = parseSwitches({
    'dsh-pet': { sync: true },
    '@artenx/dshb': { sync: false },
    junk: { sync: 'yes' },
  })
  check(parsed['dsh-pet']?.sync === true, 'a stored switch round-trips')
  check(parsed.junk === undefined, 'a non-boolean is dropped rather than guessed')
  check(Object.keys(parseSwitches(undefined)).length === 0, 'a missing file parses to no overrides')
  check(Object.keys(parseSwitches([1, 2])).length === 0, 'a wrongly shaped file is ignored')

  // How a plugin travels depends on this one answer, and getting it wrong is a silent
  // 404 on somebody's server: a local bundle has no registry entry, so `npm install` there
  // cannot work and the files have to be copied instead.
  check(isLocalSpec('link:C:/Users/x/.dsh/local-bundles/rhino-mode'), 'a link: dependency is a local bundle')
  check(isLocalSpec(undefined), 'a bundle with no recorded spec is local, not "publish latest"')
  check(!isLocalSpec('^1.2.0'), 'a caret range is published')
  check(!isLocalSpec('0.3.17'), 'an exact version is published')
  check(!isLocalSpec('latest'), 'a dist-tag is published')
  check(isLocalSpec('file:../plugin'), 'a file: dependency is local')
  check(isLocalSpec('./plugin'), 'a relative path is local')
  check(isLocalSpec('D:\\ProjectHub\\DSHpl\\packages\\dsh-remote-node-harness'), 'a Windows path is local')
  check(isLocalSpec('/opt/plugins/x'), 'an absolute POSIX path is local')
}

// ---- one node's own filesystem layout, derived from its root ---------------
// Two node records can name the same machine under different roots — the ordinary way
// to test a second node. With one global layout the second node silently reused the
// first one's runtime and resident host, so "two connected nodes" was one node counted
// twice. Measured on one machine before this was fixed.
{
  const first = remoteLayout()
  const defaultAgain = remoteLayout('~/.dsh-remote-node-harness')
  const second = remoteLayout('~/.dsh-remote-node-harness-b')
  check(first.runtime === '~/.dsh-remote-node-harness/runtime', 'the default root keeps its runtime')
  check(first.profile === defaultAgain.profile,
    'the historical root keeps the profile an earlier build created', first.profile)
  check(first.profileName === 'rnh', 'and the profile name a resident host is started with',
    first.profileName)
  check(remoteLayout('~/.dsh-remote-node-harness/').profileName === 'rnh', 'a trailing slash changes nothing')
  check(second.runtime === '~/.dsh-remote-node-harness-b/runtime', 'a second root gets its own runtime')
  check(second.profileName === 'rnh-b', 'and its own profile name', second.profileName)
  check(second.profile !== first.profile, 'so the two nodes cannot overwrite each other\'s patch',
    `${first.profile} vs ${second.profile}`)
  check(second.run !== first.run && second.status !== first.status,
    'their run directories and status files are distinct too')
  check(remoteLayout('~/.brains/scratch').profileName === 'rnh-scratch',
    'a deeper root names itself after its last segment')
  check(remoteLayout('/').profileName === 'rnh',
    'a root that reduces to nothing falls back rather than colliding silently')
  // Every path a node writes must live under its own root; one that escaped would be
  // the same bug in a different disguise.
  for (const key of ['runtime', 'run', 'log', 'status', 'cli']) {
    check(second[key].startsWith('~/.dsh-remote-node-harness-b/'), `${key} lives under the node's own root`, second[key])
  }
  // The Session log lives in the shared DSH home on purpose: two roots on one machine
  // are two brains, not two machines, and each Session record names its own cwd.
  check(second.home === first.home, 'both roots share the machine\'s DSH home', first.home)
}

// ---- the packing build, which the version cannot express -------------------
// A cached artefact is the whole point of the release route, and it also means a tree
// can be the right *version* and the wrong *bytes*: republish the same release with a
// different strip rule and every node that already has it never reinstalls. Measured:
// a strip rule that removed `doc/` also removed `yaml/dist/doc/directives.js`, every
// node from that artefact failed at startup with MODULE_NOT_FOUND, and the gate said
// "current" because the version matched.
{
  const good = inspectRuntime({ version: '0.2.2-rc.3', build: String(RUNTIME_BUILD), wantedVersion: '0.2.2-rc.3' })
  check(good.usable, 'a tree on the right version and the right build is usable', good.reason)
  const repacked = inspectRuntime({ version: '0.2.2-rc.3', build: '1', wantedVersion: '0.2.2-rc.3' })
  check(!repacked.usable, 'a tree packed by an older build is not')
  check(repacked.reason.includes('build 1'), 'and says which build made it', repacked.reason)
  const unstamped = inspectRuntime({ version: '0.2.2-rc.3', build: undefined, wantedVersion: '0.2.2-rc.3' })
  check(!unstamped.usable, 'a tree with no stamp at all is not usable')
  check(!inspectRuntime({ version: '0.1.0', build: String(RUNTIME_BUILD), wantedVersion: '0.2.2-rc.3' }).usable,
    'a tree of another version is not usable either')
  check(!inspectRuntime({ version: undefined, build: undefined, wantedVersion: '0.2.2-rc.3' }).usable,
    'no tree at all is not usable')

  // The gate has to act on that: same version, wrong pack, still a reinstall.
  const decision = decideGate({
    hostVersion: '0.2.2-rc.3',
    hostBrain: '0.3.0',
    nodeVersion: '0.2.2-rc.3',
    nodeBrain: '0.3.0',
    nodeRuntime: repacked.reason,
  })
  check(decision.action === GATE.INSTALL, 'so the gate reinstalls a wrongly packed tree',
    decision.action)
  check(decision.reason === 'node-runtime-repack', 'with a reason that names the cause', decision.reason)
  check(decideGate({
    hostVersion: '0.2.2-rc.3', hostBrain: '0.3.0', nodeVersion: '0.2.2-rc.3', nodeBrain: '0.3.0',
  }).action === GATE.CURRENT, 'and a usable tree still needs nothing')

  // The install script must leave the stamp behind, or every connect reinstalls.
  const script = installScript({
    version: '0.2.2-rc.3',
    runtime: '/root/.dsh-remote-node-harness/runtime',
    cli: '/root/.dsh-remote-node-harness/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
    urls: ['https://mirror/x.tar.gz'],
  })
  check(script.includes(BUILD_STAMP), 'the install writes the build stamp', BUILD_STAMP)
  check(script.includes(`"build":${String(RUNTIME_BUILD)}`), 'with the build this plugin packs')
}

// ---- the stamp format: JSON now, a bare integer on trees already in service -----
{
  check(parseStamp(stampJson({ via: 'artefact' })).build === RUNTIME_BUILD,
    'a stamp this build writes carries the current build', String(RUNTIME_BUILD))
  check(parseStamp(stampJson({ via: 'artefact' })).via === 'artefact',
    'and records that it came from a published artefact')
  // `npm` is a route this build no longer has. A node that still carries such a stamp is a
  // node built by build 3, and build 3 is the upstream tree — the *build* number is what
  // reinstalls it, not the route it recorded. The reader must not choke on the value.
  check(parseStamp(stampJson({ via: 'npm' })).via === 'npm',
    'a stamp from the removed route still parses')
  check(parseStamp('{"build":4,"via":"carrier-pigeon"}').via === undefined,
    'while an unknown route reads as no route rather than as itself')
  // Build 2 wrote the bare integer. A node already in service must not be judged unusable
  // by a format change — that would reinstall every node on the planet for one upgrade.
  check(parseStamp('2').build === 2, 'a build-2 stamp still reads as build 2')
  check(parseStamp('2').via === undefined, 'and claims no route, because it recorded none')
  check(parseStamp('').build === undefined && parseStamp('   ').build === undefined,
    'an absent or blank stamp is no build at all')
  check(parseStamp('garbage').build === undefined, 'a stamp that is not a stamp is no build either')
  check(parseStamp('{"build":').build === undefined,
    'and neither is one that was cut off mid-write')

  // `via` is reported, never judged: what makes a tree usable is its version and its build.
  const built = inspectRuntime({
    version: '0.2.2-rc.3', build: stampJson({ via: 'npm' }), wantedVersion: '0.2.2-rc.3',
  })
  check(built.usable, 'a stamp recording the removed route is still a usable tree', built.reason)
  check(built.via === 'npm', 'while the stamp still says how it got there')
  check(inspectRuntime({ version: '0.2.2-rc.3', build: '2', wantedVersion: '0.2.2-rc.3' }).usable === false,
    'a build-2 tree is still reinstalled, because later builds pack different bytes')
  // The one that matters now: build 3 is the *upstream* tree at the same version, which is a
  // different runtime. Without this a node that had rc.5 from the old route would never be
  // moved onto the fork.
  check(inspectRuntime({ version: '0.2.2-rc.3', build: '3', wantedVersion: '0.2.2-rc.3' }).usable === false,
    'a build-3 tree is reinstalled, because it is the upstream runtime and this build is the fork')
}

// ---- the two routes, exercised through the real RemoteHost.install ---------------
// ---- the one route, exercised through the real RemoteHost.install ---------------
// The connection is a stub: what is being proved is *which commands run* and *what happens
// to the one that did not work* — not SSH.
//
// The rule these pin down: a tree that could not be **had** is reported with the URLs it
// tried, and a tree that arrived and was **wrong** is rolled back and reported. Neither one
// is retried through a second route, because there is no second route: it was removed
// together with the ability to install the upstream release (ADR-0007).
{
  const { RemoteHost } = await import('../src/remote/daemon.js')
  const stub = (answers = {}) => {
    const calls = []
    return {
      calls,
      async exec(request) {
        calls.push(request.argv.join(' '))
        const script = request.argv.at(-1) ?? ''
        const answer = Object.entries(answers).find(([needle]) => script.includes(needle))?.[1]
        return { code: answer?.code ?? 0, stdout: answer?.stdout ?? '', stderr: answer?.stderr ?? '' }
      },
    }
  }
  const facts = {
    nodeUsable: true, nodeVersion: 'v24.21.0', curlPath: '/usr/bin/curl', wgetPath: '',
    os: 'Linux', arch: 'x86_64',
  }
  const attempt = async (options, installFacts = facts) => {
    const connection = stub({ 'ARTEFACT-UNAVAILABLE-NEVER-MATCHES': { code: 0 }, ...options.answers })
    /** @type {string[]} */
    const logs = []
    const host = new RemoteHost({ connection, version: '0.2.2-rc.3', log: message => logs.push(message) })
    let error
    let result
    try { result = await host.install(installFacts, options.install ?? {}) } catch (caught) { error = caught }
    return { error, result, calls: connection.calls, logs }
  }
  const ranNpm = calls => calls.some(call => call.includes('npm install'))
  // The rollback judgement is the one command that probes the live tree. Counting it is how
  // these tests tell "the rollback ran" from "the rollback was skipped", which is the defect.
  const rollbacks = calls => calls.filter(call => call.includes('node "$cli" --version'))

  // 1. A successful download is the whole install, and it never touches a registry.
  const installed = await attempt({})
  check(installed.error === undefined, 'a served artefact installs',
    String(installed.error?.message).slice(0, 90))
  check(installed.result?.via === 'artefact', 'and reports the route it took', installed.result?.via)
  check(!ranNpm(installed.calls), 'without ever running npm on the node')

  // 2. When nothing serves the artefact the connect fails, naming the URLs it tried. It does
  //    **not** fall back to the upstream release: that tree would write this build's stamp
  //    and read as "in step" forever, pinning the node to the upstream runtime after one
  //    network blip.
  const refused = await attempt({ answers: { 'ARTEFACT_UNAVAILABLE': { code: 3, stderr: 'ARTEFACT_UNAVAILABLE' } } })
  check(refused.error !== undefined, 'a missing artefact fails the connect')
  const refusedText = String(refused.error?.message)
  check(refusedText.includes('could not be installed'), 'with a message that says so',
    refusedText.slice(0, 90))
  check(refusedText.includes('https://cnb.cool/'), 'naming the URL it tried',
    refusedText.slice(-160))
  check(!ranNpm(refused.calls),
    'and never reaching for the upstream release, which would pin the node to it')

  // 3. Every URL the artefact script is given comes from the one configured source, and none
  //    starts at GitHub itself: GitHub direct is ~27 KB/s, which reads as a hang.
  const scriptUrls = refused.calls
    .flatMap(call => [...call.matchAll(/'(https:\/\/[^']+)'/gu)].map(match => match[1]))
  check(scriptUrls.length > 0 && scriptUrls.every(url => url.startsWith('https://cnb.cool/')),
    'every URL it tries comes from CNB', scriptUrls.find(url => !url.startsWith('https://cnb.cool/')))
  check(scriptUrls.every(url => !url.startsWith('https://github.com/')),
    'and none starts at GitHub directly')

  // 4. A checksum mismatch is *not* the same thing. The bytes arrived and were wrong, so the
  //    rollback judgement runs and the failure is reported. Every check the install script does
  //    (checksum, unpack, shape, executable bit) happens **before** the rename, so the live tree
  //    is intact and the judgement must keep it — restoring `$runtime.previous` here would
  //    downgrade the node by one release. Measured on a real node: runtime=v2-good,
  //    runtime.previous=v1-old, one old-style rollback later the node ran v1-old.
  const mismatch = await attempt({
    answers: { 'ARTEFACT_CHECKSUM_MISMATCH': { code: 4, stderr: 'ARTEFACT_CHECKSUM_MISMATCH a b' } },
  })
  check(rollbacks(mismatch.calls).length === 1,
    'a bad checksum asks for the rollback judgement exactly once',
    String(rollbacks(mismatch.calls).length))
  check(mismatch.calls.some(call => call.includes('node "$cli" --version')),
    'and that judgement starts the live tree instead of moving `.previous` in blindly')
  check(String(mismatch.error?.message).includes('installing the resident host failed'),
    'and reports the checksum rather than the source list')
  // The verdict is part of the thrown message, not just a log line: a rollback that failed is
  // the worst outcome of the three and must not read like an ordinary install error.
  check(String(mismatch.error?.message).includes('rollback'),
    'and the error text carries what the rollback did', String(mismatch.error?.message).split('\n').at(-1))
  check(!ranNpm(mismatch.calls), 'so a broken artefact is never retried through a registry')

  // 4b. An archive that arrived without its `.sha256` is also a failure, and it must *not* read
  //     as "no source served it": the bytes are there, they just cannot be trusted. That
  //     distinction is the whole reason this exit code exists — `ARTEFACT_CHECKSUM_UNAVAILABLE`
  //     deliberately does not contain the substring `ARTEFACT_UNAVAILABLE`, so it takes the
  //     rollback branch instead of the "try the next URL" branch.
  const noSidecar = await attempt({
    answers: { 'ARTEFACT_CHECKSUM_UNAVAILABLE': { code: 6, stderr: 'ARTEFACT_CHECKSUM_UNAVAILABLE' } },
  })
  check(noSidecar.error !== undefined, 'an archive with no checksum fails the connect')
  check(rollbacks(noSidecar.calls).length === 1,
    'and asks for the rollback judgement rather than leaving an unverified tree in place')
  check(!String(noSidecar.error?.message).includes('no source served'),
    'it is not reported as a missing artefact, because the bytes did arrive')
  check(!ranNpm(noSidecar.calls), 'and it never reaches for a registry')

  // 4c. The verdict the node reports decides the sentence, and each of the three is surfaced.
  for (const [verdict, expected] of [
    [ROLLBACK_VERDICTS.KEPT_CURRENT, 'nothing was changed'],
    [ROLLBACK_VERDICTS.ROLLED_BACK, 'previous release was restored'],
    [ROLLBACK_VERDICTS.NOTHING_TO_ROLL_BACK, 'no previous runtime'],
  ]) {
    const answer = await attempt({
      answers: {
        'ARTEFACT_SHAPE_UNEXPECTED': { code: 5, stderr: 'ARTEFACT_SHAPE_UNEXPECTED' },
        'node "$cli" --version': { code: 0, stdout: `${verdict}\n` },
      },
    })
    check(String(answer.error?.message).includes(expected),
      `a ${verdict} verdict reaches the thrown error`, String(answer.error?.message).split('\n').at(-1))
    check(answer.logs.some(line => line.includes(`rollback=${verdict}`)),
      `and is logged, not swallowed (${verdict})`, answer.logs.at(-1))
  }

  // 4d. A rollback that itself fails also has to be reported: the old `.catch(() => undefined)`
  //     left no trace at all, which is exactly the case where the node is left on a tree that
  //     does not start and nobody is told.
  {
    /** @type {string[]} */
    const logs = []
    const connection = stub({
      'ARTEFACT_SHAPE_UNEXPECTED': { code: 5, stderr: 'ARTEFACT_SHAPE_UNEXPECTED' },
      'node "$cli" --version': { code: 0, stdout: `${ROLLBACK_VERDICTS.KEPT_CURRENT}\n` },
    })
    connection.exec = (request => {
      const script = request.argv.at(-1) ?? ''
      if (script.includes('node "$cli" --version')) return Promise.reject(new Error('ssh exec timed out after 120000ms'))
      connection.calls.push(request.argv.join(' '))
      return Promise.resolve({ code: 5, stdout: '', stderr: 'ARTEFACT_SHAPE_UNEXPECTED' })
    })
    const host = new RemoteHost({ connection, version: '0.2.2-rc.3', log: message => logs.push(message) })
    let error
    try { await host.install(facts, {}) } catch (caught) { error = caught }
    check(String(error?.message).includes('rollback could not run'),
      'a rollback that cannot run is named in the thrown error', String(error?.message).split('\n').at(-1))
    check(logs.some(line => line.includes('rollback itself failed')),
      'and it is logged, not swallowed like the old `.catch(() => undefined)`', logs.at(-1))
  }

  // 4e. **A transport failure has no exit code at all.** A timeout or a dropped channel makes
  //     `exec` reject, so the `code === 0` check and the rollback branch used to be skipped
  //     entirely and the rejection flew straight out of `install()`. The remote `sh` may already
  //     have swapped the tree in before the channel died, so the same judgement is asked for
  //     and the failure is reported with context.
  {
    let rollbackCalls = 0
    /** @type {string[]} */
    const logs = []
    const connection = {
      calls: [],
      async exec(request) {
        const script = request.argv.at(-1) ?? ''
        if (script.includes('node "$cli" --version')) {
          rollbackCalls += 1
          return { code: 0, stdout: `${ROLLBACK_VERDICTS.KEPT_CURRENT}\n`, stderr: '' }
        }
        connection.calls.push(request.argv.join(' '))
        throw Object.assign(new Error('ssh exec timed out after 1860000ms'), { sshCategory: 'timeout' })
      },
    }
    const host = new RemoteHost({ connection, version: '0.2.2-rc.3', log: message => logs.push(message) })
    let error
    try { await host.install(facts, {}) } catch (caught) { error = caught }
    check(error !== undefined, 'a rejected install exec is still a reported failure')
    check(rollbackCalls === 1, 'and it still asks the rollback judgement, which is what makes a timeout safe',
      String(rollbackCalls))
    check(String(error?.message).includes('the transfer failed'),
      'the error says what failed', String(error?.message).slice(0, 100))
    check(String(error?.message).includes('nothing was changed'),
      'and carries the rollback verdict, so a node left intact is stated as such',
      String(error?.message).split('\n').at(-1))
    check(error?.sshCategory === 'timeout', 'with the transport category kept for the caller', error?.sshCategory)
  }

  // 5. A machine that cannot download cannot install, and says which tool is missing. This
  //    used to be a machine that upgraded itself through npm; it is now a machine that has
  //    to have `curl` or `wget`, because that is the only way a runtime arrives.
  const noDownloader = await attempt({}, { ...facts, curlPath: '', wgetPath: '' })
  check(noDownloader.error !== undefined, 'a node with no curl and no wget is an error')
  check(String(noDownloader.error?.message).includes('neither curl nor wget'),
    'which names the missing downloader', String(noDownloader.error?.message).slice(0, 120))
  check(!ranNpm(noDownloader.calls), 'and does not try npm instead')

  // 6. A platform this build has never published for is reported as such, not resolved.
  const untaggable = await attempt({}, { ...facts, os: 'Plan9', arch: 'mips' })
  check(untaggable.error !== undefined, 'an untaggable platform is an error')
  check(String(untaggable.error?.message).includes('no platform tag'),
    'naming the reason', String(untaggable.error?.message).slice(0, 120))
  check(!ranNpm(untaggable.calls), 'and never reaches for a registry')

  // 7. A node older than the floor is refused before anything is downloaded.
  const old = await attempt({}, { ...facts, nodeUsable: false, nodeVersion: 'v18.20.0' })
  check(old.error !== undefined, 'a node below the Node floor is refused')
  check(!old.calls.some(call => call.includes('dsh-0.2.2-rc.3-')),
    'before any archive is downloaded')
}

if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
}
