/**
 * The fork-runtime build: which packages a brain tree keeps, and what it refuses to
 * hand to npm.
 *
 * Three rules from that script decide whether a node can boot at all, and all three
 * were measured rather than guessed, so all three get an assertion:
 *
 * 1. **`@deepseek-ai/dsh-web-app` is retained even though the brain never loads it.**
 *    Upstream resolves a profile's dependency closure through the installation's
 *    manifests. Dropping that one manifest made the loader fail on fifteen kept rows
 *    with `ERR_MODULE_NOT_FOUND` — the rows themselves never import the package.
 * 2. **Foreign-platform packages are filtered before npm sees them.** `--os`/`--cpu`
 *    choose what to resolve *for*; they do not exempt a direct `file:` dependency
 *    from its own `os` field, so a darwin-only tarball in the staging manifest fails
 *    the whole install with `EBADPLATFORM`.
 * 3. **Nothing a retained package depends on is dropped.** This is the gate that did
 *    not exist, and the failure it missed shipped for a year: the Office host row was
 *    retained, its hard dependency `@deepseek-ai/libreoffice-kit` was dropped by a
 *    prefix rule, and the node advertised `office_*` tools whose every call threw. The
 *    old assertion compared `RETAINED` against `DROP_RULES` *by name*; the real failure
 *    is a relation between manifests, which is why the fixture below writes them.
 *
 * Booting a built tree is still the only evidence that the whole composition loads; it
 * belongs to the build acceptance, not here. What this file can prove is that the
 * *rules* cannot contradict each other, and that the staged tree resolves what the kept
 * composition names.
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
  keepClosure,
  stripResidue,
  unresolvedInTree,
} from '../scripts/trim-fork-runtime.mjs'
import { PUBLISHED_PLATFORMS, isPublishedPlatform } from '../src/remote/artefact.js'

const log = message => process.stdout.write(`[fork-runtime-unit] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/**
 * One package directory with a manifest, so the trim has something to weigh.
 *
 * `dependencies` is the third argument because the bug this suite exists to catch is a
 * *relation between manifests*, and a fixture that writes only `{name, version}` erases
 * that relation before any assertion can look at it. Writing the real edge
 * (`dsh-office-kit` → `libreoffice-kit`) is what turns "retained ∪ dropped" into
 * something checkable.
 * @param {string} root
 * @param {string} name full package name, scope included.
 * @param {Record<string, string>} [dependencies] runtime `dependencies` of this package.
 * @param {Record<string, Record<string, string>>} [optionalFields] extra manifest fields,
 *   e.g. `{ optionalDependencies: { '…-win32-x64': '0.2.3' } }`.
 */
function packageIn(root, name, dependencies = {}, optionalFields = {}) {
  const dir = join(root, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '0.0.0',
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    ...optionalFields,
  }), 'utf8')
  writeFileSync(join(dir, 'index.js'), 'export {}\n', 'utf8')
  return dir
}

/** Read the manifest the closure walk sees: by full name, `undefined` when absent. */
function manifestsUnder(root) {
  return name => {
    try {
      return JSON.parse(readFileSync(join(root, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
    } catch {
      return undefined
    }
  }
}

/** The bare directory name `dropPackages` feeds to `DROP_RULES`. */
const bareName = name => name.slice(name.lastIndexOf('/') + 1)

/** The rules a full package name collides with, matching exactly as `dropPackages` does. */
const collidingRules = name => DROP_RULES.filter(([pattern]) => pattern.test(bareName(name)))

// ---- what the trim must keep, and why ---------------------------------------
{
  // The one entry that looks like a mistake and is not: without this manifest the
  // brain's own kept rows cannot resolve their dependencies.
  check(RETAINED.includes('@deepseek-ai/dsh-web-app'), 'the web-app manifest is retained')
  check(RETAINED.includes('@deepseek-ai/dsh-office-kit'), 'the office host row keeps its kit')
  check(RETAINED.includes('@deepseek-ai/libreoffice-kit'),
    'the driver the office rows resolve at call time is retained, not just its caller')
  check(RETAINED.includes('@deepseek-ai/libreoffice-kit-wasm'),
    'and so is the portable engine that driver loads on this platform')
  // The old assertion, kept because the relation it tests is still real — but labelled
  // for what it is: a same-name cross-check between two lists over *different key
  // spaces*. It cannot say anything about Office, and for a year it read as if it did:
  // `dsh-office-kit` never matched a rule, while the package it depends on was dropped.
  const contradictions = RETAINED.filter(name => collidingRules(name).length > 0)
  check(contradictions.length === 0, 'no retained name itself matches a drop rule', contradictions.join(', '))
  // Every rule states why; a rule without a reason is a guess with a regex.
  check(DROP_RULES.every(([, reason]) => typeof reason === 'string' && reason.length > 10),
    'every drop rule states its reason')
}

// ---- the dependency closure a kept package cannot lose ----------------------
// This is the gate the same-name check could never be. The shipped failure was not
// "a retained name matched a rule"; it was "a package a retained package *depends on*
// matched a rule", and no assertion looked along that edge. The fixture writes the real
// manifests of the Office chain — including the real `optionalDependencies`, because
// which field an edge lives in is the whole question.
{
  const root = mkdtempSync(join(tmpdir(), 'fork-closure-'))
  try {
    packageIn(root, '@deepseek-ai/dsh-web-app')
    // The metapackage's real manifest also declares `dsh-client-ui-*`, which DROP_RULES
    // removes on purpose: upstream resolves its closure by walking manifests and skips a
    // declared-but-absent package (recorded as the known gap in `docs/refactor-node-side`).
    // Modelling those edges here would make this gate red forever over a documented
    // decision, so the fixture writes only the edges this gate is about — rooted at the
    // Office capability, where "declared, absent, skipped" is *not* acceptable.
    packageIn(root, '@deepseek-ai/dsh-office-kit', { '@deepseek-ai/libreoffice-kit': '0.2.3' }, {
      // devDependencies are *not* installed into a production tree, so following them
      // would drag test tooling into the keep set and hide a real gap behind noise.
      devDependencies: { '@deepseek-ai/dsh-office-kit-dev-only': '0.2.3' },
      // A peer is a composition-supplied declaration: its name is collected because it
      // is a real declaration worth checking against the drop list, but its own subtree
      // is not this package's to walk.
      peerDependencies: { '@deepseek-ai/cordis': '~4.1.0' },
    })
    packageIn(root, '@deepseek-ai/dsh-office-kit-dev-only')
    packageIn(root, '@deepseek-ai/dsh-skill-office')
    packageIn(root, '@deepseek-ai/dsh-tool-office')
    packageIn(root, '@deepseek-ai/libreoffice-kit', { fflate: '0.8.2', fontkit: '2.0.4', saxes: '6.0.0' }, {
      optionalDependencies: {
        koffi: '3.1.1',
        '@deepseek-ai/libreoffice-kit-wasm': '0.2.3',
        '@deepseek-ai/libreoffice-kit-darwin-arm64': '0.2.3',
        '@deepseek-ai/libreoffice-kit-win32-x64': '0.2.3',
      },
    })
    packageIn(root, '@deepseek-ai/libreoffice-kit-wasm')
    packageIn(root, '@deepseek-ai/libreoffice-kit-win32-x64')
    packageIn(root, '@deepseek-ai/dsh-client-ui-chat')
    packageIn(root, 'fflate')
    packageIn(root, 'fontkit')
    packageIn(root, 'saxes')

    const manifestOf = manifestsUnder(root)

    // 1. The walk actually follows the edge the bug travelled along.
    const office = keepClosure(manifestOf, ['@deepseek-ai/dsh-office-kit'])
    check(office.has('@deepseek-ai/libreoffice-kit'),
      'the keep closure of the office kit reaches the engine driver through dependencies',
      [...office].join(', '))
    check(office.has('fflate') && office.has('fontkit') && office.has('saxes'),
      'and continues through the driver\'s own dependencies, so the walk is recursive')

    // Which manifest field an edge lives in is the whole question, so each one is pinned:
    // `dependencies` is walked, `devDependencies` is ignored (absent from a production
    // tree), `peerDependencies` contributes its name but not its subtree.
    packageIn(root, '@deepseek-ai/cordis', { 'cordis-inner': '1.0.0' })
    packageIn(root, 'cordis-inner')
    const walked = keepClosure(manifestOf, ['@deepseek-ai/dsh-office-kit'])
    check(walked.has('@deepseek-ai/cordis'),
      'a peer dependency\'s name enters the keep set, because it is a real declaration to check')
    check(!walked.has('cordis-inner'),
      'but the peer is not walked — its closure belongs to the composition, not to this package')
    check(!walked.has('@deepseek-ai/dsh-office-kit-dev-only'),
      'devDependencies are not followed: a production tree does not install them')

    // 2. The gate: nothing the kept composition needs may be dropped. Red under
    //    `^libreoffice-kit` (driver and engine both matched), green under the narrowed
    //    rule. This is the assertion whose absence shipped an uncallable Office toolset.
    const keep = keepClosure(manifestOf)
    const forbidden = [...keep].filter(name => collidingRules(name).length > 0)
    check(forbidden.length === 0,
      'no package in the keep closure matches a drop rule',
      forbidden.map(name => `${name} (${collidingRules(name).map(([, reason]) => reason).join('; ')})`).join(', '))

    // 3. Optional dependencies are not followed. That is not an oversight: it is what
    //    lets a Linux node drop the win32 payload of the same driver. `optional` means
    //    "the install is correct without it", so treating it as required would keep
    //    189.7 MiB of unexecutable bytes; treating it as an absence it cannot tolerate
    //    would make the gate red for a package that is *supposed* to be gone.
    check(!keep.has('@deepseek-ai/libreoffice-kit-win32-x64'),
      'a foreign-platform engine declared as optionalDependencies is not in the keep closure')
    check(!keep.has('@deepseek-ai/libreoffice-kit-darwin-arm64'),
      'and neither is another platform\'s')
    const driverOnly = keepClosure(manifestOf, ['@deepseek-ai/libreoffice-kit'])
    check(!driverOnly.has('@deepseek-ai/libreoffice-kit-wasm'),
      'the WASM engine is kept because RETAINED names it as this platform\'s engine, not because it is optional')
    check(keep.has('@deepseek-ai/libreoffice-kit-wasm'),
      'yet it is in the kept set all the same — the driver is useless without it on Linux')

    // 4. A dependency with no manifest is kept by name and not walked: silently treating
    //    it as a leaf would hide a broken install inside the keep set. `unresolvedInTree`
    //    is the probe that reports it; this only pins the closure's half of the contract.
    const partial = keepClosure(manifestOf, ['@deepseek-ai/dsh-office-kit', 'not-installed-pkg'])
    check(partial.has('not-installed-pkg'), 'a root with no manifest is still a kept name')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- the probe: does the staged tree resolve what the composition keeps? -----
// The keep set and the drop rules can agree perfectly and still ship an archive that
// cannot boot, because the rules only see what is *present*. The probe asks about the
// tree being packed, not about this checkout.
{
  const root = mkdtempSync(join(tmpdir(), 'fork-unresolved-'))
  try {
    packageIn(root, '@deepseek-ai/libreoffice-kit')
    packageIn(root, 'fflate')
    check(unresolvedInTree(root, ['@deepseek-ai/libreoffice-kit', 'fflate']).missing.length === 0,
      'a present package — scoped and unscoped — is reported resolvable')
    const missing = unresolvedInTree(root, ['@deepseek-ai/libreoffice-kit-win32-x64', 'koffi'])
    check(missing.missing.length === 2 &&
      missing.missing.includes('@deepseek-ai/libreoffice-kit-win32-x64') &&
      missing.missing.includes('koffi'),
    'absent packages are reported by name', missing.missing.join(', '))
    // The name is kept as two path segments: a lookup that dropped the scope would look
    // for `libreoffice-kit/package.json` and wrongly report the scoped package missing.
    check(!missing.missing.includes('@deepseek-ai/libreoffice-kit'),
      'and a scoped package is not mistaken for an unscoped one')

    // The walk must not climb above `root`. The fork build stages at
    // `<fork>/stage/<platform>`, directly under a checkout that has its own
    // `node_modules` — a Node-literal climb would "resolve" packages that are not in the
    // archive, which is the false green this probe exists to prevent. This fixture puts a
    // package one level above `root` and asserts it is still reported missing.
    const outer = mkdtempSync(join(tmpdir(), 'fork-unresolved-outer-'))
    try {
      packageIn(outer, 'left-behind')
      mkdirSync(join(outer, 'stage', 'linux-x64'), { recursive: true })
      const staged = join(outer, 'stage', 'linux-x64')
      check(unresolvedInTree(staged, ['left-behind']).missing.includes('left-behind'),
        'a package that exists only above the tree root is still reported missing — the walk is sealed at root')
    } finally {
      rmSync(outer, { recursive: true, force: true })
    }

    // The exact shape of the shipped bug: remove the driver from a tree that keeps
    // dsh-office-kit, and the probe names it instead of letting the archive ship.
    rmSync(join(root, 'node_modules', '@deepseek-ai', 'libreoffice-kit'), { recursive: true, force: true })
    const broken = unresolvedInTree(root, ['@deepseek-ai/libreoffice-kit'])
    check(broken.missing.includes('@deepseek-ai/libreoffice-kit'),
      'a driver deleted out of the tree is exactly what the probe reports')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- the trim itself --------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'fork-trim-'))
  try {
    packageIn(root, '@deepseek-ai/dsh')
    packageIn(root, '@deepseek-ai/dsh-web-app')
    packageIn(root, '@deepseek-ai/dsh-office-kit', { '@deepseek-ai/libreoffice-kit': '0.2.3' })
    packageIn(root, '@deepseek-ai/dsh-client-ui-chat')
    packageIn(root, '@deepseek-ai/dsh-experimental-inspector')
    packageIn(root, '@deepseek-ai/libreoffice-kit-win32-x64')
    // The driver and the WASM engine are the two packages the old rule took with the
    // native payloads, and the two the node actually resolves on Linux: the trim must
    // leave them standing while removing the platform payloads it cannot execute.
    packageIn(root, '@deepseek-ai/libreoffice-kit')
    packageIn(root, '@deepseek-ai/libreoffice-kit-wasm')
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
    // Both halves of the Office answer have to be pinned here, in one assertion pair:
    // the drop rule that used to be `^libreoffice-kit` took the driver and the WASM
    // engine too, so "the engine is dropped" was true and the capability was dead.
    check(!left('libreoffice-kit-win32-x64'),
      'the win32 Office engine is dropped — a Linux artefact cannot execute it')
    check(left('libreoffice-kit') && left('libreoffice-kit-wasm'),
      'the driver and the portable WASM engine survive, so the kept office rows can resolve them')
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
  // **The rules cannot check their own output.** `DROP_RULES` match a name and residue rules
  // match a path; neither knows whether the composition the node loads still resolves what it
  // names. That is how a build shipped `dsh-office-kit` without `@deepseek-ai/libreoffice-kit`:
  // the gate said "in step" and every Office call threw on the node. So the build asks the
  // staged tree, before packing, whether every `RETAINED` package survived the trim.
  check(/import \{[^}]*\bunresolvedInTree\b[^}]*\} from '\.\/trim-fork-runtime\.mjs'/u.test(build),
    'the fork build imports the tree-resolution probe, rather than trusting the drop rules')
  check(/unresolvedInTree\(staging, kept\)/u.test(build) && /RETAINED/u.test(build),
    'and probes the staged tree for every package RETAINED keeps — the tree being packed, not this checkout')
  check(/unresolved\.length > 0/u.test(build) && /throw new Error/u.test(build),
    'a kept package the trim removed fails the build instead of being published')
  // Ordering is the point: a probe that runs after `archive()` would leave a broken archive in
  // `--out` for the uploader (or a human) to ship anyway.
  const probeAt = build.indexOf('unresolvedInTree(staging, kept)')
  const packAt = build.indexOf('const built = archive(staging, version)')
  check(probeAt > 0 && packAt > probeAt,
    'and it runs before the archive is written', `${String(probeAt)} < ${String(packAt)}`)
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
