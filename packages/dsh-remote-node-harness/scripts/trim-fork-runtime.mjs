/**
 * Drop the parts of a forked DSH runtime a node never loads.
 *
 * The node is a **brain**: it composes `@deepseek-ai/dsh-base` plus
 * `@local/rnh-brain` and serves the Remote API. It renders nothing, so the
 * browser surface and every package that exists only to draw a window are dead
 * weight — and the node pays for them in download time and disk on every machine.
 *
 * Measured on the rc.5 tree, before → after (unpacked):
 *
 * | | before | after |
 * |---|---|---|
 * | whole tree | 2014.6 MiB | 1185.8 MiB (old rules) / ~1335.5 MiB (now, derived) |
 * | `dsh-client-ui-*` | 78.8 MiB / 65 packages | 0 |
 * | `dsh-web-frontend` | 20.1 MiB | 0 |
 * | `libreoffice-kit-win32-*` / `-darwin-*` | 189.7 MiB (win32-x64, unpacked) | 0 |
 * | `libreoffice-kit` (driver) + `libreoffice-kit-wasm` | 149.7 MiB (4.4 + 145.3) | 149.7 MiB (kept) |
 * | `dsh-experimental-*` | 111.3 MiB / 41 packages | 0 |
 *
 * ## The Office engine, and the closure bug this trim shipped
 *
 * The first version of {@link DROP_RULES} dropped `^libreoffice-kit` — the whole family,
 * 339.5 MiB. That did remove the native engines, but it also took the two packages a
 * Linux node needs: the driver (`@deepseek-ai/libreoffice-kit`, 4.4 MiB unpacked) and the
 * portable WASM engine it selects on Linux (`@deepseek-ai/libreoffice-kit-wasm`,
 * 145.3 MiB). `dsh-office-kit` itself stayed, because a kept row imports it — so the node
 * advertised `office_render` / `office_convert` / `office_recalculate` while every call
 * failed at `import.meta.resolve('@deepseek-ai/libreoffice-kit')`.
 *
 * The rule now drops only native engines for platforms this artefact does not target, and
 * keeps the driver plus the WASM engine. The tree is therefore 149.7 MiB heavier than the
 * old `after` column (1185.8 → 1335.5 MiB); that is the price of the Office capability,
 * decided deliberately rather than a regression. The `before` column and the per-package
 * figures were measured on the rc.5 staging tree; **1335.5 MiB has not been re-measured
 * end to end** — only the arithmetic from those package sizes. The build acceptance owns
 * that measurement; this module owns the rules.
 *
 * ## `@deepseek-ai/dsh-web-app` stays, and that is not an oversight
 *
 * Upstream resolves a profile bundle's dependency closure by walking the
 * manifests of the installation's own dependency tree (`collectInstallationScopePackages`
 * in `dsh-app-boot`). The brain's patch keeps the Web host-plane rows, and those
 * rows name packages (`dsh-client-ui-*` among them) that only the `web-app`
 * manifest declares. Removing that manifest made the loader fail on fifteen rows
 * with `ERR_MODULE_NOT_FOUND`, even though the rows the brain keeps never import
 * them. Keeping one 0.2 MiB manifest is what lets the trimmed tree boot.
 *
 * ## What may be dropped, and the one rule behind it
 *
 * Nothing a kept row *imports* may go. Everything else is fair game, so the two
 * lists below are read together:
 *
 * - {@link RETAINED} names what must survive because a kept row loads it.
 * - {@link DROP_RULES} names what goes, each with the reason it cannot be reached.
 *
 * A package that is in neither list stays: this module removes what it can prove
 * is unreachable, never what it merely suspects.
 *
 * ## Why this is not `STRIPPED` in `publish-runtime.mjs`
 *
 * They answer different questions. `STRIPPED` removes *files* from any runtime,
 * upstream or fork, and is part of the published artefact's contract
 * (`RUNTIME_BUILD`). These rules remove *packages*, which only makes sense for a
 * tree this project compiled itself — an upstream install has to keep them
 * because upstream's own bundles may name them.
 *
 * @module @greatbaby/dsh-remote-node-harness/scripts/trim-fork-runtime
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { keptPackages } from '../../rnh-brain/capabilities.mjs'

/**
 * Build residue no runtime reads: type declarations, TypeScript sources, source maps,
 * debug symbols and package documentation. Kept here rather than in `publish-runtime.mjs`
 * so the fork build and the upstream artefact build strip exactly the same files — they
 * produce archives a node consumes identically, and a divergence between them would be a
 * difference in the artefact's contents at one version.
 *
 * **Every entry here was measured against the published archive, not guessed.** The first
 * version of this list had three rules that matched nothing at all:
 *
 * - `/(^|\/)\.md$/` matches a file whose *name* is exactly `.md`. `guide.md`, `HISTORY.md`
 *   and 600 other real documents all survived it — 5.3 MiB that shipped for no reason.
 *   Markdown is now matched by extension and rescued by {@link ARTEFACT_RESIDUE_KEEP}.
 * - `.d.cts` was missing while `.d.ts` and `.d.mts` were present, so zod's 7 110 declaration
 *   files (22.7 MiB) went out with every node.
 * - `.ts` sources were never covered. The tree loads `lib/*.js`; 9 534 `src/*.ts` files
 *   (91.9 MiB) were dead weight. Deleting them is safe because **no manifest on a Node
 *   resolution path names a `.ts` file** — checked across 1 207 manifests, looking only at
 *   `main`, `bin` and the `import`/`require`/`default`/`node` conditions of `exports`; the
 *   `types` and custom conditions (zod's `@zod/source`) that do point at `.ts` are read by a
 *   bundler or a type checker, never by `import`. No runtime file imports a `.ts` specifier
 *   and none reads one as data either.
 *
 * `doc/` as a *directory* is still deliberately absent: `yaml` ships
 * `dist/doc/directives.js`, which is code, and a path cannot tell the two apart (measured —
 * a `docs?/` rule removed it and every node installed from that artefact failed with
 * `MODULE_NOT_FOUND`). Markdown *files* are a different question and are safe.
 * @type {ReadonlyArray<RegExp>}
 */
export const ARTEFACT_RESIDUE = Object.freeze([
  /\.d\.ts$/u,
  /\.d\.cts$/u,
  /\.d\.mts$/u,
  /\.map$/u,
  // A `.ts`/`.tsx` that is not a declaration. The lookbehind keeps `x.d.ts` out; `.d.cts`
  // and `.d.mts` cannot match `\.ts$` at all because they end in `cts`/`mts`.
  /(?<!\.d)\.ts$/u,
  /\.tsx$/u,
  // Windows debug symbols inside a Linux artefact.
  /\.pdb$/u,
  /(^|\/)README(\.[^/]*)?$/iu,
  /(^|\/)CHANGELOG(\.[^/]*)?$/iu,
  /(^|\/)\.github\//u,
  /(^|\/)(test|tests|__tests__)\//u,
  /\.md$/iu,
])

/**
 * Markdown an agent loads at runtime, which the `.md` rule above must not touch.
 *
 * Found by searching every `.js`/`.cjs`/`.mjs` in the tree for `readFile…new URL(…'.md')`
 * and for `SKILL.md` path joins. Exactly these shapes came back:
 *
 * - `dsh-skill-filesystem` joins `entry.path` with `SKILL.md`, and the packaged Office
 *   skills are `assets/<skill>/SKILL.md`;
 * - `dsh-creation-recommendations` reads `skills/personalized-pages.md` and its
 *   `references/*.md` page specs;
 * - `dsh-plugin-recommendations` reads `skills/official-plugins.md`;
 * - `dsh-skill-badge` reads `assets/dsh-badge.md`;
 * - `dsh-agent-preset` ships the `dsh-doc` skill: `skills/dsh-doc/{SKILL.md,references/*,
 *   templates/**}` — the templates are scaffolding an agent copies into a new plugin.
 *
 * `@deepseek-ai/dsh/docs/` is the sixth, and it is the one that made the first version of
 * this list wrong. **No code reads it** — an agent does: the `dsh-doc` skill's own
 * `references/locate-docs.md` tells the reader to open `DSH_INSTALL_DIR/docs/user/index.md`
 * and `docs/upgrade-guide/README.md`, and the skill ships in the brain composition
 * (`skill-filesystem` with `customSkillDirs` pointing at `@deepseek-ai/dsh-agent-preset`).
 * A strip rule that only looks for `import`/`readFile` cannot see a path spelled out in
 * prose, so this one is kept because a *capability the node keeps* names it. Measured:
 * 481 files, 4.66 MiB — the price of not shipping a skill that points at nothing.
 * @type {ReadonlyArray<RegExp>}
 */
export const ARTEFACT_RESIDUE_KEEP = Object.freeze([
  /(^|\/)SKILL\.md$/u,
  /(^|\/)skills\//u,
  /(^|\/)assets\//u,
  /(^|\/)references\//u,
  /(^|\/)templates\//u,
  /(^|\/)@deepseek-ai\/dsh\/docs\//u,
])

/**
 * Native binaries for a platform this artefact will never run on.
 *
 * `node-pty` picks its binary by string concatenation — `prebuilds/${process.platform}-${process.arch}`
 * (`lib/utils.js`) — so exactly one of its six prebuild directories can ever be loaded. The
 * Windows ones carry `conpty` (an `.exe`, a `.dll` and `.pdb` debug symbols) that a Linux node
 * cannot execute; measured on the build-4 archive, 23.2 MiB of `prebuilds/` of which 0.07 MiB
 * was the one directory that loads.
 *
 * This is a function rather than an entry in {@link ARTEFACT_RESIDUE} because the answer depends
 * on the artefact being packed: a darwin archive must keep `darwin-*`, and hard-coding "strip
 * win32" would silently break the day another platform ships. `PUBLISHED_PLATFORMS` is one
 * platform today, so this only ever removes bytes, but the rule stays honest either way.
 * @param {string} platform - `linux-x64`, `darwin-arm64`, …
 * @returns {ReadonlyArray<RegExp>} patterns for every native payload of another platform.
 */
export function foreignPlatformResidue(platform) {
  const patterns = [
    // `prebuilds/<os>-<arch>/` where `<os>-<arch>` is not this artefact's platform. The
    // lookahead is what makes "not this one" expressible without listing the others: the
    // directory must not *continue* as the shipped platform, but must still match the shape.
    new RegExp(`(^|/)prebuilds/(?!${platform}/)[a-z0-9]+-[a-z0-9]+/`, 'u'),
  ]
  if (!platform.startsWith('win32')) {
    // node-pty's Windows ConPTY payload, which it reads only on win32.
    patterns.push(/(^|\/)third_party\/conpty\//u)
    // Executables, debug symbols and shell shims of another OS that survived the directory
    // rules. The `.cmd`/`.ps1` pair is what npm writes next to every `.bin/` entry — 26 files,
    // 15 KiB, referenced by nothing on Linux (`sh` runs the extensionless one).
    patterns.push(/\.(exe|dll|pdb|cmd|ps1)$/u)
  }
  return patterns
}

/**
 * Packages a kept host-plane row imports at runtime, so they survive the trim.
 *
 * **Derived, not listed.** The names come from `packages/rnh-brain/capabilities.mjs`, which is
 * the one place this project says what a node can do: a package survives because an *enabled
 * capability* names it, not because somebody remembered to add it here. The list used to be
 * written out in this file, and that is how the Office row came to be kept while the engine it
 * resolves at call time was deleted — two lists, two files, no cross-check.
 *
 * Two retention lists, two key shapes, and that asymmetry is a known defect rather than a
 * design: this list holds **full names** (`@deepseek-ai/…`) and is compared against full names
 * in {@link dropPackages}, while {@link DROP_RULES} is matched against the **bare directory
 * name**. Reconciling those two key spaces changes what the build drops, which is a separate
 * decision from where the names come from; `check-capabilities` asserts the derivation today.
 *
 * `capabilities.mjs` is a build-time import: this script is not published (`package.json`'s
 * `files` excludes `scripts/`), so reaching across to the sibling package costs nothing at
 * runtime and cannot create an inter-package dependency for anyone installing the plugin.
 */
export const RETAINED = Object.freeze(keptPackages())

/**
 * Removal rules, applied to the `@deepseek-ai` scope by package name.
 *
 * Each entry says why nothing the brain keeps can reach that package. A rule that
 * cannot state its reason is not a rule; it is a guess with a regular expression.
 *
 * **The patterns are matched against the bare directory name**
 * (`libreoffice-kit-win32-x64`, no scope), because that is what {@link dropPackages}
 * reads out of `node_modules/@deepseek-ai`; {@link RETAINED} is compared against the
 * full name. A rule written with the scope would therefore match nothing. That
 * asymmetry — one key space for rules, another for retention — is a known defect,
 * left alone here on purpose: changing it changes what the build drops, which is a
 * capability-inventory decision, not a regex tidy-up.
 * @type {ReadonlyArray<readonly [RegExp, string]>}
 */
export const DROP_RULES = Object.freeze([
  [/^dsh-client-ui-/u, 'a browser window this node does not have'],
  [/^dsh-web-frontend$/u, 'the SPA dist the brain never serves'],
  // Only the *native* engines of a platform this artefact does not target. The rule used
  // to be `^libreoffice-kit`, which also removed the driver
  // (`@deepseek-ai/libreoffice-kit`) and the WASM engine — exactly the two packages
  // `dsh-office-kit` resolves on Linux — so the node advertised Office tools whose every
  // call threw. Linux is the only published platform and selects WASM, therefore the
  // win32/darwin native payloads are the only part of the family no node here can reach.
  // `@deepseek-ai/libreoffice-kit` also lists unscoped `koffi` in its
  // `optionalDependencies`; this walk only scans the `@deepseek-ai` scope, so `koffi` is
  // never a candidate — nothing is missing, it is outside this scope by construction.
  [/^libreoffice-kit-(?:win32|darwin)-/u, 'native engine for a platform this artefact does not target; the portable WASM engine is what Linux uses'],
  [/^dsh-experimental-/u, 'evaluated capabilities with no product commitment; none is a row in the brain composition'],
  [/^dsh-cua(?:-|$)/u, 'computer use: needs a screen on the node'],
  [/^dsh-browser-use$/u, 'browser automation: needs a browser on the node'],
  [/^dsh-client-test-runtime$/u, 'a test harness'],
  [/^dsh-desktop(?:-|$)/u, 'the Electron shell'],
  [/^dsh-subagent-(?:claude-code|codex|acp|dsh-sdk)$/u, 'on-demand subagent bundles the node never installs'],
  [/^dsh-hooks-(?:claude-code|codex)$/u, 'editor hooks for a developer machine'],
  [/^dsh-(?:llm-mock-server|llm-replay|loader-smoke|session-snapshot|remote-mock|tool-testkit|agent-loop-testkit|typert-generator)$/u, 'test and replay tooling'],
])

/**
 * Packages that must survive: the retained set plus their runtime dependency closure.
 *
 * This answers the question the trim rules were never asked: not "does a kept name
 * happen to match a drop rule" (those are two different lists over two different key
 * spaces) but **"can a package a kept package depends on be deleted?"** The bug that
 * made Office uncallable on every node was exactly that shape — `dsh-office-kit` was
 * retained, `@deepseek-ai/libreoffice-kit` was dropped by prefix, and nothing compared
 * the two.
 *
 * Edges are followed only where npm guarantees installation:
 *
 * - `dependencies`: followed. The package is required at runtime, so its own
 *   dependencies are required too.
 * - `devDependencies`: **not** followed. They are absent from a production install,
 *   and following them would keep test tooling in a node's tree.
 * - `peerDependencies`: their **names are collected, but not walked**. A peer is
 *   supplied by the composition, not by the package that names it, so the name is a
 *   real declaration worth checking against the drop list, while walking the peer's
 *   own manifest would import a closure this package does not own.
 * - `optionalDependencies`: **not** followed at all. "Optional" means the install is
 *   correct without it, and this is what lets a Linux node drop
 *   `libreoffice-kit-win32-x64` / `-darwin-*` (they are optional dependencies of
 *   `@deepseek-ai/libreoffice-kit`) without making the driver's closure incomplete.
 *
 * A dependency whose manifest is missing from the tree is reported by name and not
 * walked: that is a gap {@link unresolvedInTree} is for, and silently treating it as
 * a leaf would hide a broken install inside the keep set.
 * @param {(name: string) => {dependencies?: Record<string, string>, peerDependencies?: Record<string, string>} | undefined} manifestOf
 *   reads one package manifest by full name; `undefined` means "not in the tree".
 * @param {ReadonlyArray<string>} [roots] - full package names to start from.
 * @returns {Set<string>} every full name the kept composition cannot lose.
 */
export function keepClosure(manifestOf, roots = RETAINED) {
  const keep = new Set()
  const walked = new Set()
  const pending = [...roots]
  while (pending.length > 0) {
    const name = pending.pop()
    keep.add(name)
    // A name can enter the closure twice — once as a peer (collected only) and once as a
    // real dependency (which must be walked). Marking it walked only here keeps the
    // second arrival from suppressing the traversal, while the first still records the
    // name. Dropping that distinction made a peer that is also a dependency lose its
    // own subtree.
    if (walked.has(name)) continue
    walked.add(name)
    const manifest = manifestOf(name)
    if (manifest === undefined) continue
    for (const dependency of Object.keys(manifest.dependencies ?? {})) pending.push(dependency)
    // Peers are collected by name and never walked: a peer is supplied by the
    // composition rather than by this package, so its own closure is not this package's.
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) keep.add(peer)
  }
  return keep
}

/**
 * Assert every package the kept composition resolves actually exists in the staged tree.
 *
 * The keep set and the drop rules can agree with each other and still ship an archive
 * a node cannot boot: the rules only look at what is *present* in the staging tree, so
 * a package the resolver never installed is invisible to them. This probe asks the
 * question a node will ask on first call — "can this specifier be resolved from this
 * tree?" — and lets the build refuse the archive instead of discovering it later.
 *
 * It deliberately does **not** use `import.meta.resolve`: that resolves against *this*
 * process's `node_modules` (the repository's), not against `root`, so it would answer
 * about the build machine instead of the artefact.
 *
 * **`root` is sealed.** Node's algorithm climbs parent directories, and copying that
 * literally would be a trap here: the fork build stages at `<fork>/stage/<platform>`,
 * directly under a checkout with its own `node_modules`, so a climb would "resolve"
 * packages that are not in the archive at all. The walk therefore stops at `root`:
 * `<root>/node_modules/<name>/package.json`, scope kept as two path segments.
 * @param {string} root - unpacked runtime tree, `node_modules` at its top.
 * @param {ReadonlyArray<string>} specifiers - bare package names, e.g. `@deepseek-ai/libreoffice-kit`.
 * @returns {{ missing: string[] }} the specifiers with no manifest in the tree.
 */
export function unresolvedInTree(root, specifiers) {
  const missing = []
  for (const specifier of specifiers) {
    const parts = String(specifier).split('/')
    const segments = parts[0].startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)
    const candidate = join(root, 'node_modules', ...segments, 'package.json')
    const present = existsSync(candidate) && statSync(candidate).isFile()
    if (!present) missing.push(String(specifier))
  }
  return { missing }
}

/** Measure a file or a directory tree. */
function measure(entry) {
  if (!existsSync(entry)) return { bytes: 0, files: 0 }
  const stat = statSync(entry)
  if (!stat.isDirectory()) return { bytes: stat.size, files: 1 }
  let bytes = 0
  let files = 0
  for (const child of readdirSync(entry, { withFileTypes: true })) {
    const inner = measure(join(entry, child.name))
    bytes += inner.bytes
    files += inner.files
  }
  return { bytes, files }
}

/**
 * Delete every package a {@link DROP_RULES} entry matches.
 * @param {string} root - unpacked runtime tree, with `node_modules` at its top.
 * @returns {{ bytes: number, files: number, dropped: string[] }} what was removed.
 */
export function dropPackages(root) {
  const scope = join(root, 'node_modules', '@deepseek-ai')
  if (!existsSync(scope)) throw new Error(`${root} holds no node_modules/@deepseek-ai`)
  let bytes = 0
  let files = 0
  const dropped = []
  for (const name of readdirSync(scope)) {
    const full = join(scope, name)
    if (!statSync(full).isDirectory()) continue
    if (RETAINED.includes(`@deepseek-ai/${name}`)) continue
    const rule = DROP_RULES.find(([pattern]) => pattern.test(name))
    if (rule === undefined) continue
    const size = measure(full)
    rmSync(full, { recursive: true, force: true })
    bytes += size.bytes
    files += size.files
    dropped.push(`${basename(full)} (${(size.bytes / 1048576).toFixed(1)} MiB) — ${rule[1]}`)
  }
  return { bytes, files, dropped }
}

/**
 * Remove build residue no runtime reads.
 *
 * The same list `publish-runtime.mjs` strips from every artefact, because a node
 * consumes this tree the same way.
 *
 * `keepMarkdown` is what makes the `.md` rule safe, and it applies **only to markdown**.
 * That restriction is load-bearing rather than tidy: the first version consulted the keep
 * list for every path, and `skills/` then rescued `openai/src/resources/skills/*.ts` —
 * thirteen TypeScript sources that have nothing to do with documentation, left in the tree
 * because their directory happened to be called `skills`. A rescue is an exception to one
 * rule, not a blanket exemption from all of them.
 * @param {string} root - unpacked runtime tree.
 * @param {ReadonlyArray<RegExp>} residue - patterns matched against `/`-joined relative paths.
 * @param {ReadonlyArray<RegExp>} keepMarkdown - markdown paths the `.md` rule must not touch.
 * @returns {{ bytes: number, files: number }} what was removed.
 */
export function stripResidue(root, residue, keepMarkdown = []) {
  let bytes = 0
  let files = 0
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const path = relative(root, full).replaceAll('\\', '/')
      // A directory is matched with a trailing slash so a file-shaped pattern (`.md`)
      // cannot take a whole tree with it, and a directory-shaped one (`test/`) cannot
      // match an unrelated file.
      const subject = entry.isDirectory() ? `${path}/` : path
      if (!entry.isDirectory() && path.endsWith('.md') && keepMarkdown.some(pattern => pattern.test(subject))) {
        continue
      }
      if (residue.some(pattern => pattern.test(subject))) {
        const size = measure(full)
        rmSync(full, { recursive: true, force: true })
        bytes += size.bytes
        files += size.files
        continue
      }
      if (entry.isDirectory()) walk(full)
    }
  }
  walk(root)
  return { bytes, files }
}
