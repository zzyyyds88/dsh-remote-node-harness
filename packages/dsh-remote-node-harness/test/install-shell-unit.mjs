/**
 * The install and rollback scripts, **actually executed by a POSIX shell**.
 *
 * `version-unit.mjs` asserts what the generated script *says*; this suite asserts what it
 * *does*, because the two failures this batch exists for were both invisible in the text:
 *
 * - the swap was three statements (`rm -rf previous` / `mv runtime previous` / `mv staging
 *   runtime`), so `runtime` did not exist for the duration of a rename. A shell has no way to
 *   make that atomic, and a script killed inside it left a node with no runtime at all.
 * - "rollback" restored a backup unconditionally instead of asking whether the live tree
 *   still started, so a failed *download* downgraded a healthy node by one release.
 *
 * Neither is checkable by reading the script. So the script is run: real `ln -sfn`, real
 * `readlink`, real `tar`, real `sha256sum`, a real `node` probing the unpacked tree, and a
 * really killed script in the window that used to destroy the live tree.
 *
 * ## Why the shell is not always Git Bash
 *
 * `ln -sfn` needs a symlink privilege on Windows, and MSYS/Git Bash does not have one: plain
 * `ln -s` silently produces a **copy**, and `MSYS=winsymlinks:nativestrict` fails with
 * `Operation not permitted`. A test that ran there would pass while proving nothing, so the
 * suite looks for a shell that can really create a symlink (a Linux `sh`, or WSL's `bash`) and
 * reports exit 3 — a named SKIP, never a pass — when this machine has none. When only a
 * non-symlink shell exists it still runs the static half (`sh -n` on both generated scripts)
 * and says so in the skip reason.
 *
 * The tests run their work in the shell's own filesystem (WSL's `/tmp`, an ext4 tree) rather
 * than `/mnt/c`: on DrvFs every file reads 0777, so `chmod` and the `-x` verification are
 * meaningless there and the executable-bit repair would look correct no matter what.
 *
 * @module @greatbaby/dsh-remote-node-harness/test/install-shell-unit
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUILD_STAMP,
  ROLLBACK_VERDICTS,
  RUNTIME_BUILD,
  SCRIPT_CODES,
  installScript,
  parseScriptResult,
  rollbackScript,
} from '../src/remote/artefact.js'

const log = message => process.stdout.write(`[install-shell-unit] ${message}\n`)
let failed = 0
const check = (condition, label, detail = '') => {
  if (condition) {
    log(`ok   ${label}${detail === '' ? '' : ` — ${String(detail).slice(0, 220)}`}`)
    return
  }
  failed += 1
  log(`FAIL ${label}${detail === '' ? '' : ` — ${String(detail).slice(0, 220)}`}`)
}

// ---- finding a shell that can really make a symlink ------------------------
/**
 * A shell this machine can hand the generated script to.
 *
 * `toShellPath` is the one fact the rest of the suite needs: the driver is written for
 * `bash`, the scripts under test are run with `sh` (which is what `daemon.js` passes to
 * `exec`), and every path inside them has to be spelled the way the shell sees it.
 *
 * @returns {{ label: string, toShellPath: (path: string) => string,
 *   run: (scriptPath: string) => { code: number, stdout: string, stderr: string } }
 *   | { skip: string } | { noSymlinks: string }}
 */
function pickShell() {
  const probe = 'd=$(mktemp -d /tmp/rnh-probe.XXXXXX); ln -s a "$d/l"; '
    + 'if [ -L "$d/l" ]; then echo SYMLINK_OK; else echo NO_SYMLINK; fi; '
    + 'command -v node >/dev/null 2>&1 && echo NODE_OK || echo NO_NODE; '
    + 'command -v sha256sum >/dev/null 2>&1 && echo SHA_OK || echo NO_SHA; '
    + 'rm -rf "$d"'

  /** Run one probe command and read the answers. */
  const ask = (spawn) => {
    const result = spawn(probe)
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
    return {
      symlink: text.includes('SYMLINK_OK'),
      node: text.includes('NODE_OK'),
      sha: text.includes('SHA_OK'),
      text: text.trim().slice(0, 160),
    }
  }

  if (process.platform !== 'win32') {
    const answer = ask(script => spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8', timeout: 60_000 }))
    if (answer.symlink && answer.node && answer.sha) {
      return {
        label: '/bin/bash',
        toShellPath: path => path,
        run: scriptPath => spawnSync('/bin/bash', [scriptPath], { encoding: 'utf8', timeout: 300_000 }),
      }
    }
    return { noSymlinks: `this machine's /bin/bash cannot run the suite (${answer.text})` }
  }

  // WSL: `wsl.exe -l -q` prints UTF-16LE on this platform, so a plain `encoding: 'utf8'`
  // would read `U\0b\0u\0n\0t\0u\0…`. Decoding both ways and keeping the readable one is
  // ugly but it is the only way to be right on every Windows build.
  const listed = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer', timeout: 30_000 })
  let names = ''
  if (listed.stdout !== undefined && listed.stdout.length > 0) {
    const utf16 = listed.stdout.toString('utf16le').replaceAll('\u0000', '')
    names = /^[\x09\x0a\x0d\x20-\x7e]*$/u.test(utf16) ? utf16 : listed.stdout.toString('utf8')
  }
  const distros = names.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
  for (const distro of distros) {
    const wsl = args => spawnSync('wsl.exe', ['-d', distro, '--', ...args], { encoding: 'utf8', timeout: 60_000 })
    const answer = ask(script => wsl(['bash', '-c', script]))
    if (!answer.symlink || !answer.node || !answer.sha) continue
    return {
      label: `WSL ${distro}`,
      // `C:\Users\x` is `/mnt/c/Users/x` inside WSL. Every other drive is the same shape.
      toShellPath: path => {
        const match = /^([A-Za-z]):[\\/](.*)$/u.exec(path)
        if (match === null) return path.replaceAll('\\', '/')
        return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`
      },
      run: scriptPath => wsl(['bash', scriptPath]),
    }
  }

  // Git Bash exists on nearly every Windows dev machine, but it cannot make a symlink. Its
  // only honest contribution is the syntax half, which is still worth running.
  const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']
    .find(path => existsSync(path))
  if (gitBash !== undefined) {
    return { noSymlinks: `WSL with a usable bash was not found; ${gitBash} cannot create symlinks` }
  }
  return { skip: 'no POSIX shell on this machine could be used (no WSL, no Git Bash)' }
}

const picked = pickShell()
if ('skip' in picked) {
  log(`skip: ${picked.skip}`)
  process.exitCode = 3
} else if ('noSymlinks' in picked) {
  // Static half only, and the exit code says "skipped" rather than "passed": a run that could
  // not execute the transaction must never read as proof that the transaction works.
  const shell = 'C:\\Program Files\\Git\\bin\\bash.exe'
  const syntax = String.raw`
set -u
runtime="/root/.dsh-remote-node-harness/runtime"
cli="$runtime/node_modules/@deepseek-ai/dsh/lib/bin.js"
`
  const script = installScript({ version: '0.2.2', runtime: '/root/r/runtime', cli: '/root/r/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js', urls: ['https://x/y.tar.gz'] })
  const rollback = rollbackScript('/root/r/runtime')
  const attempt = text => {
    const result = spawnSync(shell, ['-n', '-c', `${syntax}${text}`], { encoding: 'utf8' })
    return { ok: result.status === 0, why: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 200) }
  }
  const installSyntax = attempt(script)
  check(installSyntax.ok, 'the generated install script is syntactically valid POSIX shell', installSyntax.why)
  const rollbackSyntax = attempt(rollback)
  check(rollbackSyntax.ok, 'and so is the rollback script', rollbackSyntax.why)
  log(`skip: ${picked.noSymlinks} — the transaction was NOT executed, only parsed`)
  process.stdout.write(failed === 0
    ? '[install-shell-unit] SKIPPED: no symlink-capable shell; static syntax checks passed\n'
    : `[install-shell-unit] FAILED: ${String(failed)} check(s)\n`)
  process.exitCode = failed === 0 ? 3 : 1
} else {
  const { label, toShellPath, run } = picked
  const temp = mkdtempSync(join(tmpdir(), 'rnh-install-shell-'))
  // Inside the shell's own filesystem, not the Windows share: file modes on DrvFs are all
  // 0777, which would make the executable-bit repair and its `-x` verification vacuous.
  const root = process.platform === 'win32'
    ? `/tmp/rnh-install-shell-${String(process.pid)}`
    : join(temp, 'work')
  const shellTemp = toShellPath(temp)
  const at = path => `${root}/${path}`

  /** The layout one scenario installs into, in the shell's spelling. */
  const layoutFor = base => ({
    runtime: at(`${base}/runtime`),
    cli: at(`${base}/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`),
  })
  const installFor = (base, version, archive) => installScript({
    version,
    ...layoutFor(base),
    urls: [`file://${at(`arch/${archive}.tar.gz`)}`],
  })

  const scripts = {
    a1: installFor('s1', '0.9.9', 'a'),
    b1: installFor('s1', '1.0.0', 'b'),
    bad1: installFor('s1', '0.9.9', 'bad'),
    nosum1: installFor('s1', '0.9.9', 'nosum'),
    a5: installFor('s5', '0.9.9', 'a'),
    b5: installFor('s5', '1.0.0', 'b'),
    mig7: installFor('s7', '1.0.0', 'b'),
    a9: installFor('s9', '0.9.9', 'a'),
    rollback5: rollbackScript(layoutFor('s5').runtime, layoutFor('s5').cli),
  }
  for (const [name, text] of Object.entries(scripts)) {
    writeFileSync(join(temp, `${name}.sh`), `${text}\n`, 'utf8')
  }

  const driver = String.raw`
set -u
ROOT='@@ROOT@@'
OUT='@@OUT@@'
SCRIPTS='@@SCRIPTS@@'
STAMP='@@STAMP@@'
ARCH="$ROOT/arch"
mkdir -p "$ROOT" "$OUT" "$ARCH"
trap 'rm -rf "$ROOT"' EXIT

fact() { if [ $# -ge 2 ]; then printf 'FACT %s=%s\n' "$1" "$2"; else printf 'FACT %s=\n' "$1"; fi; }
gens() { ls -d "$1"/runtime.* 2>/dev/null | sed 's|.*/||' | sort -V | tr '\n' ' ' | sed 's/ $//'; }
last() { if [ -s "$1" ]; then tail -n 1 "$1"; fi; }
starts() { if [ -f "$1" ] && node "$1" --version >/dev/null 2>&1; then echo yes; else echo no; fi; }

# ---- a fake artefact, built with real POSIX file modes --------------------
build_tree() {
  mkdir -p "$1/node_modules/@deepseek-ai/dsh/lib" "$1/node_modules/@vscode/ripgrep-linux-x64/bin"
  printf 'console.log("%s")\n' "$2" > "$1/node_modules/@deepseek-ai/dsh/lib/bin.js"
  printf 'not really ripgrep\n' > "$1/node_modules/@vscode/ripgrep-linux-x64/bin/rg"
  # The published archive carries 0666 for every entry (measured on rc.5: 25 038 files, 0 with
  # +x), and the installer is the only place that can restore the bit. Setting it here means
  # the test proves the repair instead of assuming it.
  chmod 0666 "$1/node_modules/@vscode/ripgrep-linux-x64/bin/rg"
}
build_tree "$ROOT/build/a" 0.9.9
tar czf "$ARCH/a.tar.gz" -C "$ROOT/build/a" .
( cd "$ARCH" && sha256sum a.tar.gz > a.tar.gz.sha256 )
build_tree "$ROOT/build/b" 1.0.0
tar czf "$ARCH/b.tar.gz" -C "$ROOT/build/b" .
( cd "$ARCH" && sha256sum b.tar.gz > b.tar.gz.sha256 )
# A published hash that is not the file's: the download worked, the bytes are wrong.
cp "$ARCH/a.tar.gz" "$ARCH/bad.tar.gz"
printf 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef  bad.tar.gz\n' > "$ARCH/bad.tar.gz.sha256"
# The bytes arrived but the sidecar did not.
cp "$ARCH/a.tar.gz" "$ARCH/nosum.tar.gz"

# ---- S1: a fresh install is a symlink to generation 1 ---------------------
S="$ROOT/s1"
sh "$SCRIPTS/a1.sh" > "$OUT/s1.out" 2> "$OUT/s1.err"
fact s1_exit $?
fact s1_last "$(last "$OUT/s1.out")"
fact s1_islink "$( [ -L "$S/runtime" ] && echo yes || echo no )"
fact s1_readlink "$(readlink "$S/runtime" 2>/dev/null || true)"
fact s1_gens "$(gens "$S")"
fact s1_stamp "$( [ -s "$S/runtime/$STAMP" ] && echo yes || echo no )"
fact s1_stamp_json "$(cat "$S/runtime/$STAMP" 2>/dev/null || true)"
fact s1_rg_x "$( [ -x "$S/runtime/node_modules/@vscode/ripgrep-linux-x64/bin/rg" ] && echo yes || echo no )"
fact s1_cli "$(starts "$S/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js")"
fact s1_archive_left "$(ls "$S"/runtime-*.tar.gz "$S"/runtime-*.tar.gz.sha256 2>/dev/null | wc -l)"
fact s1_err "$(head -c 200 "$OUT/s1.err" 2>/dev/null || true)"

# ---- S2: an upgrade keeps exactly one previous generation -----------------
# Residue is planted first — an empty generation, the pre-symlink staging and backup. A
# failed or interrupted install leaves all three shapes behind, and the next install has to
# clear them without touching the live tree.
mkdir -p "$S/runtime.7/stray" "$S/runtime.incoming" "$S/runtime.previous"
printf 'residue\n' > "$S/runtime.7/stray/file"
sh "$SCRIPTS/b1.sh" > "$OUT/s2.out" 2> "$OUT/s2.err"
fact s2_exit $?
fact s2_last "$(last "$OUT/s2.out")"
fact s2_readlink "$(readlink "$S/runtime" 2>/dev/null || true)"
fact s2_gens "$(gens "$S")"
fact s2_old_cli "$(starts "$S/runtime.1/node_modules/@deepseek-ai/dsh/lib/bin.js")"
fact s2_new_cli "$(starts "$S/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js")"
fact s2_residue "$(ls -d "$S/runtime.7" "$S/runtime.incoming" "$S/runtime.previous" 2>/dev/null | wc -l)"

# ---- S3/S4: a rejected archive leaves the live generation alone -----------
S3_BEFORE_LINK="$(readlink "$S/runtime" 2>/dev/null || true)"
S3_BEFORE_GENS="$(gens "$S")"
S3_BEFORE_VERSION="$(node "$S/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" --version 2>/dev/null || true)"
sh "$SCRIPTS/bad1.sh" > "$OUT/s3.out" 2> "$OUT/s3.err"
fact s3_exit $?
fact s3_last "$(last "$OUT/s3.out")"
fact s3_readlink "$(readlink "$S/runtime" 2>/dev/null || true)"
fact s3_gens "$(gens "$S")"
fact s3_archive_left "$(ls "$S"/runtime-*.tar.gz 2>/dev/null | wc -l)"
fact s3_live_version "$(node "$S/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" --version 2>/dev/null || true)"
fact s3_before_link "$S3_BEFORE_LINK"
fact s3_before_gens "$S3_BEFORE_GENS"
fact s3_before_version "$S3_BEFORE_VERSION"

sh "$SCRIPTS/nosum1.sh" > "$OUT/s4.out" 2> "$OUT/s4.err"
fact s4_exit $?
fact s4_last "$(last "$OUT/s4.out")"
fact s4_readlink "$(readlink "$S/runtime" 2>/dev/null || true)"
fact s4_gens "$(gens "$S")"
fact s4_residue "$(ls -d "$S/runtime.incoming" "$S/runtime.previous" 2>/dev/null | wc -l)"

# ---- S5: a script killed in the swap window costs the live tree nothing --


# and it is the case the old three-statement swap turned into "this node has no runtime".
S5="$ROOT/s5"
sh "$SCRIPTS/a5.sh" > "$OUT/s5a.out" 2> "$OUT/s5a.err"
fact s5_baseline "$(readlink "$S5/runtime" 2>/dev/null || true)"
mkdir -p "$ROOT/stub"
printf '#!/bin/sh\nkill -9 $PPID\nexit 1\n' > "$ROOT/stub/ln"
chmod 0755 "$ROOT/stub/ln"
PATH="$ROOT/stub:$PATH" sh "$SCRIPTS/b5.sh" > "$OUT/s5b.out" 2> "$OUT/s5b.err"
fact s5_exit $?
fact s5_last "$(last "$OUT/s5b.out")"
fact s5_readlink "$(readlink "$S5/runtime" 2>/dev/null || true)"
fact s5_gens "$(gens "$S5")"
fact s5_live_cli "$(starts "$S5/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js")"
fact s5_new_gen_cli "$(starts "$S5/runtime.2/node_modules/@deepseek-ai/dsh/lib/bin.js")"

# ---- S6: the next connect repairs an interrupted install ------------------
sh "$SCRIPTS/b5.sh" > "$OUT/s5c.out" 2> "$OUT/s5c.err"
fact s5_recover_exit $?
fact s5_recover_last "$(last "$OUT/s5c.out")"
fact s5_recover_readlink "$(readlink "$S5/runtime" 2>/dev/null || true)"
fact s5_recover_gens "$(gens "$S5")"

# ---- S7: a live generation that cannot start is rolled back --------------
# The live symlink is pointed at a generation with no CLI, which is what "the tree does not
# start" looks like from the outside. Rollback must switch back to a generation that does.
mkdir -p "$S5/runtime.99"
ln -sfn "runtime.99" "$S5/runtime"
sh "$SCRIPTS/rollback5.sh" > "$OUT/s6.out" 2> "$OUT/s6.err"
fact s6_exit $?
fact s6_last "$(last "$OUT/s6.out")"
fact s6_readlink "$(readlink "$S5/runtime" 2>/dev/null || true)"
fact s6_live_cli "$(starts "$S5/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js")"

# ---- S8: and a live generation that does start is left alone -------------
sh "$SCRIPTS/rollback5.sh" > "$OUT/s8.out" 2> "$OUT/s8.err"
fact s8_exit $?
fact s8_last "$(last "$OUT/s8.out")"
fact s8_readlink "$(readlink "$S5/runtime" 2>/dev/null || true)"

# ---- S9: an install on a pre-symlink node migrates it instead of losing it

# happen before anything is downloaded, so every exit path sees a symlink and the commit point
# stays one statement.
S7="$ROOT/s7"
mkdir -p "$S7"
cp -a "$ROOT/build/a" "$S7/runtime"
fact s7_before_islink "$( [ -L "$S7/runtime" ] && echo yes || echo no )"
sh "$SCRIPTS/mig7.sh" > "$OUT/s7.out" 2> "$OUT/s7.err"
fact s7_exit $?
fact s7_last "$(last "$OUT/s7.out")"
fact s7_islink "$( [ -L "$S7/runtime" ] && echo yes || echo no )"
fact s7_readlink "$(readlink "$S7/runtime" 2>/dev/null || true)"
fact s7_gens "$(gens "$S7")"
fact s7_old_cli "$(starts "$S7/runtime.0/node_modules/@deepseek-ai/dsh/lib/bin.js")"
fact s7_new_cli "$(starts "$S7/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js")"

# ---- S10: a signal is a reported failure, not a silent death -------------

# TERM there is the ordinary "the caller gave up" case. The contract says the last line of
# stdout is still one JSON object — otherwise the caller has to guess whether the node was
# touched, and the one thing it must know is that it was not.
S9="$ROOT/s9"
mkdir -p "$ROOT/stub-slow"
printf '#!/bin/sh\nsleep 3\nexit 1\n' > "$ROOT/stub-slow/curl"
chmod 0755 "$ROOT/stub-slow/curl"
PATH="$ROOT/stub-slow:$PATH" sh "$SCRIPTS/a9.sh" > "$OUT/s9.out" 2> "$OUT/s9.err" &
SLOW=$!
sleep 1
kill -TERM "$SLOW" 2>/dev/null || true
wait "$SLOW" 2>/dev/null
fact s9_exit $?
fact s9_last "$(last "$OUT/s9.out")"
fact s9_runtime_exists "$( [ -e "$S9/runtime" ] && echo yes || echo no )"
fact s9_gens "$(gens "$S9")"
`.replaceAll('@@ROOT@@', root)
    .replaceAll('@@OUT@@', at('out'))
    .replaceAll('@@SCRIPTS@@', shellTemp)
    .replaceAll('@@STAMP@@', BUILD_STAMP)

  const driverPath = join(temp, 'driver.sh')
  writeFileSync(driverPath, driver.replaceAll('\r\n', '\n'), 'utf8')
  const runResult = run(toShellPath(driverPath))
  const stdout = runResult.stdout ?? ''
  const stderr = runResult.stderr ?? ''
  /** @type {Record<string, string>} */
  const facts = {}
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('FACT ')) continue
    const rest = line.slice('FACT '.length)
    const at2 = rest.indexOf('=')
    if (at2 <= 0) continue
    facts[rest.slice(0, at2)] = rest.slice(at2 + 1)
  }
  const fact = name => facts[name] ?? ''
  /** @type {any} */
  let lastJson
  try {
    lastJson = JSON.parse(fact('s1_last'))
  } catch {
    lastJson = undefined
  }
  const jsonOf = name => {
    try {
      return JSON.parse(fact(name))
    } catch {
      return undefined
    }
  }
  const parsedOf = name => parseScriptResult({ stdout: fact(name), stderr: '' })

  log(`shell: ${label}, workdir ${root}`)
  if (Object.keys(facts).length === 0) {
    log(`driver produced no facts (exit ${String(runResult.status)}): ${(stderr || stdout).trim().slice(0, 400)}`)
    failed += 1
  }

  // ---- the install really happened ----------------------------------------
  check(fact('s1_exit') === '0', 'a fresh install exits 0', fact('s1_exit'))
  check(lastJson?.ok === true && lastJson?.code === SCRIPT_CODES.INSTALLED,
    'its last stdout line is the INSTALLED result object', fact('s1_last'))
  check(lastJson?.version === '0.9.9', 'carrying the version the staged CLI reported', lastJson?.version)
  check(lastJson?.generation === 'runtime.1', 'and the generation it made live', lastJson?.generation)
  check(fact('s1_islink') === 'yes',
    'the live runtime is a symlink, not a directory', fact('s1_islink'))
  check(fact('s1_readlink') === 'runtime.1',
    'pointing at the generation it unpacked', fact('s1_readlink'))
  check(fact('s1_gens') === 'runtime.1',
    'and it left no second generation behind on a first install', fact('s1_gens'))
  check(fact('s1_stamp') === 'yes', 'the build stamp is in the live tree')
  let stamp
  try {
    stamp = JSON.parse(fact('s1_stamp_json'))
  } catch {
    stamp = undefined
  }
  check(stamp?.build === RUNTIME_BUILD && stamp?.via === 'artefact',
    'and it records this build and the route it arrived by', fact('s1_stamp_json'))
  check(fact('s1_rg_x') === 'yes',
    'a payload that arrived mode 0666 is executable after the repair', fact('s1_rg_x'))
  check(fact('s1_cli') === 'yes', 'the live tree starts through the symlink')
  check(fact('s1_archive_left') === '0',
    'the downloaded archive and its sidecar are cleaned up', fact('s1_archive_left'))

  // ---- upgrade: one previous generation, bounded cleanup -------------------
  check(fact('s2_exit') === '0', 'an upgrade exits 0', fact('s2_exit'))
  check(jsonOf('s2_last')?.generation === 'runtime.8',
    'it writes into the next free generation, after the residue gap', fact('s2_last'))
  check(fact('s2_readlink') === 'runtime.8', 'and makes that one live', fact('s2_readlink'))
  check(fact('s2_gens') === 'runtime.1 runtime.8',
    'exactly one previous generation is kept, for a rollback to point at', fact('s2_gens'))
  check(fact('s2_old_cli') === 'yes', 'the kept generation still starts, so it is a real fallback')
  check(fact('s2_new_cli') === 'yes', 'and so does the live one')
  check(fact('s2_residue') === '0',
    'a stray generation, the old staging dir and the old backup are all cleared',
    fact('s2_residue'))

  // ---- a rejected archive changes nothing ---------------------------------
  check(fact('s3_exit') !== '0', 'a checksum mismatch fails the install', fact('s3_exit'))
  check(jsonOf('s3_last')?.code === SCRIPT_CODES.ARTEFACT_CHECKSUM_MISMATCH,
    'reporting the mismatch as a code rather than as stderr text', fact('s3_last'))
  check(jsonOf('s3_last')?.want === 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    'with the published hash it expected', jsonOf('s3_last')?.want)
  check(jsonOf('s3_last')?.got !== undefined && jsonOf('s3_last')?.got !== jsonOf('s3_last')?.want,
    'and the one it computed', jsonOf('s3_last')?.got)
  check(fact('s3_readlink') === fact('s3_before_link'),
    'the live symlink still points at the same generation', `${fact('s3_before_link')} → ${fact('s3_readlink')}`)
  check(fact('s3_gens') === fact('s3_before_gens'),
    'no generation was created or removed', fact('s3_gens'))
  check(fact('s3_live_version') === fact('s3_before_version') && fact('s3_live_version') === '1.0.0',
    'and the live tree is unchanged and still runs', fact('s3_live_version'))
  check(fact('s3_archive_left') === '0', 'the rejected download is deleted', fact('s3_archive_left'))

  check(fact('s4_exit') !== '0', 'an archive with no sidecar fails the install', fact('s4_exit'))
  check(jsonOf('s4_last')?.code === SCRIPT_CODES.ARTEFACT_CHECKSUM_UNAVAILABLE,
    'as CHECKSUM_UNAVAILABLE, not as a missing artefact', fact('s4_last'))
  check(fact('s4_readlink') === fact('s3_before_link'),
    'and that too leaves the live generation alone', fact('s4_readlink'))
  check(fact('s4_gens') === fact('s3_before_gens'), 'with no generation created', fact('s4_gens'))

  // ---- killed at the commit point ----------------------------------------
  check(fact('s5_baseline') === 'runtime.1', 'the baseline node is live on generation 1', fact('s5_baseline'))
  check(fact('s5_exit') !== '0', 'a script killed in the swap window does not exit 0', fact('s5_exit'))
  check(fact('s5_readlink') === 'runtime.1',
    'but the live symlink is untouched, so the node still has a runtime', fact('s5_readlink'))
  check(fact('s5_live_cli') === 'yes', 'and that runtime still starts')
  check(fact('s5_gens').includes('runtime.2'),
    'the half-finished generation is left as residue, not as the live tree', fact('s5_gens'))
  // A `kill -9` cannot run a trap, so there is no result line — which is why the parser's
  // UNKNOWN path exists. What matters is that the caller can tell it apart from a report.
  check(!parsedOf('s5_last').parsed,
    'a SIGKILLed script prints no result line, so the caller reads UNKNOWN', fact('s5_last'))
  check(parsedOf('s5_last').code === SCRIPT_CODES.UNKNOWN, 'and UNKNOWN is what it is', parsedOf('s5_last').code)
  // The judgement that a caller makes in that state, run for real: the live generation starts,
  // so the answer must be kept-current and nothing may be moved.
  check(fact('s5_recover_exit') === '0', 'connecting again installs normally', fact('s5_recover_exit'))
  check(fact('s5_recover_readlink') === 'runtime.3',
    'into the generation after the residue, which is now live', fact('s5_recover_readlink'))
  check(fact('s5_recover_gens') === 'runtime.1 runtime.3',
    'and the interrupted generation is pruned by that next install', fact('s5_recover_gens'))

  // ---- rollback, run for real -------------------------------------------
  check(jsonOf('s6_last')?.code === ROLLBACK_VERDICTS.ROLLED_BACK,
    'a live generation that cannot start is rolled back', fact('s6_last'))
  check(fact('s6_readlink') === 'runtime.3',
    'to the newest generation that does start', fact('s6_readlink'))
  check(fact('s6_live_cli') === 'yes', 'and the node starts again')
  check(jsonOf('s8_last')?.code === ROLLBACK_VERDICTS.KEPT_CURRENT,
    'asking a second time keeps the runtime, because it now starts', fact('s8_last'))
  check(fact('s8_readlink') === 'runtime.3', 'changing nothing at all', fact('s8_readlink'))

  // ---- a pre-symlink node is migrated, not destroyed ---------------------
  check(fact('s7_before_islink') === 'no', 'the fixture starts as a real directory, like an old node')
  check(fact('s7_exit') === '0', 'installing over it succeeds', fact('s7_exit'))
  check(fact('s7_islink') === 'yes', 'and it becomes a symlink', fact('s7_islink'))
  check(fact('s7_readlink') === 'runtime.1', 'pointing at the generation just installed', fact('s7_readlink'))
  check(fact('s7_gens') === 'runtime.0 runtime.1',
    'with the old directory kept as generation 0 — the migration moved it, it did not delete it',
    fact('s7_gens'))
  check(fact('s7_old_cli') === 'yes', 'and that old tree still starts')
  check(fact('s7_new_cli') === 'yes', 'as does the new one')

  // ---- a signal still produces the result line --------------------------
  check(fact('s9_exit') !== '0', 'a TERMed install exits non-zero', fact('s9_exit'))
  check(jsonOf('s9_last')?.code === SCRIPT_CODES.ARTEFACT_INTERRUPTED,
    'and its last line says it was interrupted, rather than dying silently', fact('s9_last'))
  check(jsonOf('s9_last')?.ok === false, 'as a failure, since nothing was installed', fact('s9_last'))
  check(fact('s9_runtime_exists') === 'no' && fact('s9_gens') === '',
    'with no runtime created at all', `${fact('s9_runtime_exists')} / ${fact('s9_gens')}`)

  const tail = stdout.split('\n').filter(line => line.startsWith('FACT ') && line.includes('last='))
  check(tail.length > 0, 'every script produced a result line to read', String(tail.length))

  try {
    rmSync(temp, { recursive: true, force: true })
  } catch {
    // A temp directory that will not delete is not a test failure; the OS owns it now.
  }
  // Keep the driver's own stderr visible when something went wrong: it is where a shell-level
  // failure (a missing `sha256sum`, a `tar` that refused) shows up first.
  if (failed > 0 && stderr.trim() !== '') log(`driver stderr: ${stderr.trim().slice(0, 300)}`)
  process.stdout.write(failed === 0
    ? '[install-shell-unit] all checks passed\n'
    : `[install-shell-unit] FAILED: ${String(failed)} check(s)\n`)
  process.exitCode = failed === 0 ? 0 : 1
}
