/**
 * Remote runtime lifecycle for one node: probe the machine, ensure a usable
 * Node and a DSH installation, start the resident host, and read back the fact
 * that it is serving.
 *
 * The resident host is the whole point of this plugin. Every tool the agent
 * runs afterwards executes inside that process, on that machine, against that
 * machine's own filesystem and binaries: `rg`, `git`, `read_image`, `bash` and
 * the PTY all behave like a local install because they *are* a local install.
 * Nothing is mirrored, copied or translated.
 *
 * It is, however, a **separate DSH installation** with its own `~/.dsh`, which is why
 * this plugin writes a profile of its own there: `~/.dsh/profiles/rnh`, composed as
 * `dsh-base` + `@local/rnh-brain`, with the model rows and permission preset in
 * that profile's `cordis.patch.yml`.
 *
 * That file choice is load-bearing rather than cosmetic. `dsh-hmr` watches exactly two
 * paths — a profile's `cordis.patch.yml` and `$DSH_HOME/cordis.patch.yml` — so writing
 * the profile patch is what lets this Host change a running node's model roster or key
 * **without restarting it**. A `--patch` overlay is not watched (measured; see
 * `docs/adr-0001-node-config-carrier.zh.md`).
 *
 * @module @greatbaby/dsh-remote-node-harness/remote/daemon
 */
import { createHash } from 'node:crypto'
import { SSH_FAILURE, classifySshError, quotePosixArgument, toSshError } from '../ssh/connection.js'
import {
  BUILD_STAMP,
  FETCH_CEILING_SECONDS,
  ROLLBACK_VERDICTS,
  SCRIPT_CODES,
  artefactUrls,
  inspectRuntime,
  installScript,
  parseScriptResult,
  platformTag,
  rollbackScript,
  shellPath,
} from './artefact.js'
import { archiveFor, totalBytes, watchTransfer } from './transfer-progress.js'

/**
 * The Node major version the resident host needs.
 *
 * Deliberately **below** what `@deepseek-ai/dsh` declares. Every `0.2.2` release publishes
 * `engines.node: ">=24.9.0"` (rc.1, rc.3, rc.4, rc.5 all checked), while the node in
 * service runs Node v22.20.0 with a working rc.3 on it. The desktop's own runtime is
 * Electron's Node 24, so this floor is only about the *node*.
 *
 * The runtime arrives as an unpacked tree, which never consults `engines`, so raising this
 * to 24 would newly reject machines that work today. The floor stays where a real node has
 * been measured running.
 */
export const MINIMUM_NODE_MAJOR = 22

/**
 * The bundle list an untouched `web` profile has.
 *
 * Mirrors `PROFILE_TEMPLATES.web` in `@deepseek-ai/dsh-official-bundles`. It is
 * duplicated rather than imported because this plugin keeps zero upstream imports
 * (see `AGENTS.md`), and because restoring a profile is a one-time repair, not a
 * long-lived contract: if upstream ever changes the template, a node whose `web`
 * profile was mutated simply ends up composing the older list, which is still a
 * working web app.
 */
const WEB_PROFILE_BUNDLES = Object.freeze(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])

/**
 * The profile this plugin owns on a node.
 *
 * It is deliberately its own profile rather than the upstream `web` one: a profile
 * has exactly one `cordis.patch.yml`, and that file is the **only** configuration
 * carrier the running host hot-reloads. Sharing `web` would mean this plugin and
 * anything else on the node writing the same file. See `docs/adr-0001`.
 */
export const NODE_PROFILE = 'rnh'

/** The root a node gets when its record names none. */
export const DEFAULT_REMOTE_ROOT = '~/.dsh-remote-node-harness'

/**
 * Files this plugin owns on one remote machine.
 *
 * This is a function of the node's own root rather than one global constant, because
 * two nodes can be the same machine reached under different roots — the ordinary way to
 * test a second node, and a real setup for somebody who wants a scratch brain beside
 * their main one. With a constant, the second node silently reused the first one's
 * runtime, resident host and status file, so "two connected nodes" was really one node
 * counted twice.
 *
 * The **profile name** is derived from the root for the same reason: a profile's
 * `cordis.patch.yml` is the file the resident host hot-reloads, so two nodes sharing
 * one profile would overwrite each other's model roster. `~/.dsh-remote-node-harness` keeps the
 * historical name `rnh`, so existing nodes are untouched.
 *
 * The node's DSH *home* stays shared on purpose: it holds the Session log, and two
 * roots on one machine are two views of one Harness rather than two machines.
 *
 * @param {string} [root] - the node's own directory, e.g. `~/.dsh-remote-node-harness`.
 */
export function remoteLayout(root = DEFAULT_REMOTE_ROOT) {
  const base = root.replace(/\/+$/u, '')
  const profile = profileNameFor(base)
  return Object.freeze({
    root: base,
    /**
     * The live runtime, and it is a **symlink** to `runtime.<n>`.
     *
     * Kept under the same name because every read of it — the launch line, the CLI path,
     * `inspectRuntime`, the build stamp — must go through the symlink: resolving a
     * generation at read time would let two readers disagree about which tree is live.
     * `node <runtime>/node_modules/…/bin.js` works unchanged through a symlink, and
     * `cd <runtime>` follows it, so nothing that reads this path needed to change.
     *
     * The install script owns the generations (`runtime.<n>`, one previous kept). See
     * `artefact.js` `installScript`.
     */
    runtime: `${base}/runtime`,
    /** The live symlink and the generation directories, spelled separately where a
     * caller has to tell them apart (a liveness probe must not follow into a broken
     * target and call it alive). */
    runtimeLink: `${base}/runtime`,
    generationPrefix: `${base}/runtime.`,
    run: `${base}/run`,
    log: `${base}/run/host.log`,
    status: `${base}/run/status.json`,
    /** The overlay earlier builds wrote and passed as `--patch`. Kept only so a
     * reconnect can remove it; the profile patch below is the live carrier. */
    legacyPatch: `${base}/run/brain.patch.yml`,
    packageJson: `${base}/runtime/package.json`,
    cli: `${base}/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`,
    /** The node's DSH home and the profile this plugin owns. */
    home: '~/.dsh',
    profile: `~/.dsh/profiles/${profile}`,
    /** The profile's own patch: the watched file, so config changes need no restart. */
    profilePatch: `~/.dsh/profiles/${profile}/cordis.patch.yml`,
    /** Where the Loader resolves a bundle's row names from for that profile. */
    profileModules: `~/.dsh/profiles/${profile}/node_modules`,
    /** The profile earlier builds mutated. Reverted on connect, never deleted. */
    legacyProfile: '~/.dsh/profiles/web',
    /** The profile name, which the resident host is started with. */
    profileName: profile,
  })
}

/**
 * A profile name for one root.
 *
 * `~/.dsh-remote-node-harness` keeps `rnh` so a node provisioned by an earlier build keeps working.
 * Anything else is `rnh-<last path segment>`, which is stable across reconnects and
 * distinct per root: `~/.dsh-remote-node-harness-b` becomes `rnh-rnh-b`… no — the segment is
 * stripped of its own `dsh-` prefix first, so that same root reads `rnh-b`.
 * @param {string} root
 */
function profileNameFor(root) {
  if (root === DEFAULT_REMOTE_ROOT || root === '~/.dsh-remote-node-harness/') return NODE_PROFILE
  // The last segment is what a person would call this root ("rnh-b"), and it is the
  // only part that distinguishes one root from another in the common `~/.<name>` shape.
  const segment = root.split('/').filter(Boolean).at(-1) ?? ''
  const cleaned = segment.replace(/^\./u, '').replace(/^dsh-remote-node-harness-?/u, '').replace(/[^A-Za-z0-9-]/gu, '')
  // A root that reduces to nothing (say `~/`) would collide with the default profile.
  return cleaned === '' ? NODE_PROFILE : `${NODE_PROFILE}-${cleaned}`
}

/** The default node's layout, for callers that only have one node. */
export const REMOTE_LAYOUT = remoteLayout()

/**
 * The shell that installs third-party bundles into a node's profile.
 *
 * `--legacy-peer-deps` is not a convenience flag here: without it this command bricks
 * the node. Third-party bundles declare peers on `@deepseek-ai/dsh-*` with ranges such
 * as `^0.2.0-rc.1` (dsh-pet, dsh-whale-widget, the hindsight bundle), and npm satisfies
 * a peer by downloading that package — into *this* profile's
 * `node_modules/@deepseek-ai/`, which resolves ahead of the runtime tree's own copy.
 * Measured against 0.2.2-rc.3: one plugin install pulled `dsh-session@0.2.0-rc.2` and
 * 31 more, the resident host then reported `2 required plugins did not activate`,
 * printed no URL, and `connect` failed with a log tail instead of a node. A plugin must
 * not drag DSH itself along: the runtime tree is the single source of those packages,
 * so peers are never resolved from the registry here.
 *
 * @param {{ profile: string, profileName: string, targets: readonly string[] }} options
 * @returns {string}
 */
export function pluginInstallScript({ profile, profileName, targets }) {
  // The manifest is a **shell literal**, never a printf format.
  //
  // This line used to be `printf '{"name":…"dependencies":{}}\n'` written inside a JS
  // template string. Two levels of escaping collapsed into each other: the shell received
  // `{}}` followed by *two backslashes and an n*, printf turned that into one literal
  // backslash plus `n`, and the file ended with the text `\n` rather than a newline. npm
  // then refused the manifest with
  // `EJSONPARSE … Unexpected non-whitespace character after JSON at position 65`, so every
  // new node's **first** connect failed to install its plugins while the settings page just
  // showed "the plugin did not take effect". The second connect only worked because
  // `writeProfileBundles` had rewritten the manifest in the meantime.
  //
  // So the newline is not an escape at all here: `'%s\n'` is printf's *own* format (one
  // backslash in the shell script), and the JSON rides as a single-quoted shell word, where
  // `"`, `{}`, `/` and `$` are all literal. `quotePosixArgument` is this project's existing
  // single-quote escaper (`'` → `'\''`), so a profile name containing a quote or a backslash
  // still produces a valid JSON file instead of a truncated shell word. The profile name is
  // sanitized to `[A-Za-z0-9-]` today, but the escaper must not depend on that.
  const manifest = JSON.stringify({ name: `dsh-profile-${profileName}`, private: true, dependencies: {} })
  return `
set -u
mkdir -p ${profile}
cd ${profile}
if [ ! -f package.json ]; then
  printf '%s\\n' ${quotePosixArgument(manifest)} > package.json
fi
npm install --no-audit --no-fund --loglevel=error --legacy-peer-deps ${targets.map(target => `"${target}"`).join(' ')} 2>&1
echo "RNH_NPM_EXIT=$?"
`.trim()
}

const PROBE_COMMAND = `
set -u
printf 'BEGIN\\n'
printf 'os=%s\\n' "$(uname -s 2>/dev/null || echo unknown)"
printf 'arch=%s\\n' "$(uname -m 2>/dev/null || echo unknown)"
printf 'libc=%s\\n' "$( (ldd --version 2>/dev/null || true) | head -1 | tr -d '[:space:]' )"
printf 'musl=%s\\n' "$(ls /lib/ld-musl-* 2>/dev/null | head -1 || echo)"
printf 'home=%s\\n' "$HOME"
printf 'node=%s\\n' "$(command -v node 2>/dev/null || echo)"
printf 'node_version=%s\\n' "$(node -v 2>/dev/null || echo)"
printf 'npm=%s\\n' "$(command -v npm 2>/dev/null || echo)"
printf 'git=%s\\n' "$(command -v git 2>/dev/null || echo)"
printf 'tar=%s\\n' "$(command -v tar 2>/dev/null || echo)"
printf 'curl=%s\\n' "$(command -v curl 2>/dev/null || echo)"
printf 'wget=%s\\n' "$(command -v wget 2>/dev/null || echo)"
printf 'setsid=%s\\n' "$(command -v setsid 2>/dev/null || echo)"
printf 'shell=%s\\n' "$SHELL"
printf 'END\\n'
`.trim()

/** Parse the `key=value` block the probe prints. */
export function parseProbeOutput(stdout) {
  const facts = {}
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    if (key === '' || key === 'BEGIN' || key === 'END') continue
    facts[key] = line.slice(at + 1).trim()
  }
  return facts
}

/**
 * Whether this machine's C library is musl.
 *
 * This decides **which archive the node asks for** (`linux-x64` vs `linux-x64-musl`), and
 * that is now the only thing it decides: `@koromix/koffi-linux-x64` ships a `linux_x64` and a
 * `musl_x64` binary, `sharp` ships both builds, and the loader picks by the platform it runs
 * on — so an Alpine node handed the glibc tree fails on the first tool that needs it, not on
 * the install. It used to feed npm's `--libc` on the node-side resolve; that route is gone.
 *
 * Two probes because neither alone is reliable: `ldd` prints "musl libc" on Alpine but is
 * absent on some minimal images, while the loader `ls /lib/ld-musl-*` is musl-specific and
 * survives a missing `ldd`.
 * @param {{ libc?: string, musl?: string }} facts
 * @returns {'musl' | 'glibc' | undefined}
 */
export function detectLibc(facts) {
  const reported = String(facts?.libc ?? '').toLowerCase()
  const loader = String(facts?.musl ?? '').trim()
  if (reported.includes('musl') || loader !== '') return 'musl'
  if (reported.includes('glibc') || reported.includes('gnu libc') || reported.includes('ldd')) return 'glibc'
  return undefined
}

/** A probe result normalized for the settings UI. */
export function describeProbe(facts) {
  const major = Number.parseInt((facts.node_version ?? '').replace(/^v/u, ''), 10)
  return {
    os: facts.os ?? 'unknown',
    arch: facts.arch ?? 'unknown',
    libc: detectLibc(facts),
    home: facts.home ?? '',
    nodePath: facts.node ?? '',
    nodeVersion: facts.node_version ?? '',
    nodeMajor: Number.isFinite(major) ? major : 0,
    nodeUsable: Number.isFinite(major) && major >= MINIMUM_NODE_MAJOR,
    npmPath: facts.npm ?? '',
    gitPath: facts.git ?? '',
    tarPath: facts.tar ?? '',
    curlPath: facts.curl ?? '',
    wgetPath: facts.wget ?? '',
    setsidPath: facts.setsid ?? '',
    shell: facts.shell ?? '',
  }
}

/** The remote helper that owns one node's resident host. */
export class RemoteHost {
  /**
   * @param {object} options
   * @param {import('../ssh/connection.js').SshConnection} options.connection
   * @param {string} options.version - the DSH version this profile runs.
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    this.connection = options.connection
    this.version = options.version
    // One node's own paths. Two records can name the same machine under different
    // roots, and with a shared constant the second one silently reused the first one's
    // runtime, resident host and status file.
    this.layout = options.layout ?? REMOTE_LAYOUT
    this.log = options.log ?? (() => {})
    /** @type {{ port: number, token: string, pid: number, version: string } | undefined} */
    this.serving = undefined
  }

  /** Inspect the machine. */
  async probe() {
    const result = await this.connection.exec({ argv: ['sh', '-c', PROBE_COMMAND], timeoutMs: 30_000 })
    if (result.code !== 0) {
      throw toSshError(new Error(`remote probe failed (exit ${String(result.code)}): ${result.stderr.trim()}`))
    }
    return describeProbe(parseProbeOutput(result.stdout))
  }

  /** Read the recorded host status, or `undefined` when there is no host. */
  async status() {
    const result = await this.connection.exec({
      argv: ['sh', '-c', `cat ${this.layout.status} 2>/dev/null || echo '{}'`],
      timeoutMs: 20_000,
    })
    const text = result.stdout.trim()
    if (text === '' || text === '{}') return undefined
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed?.port !== 'number' || typeof parsed?.token !== 'string') return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  /**
   * Whether one recorded process command line was launched for this node's profile.
   *
   * The comparison is anchored on both sides: `--profile <name>` must be followed by a space or
   * the end of the command line. A bare `includes('--profile rnh')` also accepts
   * `--profile rnh-dsh-fleet`, which is a **different node on the same machine** — the exact
   * collision this per-root profile naming exists to prevent.
   *
   * @param {string} cmdline - the process's command line, `/proc` NUL bytes already turned to
   *   spaces (or `ps -o command=`).
   * @param {string} profile - the profile name this node launches.
   * @returns {boolean}
   */
  #hasProfile(cmdline, profile) {
    if (cmdline === '' || profile === '') return false
    return cmdline.includes(`--profile ${profile} `) || cmdline.endsWith(`--profile ${profile}`)
  }

  /**
   * What a pid *is*, not merely that it exists.
   *
   * `kill -0 <pid>` answers one question — "does this pid exist" — and that is not the
   * question a resident host needs answered. A pid is reused after a reboot (PID 1…32768
   * wraps), so a `status.json` read back from a machine that rebooted pointed at whatever
   * now holds that number, and the old code called that host "alive". Two facts are needed
   * to tell a live host from a coincidence:
   *
   * - the command line, which must carry `--profile <our profile>` (the profile name is
   *   derived from the node's `remoteRoot`, so it is unique per node on that machine);
   * - the process **start time**, which must equal the one recorded beside the pid. Two
   *   different processes never share a pid *and* a start time, so the pair identifies the
   *   launch rather than the number.
   *
   * **`/proc` is not portable and the fallback is deliberate.** Linux gives both facts from
   * `/proc/<pid>/cmdline` and `/proc/<pid>/stat`; macOS has no `/proc`, so the command line
   * comes from `ps -p <pid> -o command=` and the start time is unavailable. On that platform
   * the judgement degrades to "the command line names our profile", which is the strongest
   * fact available there — weaker than the pair, and named as such here so it is not mistaken
   * for equal. The probe reports which one answered (`proc=yes|no`).
   *
   * @param {number} pid
   * @returns {Promise<{alive: boolean, cmdline: string, starttime: string | undefined, proc: boolean}>}
   */
  async #processProbe(pid) {
    const script = `
set -u
pid=${String(pid)}
alive=no
if kill -0 "$pid" 2>/dev/null; then alive=yes; fi
if [ "$alive" = no ]; then
  printf 'alive=no\\nproc=unknown\\ncmdline=\\nstarttime=\\n'
  exit 0
fi
if [ -r "/proc/$pid/cmdline" ]; then
  printf 'alive=yes\\nproc=yes\\n'
  printf 'cmdline=%s\\n' "$(tr '\\0' ' ' < "/proc/$pid/cmdline")"
  printf 'starttime=%s\\n' "$(sed 's/^.*) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $20}')"
else
  # No procfs (darwin). The command line is still available; the start time is not.
  printf 'alive=yes\\nproc=no\\n'
  printf 'cmdline=%s\\n' "$(ps -p "$pid" -o command= 2>/dev/null | tr '\\n' ' ')"
  printf 'starttime=\\n'
fi
`.trim()
    const result = await this.connection.exec({ argv: ['sh', '-c', script], timeoutMs: 15_000, maxBytes: 8192 })
    /** @type {Record<string, string>} */
    const facts = {}
    for (const line of result.stdout.split('\n')) {
      const at = line.indexOf('=')
      if (at <= 0) continue
      facts[line.slice(0, at)] = line.slice(at + 1).trim()
    }
    return {
      alive: facts.alive === 'yes',
      cmdline: facts.cmdline ?? '',
      starttime: facts.starttime === undefined || facts.starttime === '' ? undefined : facts.starttime,
      proc: facts.proc === 'yes',
    }
  }

  /**
   * Whether one recorded pid is still the resident host this root started.
   *
   * The answer is "yes" only when all three hold: the pid exists, its command line names
   * this node's profile, and — where the platform can tell — the start time recorded in
   * `status.json` is the one the process has now. A pid that exists but fails either of the
   * other two is **not** our host, and treating it as one is what made a rebooted machine
   * look connected.
   *
   * A `status.json` written before start times were recorded has none; those records are
   * accepted on the command line alone and upgraded in place the next time the host is
   * adopted (see `ensureServing`). Refusing them instead would restart every node once for
   * a cosmetic upgrade, and a restart of a serving host is a visible interruption.
   *
   * @param {number} pid
   * @param {{ profile?: string, starttime?: string | number }} [expected] - what the record says.
   * @returns {Promise<boolean>}
   */
  async isAlive(pid, expected = {}) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    const probe = await this.#processProbe(pid)
    if (!probe.alive) return false
    const profile = expected.profile ?? this.layout.profileName
    // The profile has to appear as `--profile <name>`, and the name has to end there: a bare
    // substring match would also accept `--profile rnh-dsh-fleet`, which is a different node.
    if (!this.#hasProfile(probe.cmdline, profile)) return false
    if (probe.proc && expected.starttime !== undefined && probe.starttime !== undefined) {
      return String(probe.starttime) === String(expected.starttime)
    }
    // Either the platform has no procfs or the record predates start times: the command
    // line is all the evidence there is. Documented here rather than silently weakened.
    return true
  }

  /**
   * Install or upgrade the resident DSH under the node's root.
   *
   * **One route: the published artefact.** One download, no registry, no resolution: the node
   * ends up on bytes this project built and tested. Downloads go through the **source list**
   * (`DEFAULT_SOURCES`: CNB, and only CNB) and nowhere else — `artefactUrls()` has no
   * direct-GitHub candidate, because GitHub direct measures ~27 KB/s here and a 165 MiB
   * archive at that speed is 1.8 hours, which is the "connecting hangs" report this came from.
   *
   * **There used to be a second route and it was removed, not disabled.** It ran
   * `npm install @deepseek-ai/dsh@<version>` on the node when the artefact could not be had.
   * That route installs the **upstream release**, and it wrote the same `BUILD_STAMP` this
   * build writes. So a node that fell back once would read as "in step" forever: one network
   * blip would pin it to the upstream tree permanently, while the settings page said "ready".
   * Keeping it behind a flag would keep that trap one config value away. See
   * `docs/adr-0007-fork-node-runtime.zh.md`.
   *
   * **What this means for an upstream bump.** The desktop and the node runtime are built from
   * the same pinned release, so a desktop upgrade has no artefact until this project rebuilds
   * one. The connect then fails with the URLs it tried — a decidable failure, on purpose.
   *
   * A broken artefact is still a different thing from a missing one: exit codes 4, 5, 6 and 7
   * mean the bytes arrived but did not survive the checksum, the unpack, the shape check or the
   * executable-bit check. All four happen **before** the live tree is replaced, so the failure
   * keeps the release the node already had and then **throws**; the previous tree is only used
   * when the live one cannot start (see `#rollbackAfterFailure`). A transport failure is judged
   * the same way and reported with the same verdict line.
   *
   * The URL is built here rather than by the caller because it needs the **node's**
   * platform, which only the probe knows. A runtime packed on Windows carries
   * `sherpa-onnx-win-x64` and a Windows `node-pty`; unpacking it on Linux would give a node
   * whose terminal fails at first use.
   *
   * @param {{ nodeUsable: boolean, nodeVersion?: string, curlPath?: string, wgetPath?: string, os?: string, arch?: string }} facts
   * @param {{ sources?: Array<{kind: 'prefix' | 'template', prefix?: string, template?: string}>,
   *   onTransfer?: (progress: { bytes: number, total?: number, bytesPerSecond?: number, etaMs?: number } | undefined) => void }} [options]
   * @returns {Promise<{ version: string, via: 'artefact' }>}
   */
  async install(facts, options = {}) {
    if (!facts.nodeUsable) {
      throw toSshError(new Error(
        `this machine runs Node ${facts.nodeVersion || '(none)'}, but the resident host needs Node ${String(MINIMUM_NODE_MAJOR)} or newer. `
        + 'Install a newer Node.js and connect again.',
      ))
    }
    const failures = []
    const tried = await this.#installFromArtefact(facts, options, failures)
    if (tried !== undefined) return tried
    throw toSshError(new Error(
      `the resident DSH ${this.version} could not be installed on this machine:\n`
      + failures.map(line => `  ${line}`).join('\n'),
    ))
  }

  /**
   * The artefact route. Returns `undefined` when nothing could be installed, with the reason
   * appended to `failures`.
   *
   * A download that could not be **had** (no source, no downloader, every source refusing) is
   * reported; anything that arrived and then failed throws.
   *
   * @param {object} facts
   * @param {{ sources?: Array<{kind: 'prefix' | 'template', prefix?: string, template?: string}> }} options
   * @param {string[]} failures
   */
  async #installFromArtefact(facts, options, failures) {
    const platform = platformTag(facts)
    if (platform === undefined) {
      failures.push(
        `artefact: this machine reports ${String(facts.os)}/${String(facts.arch)}, which has no platform tag`,
      )
      return undefined
    }
    const canDownload = (facts.curlPath ?? '') !== '' || (facts.wgetPath ?? '') !== ''
    if (!canDownload) {
      failures.push('artefact: this machine has neither curl nor wget')
      this.log('this machine has no curl or wget; the runtime cannot be installed')
      return undefined
    }
    let urls
    try {
      urls = artefactUrls({
        version: this.version,
        platform,
        sources: options.sources,
      })
    } catch (error) {
      failures.push(`artefact: ${error instanceof Error ? error.message : String(error)}`)
      this.log('no artefact source is configured; the runtime cannot be installed')
      return undefined
    }
    const script = installScript({
      version: this.version,
      runtime: this.layout.runtime,
      cli: this.layout.cli,
      urls,
    })
    // Watch the archive grow while `curl` writes it.
    //
    // The download is the only step of a connect with a duration a person notices — 58.2 MiB
    // on a link that manages 300 KiB/s is three minutes of nothing on screen. `exec` answers
    // when the channel closes, so `curl`'s own output cannot be used; the archive on disk can.
    // Both halves are optional: a source that omits `content-length` gives bytes without a
    // percentage, and a watch that cannot measure simply reports nothing.
    const stopWatch = options.onTransfer === undefined
      ? () => {}
      : watchTransfer(this.connection, {
        // The **absolute** path, resolved against the node's own `$HOME` from the probe.
        // The install script's `$(dirname "$runtime")` is expanded by the shell after
        // `$HOME` substitution, so it is absolute there; a `~` kept in a single-quoted
        // `stat` path matches nothing and the bar would read `0 B` forever.
        archive: archiveFor(this.layout, this.version, facts.home),
        total: await totalBytes(this.connection, urls),
        onUpdate: progress => options.onTransfer?.(progress),
      })
    let attempt
    try {
      attempt = await this.connection.exec({
        argv: ['sh', '-c', script],
        // Must outlast the download ceiling, or a slow-but-healthy link gets killed by the SSH
        // layer while curl is still making progress — and `channel.close()` does not reap the
        // remote `curl`, measured in the `budget-recovery` probe. The ceiling is 1800 s, so
        // this leaves a minute for unpack, the `--version` check and the stamp write.
        timeoutMs: (FETCH_CEILING_SECONDS + 60) * 1000,
        maxBytes: 1024 * 1024,
      }).finally(() => {
        stopWatch()
        // Cleared, not left at 100%: the phase has moved on, and a stale bar under "starting
        // the resident host" would say the install is still running.
        options.onTransfer?.(undefined)
      })
    } catch (error) {
      // **No exit code exists here**, so the branch below cannot run at all: a timeout or a
      // dropped channel rejects instead of resolving. That used to be the one failure path with
      // no rollback judgement and no context — the rejection simply flew out of `install()`.
      // The remote `sh` may already have renamed the staging tree into place before the channel
      // died, so the same judgement is asked for; with a healthy live tree it answers
      // `kept-current` and changes nothing.
      const reason = error instanceof Error ? error.message : String(error)
      // The original category is kept rather than flattened to `network`: a timeout is worth
      // retrying and a protocol refusal is not, and `toSshError` already reads a mark the caller
      // set. Only an unclassifiable transport error falls back to `network`, which is what it is.
      const marked = classifySshError(error)
      const rollback = await this.#rollbackAfterFailure(`the transfer of the runtime failed (${reason})`)
      throw toSshError(new Error(
        `installing the resident host failed: the transfer failed (${reason})\n${rollback}`,
        marked === SSH_FAILURE.UNKNOWN ? SSH_FAILURE.NETWORK : marked,
      ))
    }
    // One parser for every exit path: the script prints one JSON object as the last line of
    // stdout, so "did it install" is `parsed.ok`, not `code === 0`. The exit code is kept
    // only for diagnostics — it used to carry the semantics (3 = unavailable, 4 = mismatch,
    // …) and that is exactly what broke: a `set -e` abort, a killed `curl` or a full disk
    // exited with a number no branch knew, and the sentinel matching below then decided
    // "this is a download problem" or "this is an unpack problem" by searching stderr.
    const parsed = parseScriptResult(attempt)
    if (parsed.ok && parsed.code === SCRIPT_CODES.INSTALLED) {
      return { version: parsed.version ?? this.version, via: 'artefact' }
    }
    const detail = parsed.detail !== undefined && parsed.detail !== ''
      ? `${parsed.code}${parsed.stage === undefined ? '' : ` at ${parsed.stage}`}: ${parsed.detail}`
      : `${parsed.code}${parsed.stage === undefined ? '' : ` at ${parsed.stage}`}`
    if (parsed.code !== SCRIPT_CODES.ARTEFACT_UNAVAILABLE) {
      // The download worked but the unpack or verify did not — or the script did not report
      // at all (`UNKNOWN`, with the raw tail attached). Every failure the installer can name
      // happens **before** the commit line, so the live generation is intact and the rollback
      // judgement keeps it; only a live tree that cannot start is replaced. The verdict is
      // always acted on and always reported: a rollback that silently failed is the worst
      // outcome of the three, and it must not read like an ordinary install error.
      const rollback = await this.#rollbackAfterFailure(`installing the resident host failed: ${detail.slice(-600)}`)
      throw toSshError(new Error(
        `installing the resident host failed: ${detail.slice(-600)}${parsed.tail === undefined ? '' : `\nscript output tail: ${parsed.tail}`}\n${rollback}`,
      ))
    }
    failures.push(
      `artefact: no source served dsh-${this.version}-${platform} (tried ${String(urls.length)}):\n`
      + urls.map(url => `    ${url}`).join('\n'),
    )
    this.log(`no source served the ${platform} artefact`)
    return undefined
  }

  /**
   * Ask the node what a failed install left behind, and turn the answer into one log line and
   * one report line.
   *
   * The rollback itself must never throw: it runs while the caller is already handling an
   * install failure, and an exception from here would replace a diagnosable failure with an
   * anonymous one. It also must never be silent — the old code was `.catch(() => undefined)`,
   * so a rollback that itself failed left no trace anywhere. That is the worst of the three
   * outcomes: the node may now be on a tree that does not start, and nobody is told. So every
   * path here produces a sentence, and the caller appends it to the error it throws.
   *
   * @param {string} context - what had already failed, for the log.
   * @returns {Promise<string>} one line describing what the rollback did.
   */
  async #rollbackAfterFailure(context) {
    let parsed
    try {
      const result = await this.connection.exec({
        argv: ['sh', '-c', rollbackScript(this.layout.runtime, this.layout.cli)],
        timeoutMs: 120_000,
      })
      parsed = parseScriptResult(result)
      if (!parsed.parsed) {
        // The script ran but its last line was not JSON: a shell that died mid-`trap`, an
        // exec that truncated stdout. `tail` is the last 600 bytes of raw output, which is
        // the only evidence left — better in the error than swallowed.
        this.log(`${context}; the rollback printed no result line (${parsed.tail ?? 'no output'})`)
        return 'rollback did not report a verdict — the node may be on a broken tree; connect again and read the resident host log'
      }
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      this.log(`${context}; the rollback itself failed: ${why}`)
      return `rollback could not run (${why}) — the node may be on a broken tree; connect again and read the resident host log`
    }
    if (parsed.code === ROLLBACK_VERDICTS.KEPT_CURRENT) {
      // The good news case, and it is worth a log line: it says the failure cost nothing.
      this.log(`${context}; rollback=kept-current — the live runtime still starts and was left as it was`)
      return 'rollback: kept the runtime that was already installed (it still starts), so nothing was changed'
    }
    if (parsed.code === ROLLBACK_VERDICTS.ROLLED_BACK) {
      this.log(`${context}; rollback=rolled-back — the live runtime did not start, so the previous generation was restored`)
      return 'rollback: the live runtime could not start, so the previous generation was restored'
    }
    if (parsed.code === ROLLBACK_VERDICTS.NOTHING_TO_ROLL_BACK) {
      this.log(`${context}; rollback=nothing-to-roll-back — no previous runtime to fall back to`)
      return 'rollback: there was no previous runtime to restore, and the live one did not start'
    }
    this.log(`${context}; the rollback answered an unknown code ${JSON.stringify(parsed.code)}`)
    return `rollback reported ${JSON.stringify(parsed.code)}, which this build does not understand — inspect the node`
  }

  /** Read the installed resident version, or `undefined` when absent. */
  async installedVersion() {
    const result = await this.connection.exec({
      argv: ['sh', '-c', `node ${this.layout.cli} --version 2>/dev/null || echo`],
      timeoutMs: 30_000,
    })
    const text = result.stdout.trim().split('\n').at(-1) ?? ''
    return /^\d+\.\d+\.\d+/u.test(text) ? text : undefined
  }

  /**
   * What this node's installed tree is, and whether it can be trusted as-is.
   *
   * Both halves come from one round trip because they are always read together: the
   * version says which release the tree is, and the build stamp says which packing rules
   * produced it. A node on the right version but a different pack is a node this build
   * cannot run, and only the stamp can tell.
   *
   * The stamp also records **how the tree arrived** (`via`). That half is reported, never
   * judged: what makes a tree usable is its version and its build, not its route. `npm` no
   * longer occurs in stamps this build writes — the route was removed in build 4 — but a
   * node that carries one from before is read, not rejected.
   * @returns {Promise<{ version: string | undefined, build: string | undefined, via: 'artefact' | 'npm' | undefined, usable: boolean, reason: string }>}
   */
  async inspectRuntime() {
    const result = await this.connection.exec({
      argv: ['sh', '-c', `node ${this.layout.cli} --version 2>/dev/null || echo; `
        + `cat ${this.layout.runtime}/${BUILD_STAMP} 2>/dev/null || echo`],
      timeoutMs: 30_000,
    })
    const [versionLine = '', buildLine = ''] = result.stdout.trim().split('\n')
    const version = /^\d+\.\d+\.\d+/u.test(versionLine.trim()) ? versionLine.trim() : undefined
    const build = buildLine.trim() === '' ? undefined : buildLine.trim()
    return { version, build, ...inspectRuntime({ version, build, wantedVersion: this.version }) }
  }

  /**
   * Write the profile patch — the model roster and permission preset — and report
   * whether the bytes changed.
   *
   * This file is `~/.dsh/profiles/rnh/cordis.patch.yml`, one of the two paths the
   * resident host hot-reloads (`dsh-hmr` watches the profile patch and the home
   * patch; a `--patch` overlay is **not** watched — see `docs/adr-0001`). Writing it
   * therefore reconfigures a running node without restarting it.
   *
   * The payload travels base64-encoded: the patch is YAML assembled from model
   * configuration, and a heredoc would break on any line that happened to match the
   * delimiter.
   * @param {string} text
   * @returns {Promise<{ changed: boolean }>}
   */
  async writePatch(text) {
    const encoded = Buffer.from(text, 'utf8').toString('base64')
    const script = `
set -eu
mkdir -p ${this.layout.profile}
target=${this.layout.profilePatch}
tmp="$target.new"
printf '%s' '${encoded}' | base64 -d > "$tmp"
if [ -f "$target" ] && cmp -s "$tmp" "$target"; then
  rm -f "$tmp"
  echo unchanged
else
  mv "$tmp" "$target"
  echo written
fi
# An overlay from an earlier build is dead weight: the profile patch replaces it and
# the launch line no longer passes --patch.
rm -f ${this.layout.legacyPatch}
`.trim()
    const result = await this.connection.exec({ argv: ['sh', '-c', script], timeoutMs: 60_000 })
    if (result.code !== 0) {
      throw toSshError(new Error(`writing the node config failed: ${(result.stderr || result.stdout).trim().slice(-400)}`))
    }
    return { changed: result.stdout.includes('written') }
  }

  /**
   * Install the brain bundle under the node's DSH runtime, and point the profile
   * at it.
   *
   * This is the source-level customisation of the node: the profile composes
   * `dsh-base` + `@local/rnh-brain` instead of `dsh-base` + `dsh-web-app`, so
   * the node never loads the browser surface at all — it is not loaded and then
   * disabled, it is absent from the composition.
   *
   * The package lands in the **profile's** `node_modules`, which is where the
   * Loader resolves a bundle's row names from (a profile's interception layer is
   * its own `node_modules`). It is written by `exec`, not SFTP: one `sh` round trip
   * for the whole tree beats a dozen SFTP round trips on a slow link, and the runtime
   * is already a directory this plugin owns.
   *
   * **The tree travels on stdin, never on the command line.** ssh2 writes an `exec`
   * request as one SSH packet whatever its length, and OpenSSH's `PACKET_MAX_SIZE` is
   * 256 KiB — so a command line carrying a tree is not a large exec, it is a packet the
   * server rejects *after* reading it, leaving its stream misaligned. Measured on a real
   * node: a 262,200-byte command line produced six corrupted connections; the same bytes
   * on stdin produced none, at any size. See `MAX_COMMAND_BYTES` in `ssh/connection.js`.
   *
   * @param {Record<string, string>} files - package-relative path → contents.
   * @param {string} packageName - the bundle's package name.
   * @returns {Promise<{ changed: boolean, files: number }>}
   */
  async writeBrainBundle(files, packageName) {
    const target = `${this.layout.profileModules}/${packageName}`
    // A digest over path+content decides `changed` without shipping the tree twice.
    const digest = createHash('sha256')
    for (const path of Object.keys(files).sort()) {
      digest.update(path).update('\0').update(files[path]).update('\0')
    }
    const wanted = digest.digest('hex')
    const stamp = `${target}/.rnh-digest`

    const payload = Object.entries(files).map(([path, text]) => ({
      path,
      // `base64 -d` per file keeps a heredoc out of the picture entirely.
      data: Buffer.from(text, 'utf8').toString('base64'),
    }))
    const script = `
set -eu
target=${target}
stamp=${stamp}
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "${wanted}" ]; then
  echo unchanged
  exit 0
fi
rm -rf "$target"
mkdir -p "$target"
cd "$target"
while IFS='\t' read -r rel data; do
  mkdir -p "$(dirname "$rel")"
  printf '%s' "$data" | base64 -d > "$rel"
done
printf '%s' "${wanted}" > "$stamp"
echo written
`.trim()
    const result = await this.connection.exec({
      argv: ['sh', '-c', script],
      // One `path<TAB>base64` line per file, and `read` needs a final newline to return
      // the last one.
      stdin: `${payload.map(file => `${file.path}\t${file.data}`).join('\n')}\n`,
      timeoutMs: 120_000,
      // The script echoes nothing but its verdict, so a small cap is enough.
      maxBytes: 64 * 1024,
    })
    if (result.code !== 0) {
      throw toSshError(new Error(
        `installing the brain bundle failed: ${(result.stderr || result.stdout).trim().slice(-600)}`,
      ))
    }
    return { changed: result.stdout.includes('written'), files: Object.keys(files).length }
  }

  /**
   * Write one bundle's files into the node's profile, byte for byte.
   *
   * This is how a **locally built** plugin travels. A plugin installed from npm is
   * installed by npm; one the user wrote lives as a directory on this machine
   * (`dependencies: { "@local/x": "link:…" }`) and has no registry entry at all — so
   * `npm install @local/x` fails with a 404, which is exactly what a node reported before
   * this existed. Copying the tree is the only way such a bundle reaches a node.
   *
   * Base64 per file rather than a heredoc: the payload can contain anything, and a plugin
   * source file is not the place to discover that a `$` in a string was eaten by a shell.
   *
   * The payload travels on **stdin**, and that is not a style choice. ssh2 writes an `exec`
   * request as one SSH packet however long the command is, and OpenSSH's `PACKET_MAX_SIZE` is
   * 256 KiB; a plugin tree on the command line therefore crosses the ceiling and the server
   * drops the connection with `Bad packet length …` / `Connection corrupted`. Measured on the
   * reference node with a single connection: a 262,200-byte command line → six corrupted
   * connections, while the same 7.9 MB on stdin → none. The 7,923,616 in that log was this
   * function's command line for `dsh-whale-widget`, to within its script tail.
   *
   * @param {Record<string, string>} files - relative path → base64 of the raw bytes.
   * @param {string} packageName
   * @returns {Promise<{ changed: boolean, files: number }>}
   */
  async writePluginBundle(files, packageName) {
    const target = `${this.layout.profileModules}/${packageName}`
    const digest = createHash('sha256')
    for (const path of Object.keys(files).sort()) digest.update(path).update('\0').update(files[path]).update('\0')
    const wanted = digest.digest('hex')
    const stamp = `${target}/.rnh-digest`
    const payload = Object.entries(files).map(([path, data]) => `${path}\t${data}`).join('\n')
    const script = `
set -eu
target=${target}
stamp=${stamp}
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "${wanted}" ]; then
  echo unchanged
  exit 0
fi
rm -rf "$target"
mkdir -p "$target"
cd "$target"
while IFS='\t' read -r rel data; do
  mkdir -p "$(dirname "$rel")"
  printf '%s' "$data" | base64 -d > "$rel"
done
printf '%s' "${wanted}" > "$stamp"
echo written
`.trim()
    const result = await this.connection.exec({
      argv: ['sh', '-c', script],
      // One `path<TAB>base64` line per file, and `read` needs a final newline to return
      // the last one.
      stdin: `${payload}\n`,
      timeoutMs: 180_000,
      maxBytes: 256 * 1024,
    })
    if (result.code !== 0) {
      throw toSshError(new Error(
        `writing ${packageName} onto the node failed: ${(result.stderr || result.stdout).trim().slice(-400)}`,
      ))
    }
    return { changed: result.stdout.includes('written'), files: Object.keys(files).length }
  }

  /**
   * Install the third-party bundles a node has been told to load.
   *
   * The switch means "this plugin also runs there", and a name in `dsh.profile.bundles`
   * only composes if the package is actually resolvable from the profile — so the switch is
   * carried out by installing the package into the node's profile, exactly the way the
   * desktop installed it (`spec` is the desktop's own dependency spec, e.g. `^0.3.8` or a
   * version pin). Skipping this step is what would make a switch look applied while the
   * node silently composes nothing: DSH warns and drops a bundle it cannot resolve.
   *
   * The node has its own npm and registry configuration (AGENTS.md §13), so this uses
   * whatever the node is set up with rather than overriding it from here.
   *
   * @param {readonly string[]} bundles - third-party bundle names to install.
   * @param {(name: string) => string | undefined} specOf - the spec to install each at.
   * @returns {Promise<{ installed: string[], failed: Array<{ bundle: string, reason: string }> }>}
   */
  async installPlugins(bundles, specOf) {
    if (bundles.length === 0) return { installed: [], failed: [] }
    const lines = bundles.map(bundle => {
      const spec = specOf(bundle)
      // A name alone resolves to `latest`, which is what an unpinned dependency means.
      return { bundle, target: spec === undefined || spec.length === 0 ? bundle : `${bundle}@${spec}` }
    })
    // One `npm install` for the whole list: it resolves the tree once, and a single
    // network round of failures is easier to report than several partial ones.
    const script = pluginInstallScript({
      profile: this.layout.profile,
      profileName: this.layout.profileName,
      targets: lines.map(line => line.target),
    })
    const result = await this.connection.exec({
      argv: ['sh', '-c', script],
      // A big plugin pulls its own dependency tree; the artefact install gets 15 minutes
      // for a comparable amount of work, so this gets the same budget.
      timeoutMs: 10 * 60_000,
      maxBytes: 256 * 1024,
    })
    const output = `${result.stdout}\n${result.stderr}`.trim()
    // `npm install` is all-or-nothing for the list, so a failure does not name one package
    // that can be safely dropped: reporting per package would be a guess dressed up as a
    // diagnosis. The honest answer is "none of these are confirmed installed, here is what
    // npm said", and the caller retries or surfaces it.
    const ok = result.code === 0 && /RNH_NPM_EXIT=0/u.test(output)
    if (ok) return { installed: lines.map(line => line.bundle), failed: [] }
    const reason = output.split('\n').slice(-4).join(' | ') || `npm exited ${String(result.code)}`
    return {
      installed: [],
      failed: lines.map(line => ({ bundle: line.bundle, reason })),
    }
  }

  /**
   * Remove a bundle from the node's package list.
   *
   * Only the resolution is dropped; the directory stays until npm prunes it, because a
   * half-deleted package is worse than an unused one and the bundle list is what decides
   * composition anyway.
   * @param {readonly string[]} bundles
   */
  async uninstallPlugins(bundles) {
    if (bundles.length === 0) return
    await this.connection.exec({
      argv: ['sh', '-c', `cd ${this.layout.profile} && npm uninstall --no-audit --no-fund --loglevel=error ${bundles.map(name => `"${name}"`).join(' ')} 2>&1 || true`],
      timeoutMs: 5 * 60_000,
      maxBytes: 128 * 1024,
    })
  }

  /**
   * Point the plugin's own profile at `bundles`, writing its manifest only when it
   * differs, and make sure a patch file exists for the host to hot-reload.
   *
   * The profile manifest is the *only* place the bundle list lives, so this is what
   * makes a node a brain rather than a web app. Two profiles matter here:
   *
   * - `~/.dsh/profiles/rnh` — this plugin's own profile, written here.
   * - `~/.dsh/profiles/web` — the profile earlier builds mutated. Its bundle list is
   *   put back to the upstream default so a node is not left composing a brain it
   *   is no longer started with. The directory itself is left alone: it may hold the
   *   user's own sessions and settings, so deleting it is not ours to do.
   *
   * @param {readonly string[]} bundles
   * @returns {Promise<{ changed: boolean, revertedPrevious: boolean }>}
   */
  async writeProfileBundles(bundles) {
    const manifestPath = `${this.layout.profile}/package.json`
    const read = await this.connection.exec({
      argv: ['sh', '-c', `cat ${manifestPath} 2>/dev/null || echo '{}'`],
      timeoutMs: 15_000,
    })
    /** @type {Record<string, unknown>} */
    let manifest = {}
    try {
      manifest = JSON.parse(read.stdout)
    } catch {
      // A corrupt manifest is replaced rather than preserved: it cannot compose
      // anything, and keeping its bytes would only hide that.
    }
    const current = manifest?.dsh?.profile?.bundles
    const same = Array.isArray(current) && current.length === bundles.length
      && current.every((name, index) => name === bundles[index])

    let changed = false
    if (!same) {
      const next = {
        ...manifest,
        name: manifest.name ?? `dsh-profile-${this.layout.profileName}`,
        private: true,
        dependencies: manifest.dependencies ?? {},
        dsh: {
          ...(manifest.dsh ?? {}),
          profile: { ...(manifest.dsh?.profile ?? {}), bundles: [...bundles] },
        },
      }
      const encoded = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8').toString('base64')
      const write = await this.connection.exec({
        argv: ['sh', '-c', `mkdir -p ${this.layout.profile} && printf '%s' '${encoded}' | base64 -d > ${manifestPath}`],
        timeoutMs: 30_000,
      })
      if (write.code !== 0) {
        throw toSshError(new Error(`writing the profile manifest failed: ${(write.stderr || write.stdout).trim().slice(-400)}`))
      }
      changed = true
    }

    // Ensure the patch exists before the first launch: the host reads it as a layer,
    // and an absent file would simply mean "no configuration yet".
    const ensure = await this.connection.exec({
      argv: ['sh', '-c', `mkdir -p ${this.layout.profile} && [ -f ${this.layout.profilePatch} ] || printf '# owned by @greatbaby/dsh-remote-node-harness\\n[]\\n' > ${this.layout.profilePatch}`],
      timeoutMs: 15_000,
    })
    if (ensure.code !== 0) {
      throw toSshError(new Error(`preparing the node profile failed: ${(ensure.stderr || ensure.stdout).trim().slice(-400)}`))
    }

    const revertedPrevious = await this.#revertPreviousProfile(bundles)
    return { changed, revertedPrevious }
  }

  /**
   * Undo what earlier builds did to the upstream `web` profile.
   *
   * Earlier builds replaced that profile's bundle list with the brain composition and
   * launched with `--patch`. Two reasons to undo it: the node should not compose a
   * brain bundle on the moments something else starts `web`, and a `web` profile left
   * composing an empty list is worse than one the user never touched.
   *
   * Only the bundle list this plugin wrote is restored — the profile's own patch,
   * sessions and settings are the user's and are never touched.
   * @param {readonly string[]} ours - the bundle list this plugin composes.
   * @returns {Promise<boolean>} whether anything was reverted.
   */
  async #revertPreviousProfile(ours) {
    const manifestPath = `${this.layout.legacyProfile}/package.json`
    const read = await this.connection.exec({
      argv: ['sh', '-c', `cat ${manifestPath} 2>/dev/null || echo ''`],
      timeoutMs: 15_000,
    })
    if (read.stdout.trim() === '') return false
    /** @type {any} */
    let manifest
    try {
      manifest = JSON.parse(read.stdout)
    } catch {
      return false
    }
    const current = manifest?.dsh?.profile?.bundles
    // Only a list this plugin provably wrote is touched. An empty list is left alone:
    // it is broken enough that somebody will notice, and guessing that "empty means we
    // did it" would let this repair overwrite a deliberate choice.
    if (!Array.isArray(current) || !current.includes(ours.at(-1))) return false
    // Restore the shipped template rather than subtracting our names: an earlier
    // build replaced the whole list, so subtracting would leave `web` composing
    // nothing at all — a machine whose own web profile silently stopped working.
    const next = {
      ...manifest,
      dsh: { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles: [...WEB_PROFILE_BUNDLES] } },
    }
    const encoded = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8').toString('base64')
    const write = await this.connection.exec({
      argv: ['sh', '-c', `printf '%s' '${encoded}' | base64 -d > ${manifestPath}`],
      timeoutMs: 30_000,
    })
    if (write.code !== 0) {
      throw toSshError(new Error(`reverting the previous profile failed: ${(write.stderr || write.stdout).trim().slice(-400)}`))
    }
    this.log('reverted the bundle list an earlier build wrote into profiles/web')
    return true
  }

  /**
   * Start the resident host unless one is already serving this version, then
   * read the port and launch token it printed.
   *
   * The launch line carries **no `--patch`**: configuration reaches the node through
   * its profile patch, which the running host hot-reloads. That is what lets a local
   * model or key change reach an already connected node without a restart — see
   * `docs/adr-0001`.
   * @param {object} [options]
   * @param {boolean} [options.force] - restart even when a host is alive.
   * @param {boolean} [options.bundleChanged] - restart because the brain bundle changed
   *   (module code has to be re-imported; only a restart does that).
   */
  async ensureServing(options = {}) {
    const existing = await this.status()
    // `existing.profile === this.layout.profileName`, never the `NODE_PROFILE` constant:
    // the profile name is *derived from the node's root*, so `~/.dsh-fleet` launches
    // `--profile rnh-dsh-fleet`. Comparing against the constant made every non-default
    // root fail this check forever and stop/start a perfectly healthy host on **every**
    // connect (measured on a real node: `status.json` said `"profile":"rnh"` while the
    // host ran `--profile rnh-dsh-fleet`).
    const launchedByThisShape = existing !== undefined
      && existing.profile === this.layout.profileName
      && existing.overlay !== true
      && existing.version === this.version
    if (existing !== undefined && !options.force && !options.bundleChanged
      && launchedByThisShape
      && await this.isAlive(existing.pid, existing)) {
      this.serving = existing
      return existing
    }
    if (existing !== undefined) await this.stop()
    const script = `
set -eu
mkdir -p ${this.layout.run}
rm -f ${this.layout.log}
: > ${this.layout.log}
(cd ${this.layout.runtime} && setsid nohup node ${this.layout.cli} --profile ${this.layout.profileName} --host 127.0.0.1 --port 0 --no-open >> ${this.layout.log} 2>&1 & echo $! > ${this.layout.run}/pid)
i=0
while [ "$i" -lt 120 ]; do
  if grep -q 'dsh web: http' ${this.layout.log} 2>/dev/null; then break; fi
  sleep 0.5
  i=$((i + 1))
done
cat ${this.layout.log}
`.trim()
    const result = await this.connection.exec({ argv: ['sh', '-c', script], timeoutMs: 5 * 60_000, maxBytes: 256 * 1024 })
    const parsed = parseWebUrl(result.stdout)
    if (parsed === undefined) {
      const tail = (result.stdout || result.stderr).trim().split('\n').slice(-12).join('\n')
      throw toSshError(new Error(`the resident host did not report a URL. Its log tail:\n${tail}`))
    }
    const pidResult = await this.connection.exec({
      argv: ['sh', '-c', `cat ${this.layout.run}/pid 2>/dev/null || echo 0`],
      timeoutMs: 15_000,
    })
    let pid = Number.parseInt(pidResult.stdout.trim(), 10) || 0
    // What the recorded pid *is*, not only that it exists. Two facts are written down:
    // the command line (checked against the profile) and the process start time (which is
    // what makes the pid-plus-starttime pair identify this launch rather than merely this
    // number). `$!` can be a `setsid` wrapper on a platform where setsid forks, so when the
    // recorded pid does not carry our profile the real child is looked up by its command
    // line—better one extra round trip than a status file that makes every later connect
    // restart the host.
    let probe = pid === 0 ? undefined : await this.#processProbe(pid)
    if (probe === undefined || !this.#hasProfile(probe.cmdline, this.layout.profileName)) {
      const found = await this.#findHostPid()
      if (found !== 0) {
        pid = found
        probe = await this.#processProbe(pid)
      }
    }
    // The record says which launch shape produced this host, so a host started by an
    // older build (a `web` profile or a `--patch` overlay) is replaced once instead of
    // being trusted to hot-reload a file it never read.
    const serving = {
      port: parsed.port,
      token: parsed.token,
      pid,
      version: this.version,
      profile: this.layout.profileName,
      overlay: false,
      // Absent on a platform without procfs; `isAlive` then falls back to the command line
      // and says so in its own comment.
      starttime: probe?.starttime,
    }
    await this.connection.exec({
      argv: ['sh', '-c', `printf '%s' '${JSON.stringify(serving).replaceAll("'", `'\\''`)}' > ${this.layout.status}`],
      timeoutMs: 15_000,
    })
    this.log(`resident host ready on ${String(parsed.port)} (pid ${String(pid)})`)
    this.serving = serving
    return serving
  }

  /**
   * The pid of the resident host, found by its command line.
   *
   * Only used when `$!` did not point at the host itself. `ps -eo pid=,args=` is POSIX enough
   * to exist on both Linux and Darwin, unlike procfs.
   *
   * The **judgement stays in JS** (`#hasProfile`, applied by the caller): a shell `case`
   * pattern for "the profile name, exactly" is where this went wrong once — `--profile rnh`
   * matched `--profile rnh-dsh-fleet`, which is a different node on the same machine, and the
   * pattern also has to know that the CLI path comes *before* the profile in the launch line.
   * The script therefore only lists candidates that mention both facts; the caller decides.
   *
   * `0` means "not found"; the caller keeps the pid it had rather than inventing one.
   * @returns {Promise<number>}
   */
  async #findHostPid() {
    // Two cheap prefilters in the shell — it names our CLI and it was started with some
    // `--profile` — and the exact judgement in JS. The shell is not trusted with the
    // comparison: a `case` glob for "this profile name, exactly" is what silently accepted
    // `--profile rnh-dsh-fleet` for `--profile rnh` here once, and that is a different node.
    const script = `
set -u
ps -eo pid=,args= 2>/dev/null | while read -r pid args; do
  case "$args" in
    *"@deepseek-ai/dsh/lib/bin.js"*) ;;
    *) continue ;;
  esac
  case "$args" in
    *"--profile "*) ;;
    *) continue ;;
  esac
  printf '%s\\n' "$pid"
done
`.trim()
    try {
      const result = await this.connection.exec({ argv: ['sh', '-c', script], timeoutMs: 15_000, maxBytes: 4096 })
      const candidates = result.stdout.split('\n').map(line => line.trim()).filter(line => /^\d+$/u.test(line))
      for (const candidate of candidates) {
        const pid = Number.parseInt(candidate, 10)
        const probe = await this.#processProbe(pid)
        if (this.#hasProfile(probe.cmdline, this.layout.profileName)) return pid
      }
      return 0
    } catch {
      return 0
    }
  }

  /** Stop the resident host if this plugin started one. */
  async stop() {
    const existing = await this.status()
    // The fallback pattern is derived from **this node's root**, not hard-coded: with
    // `~/.dsh-fleet` written down, a non-default node's host could never be killed and
    // its `status.json` was deleted anyway, which is worse than not trying.
    //
    // It is bracketed on purpose: `pkill -f` matches **any** command line containing the
    // pattern, and the `sh -c` that runs this very command carries it in its own argv.
    // Measured on the reference node — plain pattern → the shell killed itself and the
    // channel died with no exit status (`{"out":"","code":null}`), bracketed pattern → it
    // survived and reported (`{"out":"SURVIVED","code":0}`). A `[.]` is one character in
    // the regex, so it still matches `bin.js` in the resident host's own argv.
    //
    // `$HOME` is expanded by the shell here rather than by JS: the layout is written with
    // `~` (it is what a person types), and a `~` inside the pkill pattern would be a
    // literal tilde in a regex. Double quotes let `$HOME` expand while `[` and `]` stay
    // part of the pattern.
    const fallbackPattern = shellPath(this.layout.root)
    const script = existing === undefined
      ? `
set -u
pattern="${fallbackPattern}/runtime/node_modules/@deepseek-ai/dsh/lib/bin[.]js"
pkill -f "$pattern" 2>/dev/null || true
rm -f ${this.layout.status}
`.trim()
      : `
kill ${String(existing.pid)} 2>/dev/null || true
i=0
while [ "$i" -lt 20 ]; do
  kill -0 ${String(existing.pid)} 2>/dev/null || break
  sleep 0.25
  i=$((i + 1))
done
kill -9 ${String(existing.pid)} 2>/dev/null || true
rm -f ${this.layout.status}
`.trim()
    await this.connection.exec({ argv: ['sh', '-c', script], timeoutMs: 60_000 })
    this.serving = undefined
  }

  /** Everything the settings page shows for one node. */
  async inspect() {
    const facts = await this.probe()
    const installed = facts.nodeUsable ? await this.installedVersion() : undefined
    const status = await this.status()
    const alive = status === undefined ? false : await this.isAlive(status.pid, status)
    return {
      facts,
      installedVersion: installed,
      needsInstall: installed !== this.version,
      serving: status !== undefined && alive ? status : undefined,
      versionMatches: installed === this.version,
    }
  }
}

/** Read `dsh web: http://127.0.0.1:<port>/?token=<token>` out of one log. */
export function parseWebUrl(text) {
  const match = /dsh web:\s+(https?:\/\/[^\s]+)/u.exec(text)
  if (match === null) return undefined
  try {
    const url = new URL(match[1])
    const token = url.searchParams.get('token') ?? ''
    const port = Number.parseInt(url.port, 10)
    if (!Number.isFinite(port) || token === '') return undefined
    return { port, token, origin: `${url.protocol}//${url.host}` }
  } catch {
    return undefined
  }
}

/** Categories that mean "this machine cannot host a resident DSH yet". */
export const PROVISION_FAILURES = Object.freeze({
  NO_NODE: 'no-node',
  OLD_NODE: 'old-node',
  NO_NPM: 'no-npm',
  INSTALL_FAILED: 'install-failed',
  START_FAILED: 'start-failed',
  AUTH: SSH_FAILURE.AUTH,
})
