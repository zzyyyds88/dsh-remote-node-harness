/**
 * The fork-runtime build: which packages a brain tree keeps, and what it refuses to
 * hand to npm.
 *
 * Two rules from that script decide whether a node can boot at all, and both were
 * measured rather than guessed, so both get an assertion:
 *
 * 1. **`@deepseek-ai/dsh-web-app` is retained even though the brain never loads it.**
 *    Upstream resolves a profile's dependency closure through the installation's
 *    manifests. Dropping that one manifest made the loader fail on fifteen kept rows
 *    with `ERR_MODULE_NOT_FOUND` — the rows themselves never import the package.
 * 2. **Foreign-platform packages are filtered before npm sees them.** `--os`/`--cpu`
 *    choose what to resolve *for*; they do not exempt a direct `file:` dependency
 *    from its own `os` field, so a darwin-only tarball in the staging manifest fails
 *    the whole install with `EBADPLATFORM`.
 *
 * The rest of the trim is a removal list, and its risk is the opposite one: removing
 * something a kept row imports. That cannot be checked from the script alone — it is
 * checked by booting the built tree, which `docs/ARCHITECTURE.md` records as the
 * acceptance evidence for this path.
 *
 * Run: `node test/fork-runtime-unit.mjs`
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ARTEFACT_RESIDUE,
  ARTEFACT_RESIDUE_KEEP,
  DROP_RULES,
  RETAINED,
  dropPackages,
  foreignPlatformResidue,
  stripResidue,
} from '../scripts/trim-fork-runtime.mjs'
import { PUBLISHED_PLATFORMS, isPublishedPlatform } from '../src/remote/artefact.js'

const log = message => process.stdout.write(`[fork-runtime-unit] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/** One package directory with a manifest, so the trim has something to weigh. */
function packageIn(root, name) {
  const dir = join(root, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }), 'utf8')
  writeFileSync(join(dir, 'index.js'), 'export {}\n', 'utf8')
  return dir
}

// ---- what the trim must keep, and why ---------------------------------------
{
  // The one entry that looks like a mistake and is not: without this manifest the
  // brain's own kept rows cannot resolve their dependencies.
  check(RETAINED.includes('@deepseek-ai/dsh-web-app'), 'the web-app manifest is retained')
  check(RETAINED.includes('@deepseek-ai/dsh-office-kit'), 'the office host row keeps its kit')
  // A retained name must not also match a drop rule, or the two lists contradict
  // each other and the result depends on which one the loop reaches first.
  const contradictions = RETAINED.filter(name => DROP_RULES.some(([pattern]) => pattern.test(name.slice('@deepseek-ai/'.length))))
  check(contradictions.length === 0, 'no retained package matches a drop rule', contradictions.join(', '))
  // Every rule states why; a rule without a reason is a guess with a regex.
  check(DROP_RULES.every(([, reason]) => typeof reason === 'string' && reason.length > 10),
    'every drop rule states its reason')
}

// ---- the trim itself --------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'fork-trim-'))
  try {
    packageIn(root, '@deepseek-ai/dsh')
    packageIn(root, '@deepseek-ai/dsh-web-app')
    packageIn(root, '@deepseek-ai/dsh-office-kit')
    packageIn(root, '@deepseek-ai/dsh-client-ui-chat')
    packageIn(root, '@deepseek-ai/dsh-experimental-inspector')
    packageIn(root, '@deepseek-ai/libreoffice-kit-win32-x64')
    packageIn(root, '@deepseek-ai/dsh-cua-bundle')
    packageIn(root, '@deepseek-ai/dsh-unclassified-new-package')
    writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'index.d.ts'), 'export {}\n', 'utf8')
    writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'index.js.map'), '{}', 'utf8')
    writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'README.md'), '# dsh\n', 'utf8')
    mkdirSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'test'), { recursive: true })
    writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'test', 'a.js'), 'export {}\n', 'utf8')

    const result = dropPackages(root)
    const scope = join(root, 'node_modules', '@deepseek-ai')
    const left = name => {
      try {
        readFileSync(join(scope, name, 'package.json'))
        return true
      } catch {
        return false
      }
    }
    check(left('dsh') && left('dsh-web-app') && left('dsh-office-kit'),
      'a package nothing drops is kept')
    check(left('dsh-unclassified-new-package'),
      'a package with no matching rule is kept rather than guessed at')
    check(!left('dsh-client-ui-chat'), 'the browser surface is dropped')
    check(!left('dsh-experimental-inspector'), 'experimental bundles are dropped')
    check(!left('libreoffice-kit-win32-x64'), 'the Office engine is dropped')
    check(!left('dsh-cua-bundle'), 'computer use is dropped')
    check(result.dropped.length === 4, 'every drop is reported', String(result.dropped.length))

    const stripped = stripResidue(root, ARTEFACT_RESIDUE)
    check(stripped.files === 4, 'declarations, maps, readmes and tests are stripped', String(stripped.files))
    const kept = readFileSync(join(scope, 'dsh', 'index.js'), 'utf8')
    check(kept.includes('export'), 'the runtime file survives the strip')
    // `doc/` must never be a strip rule: `yaml` ships code under `dist/doc/`.
    check(!ARTEFACT_RESIDUE.some(pattern => pattern.test('node_modules/yaml/dist/doc/directives.js')),
      'the strip never matches a package path named doc/')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- native payloads of a platform this artefact cannot run on ---------------
// `node-pty` loads exactly one `prebuilds/<os>-<arch>/` directory — it builds the path by
// concatenating `process.platform` and `process.arch` (`lib/utils.js`). On the build-4 archive
// that meant 23.2 MiB of prebuilds shipped for 0.07 MiB of reachable binary, including a
// Windows ConPTY `.exe`, `.dll` and `.pdb` in a Linux artefact.
{
  const linux = foreignPlatformResidue('linux-x64')
  const hits = path => linux.some(pattern => pattern.test(path))
  check(hits('node_modules/node-pty/prebuilds/win32-x64/'), 'another OS prebuild is stripped')
  check(hits('node_modules/node-pty/prebuilds/win32-arm64/conpty.pdb'), 'including its debug symbols')
  check(hits('node_modules/node-pty/prebuilds/darwin-arm64/'), 'and a same-OS wrong-arch one')
  check(!hits('node_modules/node-pty/prebuilds/linux-x64/'), 'the one directory that loads survives')
  check(hits('node_modules/node-pty/third_party/conpty/1.25.260303002/win10-x64/OpenConsole.exe'),
    'the Windows-only third_party payload is stripped too')
  // npm writes a `.cmd` and a `.ps1` next to every `.bin/` entry. On Linux `sh` runs the
  // extensionless one, so the pair is unreachable — 26 files on the real archive.
  check(hits('node_modules/.bin/dsh.cmd') && hits('node_modules/.bin/dsh.ps1'),
    'the Windows npm shims are stripped')
  check(!hits('node_modules/.bin/dsh'), 'the extensionless bin entry survives')

  // The rule is a function of the platform, not a hard-coded "strip win32": a win32 artefact
  // must keep its own payload and drop the POSIX one.
  const win = foreignPlatformResidue('win32-x64')
  const winHits = path => win.some(pattern => pattern.test(path))
  check(!winHits('node_modules/node-pty/prebuilds/win32-x64/'), 'a win32 artefact keeps win32')
  check(winHits('node_modules/node-pty/prebuilds/linux-x64/'), 'and drops linux')
  check(!winHits('node_modules/node-pty/prebuilds/win32-x64/conpty.pdb'),
    'and keeps its own debug symbols')

  // A darwin artefact is the third case, and the one a hard-coded rule would get wrong.
  const mac = foreignPlatformResidue('darwin-arm64')
  check(!mac.some(pattern => pattern.test('node_modules/node-pty/prebuilds/darwin-arm64/')),
    'a darwin artefact keeps darwin')
}

// ---- the four rules that used to match nothing ------------------------------
// Each of these was measured against the published archive: the old list let 139.8 MiB of
// dead bytes through, and none of it showed up as a failure — it just made every node
// download a third more than it needs.
{
  const root = mkdtempSync(join(tmpdir(), 'fork-residue-'))
  try {
    const dir = packageIn(root, '@deepseek-ai/dsh')
    const write = (path, body) => {
      const full = join(dir, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, body, 'utf8')
    }
    write('lib/index.js', 'export {}\n')
    // Dead: the tree loads lib/*.js, never src/*.ts.
    write('src/index.ts', 'export type A = 1\n')
    write('src/client/Panel.tsx', 'export const Panel = () => null\n')
    // Dead: a declaration in the .cts spelling the old list forgot.
    write('node_modules/zod/index.d.cts', 'declare const z: 1\n')
    write('index.d.ts', 'export {}\n')
    // Dead: a Windows debug symbol inside a Linux artefact.
    write('prebuilds/win32-x64/conpty.pdb', 'MZ\n')
    // Alive: an agent loads these by path.
    write('skills/personalized-pages.md', '# skill\n')
    write('assets/office/SKILL.md', '# skill\n')
    write('references/session-tab.md', '# ref\n')

    // Alive, and not because any code reads it: the `dsh-doc` skill ships in the brain
    // composition and its `locate-docs.md` tells the reader to open
    // `DSH_INSTALL_DIR/docs/user/index.md` and `docs/upgrade-guide/README.md`. A rule that
    // only looks for `import`/`readFile` cannot see a path spelled out in prose — the first
    // version of this list deleted all 481 files and left the skill pointing at nothing.
    for (const path of ['docs/user/index.md', 'docs/upgrade-guide/README.md', 'docs/architecture.md']) {
      write(path, '# doc\n')
    }

    // Dead: documentation of *other* packages, in the spellings the old
    // `/(^|\/)\.md$/` rule could not match. The dsh package's own `docs/` is exempt (above),
    // so these live elsewhere — which is also the shape the real tree has: 481 of the 622
    // markdown files were under `@deepseek-ai/dsh/docs/`, the remaining 141 were not.
    const other = packageIn(root, '@deepseek-ai/dsh-tool-bash')
    const writeOther = (path, body) => {
      const full = join(other, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, body, 'utf8')
    }
    writeOther('docs/guide.md', '# a\n')
    writeOther('HISTORY.md', '# h\n')

    const result = stripResidue(root, ARTEFACT_RESIDUE, ARTEFACT_RESIDUE_KEEP)
    const gone = path => !existsSync(join(dir, path))
    const there = path => existsSync(join(dir, path))
    const goneOther = path => !existsSync(join(other, path))

    check(there('lib/index.js'), 'the compiled entry survives')
    check(gone('src/index.ts'), 'non-declaration .ts sources are stripped')
    check(gone('src/client/Panel.tsx'), 'and .tsx')
    check(gone('index.d.ts'), 'declarations are stripped')
    check(gone('node_modules/zod/index.d.cts'), 'including the .d.cts spelling the old list missed')
    check(gone('prebuilds/win32-x64/conpty.pdb'), 'debug symbols are stripped')
    check(goneOther('docs/guide.md') && goneOther('HISTORY.md'),
      'another package\'s documentation is stripped even when its name is not exactly ".md"')
    check(there('skills/personalized-pages.md'), 'a skill an agent reads survives')
    check(there('assets/office/SKILL.md'), 'a packaged SKILL.md survives')
    check(there('references/session-tab.md'), 'a references/ page survives')
    check(there('docs/user/index.md') && there('docs/upgrade-guide/README.md')
      && there('docs/architecture.md'),
      'the install docs the dsh-doc skill names in prose survive — no code reads them, an agent does')
    check(result.files === 7, 'the strip reports every file it removed', String(result.files))

    // The rescue must apply to markdown only. It is an exception to one rule, not a blanket
    // exemption: consulting it for every path let `skills/` rescue
    // `openai/src/resources/skills/*.ts`, thirteen TypeScript sources that shipped because
    // their directory happened to be called `skills`.
    write('skills/nested/deep/extra.md', '# more\n')
    write('skills/impl/reader.ts', 'export const read = () => 1\n')
    stripResidue(root, ARTEFACT_RESIDUE, ARTEFACT_RESIDUE_KEEP)
    check(there('skills/nested/deep/extra.md'),
      'markdown nested under a rescued directory survives')
    check(gone('skills/impl/reader.ts'),
      'but a .ts under a directory called skills/ is still stripped — the rescue is about markdown')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- the archive contract ---------------------------------------------------
{
  // `tar` is spawned, not imported, and the argv shape is load-bearing on Windows. Measured on
  // run 44902426318: the `win32-x64` leg of `release-runtime.yml` runs under `shell: bash`, so
  // the `tar` it gets is Git Bash's GNU tar, which reads an absolute `D:\...` path as a *remote
  // host* (`tar: Cannot connect to D: resolve failed`) and `D:/...` as a file named `D:...`.
  // bsdtar in System32 accepts both, which is why the same script packs fine from PowerShell and
  // fails only in CI. The portable form is a relative `-C` with `cwd` at the output directory,
  // verified against both binaries.
  const relativeTar = /\['-czf', basename\((?:target|archive)\), '-C', [^\]]*\]/u
  const cwdTar = /cwd: outDir/u
  const publishTar = readFileSync(new URL('../scripts/publish-runtime.mjs', import.meta.url), 'utf8')
  check(relativeTar.test(publishTar) && cwdTar.test(publishTar),
    'publish-runtime packs with a relative -C and cwd, so it survives GNU tar as well as bsdtar')
  check(!/spawnSync\('tar', \['-czf', (?:archive|target), '-C'/u.test(publishTar),
    'and no longer puts an absolute path in the tar argv')
  // The residue list has one home. Two copies would drift into two artefact
  // contents at one version, which is what `RUNTIME_BUILD` exists to catch — and it already
  // happened once: `publish-runtime` had its own `strip()` walker, so a rule added to the
  // shared list would have applied to the fork build only.
  const publish = readFileSync(new URL('../scripts/publish-runtime.mjs', import.meta.url), 'utf8')
  check(/import \{[^}]*ARTEFACT_RESIDUE[^}]*\} from '\.\/trim-fork-runtime\.mjs'/u.test(publish),
    'publish-runtime imports the shared residue list')
  check(/stripResidue\(dir, \[\.\.\.STRIPPED, \.\.\.foreignPlatformResidue\(platform\)\], ARTEFACT_RESIDUE_KEEP\)/u.test(publish),
    'and deletes through the shared walker, so the keep list and the platform rules apply to both routes')
  check(!/const STRIPPED = Object\.freeze/u.test(publish),
    'and keeps no second copy of it')
  const build = readFileSync(new URL('../scripts/build-fork-runtime.mjs', import.meta.url), 'utf8')
  check(/stripResidue\(staging, \[\.\.\.ARTEFACT_RESIDUE, \.\.\.foreignPlatformResidue\(platform\)\], ARTEFACT_RESIDUE_KEEP\)/u.test(build),
    'the fork build strips with the same list, the same keep list, and the same platform rules')
  // Both packers must ask the shared predicate which files are programs. The rule used to be
  // `spawn-helper` + `*.node` in each script independently, and both were wrong the same way:
  // the ripgrep binary and the sandbox launcher were left 0666, so every `glob`/`grep` on a
  // node failed with "ripgrep provider failure". A second copy of the rule is how that happens.
  check(/import \{[^}]*\bisArtefactExecutable\b[^}]*\} from '\.\.\/src\/remote\/artefact\.js'/u.test(publish)
    && /if \(!isArtefactExecutable\(full\)\) continue/u.test(publish),
  'publish-runtime asks the shared executable rule, rather than keeping its own list')
  check(/import \{[^}]*\bisArtefactExecutable\b[^}]*\} from '\.\.\/src\/remote\/artefact\.js'/u.test(build)
    && /if \(!isArtefactExecutable\(full\)\) continue/u.test(build),
  'and the fork build asks the same rule, so the two archives cannot disagree about modes')
  check(!/entry\.name !== 'spawn-helper'/u.test(publish) && !/entry\.name !== 'spawn-helper'/u.test(build),
    'neither packer still carries the old name-only rule')
  check(/--ignore-scripts/u.test(build), 'the fork build resolves without running install scripts')
  check(relativeTar.test(build) && cwdTar.test(build),
    'and the fork build packs the same way, so a Windows CI leg cannot fail on argv shape')
  check(!/spawnSync\('tar', \['-czf', (?:archive|target), '-C'/u.test(build),
    'and it too stopped handing an absolute path to tar')
  check(/overrides/u.test(build),
    'the fork build stages by override, so only the imported closure is installed')
  check(/publish-runtime\.mjs/u.test(build), 'the fork build publishes through the one uploader')
  // One uploader means one source list: a fork archive must reach a node through
  // `DEFAULT_SOURCES`, or the node would need a second, undocumented route.
  check(!/DEFAULT_SOURCES|cnb\.cool/u.test(build),
    'and does not invent a second download source')
  // The staging manifests name 384 tarballs by absolute path on the packing machine, so
  // shipping them would publish the packer's filesystem layout — and leave a manifest on the
  // node that a later `npm install` there could act on. Measured on the first build-4 archives:
  // they carried `package.json`, `package-lock.json` and `node_modules/.package-lock.json`.
  check(/package-lock\.json/u.test(build) && /rmSync\(join\(staging, scratch\)/u.test(build),
    'the fork build removes its staging manifests before packing')
  // The release body is written once per release and publishing happens one archive at a time,
  // so a body built from "this archive" is wrong as soon as a second platform lands. Measured on
  // rc.5: the body named linux-x64 and a sha256 that no archive in the release had any more.
  check(/function releaseNotes\(/u.test(publish) && /readdirSync\(outDir\)/u.test(publish),
    'the release body is built from every archive in --out, not from the one being uploaded')
  check(/release', 'edit'/u.test(publish), 'and a re-publish rewrites an existing release body')
  check(/method: 'PATCH'/u.test(publish), 'on CNB too, which keeps its own copy of the body')
  // The release body tells a reader where the archive lands on a node. It cannot import the
  // daemon (`ssh2` has no business in a packaging script), so the path is a second spelling of
  // `DEFAULT_REMOTE_ROOT` — exactly the kind of copy that drifts. Measured 2026-11-21: the body
  // said `~/.dsh-rnh`, the plugin writes `~/.dsh-remote-node-harness`.
  const daemon = readFileSync(new URL('../src/remote/daemon.js', import.meta.url), 'utf8')
  const root = /export const DEFAULT_REMOTE_ROOT = '([^']+)'/u.exec(daemon)?.[1]
  check(typeof root === 'string' && root.length > 0, 'the daemon names one default remote root', root)
  check(publish.includes(`\`${String(root)}/runtime\``),
    'and the release body spells that same path, so it cannot point a reader into a directory nothing writes')
}

// ---- only platforms a node can actually ask for get published ----------------
{
  // `win32-x64` used to be published. It packs and boots, but no node can name it: the probe
  // reads `uname -s` (Windows answers `MINGW64_NT-…` or nothing), the node side is 21 `sh -c`
  // calls plus `setsid`, and the only transport is SSH. Publishing it left 85 MiB nothing
  // fetched and a release-body line implying Windows nodes work.
  check(PUBLISHED_PLATFORMS.includes('linux-x64'), 'linux-x64 is a published platform')
  check(!PUBLISHED_PLATFORMS.includes('win32-x64'),
    'win32-x64 is not published: no probe can name it and the node side is POSIX-only')
  check(!isPublishedPlatform('linux-arm64') && !isPublishedPlatform('darwin-arm64'),
    'the other taggable platforms are not published either — they were never built or verified')
  check(isPublishedPlatform('linux-x64'), 'and the one that is, says so')
  // The gate has to live in the uploader both entry points share, or CI could still upload it.
  const publish = readFileSync(new URL('../scripts/publish-runtime.mjs', import.meta.url), 'utf8')
  check(/isPublishedPlatform\(platform\)/u.test(publish),
    'publish-runtime refuses a platform outside PUBLISHED_PLATFORMS')
  check(/PUBLISHED_PLATFORMS/u.test(publish),
    'and names the allowed set in the refusal, so the reader is not left guessing')
  // The listing side has to be filtered too, or a stale archive left in `--out` from a
  // withdrawn platform reappears in the release body with a live-looking sha256 that 404s.
  check(/if \(!isPublishedPlatform\(match\[2\]\)\) continue/u.test(publish),
    'the release body skips an archive whose platform is no longer published')
  // And the uploader must refuse a tree it packed itself: `pack()` resolves the upstream
  // release with no fork, so it has none of `dropPackages`. A comment in the CI workflow
  // warned about this for months; only a branch can stop it.
  check(/function assertPublishable\(/u.test(publish) && /assertPublishable\(\)/u.test(publish),
    'publish-runtime refuses to upload an archive it packed itself, not just a wrong platform')
  check(/if \(cnbOnly \|\| allowUpstreamPublish\) return/u.test(publish),
    'the only way past that gate is an archive somebody else built (--cnb-only)')
}

if (failures.length > 0) {
  log(`${failures.length} failed: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all assertions passed')
}
