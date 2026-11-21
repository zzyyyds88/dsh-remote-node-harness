#!/usr/bin/env node
/**
 * Upload a node runtime archive to the release.
 *
 * The archive itself is built by `build-fork-runtime.mjs` from this project's fork of the
 * upstream source: a node runs the tree this project built and tested, not the upstream
 * release (see `docs/adr-0007-fork-node-runtime.zh.md`). This script only carries a built
 * archive to the two places it is published, and it is the single uploader — the fork build
 * calls it, so there is one set of release-side quirks to get right instead of two.
 *
 * **Why an archive at all.** A node used to get its DSH by running `npm install` over SSH:
 * several minutes, a working registry, and a tree nobody could reproduce. A published
 * archive is one download, and every node on that platform ends up with the same bytes.
 *
 * **Why the tree is resolved rather than copied from a local install.** A DSH installation
 * is not pure JavaScript: `node-pty`, `sharp` and `sherpa-onnx` ship native binaries, and the
 * installed tree names the platform it was built for (`sherpa-onnx-win-x64`,
 * `@img/sharp-linux-x64`/`sharp-libvips-linux-x64`). Copying this Windows desktop's tree and
 * unpacking it on a Linux node would give a node whose terminal and image tools fail at first
 * use — worse than the slow install it replaced, because it fails later and further from the
 * cause. So the fork build resolves **for the target platform** with npm's own platform flags
 * (`--os --cpu --libc`), and the archive name carries that platform.
 *
 * Usage:
 *   node packages/dsh-remote-node-harness/scripts/publish-runtime.mjs [--platform linux-x64[(-musl)]] [--out dist] [--publish] [--cnb]
 *
 * `--platform` accepts the tag form the plugin uses (`linux-x64`, `linux-arm64`,
 * `linux-x64-musl`, `darwin-arm64`). The order is `<os>-<cpu>[-<libc>]` — the libc suffix
 * comes **last**, so the musl spelling is `linux-arm64-musl`, not `linux-musl-arm64` (the
 * latter parses as `--cpu=musl --libc=arm64`, which npm rejects). Nothing is published unless
 * `--publish` or `--cnb` is given. CI runs this per platform
 * (`.github/workflows/release-runtime.yml`).
 *
 * **Two destinations, and they are not alternatives.** `--cnb` uploads to CNB, which is the
 * **only** source a node downloads from: it serves the archive straight at 4 233 285 B/s on
 * the reference node, and the machines this project serves cannot reach GitHub at all.
 * `--publish` uploads the same bytes to the GitHub release as a backup and for the record;
 * no node reads them from there. The CNB token is read from `CNB_TOKEN` and never written
 * anywhere: this repository is public.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARTEFACT_RESIDUE, ARTEFACT_RESIDUE_KEEP, foreignPlatformResidue, stripResidue } from './trim-fork-runtime.mjs'
import { isArtefactExecutable, PUBLISHED_PLATFORMS, isPublishedPlatform } from '../src/remote/artefact.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const args = process.argv.slice(2)
const flag = name => args.includes(`--${name}`)
const value = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const platform = value('platform', 'linux-x64')
const outDir = resolve(pluginRoot, value('out', '../../dist'))
const shouldPublish = flag('publish')
const shouldPublishCnb = flag('cnb') || flag('cnb-only')
const cnbOnly = flag('cnb-only')
const allowUpstreamPublish = flag('allow-upstream-publish')
const tag = value('tag', undefined)
const registry = value('registry', 'https://registry.npmmirror.com')
const cnbRepository = value('cnb-repo', 'serendipity-archive/dsh-fleet')

// Publishing a platform no node can ask for leaves an asset that nothing fetches and a release
// body line that reads like the platform works. `win32-x64` was exactly that: the tree packs and
// boots, but the probe reads `uname`, the node side is 21 `sh -c` calls plus `setsid`, and the
// only transport is SSH — so no Windows node can ever name it. Building it locally (no
// `--publish`, no `--cnb`) stays allowed: that is how the tree gets smoke-tested.
// The list lives in `src/remote/artefact.js` beside `platformTag()`, which is where the
// "can this machine be a node at all" question is already answered.
if ((shouldPublish || shouldPublishCnb) && !isPublishedPlatform(platform)) {
  throw new Error(
    `${platform} is not a published platform (${PUBLISHED_PLATFORMS.join(', ')}). `
    + 'Refusing to upload an archive no node can ask for; drop --publish/--cnb to build it locally.',
  )
}

/**
 * `linux-x64` → npm's `--os linux --cpu x64`, plus libc for the Linux split.
 *
 * The libc suffix is optional (`linux-x64-musl`). Without one, Linux resolves as glibc,
 * which is what the nodes in service run; a musl node needs a musl artefact, and both
 * `sharp` and `sherpa-onnx` publish one. Measured: `ldd --version` on the test node reports
 * `Ubuntu GLIBC 2.35-0ubuntu3.18`, and `@koromix/koffi-linux-x64` ships both `linux_x64` and
 * `musl_x64` — asking npm for the wrong half installs a library that cannot be loaded.
 */
function npmPlatform(tagName) {
  const [os, cpu, libc] = String(tagName).split('-')
  if (!os || !cpu) throw new Error(`--platform wants a tag like linux-x64, got "${tagName}"`)
  const flags = [`--os=${os}`, `--cpu=${cpu}`]
  if (os === 'linux') flags.push(`--libc=${libc ?? 'glibc'}`)
  else if (libc !== undefined) throw new Error(`only Linux splits by libc, and "${tagName}" is not Linux`)
  return flags
}

/**
 * The version to publish.
 *
 * Taken from the installation the desktop actually runs, so `publish` cannot disagree
 * with the app that will ask nodes for it.
 */
function installedVersion() {
  const fromEnv = process.env.DSH_INSTALL_DIR
  if (typeof fromEnv === 'string' && fromEnv.length > 0 && existsSync(join(fromEnv, 'package.json'))) {
    return JSON.parse(readFileSync(join(fromEnv, 'package.json'), 'utf8')).version
  }
  const fromArg = value('version', undefined)
  if (typeof fromArg === 'string' && fromArg.length > 0) return fromArg
  throw new Error(
    'Set DSH_INSTALL_DIR (as the desktop app does) or pass --version. '
    + 'Running this with the desktop\'s own Node sets it: '
    + 'ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" scripts/publish-runtime.mjs',
  )
}

/**
 * Files a running node never reads.
 *
 * The list lives in `trim-fork-runtime.mjs` because the fork build strips the same
 * files: two copies would drift into two artefact contents at one version, which is
 * exactly what `RUNTIME_BUILD` exists to catch. `LICENSE` files are kept either way —
 * they are the licence conditions of the packages being redistributed.
 *
 * **No pattern here may match a directory whose name merely looks like documentation.**
 * `/(^|\/)docs?\//` was in this list and broke the node outright: `yaml` ships
 * `dist/doc/directives.js`, which `dist/compose/composer.js` requires, so stripping
 * `doc/` removed a module the runtime loads during boot. A `doc`-shaped directory inside
 * a package's build output is code, not documentation, and nothing distinguishes the two
 * from the path alone — so the rule is gone rather than narrowed. Measured cost of
 * keeping those trees: under 2 MB.
 */
const STRIPPED = ARTEFACT_RESIDUE

function measure(dir) {
  let bytes = 0
  let files = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const inner = measure(full)
      bytes += inner.bytes
      files += inner.files
      continue
    }
    files += 1
    try { bytes += statSync(full).size } catch { /* vanished mid-walk */ }
  }
  return { bytes, files }
}

/**
 * Delete everything `STRIPPED` matches, honouring the keep list and the platform rules.
 *
 * This used to be a second implementation of `stripResidue`, and the two drifted the moment
 * one gained a rule: the fork build would strip `.ts` sources while this one would not, and
 * the two archives a node can install would differ at the same version. It now calls the
 * shared walker, so a rule or a rescue added there applies to both routes.
 *
 * `platform` is threaded through because "dead bytes" is not a property of the tree alone:
 * a win32 ConPTY payload is dead in a linux archive and load-bearing in a win32 one.
 */
function strip(dir, platform) {
  return stripResidue(dir, [...STRIPPED, ...foreignPlatformResidue(platform)], ARTEFACT_RESIDUE_KEEP)
}

const version = installedVersion()
const name = `dsh-${version}-${platform}.tar.gz`
const archive = join(outDir, name)
const staging = join(outDir, `.staging-${version}-${platform}`)
const runtime = join(staging, 'node_modules')

/**
 * Pack a fresh tree from the **upstream release**, for local inspection only.
 *
 * **This must never be uploaded.** It resolves `@deepseek-ai/dsh` from a registry with no
 * fork, so the tree it produces has none of the trimming (`dropPackages` lives in
 * `build-fork-runtime.mjs`) — it is the 165 MiB upstream tree with a few residue files
 * removed. Uploading it to `v<version>/dsh-<version>-<platform>.tar.gz` replaces exactly what
 * every node downloads, under the same name, version and checksum contract, and nothing in
 * the download would notice. `release-runtime.yml` has warned about this in a comment for
 * months; a comment is not a gate.
 *
 * The gate is `assertPublishable()`, called from `main()` before either upload path.
 */
function pack() {
  mkdirSync(outDir, { recursive: true })
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(runtime, { recursive: true })

  // A minimal manifest so npm installs a *tree* rather than resolving a project.
  writeFileSync(join(staging, 'package.json'), `${JSON.stringify({
    name: 'dsh-rnh-runtime',
    private: true,
    dependencies: { '@deepseek-ai/dsh': version },
  }, undefined, 2)}\n`, 'utf8')

  process.stdout.write(`resolving @deepseek-ai/dsh ${version} for ${platform}\n`)
  // `--ignore-scripts` is load-bearing, not a speed-up. A package's `install` script runs with
  // **this** machine's `process.platform`, so koffi's `cnoke` compiles for Windows even when
  // npm was asked to resolve `--os=linux --cpu=x64`. Measured on the rc.5 archive built the old
  // way: 48 `.exe`/`.cmd`/`.dll`/`.lib` files and 147 `koffi/build/win32_x64/**` entries inside
  // a `linux-x64` artefact, and the packer's own `koffi/build` shadowed the resolved
  // `@koromix/koffi-linux-x64` (which `koffi`'s loader checks *first*, so it kept working —
  // on a tree that was 0.9 MB larger and wrong).
  //
  // Nothing is lost by skipping them: every native dependency in this tree ships a prebuilt
  // platform package (`@koromix/koffi-linux-x64`, `@img/sharp-linux-x64`,
  // `sherpa-onnx-linux-x64`, `node-pty/prebuilds/linux-x64/pty.node`). Measured both ways:
  // with scripts 968.2 MiB / 94106 files, without 957.3 MiB and all four native modules
  // present. The one script that does real work is `dsh-subprocess-local`'s, which restores
  // `+x` on a helper — and the node fixes modes itself when it unpacks (see `installScript`).
  const install = spawnSync('npm', [
    'install',
    '--prefix', staging,
    '--no-audit', '--no-fund', '--loglevel=error',
    '--ignore-scripts',
    '--registry', registry,
    ...npmPlatform(platform),
  ], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (install.status !== 0) throw new Error(`npm install failed with status ${String(install.status)}`)

  const cli = join(runtime, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(cli)) throw new Error(`the resolved tree has no ${cli}; refusing to publish it`)

  // The lock file and npm's own metadata describe a *project*, not the runtime a node
  // starts. Keeping them would let a later `npm install` on the node rewrite the tree.
  for (const scratch of ['package.json', 'package-lock.json', 'node_modules/.package-lock.json']) {
    rmSync(join(staging, scratch), { force: true })
  }

  const before = measure(staging)
  const stripped = strip(staging, platform)
  const after = measure(staging)

  // Restore the executable bit — but only where the packer has POSIX modes to restore.
  //
  // Measured: bsdtar on Windows writes `-rw-rw-rw-` for **every** entry, and `chmodSync` there
  // leaves `100666` (Windows has no exec bit; `--owner/--group` change nothing). So a Windows
  // packer cannot put modes in the archive at all, which is why the load-bearing repair is the
  // `chmod` in `installScript` on the node. This step still matters for the CI matrix, where
  // the same script runs on an ubuntu runner and the modes it sets are the modes that ship.
  //
  // The rule is `isArtefactExecutable`, shared with the installer, so the two cannot disagree
  // about which files are programs. It used to be `spawn-helper` + `*.node`, which missed the
  // ripgrep binary and the sandbox launcher — the defect that made every `glob`/`grep` on a
  // node fail with "ripgrep provider failure".
  let chmodded = 0
  const restore = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { restore(full); continue }
      if (!isArtefactExecutable(full)) continue
      try {
        chmodSync(full, 0o755)
        chmodded += 1
      } catch { /* the node fixes it on unpack */ }
    }
  }
  restore(staging)

  rmSync(archive, { force: true })
  // A subprocess rather than a library: `tar` is on every platform this ships to, and
  // this script must not add a dependency to the plugin.
  //
  // **Relative argv, with `cwd` at the output directory.** An absolute Windows path in the
  // argv is not portable between the two `tar` binaries a Windows machine can have: Git Bash's
  // GNU tar reads `D:\...` as a *remote host* spec (`tar: Cannot connect to D: resolve
  // failed`) and `D:/...` as a file named `D:...`, while bsdtar in System32 handles both. That
  // is not hypothetical — the `win32-x64` leg of `release-runtime.yml` runs under
  // `shell: bash`, so it gets GNU tar and failed deterministically (run 44902426318). Relative
  // paths with `cwd` are the intersection both accept, measured on both binaries.
  const tarred = spawnSync('tar', ['-czf', basename(archive), '-C', basename(staging), '.'], {
    cwd: outDir,
    stdio: 'inherit',
  })
  if (tarred.status !== 0) throw new Error(`tar failed with status ${String(tarred.status)}`)
  rmSync(staging, { recursive: true, force: true })

  const bytes = readFileSync(archive)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(`${archive}.sha256`, `${sha256}  ${name}\n`, 'utf8')

  const mib = value => (value / 1024 / 1024).toFixed(1)
  process.stdout.write(
    `wrote ${name}\n`
    + `  archive  ${mib(bytes.length)} MiB\n`
    + `  unpacked ${after.files} files, ${mib(after.bytes)} MiB`
    + ` (${mib(stripped.bytes)} MiB stripped from ${before.files})\n`
    + `  modes    ${String(chmodded)} files marked 0755\n`
    + `  sha256   ${sha256}\n`,
  )
  return sha256
}

/**
 * Read back the hash of an archive somebody else built.
 *
 * `--cnb-only` is the CI path: the matrix legs pack on the matching runner (where `tar` can
 * record the executable bit) and this job only uploads. Re-resolving there would need a
 * registry and several minutes per platform for bytes that already exist.
 */
function adoptExisting() {
  if (!existsSync(archive)) {
    throw new Error(`--cnb-only expects ${archive}; CI downloads the artifacts into --out first`)
  }
  const bytes = readFileSync(archive)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const sidecar = `${archive}.sha256`
  if (!existsSync(sidecar)) writeFileSync(sidecar, `${sha256}  ${name}\n`, 'utf8')
  process.stdout.write(`uploading the existing ${name} (${(bytes.length / 1024 / 1024).toFixed(1)} MiB)\n`)
  return sha256
}

/**
 * Refuse to upload any archive this script packed itself.
 *
 * The rule is about **who produced the bytes**, not about the file name. A `--cnb-only` /
 * adopted archive came from `build-fork-runtime.mjs` (CI packs with the same script), so it is
 * trimmed. Anything `pack()` produced came straight from the registry with no fork, so it is
 * the upstream tree and must stay local.
 *
 * `--allow-upstream-publish` exists only so this message has an escape hatch for a deliberate
 * one-off (e.g. publishing an upstream comparison tree under its own tag). It is not a normal
 * flag: `build-fork-runtime.mjs` never passes it.
 */
function assertPublishable() {
  if (cnbOnly || allowUpstreamPublish) return
  throw new Error(
    'refusing to upload an archive this script packed: it resolves @deepseek-ai/dsh from the\n'
    + 'registry without the fork, so it carries no trimming, and uploading it would replace what\n'
    + 'every node downloads with a 165 MiB upstream tree under the same name and version.\n'
    + '  Build and publish through build-fork-runtime.mjs (it produces the trimmed tree).\n'
    + '  To upload bytes somebody else built, point --out at them and pass --cnb-only.',
  )
}

const sha256 = cnbOnly ? adoptExisting() : pack()


if (!shouldPublish && !shouldPublishCnb) {
  process.stdout.write(
    '\nNot published. Upload with:\n'
    + `  gh release upload ${tag ?? `v${version}`} "${archive}" "${archive}.sha256" --clobber\n`
    + `  CNB_TOKEN=… node ${process.argv[1]} --platform ${platform} --cnb\n`,
  )
  process.exit(0)
}

assertPublishable()

const releaseTag = tag ?? `v${version}`

/**
 * The release description, built from the archives that are actually in `--out`.
 *
 * **Not from "this platform's sha256", which is what it used to say.** The body is one per
 * release while publishing is one archive at a time, so a body naming a single platform is
 * wrong the moment a second one is uploaded — and a body naming a single `sha256` is worse
 * than wrong: measured on the rc.5 release, the body carried the hash of an archive that had
 * since been replaced, so the only place a person could read a checksum disagreed with both
 * the sidecar and the bytes. Each archive's `.sha256` is authoritative; the body lists them
 * so a reader can see which platforms exist at all.
 */
function releaseNotes() {
  const rows = []
  for (const file of readdirSync(outDir).sort()) {
    const match = /^dsh-(.+)-([a-z0-9]+-[a-z0-9]+(?:-musl)?)\.tar\.gz$/u.exec(file)
    if (match === null) continue
    // The body must describe what the release *has*, not what the out directory happens to
    // contain: a stale archive from a platform since withdrawn (win32-x64 was withdrawn
    // 2026-11-20) would otherwise be advertised with a live-looking sha256 that 404s.
    if (!isPublishedPlatform(match[2])) continue
    const sidecar = join(outDir, `${file}.sha256`)
    const sha = existsSync(sidecar) ? readFileSync(sidecar, 'utf8').trim().split(/\s+/u)[0] : '(no sidecar)'
    const bytes = statSync(join(outDir, file)).size
    rows.push(`| \`${match[2]}\` | ${(bytes / 1048576).toFixed(1)} MiB | \`${sha}\` |`)
  }
  return [
    `Node runtime for DSH ${version}, built by this project from its fork of the upstream source.`,
    '',
    // The path is `DEFAULT_REMOTE_ROOT` in `src/remote/daemon.js`; it is spelled out here because
    // this module must not import the daemon (that would drag `ssh2` into a packaging script).
    // `test/fork-runtime-unit.mjs` asserts the two spellings agree, so a rename cannot leave a
    // release body telling nodes to look in a directory the plugin never writes.
    'A node downloads one of these instead of resolving a release: `~/.dsh-remote-node-harness/runtime`',
    'becomes exactly the unpacked tree. The `.sha256` beside each archive is what the node',
    'verifies, and what `installScript` refuses to unpack on a mismatch.',
    '',
    '| platform | archive | sha256 |',
    '|---|---|---|',
    ...rows,
    '',
    `Only ${PUBLISHED_PLATFORMS.join(', ')} is published: that is the one platform a node can`,
    'name from its own probe and this project has run end to end. A node on any other platform',
    'reports `ARTEFACT_UNAVAILABLE` with the URLs it tried, rather than taking a tree built for',
    'something else.',
    '',
    'Archives are downloaded from CNB; the GitHub release holds the same bytes as a backup.',
  ].join('\n')
}

const notes = releaseNotes()

/**
 * Upload the archive and its checksum to CNB, the primary source.
 *
 * The API is release-oriented and needs a git object to hang a tag on, so an empty repository
 * is the one state this cannot work in — reported as such rather than as a mysterious 400.
 *
 * Four calls, in the order CNB requires — the fourth is the one that is easy to miss:
 *   1. `POST /{repo}/-/releases` — 409 means "already there", which is the normal re-publish
 *      case, so the tag is looked up instead of failing;
 *   2. `POST /{repo}/-/releases/{id}/asset-upload-url` — a signed `asset.cnb.cool` URL,
 *      scoped to one file name and one size, plus the `verify_url` that confirms it;
 *   3. `PUT` the bytes to it;
 *   4. `POST` the `verify_url`. **Without this the asset never becomes part of the release.**
 *      Measured: a PUT answers 200 and the release's asset list stays empty, and an anonymous
 *      download of the file 404s. The API description says so; nothing else does.
 *
 * `ttl` is left at `0` (permanent) because a runtime artefact has to outlive its release's
 * retention: the maximum is 180 days, so anything else would silently delete the fast path.
 *
 * The public repository is deliberate: the node holds no CNB credential, and an anonymous
 * `GET` of a public asset answers 302 with Range/206 support.
 */
async function publishToCnb() {
  const token = process.env.CNB_TOKEN
  if (typeof token !== 'string' || token === '') {
    throw new Error('--cnb needs CNB_TOKEN in the environment; it is never written to disk')
  }
  const base = `https://api.cnb.cool/${cnbRepository}`
  const auth = { authorization: `Bearer ${token}`, accept: 'application/json' }
  const json = { ...auth, 'content-type': 'application/json' }

  const created = await fetch(`${base}/-/releases`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      tag_name: releaseTag,
      name: `DSH ${version} node runtime`,
      body: notes,
      prerelease: version.includes('-'),
      target_commitish: 'main',
    }),
  })
  if (!created.ok && created.status !== 409) {
    throw new Error(`CNB release ${releaseTag}: ${created.status} ${(await created.text()).slice(0, 300)}`)
  }
  const release = await fetch(`${base}/-/releases/tags/${encodeURIComponent(releaseTag)}`, { headers: auth })
  if (!release.ok) throw new Error(`CNB release ${releaseTag} is not readable: ${release.status}`)
  const { id } = await release.json()

  for (const file of [`${archive}`, `${archive}.sha256`]) {
    const bytes = readFileSync(file)
    const granted = await fetch(`${base}/-/releases/${id}/asset-upload-url`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ asset_name: basename(file), overwrite: true, size: bytes.length, ttl: 0 }),
    })
    if (!granted.ok) throw new Error(`CNB upload URL for ${file}: ${granted.status} ${(await granted.text()).slice(0, 300)}`)
    const { upload_url: uploadUrl, verify_url: verifyUrl } = await granted.json()
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
      body: bytes,
    })
    if (!put.ok) throw new Error(`CNB upload of ${file}: ${put.status} ${(await put.text()).slice(0, 300)}`)
    const confirmed = await fetch(verifyUrl, { method: 'POST', headers: auth })
    if (!confirmed.ok) {
      throw new Error(`CNB confirmation of ${file}: ${confirmed.status} ${(await confirmed.text()).slice(0, 300)}`)
    }
    process.stdout.write(`  uploaded and confirmed ${basename(file)} on CNB\n`)
  }

  // The asset list carries the hash CNB computed, so the published bytes are checked rather
  // than assumed — the same reasoning as the `.sha256` sidecar for the node's own download.
  const settled = await (await fetch(`${base}/-/releases/tags/${encodeURIComponent(releaseTag)}`, { headers: auth })).json()
  const asset = (settled.assets ?? []).find(item => item.name === name)
  if (asset === undefined) throw new Error(`CNB accepted the upload but ${name} is not in the release`)
  if (asset.hash_value !== sha256) {
    throw new Error(`CNB reports sha256 ${asset.hash_value} for ${name}, the archive is ${sha256}`)
  }
  // The body is one per release and is written when the *first* archive is published, so a
  // second platform has to rewrite it or the release keeps describing one platform (and the
  // old hash of an archive that has since been replaced). Measured on rc.5: the body still
  // named linux-x64 and a sha256 nothing in the release had any more.
  const patched = await fetch(`${base}/-/releases/${id}`, {
    method: 'PATCH',
    headers: json,
    body: JSON.stringify({ body: notes }),
  })
  if (!patched.ok) {
    process.stdout.write(`  could not update the release body: ${patched.status}\n`)
  }
  process.stdout.write(
    `published ${name} to CNB ${releaseTag}\n`
    + `  ${asset.browser_download_url}\n`,
  )
}

if (shouldPublishCnb) await publishToCnb()

if (!shouldPublish) {
  process.stdout.write('\nNot uploaded to GitHub. Add --publish to do that too.\n')
  process.exit(0)
}

const made = spawnSync('gh', [
  'release', 'create', releaseTag,
  '--title', `DSH ${version} node runtime`,
  '--notes', notes,
], { stdio: 'inherit' })
// A pre-existing release is the normal case after publishing a second platform; a
// failed *upload* is the one that must stop this script.
if (made.status !== 0) {
  process.stdout.write(`release ${releaseTag} already exists; uploading into it\n`)
  // `gh release create` failing means "the tag is there", and its notes are then whatever the
  // first platform wrote. Rewriting them is what keeps the body describing the archives the
  // release actually has — the same reason the CNB path patches its body.
  spawnSync('gh', ['release', 'edit', releaseTag, '--notes', notes], { stdio: 'inherit' })
}
const uploaded = spawnSync('gh', [
  'release', 'upload', releaseTag, archive, `${archive}.sha256`, '--clobber',
], { stdio: 'inherit' })
if (uploaded.status !== 0) throw new Error('the release upload failed')
process.stdout.write(`published ${name} to ${releaseTag}\n`)
