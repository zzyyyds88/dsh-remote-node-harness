/**
 * The node's DSH runtime, fetched as a published artefact.
 *
 * Provisioning used to run `npm install @deepseek-ai/dsh@<version>` on every node.
 * That is a 1.3 GB install tree, several minutes, and it needs the node to reach a
 * registry — three things that make "connect to a machine" feel like "deploy a
 * service". The artefact route is the same idea ZCode uses: the desktop publishes the
 * runtime it was tested against and a node downloads exactly that tarball.
 *
 * **The tree in that tarball is this project's own build**, not the upstream release: it
 * comes from a fork of the upstream source with the browser surface, the Office engine and
 * the experimental bundles removed (see `docs/adr-0007-fork-node-runtime.zh.md` and
 * `scripts/build-fork-runtime.mjs`). A node runs what this project built and tested, which
 * is the whole reason the fork exists.
 *
 * **The artefact has to be per-platform, and that is not a detail.**
 *
 * A DSH installation is not pure JavaScript: `node-pty`, `sharp` and
 * `sherpa-onnx` ship native binaries, and the installed tree names the platform it was
 * built for (`sherpa-onnx-win-x64`, `@img/sharp-linux-x64`, …). Packing this Windows
 * desktop's tree and unpacking it on a Linux node would produce a node whose terminal
 * and image tools fail at first use — worse than the slow install it replaced, because
 * it fails later and further from the cause. So:
 *
 * - the file name carries the platform (`dsh-<version>-linux-x64.tar.gz`);
 * - the plugin asks for the artefact matching **the node's** `uname`, not its own;
 * - a platform this build publishes no artefact for is reported, not resolved elsewhere.
 *
 * Two more decisions:
 *
 * - **The checksum is published beside it.** A truncated download over a flaky link
 *   would otherwise unpack into a half-installed runtime that fails at first use
 *   instead of at download time.
 * - **The install is a transaction.** The new tree is unpacked, repaired, stamped and
 *   probed inside its own generation directory (`runtime.<n+1>`), and the live runtime is
 *   a **symlink** (`runtime -> runtime.<n>`) that one `ln -sfn` flips. That is the only
 *   statement that changes what a node runs, so a script killed anywhere before it leaves
 *   the previous generation serving and the previous tree untouched — see
 *   {@link installScript}. It replaced two renames (`runtime` → `.previous`, staging →
 *   `runtime`), a three-statement window in which a killed script left the node with no
 *   runtime at all.
 *
 * **shell and JS speak one contract: the last line of stdout is one JSON object.**
 * A `trap` guarantees the line is printed on every exit path, the exit code is kept for
 * diagnostics but carries no meaning, and the old sentinel-substring vocabulary
 * (`ARTEFACT_UNAVAILABLE` matched with `String.includes`) is now only the `code` *field*
 * of that object — so `ARTEFACT_CHECKSUM_UNAVAILABLE` can never be mistaken for
 * `ARTEFACT_UNAVAILABLE` because of how somebody spelled a name
 * ({@link parseScriptResult}).
 *
 * @module @greatbaby/dsh-remote-node-harness/remote/artefact
 */

/**
 * The accelerator prefixes that used to sit behind CNB, kept only as a record.
 *
 * They were a list because a single accelerator dies: measured on the test node, `git.yylx.win`
 * refused :443 outright while `gh.inkchills.cn` carried the archive at 2.4 MB/s, and the set
 * spans 0.2–9.6 MB/s run to run. None of them is a download source any more — see
 * {@link DEFAULT_SOURCES} for why the list became one host.
 *
 * `github.akams.cn` is the catalog these came from, not a proxy itself: asking it for
 * `/https://github.com/…` answers 404.
 */
export const RETIRED_MIRRORS = Object.freeze([
  'https://git.yylx.win/',
  'https://gh.inkchills.cn/',
  'https://tvv.tw/',
  'https://ghfast.top/',
])

/** GitHub repository the releases are also uploaded to, as a backup. */
export const DEFAULT_REPOSITORY = 'zzyyyds88/dsh-remote-node-harness'

/** Where a published node runtime lives on GitHub (backup only; nodes read CNB). */
export const RELEASE_BASE = 'releases/download'

/**
 * The primary source: CNB, a domestic host that serves release assets straight.
 *
 * **CNB is the only source.** The node has exactly one place to download from, and that
 * is a decision, not an accident of the list's length: GitHub is not reachable from the
 * machines this project serves, and every accelerator in front of it varies by a factor
 * of 40 between runs (measured on the test node, full archive: 0.2–9.6 MB/s). A source
 * list whose other entries are known-bad is a list that turns one failure into a
 * sequence of slow failures.
 *
 * The archive is also uploaded to the GitHub release (`build-fork-runtime.mjs --publish`),
 * as a backup and for the record. Nodes do not read it from there.
 *
 * **Measured on the test node, full 172 683 323-byte archive, not a HEAD request:**
 *
 *   cnb.cool         4 233 285 B/s   (~33 s for the whole archive, run-to-run spread under 1%)
 *   gh.inkchills.cn  ~2.4 MB/s
 *   tvv.tw           ~2.3 MB/s
 *   ghfast.top       ~0.7 MB/s
 *   git.yylx.win     connection refused at the time
 *
 * Public repository on purpose: the node holds **no CNB credential at all**, and an anonymous
 * `GET` of a public asset answers 302 into `asset.cnb.cool` with Range/206 support.
 */
export const CNB_REPOSITORY = 'serendipity-archive/dsh-fleet'

/** The CNB release URL shape, with the placeholders {@link artefactUrls} fills in. */
export const CNB_TEMPLATE =
  `https://cnb.cool/${CNB_REPOSITORY}/-/releases/download/{tag}/{file}`

/**
 * The one source a node downloads from.
 *
 * A `template` source builds the URL from `{version}`/`{platform}`/`{file}`/`{tag}`; a
 * `prefix` source would prepend itself to the canonical
 * `github.com/<repository>/releases/download/…` URL, which is what an accelerator *is*. No
 * prefix source is left: every accelerator in front of GitHub measured between 0.2 and
 * 9.6 MB/s on the same archive, and the machines this project serves cannot reach GitHub at
 * all. A `sources` array is still accepted, so a private mirror is one config value away.
 */
export const DEFAULT_SOURCES = Object.freeze([
  Object.freeze({ kind: 'template', template: CNB_TEMPLATE }),
])

/**
 * The packaging rules that produced an artefact.
 *
 * A version comparison says nothing about the *contents* of a tree: this plugin packs a
 * runtime itself, so the same `0.2.2-rc.3` can be published twice with different files
 * in it. When the packing changes — a strip rule added or removed — a node that already
 * has that version would never be reinstalled, and it would keep a tree this build
 * cannot run.
 *
 * Measured, not hypothesised: a strip rule that removed `doc/` also removed
 * `yaml/dist/doc/directives.js`, and every node installed from that artefact failed at
 * startup with `MODULE_NOT_FOUND`. The version was identical, so the gate said "current"
 * and nothing repaired it.
 *
 * **Bump this whenever `STRIPPED` in `scripts/publish-runtime.mjs` changes, or when the
 * archive layout changes.** It is written into the installed tree and compared on
 * connect; a node whose stamp is missing or older is reinstalled even though its version
 * matches.
 *
 * Build 3 changed what a tree contains, not just how it is packed: the packer resolves
 * with `--ignore-scripts`, so a released archive no longer carries the **packing machine's**
 * native build output. Measured on the rc.5 archive built the old way: 48 `.exe`/`.cmd`/
 * `.dll`/`.lib` files and 147 `koffi/build/win32_x64/**` entries inside a `linux-x64`
 * artefact, because koffi's `install` script compiles for `process.platform` — the
 * packer's, not the node's. The stamp format changed in the same build (see
 * {@link stampJson}), and a tree stamped `2` is packed by the old rules either way.
 *
 * Build 4 is the fork: the tree is built from this project's own copy of the upstream
 * source (`scripts/build-fork-runtime.mjs`) with the browser surface, the Office engine and
 * the experimental bundles removed — 2014.6 MiB unpacked → 408.6 MiB, measured. A build-3
 * tree is the upstream release, which is a different runtime at the same version, so it is
 * reinstalled rather than kept.
 *
 * Build 5 strips what no runtime reads from *inside* the packages build 4 kept: TypeScript
 * sources (the tree loads `lib/*.js`), `.d.cts` declarations, debug symbols, and documentation
 * except the files an agent loads by path (`skills/`, `assets/`, `references/`, `templates/`,
 * `SKILL.md`). Measured on the published build-4 archive: 17 245 files / 139.8 MiB, 408.2 →
 * 268.4 MiB. Same version, same package set, a third fewer bytes — so it needs its own stamp.
 *
 * Build 6 changes **no byte of the archive** and still needs its own stamp, because the defect
 * it repairs is in `installScript` and the archive is what a node has already installed. A
 * Windows packer cannot record an executable bit at all — measured on the published rc.5
 * archive: 25 038 files, 0 with `+x`, `chmodSync` leaves `100666` — so `node_modules/@vscode/
 * ripgrep-linux-x64/bin/rg` arrives mode 0666 and every `glob`/`grep` call answers
 * "ripgrep provider failure". Build 5 repaired only `spawn-helper`, which the Linux tree does
 * not even contain. The stamp is the only lever that reaches a node already on the same
 * version: `inspectRuntime` reuses a tree whose stamp matches, so without the bump the repair
 * would never run anywhere it is needed. See {@link isArtefactExecutable}.
 *
 * Build 7 is the first build whose **source** differs from the upstream tag. Two upstream
 * defects reached real use on a node and are fixed by the node patch chain
 * (`patches/node/`, ledger `docs/node-patches.zh.md`): a Team write-scope warning that vanished
 * the moment a sibling task completed, and a fork child that inherited nothing when the
 * delegation happened before the parent's first `turn/end`. Unlike build 6, these change the
 * compiled `lib/` the node loads, so the archive's bytes change too — a stale tree would keep
 * answering the old way while its stamp claimed to be current.
 */
export const RUNTIME_BUILD = 7

/** The stamp file, relative to the runtime directory. */
export const BUILD_STAMP = '.rnh-artefact.json'

/**
 * Names of files a runtime spawns as a **program**, wherever they sit in the tree.
 *
 * `node-pty` spawns `prebuilds/<os>-<arch>/spawn-helper` by path, and a file that arrives
 * without `+x` fails at the first terminal, days after the install — measured on the Darwin
 * prebuilds, which is why this name was the first (and for a while the only) entry.
 */
export const ARTEFACT_EXECUTABLE_NAMES = Object.freeze(['spawn-helper'])

/**
 * Suffixes that are marked executable too, though nothing requires it.
 *
 * A `.node` addon is `dlopen`ed, not `exec`ed, so the bit is inert. It was in the packer's
 * old rule and stays: dropping it would be an unmeasured change committed alongside a
 * measured one, and no archive is one byte smaller for keeping it.
 */
export const ARTEFACT_EXECUTABLE_SUFFIXES = Object.freeze(['.node'])

/**
 * Whether this file must carry an executable bit once unpacked.
 *
 * The rule is by **shape**, not by a list of paths, because a list of paths is wrong at the
 * next dependency bump and nothing would say so. Two shapes, both measured on the published
 * rc.5 archive:
 *
 * - anything directly inside a **`bin/` directory of a package** — `@vscode/ripgrep-linux-x64/
 *   bin/rg` (the ripgrep every `glob`/`grep` call spawns), `@deepseek-ai/node-addon-system-
 *   linux-x64/bin/landlock-run` (the Linux sandbox launcher), plus the three npm CLI shims
 *   this runtime never calls;
 * - {@link ARTEFACT_EXECUTABLE_NAMES} by name, because `spawn-helper` is not under a `bin/`;
 * - {@link ARTEFACT_EXECUTABLE_SUFFIXES} by suffix, for native addons.
 *
 * `node_modules/.bin/*` is deliberately **not** matched: npm writes those as shims for a
 * shell, nothing in this runtime resolves them (checked: neither `dsh-util-ripgrep` nor
 * `node-addon-system` mentions `.bin`), and a `.js` shim that gains `+x` gains nothing.
 *
 * @param {string} path - a path in the tree, absolute or relative, either separator.
 * @returns {boolean}
 */
export function isArtefactExecutable(path) {
  const posix = String(path).replaceAll('\\', '/')
  const name = posix.slice(posix.lastIndexOf('/') + 1)
  if (ARTEFACT_EXECUTABLE_NAMES.includes(name)) return true
  if (ARTEFACT_EXECUTABLE_SUFFIXES.some(suffix => name.endsWith(suffix))) return true
  // A `bin/` **directory segment**, not the substring: `…/bin/rg` matches, `…/.bin/rg` does not.
  return posix.includes('/bin/')
}

/**
 * The stamp one install writes.
 *
 * Two facts, because one was not enough: **which build packed it** decides whether the tree
 * can be trusted (see {@link RUNTIME_BUILD}), and **how it got there** is what a person needs
 * when a node behaves differently from its neighbours.
 *
 * `via` is reported, never judged. It used to distinguish a downloaded artefact from a tree
 * the node resolved itself; the node no longer resolves its own (see
 * `docs/adr-0007-fork-node-runtime.zh.md`), so `artefact` is the only value this build
 * writes — the field stays because a stamp is read by nodes that predate the removal, and
 * because "where did this tree come from" is a question every future supply route asks.
 *
 * JSON rather than a bare integer so `via` could be added without a second file. Trees
 * stamped by build 2 hold `2` alone; {@link parseStamp} still reads those, because a node
 * already in service must not be judged unusable by a format change.
 *
 * @param {{ build?: number, via: 'artefact' | 'npm' }} input
 * @returns {string}
 */
export function stampJson({ build = RUNTIME_BUILD, via }) {
  return JSON.stringify({ build, via })
}

/**
 * Read a stamp written by {@link stampJson} or by an earlier build.
 *
 * @param {string | undefined} text
 * @returns {{ build: number | undefined, via: 'artefact' | 'npm' | undefined }}
 */
export function parseStamp(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return { build: undefined, via: undefined }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      const build = Number.parseInt(String(parsed?.build ?? ''), 10)
      const via = parsed?.via === 'npm' || parsed?.via === 'artefact' ? parsed.via : undefined
      return { build: Number.isFinite(build) ? build : undefined, via }
    } catch {
      // A half-written stamp is the same as no stamp: the tree gets reinstalled.
      return { build: undefined, via: undefined }
    }
  }
  // Build 2 and earlier: a bare integer, with no record of where the tree came from.
  const legacy = Number.parseInt(trimmed, 10)
  return { build: Number.isFinite(legacy) ? legacy : undefined, via: undefined }
}

/**
 * How long a download may sit below {@link FETCH_FLOOR_BYTES} per second before curl gives up.
 *
 * A runtime archive is ~170 MiB, so a *working* link needs minutes, not seconds: a plain
 * `--max-time` either kills healthy downloads on a slow line or lets a dead one run
 * forever. Measured, not hypothesised: on the test node the mirror pulled the whole
 * archive in 4 s while the direct GitHub fallback managed 925 KB in 30 s. The install
 * script lists both, so a mirror failure silently turns into a fallback that would run
 * for over an hour — which reads to the user as "connecting hangs" with nothing to see.
 * Giving up after a minute below the floor turns that into the named
 * `ARTEFACT_UNAVAILABLE` failure the caller already reports.
 */
export const FETCH_FLOOR_BYTES = 4096

/** Seconds below {@link FETCH_FLOOR_BYTES} before that download is abandoned. */
export const FETCH_FLOOR_SECONDS = 60

/**
 * Hard ceiling for one archive download, in seconds.
 *
 * 30 minutes is ~100 KB/s for a 170 MiB archive: slower than that is not a line anyone
 * can install a node over, and the budget still leaves room for a genuinely slow but
 * working link.
 */
export const FETCH_CEILING_SECONDS = 1800

/**
 * `uname -s` / `uname -m` names → the platform tag used in a Release asset name.
 *
 * Only the pairs this plugin can actually provision are listed. An unknown pair is not an
 * error: it means "no artefact for this machine", which is reported as such.
 */
const PLATFORM_ALIASES = Object.freeze({
  linux: 'linux',
  darwin: 'darwin',
  freebsd: 'freebsd',
  x86_64: 'x64',
  amd64: 'x64',
  x64: 'x64',
  aarch64: 'arm64',
  arm64: 'arm64',
  armv7l: 'arm',
  armv6l: 'arm',
  i686: 'ia32',
  i386: 'ia32',
})

/**
 * Normalize the probe's `uname` answers into a Release platform tag.
 *
 * `uname -s` is capitalised (`Linux`, `Darwin`) while npm and Node's own `process.platform`
 * are lowercase, and `uname -m` says `x86_64` where `process.arch` says `x64`. Both
 * translations happen here so the rest of the plugin only ever sees one spelling.
 *
 * **Linux splits by C library, so the tag does too.** `koffi` and `sharp` publish both a
 * glibc and a musl build of the same package, and the loader picks by the platform it runs
 * on: handing an Alpine node the glibc tree installs a library that cannot be loaded, and the
 * failure lands on the first tool that needs it rather than on the install. The packer already
 * accepts `linux-x64-musl`, so the tag a musl node asks for is the tag that exists.
 *
 * This used to be the npm route's job (`--libc=musl`), which is why it was not here: with a
 * registry resolve the node got correct natives for free. There is no registry resolve any
 * more, so the artefact name has to carry it.
 *
 * @param {{ os?: string, arch?: string, libc?: string }} facts - the probe result.
 * @returns {string | undefined} e.g. `linux-x64`, `linux-x64-musl`, or `undefined` when
 *   unrecognisable.
 */
export function platformTag(facts) {
  const os = PLATFORM_ALIASES[String(facts?.os ?? '').toLowerCase()]
  const arch = PLATFORM_ALIASES[String(facts?.arch ?? '').toLowerCase()]
  if (os === undefined || arch === undefined) return undefined
  // Only Linux has two C libraries in the ecosystem; `darwin-arm64-musl` would be nonsense.
  const musl = os === 'linux' && String(facts?.libc ?? '').toLowerCase().includes('musl')
  return `${os}-${arch}${musl ? '-musl' : ''}`
}

/**
 * The artefact name for one DSH release on one platform.
 * @param {string} version
 * @param {string} platform - a `platformTag()` result, e.g. `linux-x64`.
 */
export function artefactName(version, platform) {
  return `dsh-${version}-${platform}.tar.gz`
}

/**
 * The platforms an artefact is actually published for.
 *
 * Not the same set as `platformTag()` can produce, and the difference is the point: a tag is
 * "the node can name its platform", a published platform is "there is a byte sequence to
 * fetch and a machine to have verified it". `linux-arm64` and `darwin-arm64` tag correctly and
 * have no archive — a node there gets an honest `ARTEFACT_UNAVAILABLE`, which is right.
 *
 * **`win32-x64` is deliberately absent, and it is the one that used to be published.** The
 * archive exists and boots (measured: unpacked, `dsh web: <url>`, cookie, `POST
 * /api/session/list` 200), but no node can ever ask for it:
 *
 * - `platformTag()` has no Windows spelling, because the probe reads `uname -s`, which on
 *   Windows says `MINGW64_NT-…` or nothing at all;
 * - the node side is POSIX throughout — 21 `sh -c` invocations (probe, install, start, stop,
 *   profile writes, status reads), `setsid nohup` to detach the host, `/lib/ld-musl-*` for the
 *   libc probe;
 * - the only transport is SSH (`registry.js` types `transport` as `'ssh'`).
 *
 * So a Windows tree was 85 MiB of release asset that nothing could fetch, and a release body
 * line implying Windows nodes work. Building one locally is still allowed — `--platform
 * win32-x64` without `--publish` — because it is how the tree gets smoke-tested. Publishing it
 * is refused, here, in the one uploader both entry points share.
 */
export const PUBLISHED_PLATFORMS = Object.freeze(['linux-x64'])

/**
 * Whether an artefact for this platform is published at all.
 * @param {string} platform - a `platformTag()` result.
 * @returns {boolean}
 */
export function isPublishedPlatform(platform) {
  return PUBLISHED_PLATFORMS.includes(platform)
}

/**
 * Absolute URLs of one artefact, best candidate first.
 *
 * A source is one of two things, because a download host is one of two things:
 *
 * - `{ kind: 'template', template }` — a host with its own path layout (CNB:
 *   `https://cnb.cool/<org>/<repo>/-/releases/download/<tag>/<file>`). Prefixing cannot express
 *   that shape, so the template is filled in instead.
 * - `{ kind: 'prefix', prefix }` — an accelerator, which works by prepending itself to the
 *   canonical `github.com/<repository>/releases/download/…` URL. None is configured by
 *   default (see {@link DEFAULT_SOURCES}); the kind stays supported so a private mirror is a
 *   configuration value rather than a code change.
 *
 * **There is no direct-GitHub candidate, on purpose.** Falling back to `github.com`
 * looks harmless and is not: measured on the test node it runs at ~27 KB/s, so a failed
 * download turns into 1.8 hours of apparent hang — the failure that started this. A
 * host that cannot reach the source is also a host where GitHub is slow or blocked,
 * so "try GitHub anyway" is the one fallback that is guaranteed to be worse than
 * reporting. When every source fails the install reports `ARTEFACT_UNAVAILABLE`
 * and the list gets fixed by hand, which is a decision a person makes once, not a
 * silent 1.8-hour wait on every connect.
 *
 * @param {object} options
 * @param {string} options.version
 * @param {string} options.platform - a `platformTag()` result.
 * @param {string} [options.repository] - the GitHub repository a `prefix` source wraps.
 * @param {Array<{kind: 'prefix' | 'template', prefix?: string, template?: string}>} [options.sources]
 *   - replaces the default source list entirely.
 * @param {string} [options.tag] - release tag; defaults to `v${version}`.
 * @returns {string[]} candidate URLs, best first.
 * @throws when the resulting source list yields no candidate — a missing source is a
 *   configuration error, not a reason to download from GitHub directly.
 */
export function artefactUrls({
  version, platform, repository = DEFAULT_REPOSITORY, sources, tag,
}) {
  const name = artefactName(version, platform)
  const releaseTag = tag ?? `v${version}`
  const official = `https://github.com/${repository}/${RELEASE_BASE}/${releaseTag}/${name}`
  const list = sources ?? DEFAULT_SOURCES
  const candidates = []
  for (const source of list) {
    if (source?.kind === 'template') {
      const template = String(source.template ?? '')
      if (template === '') continue
      candidates.push(template
        .replaceAll('{version}', version)
        .replaceAll('{platform}', platform)
        .replaceAll('{tag}', releaseTag)
        .replaceAll('{file}', name))
      continue
    }
    if (source?.kind === 'prefix') {
      const prefix = String(source.prefix ?? '')
      if (prefix === '') continue
      candidates.push(`${prefix.endsWith('/') ? prefix : `${prefix}/`}${official}`)
      continue
    }
    // An unknown kind is a configuration mistake, and skipping it silently would leave a
    // source list that looks longer than the one actually tried.
    throw new Error(`unknown artefact source kind: ${JSON.stringify(source?.kind ?? null)}`)
  }
  if (candidates.length === 0) {
    throw new Error(
      'no artefact source configured: the node runtime is downloaded only through the '
      + 'source list (CNB; see DEFAULT_SOURCES), never straight from GitHub. Add at least '
      + 'one source.',
    )
  }
  return [...new Set(candidates)]
}

/**
 * Every `code` the two node-side scripts can put in their result line.
 *
 * These are **field values of one JSON object**, not substrings to be grepped out of
 * stderr. The old contract read `detail.includes('ARTEFACT_UNAVAILABLE')`, which meant
 * `ARTEFACT_CHECKSUM_UNAVAILABLE` had to be spelled so it would not collide — a naming
 * convention standing in for a parser, and one that a truncated stderr (the exec
 * capture is capped at 1 MiB) could silently defeat.
 *
 * The names are kept because they already appear in logs and in the design doc; what
 * changed is that nothing compares substrings any more. See {@link parseScriptResult}.
 */
export const SCRIPT_CODES = Object.freeze({
  /** The tree was installed and the live symlink now points at it. */
  INSTALLED: 'INSTALLED',
  /** No configured source served the archive (or the machine has no downloader). */
  ARTEFACT_UNAVAILABLE: 'ARTEFACT_UNAVAILABLE',
  /** The archive arrived, but its published `.sha256` did not. */
  ARTEFACT_CHECKSUM_UNAVAILABLE: 'ARTEFACT_CHECKSUM_UNAVAILABLE',
  /** The archive arrived and did not match its published checksum. */
  ARTEFACT_CHECKSUM_MISMATCH: 'ARTEFACT_CHECKSUM_MISMATCH',
  /** `tar` refused the archive. */
  ARTEFACT_UNPACK_FAILED: 'ARTEFACT_UNPACK_FAILED',
  /** The archive unpacked but is not a DSH runtime (no CLI at the expected path). */
  ARTEFACT_SHAPE_UNEXPECTED: 'ARTEFACT_SHAPE_UNEXPECTED',
  /** A payload the runtime spawns directly is not executable after unpack. */
  ARTEFACT_NOT_EXECUTABLE: 'ARTEFACT_NOT_EXECUTABLE',
  /** The unpacked tree's own CLI cannot report a version, so it would not start. */
  ARTEFACT_CLI_FAILED: 'ARTEFACT_CLI_FAILED',
  /** The verified generation could not be made live (the `ln -sfn` failed). */
  ARTEFACT_SWITCH_FAILED: 'ARTEFACT_SWITCH_FAILED',
  /** A signal cut the script off. The live generation was not touched. */
  ARTEFACT_INTERRUPTED: 'ARTEFACT_INTERRUPTED',
  /** The result line was missing, unparsable, or did not name a code. */
  UNKNOWN: 'UNKNOWN',
})

/** How much of the raw tail is kept when the result line cannot be parsed. */
export const SCRIPT_RESULT_TAIL_BYTES = 600

/**
 * Read the last line of a script's stdout as the one JSON result object.
 *
 * The contract, in one sentence: **the last non-empty line of stdout is
 * `{"ok":true|false,"code":"…","stage":"…", …}` on every exit path**, because the
 * script installs an EXIT trap that prints it. The exit code is kept for diagnostics
 * and carries no meaning — a non-zero status only says "look at that line".
 *
 * When the line is missing or not JSON (a killed shell, a shell that does not run the
 * trap, an old script), the answer is `UNKNOWN` plus the last
 * {@link SCRIPT_RESULT_TAIL_BYTES} of the raw output, so the failure still says
 * something. `parsed` distinguishes "the script answered" from "we had to guess".
 *
 * **Why truncation is reported rather than guessed at.** `SshConnection.exec` caps each stream
 * at `maxBytes` and keeps the *head*, so a script that printed megabytes would lose its last
 * line — the one line that matters. The install script prints nothing else (`curl -fLsS`
 * writes to a file, `tar -xzf` is silent, and the staged `--version` output is captured into a
 * variable), so this should never happen; when the flag is set anyway, `truncated` says the
 * `UNKNOWN` below is a capture artefact and not necessarily the script's silence.
 *
 * @param {{ code?: number | null, stdout?: string, stderr?: string, truncated?: boolean } | undefined} result
 * @returns {{ ok: boolean, code: string, stage: string, detail: string,
 *   want: string | undefined, got: string | undefined, version: string | undefined,
 *   generation: string | undefined, raw: string | undefined, tail: string, parsed: boolean,
 *   truncated: boolean }}
 */
export function parseScriptResult(result) {
  const stdout = String(result?.stdout ?? '')
  const stderr = String(result?.stderr ?? '')
  const truncated = result?.truncated === true
  const lines = stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  const last = lines.at(-1)
  const tail = (stderr.trim() !== '' ? stderr : stdout).trim().slice(-SCRIPT_RESULT_TAIL_BYTES)
  if (last !== undefined) {
    let parsed
    try {
      parsed = JSON.parse(last)
    } catch {
      parsed = undefined
    }
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.ok === 'boolean') {
      const code = typeof parsed.code === 'string' && parsed.code !== ''
        ? parsed.code
        : (parsed.ok === true ? SCRIPT_CODES.INSTALLED : SCRIPT_CODES.UNKNOWN)
      return {
        ok: parsed.ok === true,
        code,
        stage: typeof parsed.stage === 'string' && parsed.stage !== '' ? parsed.stage : 'unknown',
        detail: typeof parsed.detail === 'string' ? parsed.detail : '',
        want: typeof parsed.want === 'string' ? parsed.want : undefined,
        got: typeof parsed.got === 'string' ? parsed.got : undefined,
        version: typeof parsed.version === 'string' ? parsed.version : undefined,
        generation: typeof parsed.generation === 'string' ? parsed.generation : undefined,
        raw: last,
        tail,
        parsed: true,
        truncated,
      }
    }
  }
  return {
    ok: false,
    code: SCRIPT_CODES.UNKNOWN,
    stage: 'unknown',
    detail: truncated
      ? 'the captured output hit its byte cap, so the result line may have been cut off'
      : '',
    want: undefined,
    got: undefined,
    version: undefined,
    generation: undefined,
    raw: last,
    tail,
    parsed: false,
    truncated,
  }
}

/**
 * The shell preamble that makes "last line is JSON" true on every exit path.
 *
 * Shared by {@link installScript} and {@link rollbackScript} so the two cannot answer
 * in different shapes: the caller has one parser ({@link parseScriptResult}) and one
 * vocabulary ({@link SCRIPT_CODES} plus {@link ROLLBACK_VERDICTS}).
 *
 * `trap finish EXIT` covers a normal exit, an explicit `fail`, and `set -e` tripping.
 * The INT/TERM/HUP traps turn a signal into an ordinary exit so the EXIT trap still
 * runs; without them a `sh` killed by SIGTERM exits without printing anything, which
 * is exactly the case where the caller needs the line most (it can then tell "the
 * script was cut off" from "the script said no").
 *
 * The values are escaped with `sed`/`tr` rather than assumed clean: a detail can carry
 * a path, and a path can carry a quote.
 *
 * @param {string} stage - the initial stage name, for an unexpected exit.
 * @returns {string}
 */
function resultPreamble(stage) {
  return `
# ---- result channel -------------------------------------------------------
# The caller reads the LAST LINE of stdout as one JSON object on every exit path.
# The exit code is kept for diagnostics and carries no meaning: "non-zero" only means
# "read the line". This replaced "exit code + a sentinel substring in stderr", which
# needed names chosen so one sentinel would not contain another.
json_escape() {
  printf '%s' "$1" | tr '\\n\\r\\t' '   ' | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'
}
json_field() {
  if [ -z "$2" ]; then return 0; fi
  printf ',"%s":"%s"' "$1" "$(json_escape "$2")"
}
stage="${stage}"
result=''
interrupted=''
fail_code=''
fail_stage=''
fail_detail=''
fail_want=''
fail_got=''
fail() {
  fail_code=$1
  fail_stage=$2
  fail_detail=\${3-}
  fail_want=\${4-}
  fail_got=\${5-}
  exit 1
}
finish() {
  status=$?
  # Cleared first: the traps below would otherwise re-enter this function on the way out.
  trap - EXIT INT TERM HUP
  if [ -n "$result" ]; then
    printf '%s\\n' "$result"
  else
    # A signal is not reported by the signal trap itself. The trap only sets a flag and
    # exits, and the code and stage are read **here**, at exit time: the action string of a
    # shell trap is expanded differently by different shells (dash freezes it when the trap
    # is set), so a trap that built its own JSON would report the stage the script started
    # in rather than the one it was killed in — measured: an install TERMed during the
    # download answered a stage of "prepare".
    if [ -n "$interrupted" ] && [ -z "$fail_code" ]; then
      fail_code=${SCRIPT_CODES.ARTEFACT_INTERRUPTED}
      fail_detail="a signal stopped the script during the $stage stage"
    fi
    printf '{"ok":false,"code":"%s","stage":"%s"%s%s%s}\\n' \\
      "$(json_escape "\${fail_code:-${SCRIPT_CODES.UNKNOWN}}")" \\
      "$(json_escape "\${fail_stage:-\${stage}}")" \\
      "$(json_field detail "\${fail_detail:-}")" \\
      "$(json_field want "\${fail_want:-}")" \\
      "$(json_field got "\${fail_got:-}")"
  fi
  exit "$status"
}
trap finish EXIT
# Record, then leave: the EXIT trap above still runs and prints the one result line, so a
# killed script is distinguishable from a script that said no. Without this a shell that
# receives SIGTERM exits without printing anything — the case where the caller most needs to
# know whether the live tree was touched.
trap 'interrupted=1; exit 1' INT TERM HUP
`.trimEnd()
}

/**
 * Turn a `~`-rooted path into something a shell expands inside double quotes.
 *
 * `~/.dsh-remote-node-harness/run` only expands when it is unquoted and at the start of a
 * word. Every path in the generated scripts is quoted — a directory with a space in it must
 * not break an install — so the tilde has to be replaced by `$HOME` instead. Without this the
 * script happily creates a directory literally named `~` and then fails to download into it.
 *
 * Exported because `daemon.js` needs the same rewrite for its own commands: two
 * implementations of this would eventually disagree about `~`.
 * @param {string} path
 */
export function shellPath(path) {
  return path.startsWith('~/') ? `$HOME/${path.slice(2)}` : path
}

/**
 * The `find` expression that selects every file {@link isArtefactExecutable} names.
 *
 * Relative and rooted at the staging directory on purpose: the staging directory derives from
 * a caller-supplied remote root, and an absolute `bin` path pattern would match the whole tree
 * the moment that root had a `bin` segment anywhere in it. Exported so the test can run this
 * exact expression against a fake tree instead of asserting on a string: a `find` expression
 * is one parenthesis away from matching nothing, and nothing about that is visible in a diff.
 * @returns {string}
 */
export function artefactExecutableFind() {
  // Built from parts because the literal `*/bin/*` would close the comment above.
  const binPattern = `${'*'}/bin/${'*'}`
  const nameClause = ARTEFACT_EXECUTABLE_NAMES.map(name => `-o -name '${name}'`).join(' ')
  const suffixClause = ARTEFACT_EXECUTABLE_SUFFIXES.map(suffix => `-o -name '*${suffix}'`).join(' ')
  return `find . -type f \\( -path "${binPattern}" ${nameClause} ${suffixClause} \\) -print`
}

/**
 * Shell lines that put the executable bit on everything {@link isArtefactExecutable} names.
 *
 * Generated from the same predicate the packer uses, so the two cannot disagree about which
 * files are programs. `chmod` failures are swallowed on purpose — a mode bit that cannot be
 * set (a read-only mount, an exotic filesystem) is then caught by the `-x` verification that
 * follows, which reports the file by name instead of a bare `chmod` error.
 * @returns {string}
 */
function executableRestoreLines() {
  return [
    'for executable in $(cd "$staging" && ' + artefactExecutableFind() + '); do',
    '  chmod 0755 "$staging/$executable" 2>/dev/null || true',
    'done',
  ].join('\n')
}

/**
 * The shell script that installs one runtime on the node.
 *
 * Written as one `sh -c` payload because a handful of round trips over a slow link costs more
 * than the script does, and every command here is one the probe has already proved exists
 * (`curl`/`wget`, `tar`, `sha256sum`/`shasum`).
 *
 * The archive's layout is a runtime directory itself — `node_modules/…` at the top.
 *
 * **One script = one transaction.** The live runtime is a symlink
 * (`runtime -> runtime.<n>`); the new tree is unpacked, repaired, stamped and asked for its
 * version inside its own `runtime.<n+1>`, and the last statement that changes what the node
 * runs is a single `ln -sfn runtime.<n+1> runtime`. So:
 *
 * - every failure before that line leaves the live generation serving, untouched;
 * - a rollback is the same operation pointed the other way (see {@link rollbackScript}), not
 *   a second script with its own semantics;
 * - a script killed between "unpacked" and "switched" leaves a residue generation and a
 *   working node; the next successful install prunes it;
 * - one generation is kept and the rest are removed, so the disk cost is bounded — the old
 *   `.previous` directory was never cleaned up and cost 268–408 MiB per upgrade.
 *
 * A node installed by a pre-symlink build has a **real directory** at `runtime`. It is
 * migrated to `runtime.<n>` *before* the download starts, so every exit path below sees a
 * symlink and the commit point stays one statement for new and old nodes alike.
 *
 * `set -eu` is deliberate: a partially applied install must stop the connect, not continue
 * into a node that starts with half a runtime. Every failure it can hit is either checked
 * explicitly (and reported with a {@link SCRIPT_CODES} value) or falls through to the EXIT
 * trap, which reports the stage it had reached.
 *
 * @param {object} options
 * @param {string} options.version
 * @param {string} options.runtime - the live symlink path, e.g. `~/.dsh-remote-node-harness/runtime`.
 * @param {string} options.cli - the CLI path inside the runtime, through the symlink.
 * @param {string[]} options.urls - candidate download URLs.
 * @param {number} [options.build] - the packaging build, stamped into the tree.
 * @returns {string}
 */
export function installScript({ version, runtime, cli, urls, build = RUNTIME_BUILD }) {
  const checksumUrls = urls.map(url => `${url}.sha256`)
  const quote = list => list.map(url => `'${url}'`).join(' ')
  const runtimeShell = shellPath(runtime)
  const cliShell = shellPath(cli)
  // The CLI's path *inside* a generation, so the same script can probe the staging tree
  // before it is live. The caller passes the through-the-symlink path (that is what the
  // launch line uses), so the generation-relative part is what remains after the runtime
  // prefix — and if a caller passes something unrelated, the default is the one path the
  // installer itself writes.
  const cliRelative = cliShell.startsWith(runtimeShell)
    ? cliShell.slice(runtimeShell.length)
    : '/node_modules/@deepseek-ai/dsh/lib/bin.js'
  return `
set -eu
${resultPreamble('prepare')}
runtime="${runtimeShell}"
cli="${cliShell}"
cli_relative="${cliRelative}"
base="$(dirname "$runtime")"
archive="$base/runtime-${version}.tar.gz"
mkdir -p "$base"
cd "$base"

# ---- the live generation ---------------------------------------------------
# 'runtime' is a symlink to 'runtime.<n>'; that symlink is the one and only answer to
# "what does this node run". A node installed before this layout has a **real directory**
# at 'runtime' instead, and it is migrated here, once, *before* anything is downloaded:
#
#   mv runtime runtime.0 && ln -sfn runtime.0 runtime
#
# Doing it first is what keeps the commit point uniform: every exit path below sees a
# symlink, so the only statement that changes what the node runs is the single
# 'ln -sfn' at the end. Migrating at the end instead would make the last step two
# statements for exactly the nodes that are hardest to repair by hand.
live=''
if [ -L "$runtime" ]; then
  live=$(readlink "$runtime")
elif [ -d "$runtime" ]; then
  migrate=0
  while [ -e "$base/runtime.$migrate" ]; do migrate=$((migrate + 1)); done
  mv "$runtime" "$base/runtime.$migrate"
  ln -sfn "runtime.$migrate" "$runtime"
  live="runtime.$migrate"
fi
# A 'runtime' that is neither a symlink nor a directory means one of two things: a fresh
# node, or a script that was killed inside 'ln -sfn''s own unlink/symlink pair. In the
# second case the generations are still on disk, and the newest one is what was about to
# become live — so adopt it rather than report a node with no runtime.
if [ -z "$live" ]; then
  newest=''
  for candidate in "$base"/runtime.*; do
    [ -d "$candidate" ] || continue
    suffix=\${candidate##*/runtime.}
    case "$suffix" in ''|*[!0-9]*) continue ;; esac
    if [ -z "$newest" ] || [ "$suffix" -gt "$newest" ]; then newest=$suffix; fi
  done
  if [ -n "$newest" ]; then
    ln -sfn "runtime.$newest" "$runtime"
    live="runtime.$newest"
  fi
fi
# The generation this install writes into. It is **not** the live one and is never the
# live one until the commit line: a failure anywhere below leaves 'runtime' alone.
next=1
for candidate in "$base"/runtime.*; do
  [ -d "$candidate" ] || continue
  suffix=\${candidate##*/runtime.}
  case "$suffix" in ''|*[!0-9]*) continue ;; esac
  if [ "$suffix" -ge "$next" ]; then next=$((suffix + 1)); fi
done
staging="$base/runtime.$next"

fetch() {
  for target in "$@"; do
    if command -v curl >/dev/null 2>&1; then
      curl -fLsS --connect-timeout 15 --retry 2 \\
        --speed-limit ${FETCH_FLOOR_BYTES} --speed-time ${FETCH_FLOOR_SECONDS} \\
        --max-time ${FETCH_CEILING_SECONDS} -o "$OUT" "$target" && return 0
    elif command -v wget >/dev/null 2>&1; then
      wget -q -T 20 -t 2 -O "$OUT" "$target" && return 0
    else
      fail ${SCRIPT_CODES.ARTEFACT_UNAVAILABLE} download "this machine has neither curl nor wget"
    fi
  done
  return 1
}

stage=download
OUT="$archive"
if ! fetch ${quote(urls)}; then
  fail ${SCRIPT_CODES.ARTEFACT_UNAVAILABLE} download "no configured source served the archive"
fi

stage=verify
OUT="$archive.sha256"
if ! fetch ${quote(checksumUrls)}; then
  # **No sidecar is a failure, not a skip.** The archive came from the same host that is
  # supposed to publish its hash beside it; a host that serves the bytes but not the hash is
  # either a broken release or a partial mirror. Unpacking without the comparison turns
  # "truncated download" into "half-installed runtime that fails at first use" — the exact
  # thing the checksum exists to prevent, and the failure lands days later on a tool call.
  rm -f "$archive"
  fail ${SCRIPT_CODES.ARTEFACT_CHECKSUM_UNAVAILABLE} verify "the archive arrived but its .sha256 did not"
fi
expected=$(cut -d' ' -f1 < "$archive.sha256")
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$archive" | cut -d' ' -f1)
else
  actual=$(shasum -a 256 "$archive" | cut -d' ' -f1)
fi
if [ "$expected" != "$actual" ]; then
  rm -f "$archive"
  fail ${SCRIPT_CODES.ARTEFACT_CHECKSUM_MISMATCH} verify "the archive does not match its published sha256" "$expected" "$actual"
fi

stage=unpack
rm -rf "$staging"
mkdir -p "$staging"
if ! tar -xzf "$archive" -C "$staging" 2>/dev/null; then
  rm -rf "$staging"
  rm -f "$archive" "$archive.sha256"
  fail ${SCRIPT_CODES.ARTEFACT_UNPACK_FAILED} unpack "tar could not unpack the archive"
fi
if [ ! -f "$staging$cli_relative" ]; then
  rm -rf "$staging"
  rm -f "$archive" "$archive.sha256"
  fail ${SCRIPT_CODES.ARTEFACT_SHAPE_UNEXPECTED} unpack "the archive has no node_modules/@deepseek-ai/dsh/lib/bin.js"
fi
# tar on a Windows packer writes 0666 for every entry — measured on the published rc.5
# archive: 25 038 files, **0** carrying +x. chmodSync on Windows leaves 100666, so the packer
# cannot help even when it tries; this is the only place the bit can be restored.
#
# It used to repair only spawn-helper, on the theory that node-pty's helper was the one file a
# node spawns directly. That theory was wrong about Linux, and the consequence was total:
# @vscode/ripgrep-linux-x64/bin/rg arrives mode 0666, dsh-util-ripgrep spawns it by path with
# **no system-rg fallback**, and every glob/grep call in every session on the node answers
# "ripgrep provider failure". Not a slow degradation — file search never works, on a tree the
# gate reports as "in step". The rule is now the same one the packer uses
# (isArtefactExecutable): every file inside a package's bin/ directory, spawn-helper by name,
# and native addons by suffix.
stage=repair
${executableRestoreLines()}
# **Verified, not assumed.** A tree whose payloads are not executable installs silently and
# breaks at the first search, so it is checked here, where the answer can still be "no"
# without anything live having changed. Absent is fine — a Darwin prebuild is not in a Linux
# archive — but present and not executable is fatal, and says which file.
broken=
for candidate in "$staging/node_modules/@vscode/ripgrep-linux-x64/bin/rg" "$staging/node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run"; do
  if [ -f "$candidate" ] && [ ! -x "$candidate" ]; then broken="$broken $candidate"; fi
done
if [ -n "$broken" ]; then
  rm -rf "$staging"
  rm -f "$archive" "$archive.sha256"
  fail ${SCRIPT_CODES.ARTEFACT_NOT_EXECUTABLE} repair "a payload the runtime spawns is not executable" "$broken"
fi

# The stamp is written into the **staging** generation: it records which build packed these
# bytes, and a tree only carries it once every check above has passed.
stage=stamp
printf '%s\\n' '${stampText({ build, via: 'artefact' })}' > "$staging/${BUILD_STAMP}"

# **The tree has to start before it may become live.** '--version' imports the real entry
# point, so a missing native module or a broken tree is caught while 'runtime' still points
# at the release that works. This is the check that makes the commit line safe.
stage=probe
installed_version=$(node "$staging$cli_relative" --version 2>/dev/null || true)
if ! printf '%s' "$installed_version" | grep -Eq '^[0-9]+\\.[0-9]+\\.[0-9]+'; then
  rm -rf "$staging"
  rm -f "$archive" "$archive.sha256"
  fail ${SCRIPT_CODES.ARTEFACT_CLI_FAILED} probe "the unpacked tree's CLI did not report a version" "${version}" "$installed_version"
fi

# ---- commit ---------------------------------------------------------------
# The one statement that changes what this node runs. Everything above could fail without
# touching the live generation; nothing below can undo the switch, and nothing below is
# allowed to turn a good switch into a reported failure.
stage=switch
previous=''
if [ -n "$live" ] && [ "$live" != "runtime.$next" ]; then previous="$live"; fi
if ! ln -sfn "runtime.$next" "$runtime"; then
  fail ${SCRIPT_CODES.ARTEFACT_SWITCH_FAILED} switch "could not point runtime at runtime.$next"
fi
# **Bounded cleanup.** The live generation and exactly one previous one are kept (the
# previous is what a rollback points at); every other generation is residue from a failed
# or interrupted attempt. 'runtime.incoming'/'runtime.previous' are the pre-symlink
# layout's staging and backup directories: after this switch the tree that was live is the
# previous generation, so both are older than what is kept. Failures here are ignored on
# purpose — the switch already succeeded, and a full disk must not be reported as "the
# install failed".
stage=prune
for candidate in "$base"/runtime.*; do
  [ -d "$candidate" ] || continue
  name=\${candidate##*/}
  suffix=\${name#runtime.}
  case "$suffix" in ''|*[!0-9]*) continue ;; esac
  if [ "$name" = "runtime.$next" ] || { [ -n "$previous" ] && [ "$name" = "$previous" ]; }; then continue; fi
  rm -rf "$candidate" 2>/dev/null || true
done
rm -rf "$base/runtime.incoming" "$base/runtime.previous" 2>/dev/null || true
rm -f "$archive" "$archive.sha256" 2>/dev/null || true
result=$(printf '{"ok":true,"code":"%s","stage":"done","version":"%s","generation":"%s"}' \\
  "${SCRIPT_CODES.INSTALLED}" "$(json_escape "$installed_version")" "runtime.$next")
`.trim()
}

/**
 * Escape a stamp for a single-quoted shell string.
 *
 * The stamp is JSON, which contains double quotes — harmless in `'…'` — but a `'` inside it
 * would end the string early. Nothing writes one today; this keeps the script generator from
 * depending on that.
 * @param {{ build?: number, via: 'artefact' | 'npm' }} input
 */
function stampText(input) {
  const json = stampJson(input)
  if (json.includes("'")) throw new Error(`a build stamp may not contain a quote: ${json}`)
  return json
}

/**
 * Whether an installed tree can be trusted for this release.
 *
 * Both halves matter and neither implies the other: the version says *which release* the
 * tree is, and the stamp says *who packed it*. A node can be on the right version and
 * still be broken, which is exactly what a changed strip rule produces.
 *
 * @param {object} input
 * @param {string | undefined} input.version - the version the tree reports.
 * @param {string | undefined} input.build - the stamp the tree carries, in any format
 *   {@link parseStamp} reads.
 * @param {string} input.wantedVersion
 * @returns {{ usable: boolean, reason: string, via: 'artefact' | 'npm' | undefined }}
 */
export function inspectRuntime({ version, build, wantedVersion }) {
  const stamp = parseStamp(build)
  if (version !== wantedVersion) {
    return {
      usable: false,
      reason: version === undefined ? 'no runtime installed' : `runtime is ${version}`,
      via: stamp.via,
    }
  }
  if (stamp.build === undefined) {
    // Two different faults read the same from here, so the message says both: a tree from
    // before stamps existed has no file, and a tree whose stamp was cut short has a broken
    // one. Neither can be trusted, and both are repaired by the same reinstall.
    return {
      usable: false,
      reason: String(build ?? '').trim() === ''
        ? 'this runtime predates build stamps'
        : `unreadable build stamp ${String(build).trim()}`,
      via: undefined,
    }
  }
  if (stamp.build !== RUNTIME_BUILD) {
    return {
      usable: false,
      reason: `runtime was packed by build ${String(stamp.build)}, this plugin packs build ${String(RUNTIME_BUILD)}`,
      via: stamp.via,
    }
  }
  // `via` is reported, never judged: a tree the node resolved itself is as usable as a
  // downloaded one, and the whole point of the npm route is that the two are interchangeable.
  return { usable: true, reason: 'in step', via: stamp.via }
}

/**
 * The three answers {@link rollbackScript} can give, as the caller-visible contract.
 *
 * They exist because "a rollback ran" and "a rollback did something" are different facts, and
 * the one that matters to a user is the second. `kept-current` is the ordinary answer after a
 * failed install: the live tree was never touched, so the node is still on the release it had.
 *
 * They travel as the `code` field of the result line (see {@link parseScriptResult}), not as
 * a bare word on stdout: the caller has one parser for both scripts, and a bare word would
 * need its own "did the script even run" check.
 */
export const ROLLBACK_VERDICTS = Object.freeze({
  /** The live runtime still starts; nothing was changed. */
  KEPT_CURRENT: 'kept-current',
  /** The live runtime could not start; the previous generation took its place. */
  ROLLED_BACK: 'rolled-back',
  /** The live runtime could not start and there was no previous tree to use. */
  NOTHING_TO_ROLL_BACK: 'nothing-to-roll-back',
})

/**
 * The CLI's path *inside* a runtime generation.
 *
 * The caller passes the through-the-symlink path (`…/runtime/node_modules/@deepseek-ai/dsh/
 * lib/bin.js`), which is what the launch line and every later read use; a generation path is
 * that same string with the runtime prefix swapped. Falling back to the path the installer
 * itself writes keeps a caller that passes something unrelated working instead of producing
 * a script that probes nothing.
 * @param {string} runtime - the `~`-rooted runtime path, as the caller spelled it.
 * @param {string} cli - the `~`-rooted CLI path, as the caller spelled it.
 * @returns {string}
 */
function cliRelativeTo(runtime, cli) {
  const runtimeShell = shellPath(runtime)
  const cliShell = shellPath(cli)
  return cliShell.startsWith(runtimeShell)
    ? cliShell.slice(runtimeShell.length)
    : '/node_modules/@deepseek-ai/dsh/lib/bin.js'
}

/**
 * Decide what a failed install leaves behind: the live generation, or the one before it.
 *
 * **With the symlink layout this is the same operation as an install, pointed the other
 * way.** An install that failed before its commit line never touched `runtime`, so the
 * ordinary answer is `kept-current` and the script changes nothing. An install that failed
 * *after* the commit line cannot happen by construction — the only statement after the
 * switch is cleanup that ignores its own failures — so `rolled-back` is now the answer to
 * "the live generation itself does not start", not to "an install failed".
 *
 * The live generation is started before anything is moved, and that ordering is the fix for
 * A1: a script that restored a backup unconditionally *downgraded* a node whose download had
 * merely failed. Measured on a real node by planting `runtime=v2-good` /
 * `runtime.previous=v1-old` and running the old script, the node came back running v1-old.
 *
 * Three layouts are handled, because a node in service can be in any of them:
 *
 * 1. `runtime -> runtime.<n>` (this build): probe the target; if it runs, keep it.
 * 2. `runtime` a **real directory** (a build before the symlink layout): probe it; if it
 *    runs, keep it exactly as it is. Rollback never migrates — a repair that runs while the
 *    caller is already handling a failure must be the smallest possible action.
 * 3. `runtime` gone or broken, with `runtime.previous` (the pre-symlink backup): restore it.
 *
 * `set -u` rather than `set -eu`: a failed probe is an answer here, not a reason to abort
 * without printing a verdict at all.
 *
 * @param {string} runtime - the live runtime path (`~`-rooted is fine).
 * @param {string} [cli] - the CLI inside that runtime; defaults to the path the installer
 *   writes. `RemoteHost` passes its own layout value so the two can never disagree.
 * @returns {string}
 */
export function rollbackScript(runtime, cli = `${runtime}/node_modules/@deepseek-ai/dsh/lib/bin.js`) {
  const runtimeShell = shellPath(runtime)
  const cliShell = shellPath(cli)
  const cliRelative = cliRelativeTo(runtime, cli)
  return `
set -u
${resultPreamble('rollback')}
runtime="${runtimeShell}"
cli="${cliShell}"
cli_relative="${cliRelative}"
base="$(dirname "$runtime")"
live=''
if [ -L "$runtime" ]; then live=$(readlink "$runtime"); fi

# Whether one generation holds a tree that starts. The only evidence that cannot lie about a
# tree is starting it; a stamp or a version file proves who wrote something, not that it runs.
generation_works() {
  [ -n "$1" ] || return 1
  [ -f "$base/$1$cli_relative" ] || return 1
  node "$base/$1$cli_relative" --version >/dev/null 2>&1
}

# The ordinary answer: the live generation still starts, so the failed install never got as
# far as replacing it. Nothing is changed — that is the difference between "nothing happened"
# and "the node went backwards one release".
if [ -n "$live" ] && generation_works "$live"; then
  result=$(printf '{"ok":true,"code":"%s","stage":"rollback","generation":"%s"}' \\
    "${ROLLBACK_VERDICTS.KEPT_CURRENT}" "$(json_escape "$live")")
  exit 0
fi
# A pre-symlink node whose runtime is a real directory and still starts: same answer, and it
# is left as a directory. Migrating here would be a bigger action than the failure deserves.
if [ ! -L "$runtime" ] && [ -d "$runtime" ] && node "$runtime$cli_relative" --version >/dev/null 2>&1; then
  result=$(printf '{"ok":true,"code":"%s","stage":"rollback"}' "${ROLLBACK_VERDICTS.KEPT_CURRENT}")
  exit 0
fi

# The live generation does not start. The previous one was accepted by this same installer
# when it was installed, which makes it the best candidate there is. Pick the highest numbered
# generation that is not the live one and that starts; a residue directory from an interrupted
# install is skipped because it does not start.
target=''
for candidate in "$base"/runtime.*; do
  [ -d "$candidate" ] || continue
  name=\${candidate##*/}
  suffix=\${name#runtime.}
  case "$suffix" in ''|*[!0-9]*) continue ;; esac
  [ "$name" = "$live" ] && continue
  if generation_works "$name"; then
    if [ -z "$target" ] || [ "$suffix" -gt "$target_suffix" ]; then
      target="$name"
      target_suffix="$suffix"
    fi
  fi
done
if [ -n "$target" ]; then
  ln -sfn "$target" "$runtime" || fail ${SCRIPT_CODES.ARTEFACT_SWITCH_FAILED} rollback "could not point runtime at $target"
  result=$(printf '{"ok":true,"code":"%s","stage":"rollback","generation":"%s"}' \\
    "${ROLLBACK_VERDICTS.ROLLED_BACK}" "$(json_escape "$target")")
  exit 0
fi

# The pre-symlink backup, for a node that has not been through an install since the layout
# changed. It is restored only after every generation has been proven not to start.
if [ -d "$base/runtime.previous" ] && node "$base/runtime.previous$cli_relative" --version >/dev/null 2>&1; then
  rm -rf "$runtime" "$base/runtime.incoming" 2>/dev/null || true
  mv "$base/runtime.previous" "$runtime" || fail ${SCRIPT_CODES.ARTEFACT_SWITCH_FAILED} rollback "could not restore runtime.previous"
  result=$(printf '{"ok":true,"code":"%s","stage":"rollback","generation":"runtime.previous"}' \\
    "${ROLLBACK_VERDICTS.ROLLED_BACK}")
  exit 0
fi

result=$(printf '{"ok":true,"code":"%s","stage":"rollback"}' "${ROLLBACK_VERDICTS.NOTHING_TO_ROLL_BACK}")
`.trim()
}
