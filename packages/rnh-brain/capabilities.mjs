/**
 * What a node can do — the single source of truth.
 *
 * ## Why this file exists
 *
 * "Does a node have capability X?" used to be answered in six unrelated places, none of
 * which checked the others (`docs/refactor-node-side.zh.md` §三-1):
 *
 *   1. the composed rows            `packages/rnh-brain/cordis.patch.yml`      (generated)
 *   2. the preset rows              `packages/rnh-brain/presets/*.patch.yml`   (generated)
 *   3. the packaging keep list      `scripts/trim-fork-runtime.mjs` `RETAINED`
 *   4. the packaging drop rules     the same file's `DROP_RULES`
 *   5. the provisioning whitelist   `src/host/provision.js` `COPIED_ROW_IDS`/`PROVIDER_ROW`
 *   6. the bundle manifest          `packages/rnh-brain/package.json` `dsh.bundle.patch`
 *
 * Every one of those could drift on its own, and the drift only surfaced on a real node the
 * first time somebody called the missing thing. The Office capability is the direct product
 * of that shape: the driver package was kept, the engine was dropped by a prefix rule, and
 * the tool row was declared in the presets — three files each holding one third of one
 * answer, none comparing notes.
 *
 * So the answer lives here, once, as **data plus a few pure functions**. Every consumer
 * above either derives from it (`keptPackages()`, `composedRowIds()`, `presetRowIds()`) or
 * is reconciled against it by `scripts/check-capabilities.mjs`. Nothing in this file
 * imports anything: it is plain ESM with no dependencies, because the trimming script, the
 * composition checker and the plugin's own host code all read it from contexts that have
 * nothing in common.
 *
 * ## The one rule this file also encodes
 *
 * Outside this module, `@deepseek-ai/` should not be spelled at all: a package name is a
 * fact about a capability, not about the trim script or the daemon. That rule is not
 * enforced yet (it needs a lint rule; see §四 gate 2 of the design doc) — this file is
 * written as if it were, and the consumers that still spell names say why in a comment.
 *
 * ## What a capability is
 *
 * One record per capability, and the record is the **whole chain**, not one link:
 *
 * - `rows`         — the composition-layer row ids that make it exist at all. A
 *                    `disabled: true` row counts: a brain delegates its agent plane to
 *                    presets by disabling the base rows, so the disable *is* the mechanism.
 * - `presetRows`   — the rows that mount it inside a Session, per preset;
 * - `packages`     — packages that must stay in the runtime tree, full names, `*` allowed
 *                    for a family a `never` record owns;
 * - `platformPackages` — packages that exist for one OS only (the Office engine);
 * - `manifestOnly` — packages kept for their manifest alone, whose own code is never
 *                    imported (`@deepseek-ai/dsh-web-app`);
 * - `replaces`     — an upstream row this capability substitutes (only `remote-host` does);
 * - `host`         — prerequisites on the **node** (never on the build machine);
 * - `dropRules`    — the `DROP_RULES` regex sources that implement this record. A rule is a
 *                    mechanism; it has to name the capability it serves, or it is a guess
 *                    with a regular expression;
 * - `offReason`    — one sentence for a person when the record cannot be satisfied.
 *
 * `verdict` is the field that existed nowhere before, and it is the point:
 *
 * - `required` — the node cannot be a brain without it. Probed-missing means refuse, loudly.
 * - `optional` — usable without it, so an unsatisfied record must be *absent* from the
 *                composition and the presets, never declared-then-broken.
 * - `never`    — must not exist on a node: no row, and no package on disk.
 *
 * Every capability here is `required` or `never`, and that is a finding rather than an
 * omission: `office` became unconditional the day the artefact started shipping its engine
 * (see the record), and nothing else is conditional yet. `optional` is implemented and is
 * exercised by `check-capabilities.mjs` with synthetic records, so the branch stays real
 * instead of aspirational.
 *
 * @module @local/rnh-brain/capabilities
 */

/**
 * The platform the node runtime is built for.
 *
 * A capability's package set is a fact about the **artefact**, not about the machine running
 * this module (the build box is Windows; the node is Linux). This mirrors
 * `PUBLISHED_PLATFORMS[0]` in `src/remote/artefact.js`, and `check-capabilities` asserts the
 * two agree — a silent divergence here would trim the wrong engine out of an archive.
 *
 * It is a mirror rather than an import on purpose: this module must stay importable from a
 * tree that has no plugin installed next to it (the trim script runs inside the fork build;
 * the checker runs from `packages/rnh-brain` alone).
 */
export const DEFAULT_PLATFORM = 'linux-x64'

/** The OS part of an `os-arch` platform tag. */
export function platformOs(platform = DEFAULT_PLATFORM) {
  return String(platform).split('-')[0]
}

/**
 * The bundle names a node is composed from — the whole vocabulary, once.
 *
 * Four names used to be spelled in four places (`rnh.js`, `sync-switches.js`,
 * `plugin-sync.js`, `daemon.js`) and two of them disagreed about whether a node contains
 * `dsh-web-app`. They are **not** importable from here by the plugin: `@local/rnh-brain` is
 * copied onto a node, never installed into the desktop Host, so `src/core/plugin-sync.js`
 * cannot import this module at runtime. The plugin therefore keeps its own constants and
 * `check-capabilities.mjs` asserts they are these strings — a reconciliation, not a second
 * source.
 *
 * `desktopHalf` is the one name in this table that is not `@deepseek-ai/*`: it is this
 * repository's plugin, which must never reach a node.
 */
export const BUNDLE_NAMES = Object.freeze({
  /** The shared upstream core every profile composes first. */
  base: '@deepseek-ai/dsh-base',
  /** This package: the brain layer, composed last. */
  brain: '@local/rnh-brain',
  /** Upstream's browser surface — the layer a brain is a subtraction from, and absent from a node. */
  webApp: '@deepseek-ai/dsh-web-app',
  /** The desktop half (this repository's plugin), never composed by a node. */
  desktopHalf: '@greatbaby/dsh-remote-node-harness',
})

/**
 * Whether a full package name matches one of this module's name patterns.
 *
 * `*` is the only wildcard, and deliberately so: these patterns describe package families
 * (`dsh-client-ui-*`), never path shapes or version ranges.
 * @param {string} pattern
 * @param {string} name
 * @returns {boolean}
 */
function matchesPattern(pattern, name) {
  if (!pattern.includes('*')) return pattern === name
  const escaped = pattern.split('*').map(part => part.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
  return new RegExp(`^${escaped.join('.*')}$`, 'u').test(name)
}

/**
 * Every capability a node can have.
 *
 * Order matters for one question only: `capabilityOfRow`/`capabilityOfPackage` return the
 * first match, so `remote-host` claims `@deepseek-ai/dsh-web-app` before the browser surface
 * could — that package's *manifest* is what keeps the brain's kept rows resolvable, and a
 * `never` record claiming it would argue for deleting the one file that makes booting work.
 *
 * @type {ReadonlyArray<{
 *   id: string,
 *   verdict: 'required' | 'optional' | 'never',
 *   summary: string,
 *   rows: readonly string[],
 *   presetRows: Readonly<Record<string, readonly string[]>>,
 *   packages: readonly string[],
 *   platformPackages: Readonly<Record<string, readonly string[]>>,
 *   manifestOnly: readonly string[],
 *   replaces: Readonly<Record<string, string>>,
 *   host: Readonly<Record<string, unknown>>,
 *   dropRules: readonly string[],
 *   offReason: string,
 * }>}
 */
export const CAPABILITIES = Object.freeze([
  // ── 1. the brain itself: without these a node is not a node ────────────────
  {
    id: 'remote-host',
    verdict: 'required',
    summary: 'the Host a node exists to be: HTTP listener, /api prefix, transport, and every Remote controller the desktop and the phone call',
    rows: [
      'web-startup',
      'webserver',
      'connection',
      'api-remotes',
      'session-controller',
      'workspace-controller',
      'workspace-files',
      'job-controller',
      'terminal-controller',
      'settings-controller',
      'plugin-inventory',
      'brain-runtime',
    ],
    presetRows: {},
    /**
     * `@deepseek-ai/dsh-web-app` is kept for its **manifest only**.
     *
     * Upstream resolves a profile bundle's dependency closure by walking the manifests of
     * the installation tree (`collectInstallationScopePackages` in `dsh-app-boot`), and the
     * brain's kept rows name packages only that manifest declares. Deleting it made the
     * loader fail on fifteen rows with `ERR_MODULE_NOT_FOUND`, though the rows the brain
     * keeps never import it. The manifest is load-bearing; the code is not.
     */
    packages: ['@deepseek-ai/dsh-web-app'],
    platformPackages: {},
    manifestOnly: ['@deepseek-ai/dsh-web-app'],
    /**
     * Upstream's `web-runtime` row mounts the SPA dist and hands off to a browser. A node
     * serves no browser, so the row is **replaced** rather than removed: the substitute
     * provides the same `webApp` service and prints the entry URL, which is exactly what the
     * desktop needs and what the resident host's log line carries.
     */
    replaces: Object.freeze({ 'web-runtime': 'brain-runtime' }),
    host: Object.freeze({ node: '>=22' }),
    dropRules: [],
    offReason: 'a node without its own Host cannot answer at all',
  },
  {
    id: 'brain-services',
    verdict: 'required',
    summary: 'the host-plane services the API stands on: schedules, the MCP fleet, Cordis introspection, uploads, workspace and locale',
    rows: [
      'schedule',
      'mcp-manager',
      'cordis-host-runner',
      'cordis-inspect-providers',
      'cordis-client-runner',
      'locale',
      'shortcuts',
      'resources',
      'file-upload',
      'workspace',
    ],
    presetRows: {},
    /**
     * No packages are named here, and that is a finding rather than an oversight: every one
     * of these packages survives the trim because **no drop rule matches it**, not because
     * it is on a keep list. That distinction is the defect `RETAINED` shipped with — 0 of
     * its names ever matched a rule, so "retention" never once did anything — and
     * `check-capabilities` reports such packages explicitly instead of pretending they are
     * declared.
     */
    packages: [],
    platformPackages: {},
    manifestOnly: [],
    replaces: {},
    host: Object.freeze({}),
    dropRules: [],
    offReason: 'the API would answer with rows it cannot resolve',
  },
  {
    id: 'session-surface',
    verdict: 'required',
    summary: 'what a Session is made of on a node: prompt values, projections, references, quotes, and the change feed',
    rows: [
      'system-prompt',
      'session-query-sqlite',
      'session-stats',
      'session-turn-outline',
      'session-reference',
      'file-reference-local',
      'message-feedback',
      'message-quotes',
      'workspace-changes',
      'deliverable-file-references',
      'subagent-model-selection-settings',
    ],
    presetRows: {},
    packages: [],
    platformPackages: {},
    manifestOnly: [],
    replaces: {},
    host: Object.freeze({}),
    dropRules: [],
    offReason: 'a Session would open with no prompt, no projections and no file references',
  },
  {
    id: 'agent-presets',
    verdict: 'required',
    summary: 'the preset registry plus the four preset declarations: the only way a node gives a Session any tools at all',
    rows: ['agent-preset-registry'],
    presetRows: {
      standard: ['preset-standard'],
      ptc: ['preset-ptc'],
      minimal: ['preset-minimal'],
      cordis: ['preset-cordis'],
    },
    packages: [],
    platformPackages: {},
    manifestOnly: [],
    replaces: {},
    host: Object.freeze({}),
    dropRules: [],
    offReason: 'every Session on the node would mount zero tools',
  },

  // ── 2. the agent plane: what the presets mount ─────────────────────────────
  {
    id: 'agent-core',
    verdict: 'required',
    summary: 'the agent plane as presets own it: persona, instructions, plan mode, compaction, ask-user, present',
    /**
     * These composition rows are `disabled: true` on purpose, and the disable belongs to
     * this capability rather than to a separate "off" record: a brain composes the base
     * layer, whose own tool rows would otherwise mount tools outside any preset. Disabling
     * them here is the mechanism by which the presets become the only tool source.
     */
    rows: [
      'agent-instructions',
      'plan-mode',
      'compaction-basic',
      'command-compact',
      'tool-result-pruner',
    ],
    presetRows: {
      standard: [
        'persona',
        'agent-instructions',
        'time-context',
        'planning',
        'plan-mode',
        'compaction',
        'compaction-basic',
        'command-compact',
        'tool-result-pruner',
        'tool-ask-user',
        'present',
      ],
      ptc: [
        'persona',
        'agent-instructions',
        'time-context',
        'planning',
        'plan-mode',
        'compaction',
        'compaction-basic',
        'command-compact',
        'tool-result-pruner',
        'tool-ask-user',
        'present',
      ],
      cordis: [
        'persona',
        'agent-instructions',
        'time-context',
        'planning',
        'plan-mode',
        'compaction',
        'compaction-basic',
        'command-compact',
        'tool-result-pruner',
        'tool-ask-user',
        'present',
      ],
      minimal: ['persona', 'compaction', 'compaction-basic', 'command-compact'],
    },
    packages: [],
    platformPackages: {},
    manifestOnly: [],
    replaces: {},
    host: Object.freeze({}),
    dropRules: [],
    offReason: 'a Session would run with no persona, no plan mode and no compaction',
  },
  {
    id: 'agent-tools',
    verdict: 'required',
    summary: 'the tools an agent works with: shell, files, jobs, the clock, goals, search, todos',
    rows: [
      'tool-bash',
      'tool-pwsh',
      'tool-fs',
      'tool-fs-search',
      'tool-jobs',
      'tool-todo',
      'tool-web',
      'tool-goal',
      'command-goal',
    ],
    presetRows: {
      standard: [
        'tool-bash',
        'tool-pwsh',
        'tool-fs',
        'tool-fs-search',
        'tool-jobs',
        'tool-schedule',
        'command-goal',
        'tool-goal',
        'tool-todo',
        'tool-web',
      ],
      ptc: [
        'tool-bash',
        'tool-pwsh',
        'tool-fs',
        'tool-fs-search',
        'tool-jobs',
        'tool-schedule',
        'command-goal',
        'tool-goal',
        'tool-todo',
        'tool-web',
      ],
      cordis: [
        'tool-bash',
        'tool-pwsh',
        'tool-fs',
        'tool-fs-search',
        'tool-jobs',
        'tool-schedule',
        'command-goal',
        'tool-goal',
        'tool-todo',
        'tool-web',
      ],
      minimal: ['tool-fs'],
    },
    packages: [],
    platformPackages: {},
    manifestOnly: [],
    replaces: {},
    host: Object.freeze({}),
    dropRules: [],
    offReason: 'the model would have no way to touch the node',
  },
  {
    id: 'skills',
    verdict: 'required',
    summary: 'the skill loader and the skill tool: how packaged skills — Office, `dsh-doc`, filesystem — reach a Session',
    rows: ['skill-filesystem', 'tool-skill'],
    presetRows: {
      standard: ['skill-filesystem', 'tool-skill'],
      ptc: ['skill-filesystem', 'tool-skill'],
      cordis: ['skill-filesystem', 'tool-skill'],
    },
    packages: [],
    platformPackages: {},
    manifestOnly: [],
    replaces: {},
    host: Object.freeze({}),
    dropRules: [],
    offReason: 'a Session could reach no skill at all, including the ones the node ships',
  },
  {
    id: 'delegation',
    verdict: 'required',
    summary: 'subagents and workflows: the spawn/fork providers, the workflow engine, and the tool that controls them',
    rows: [
      'tool-subagent-control',
      'tool-subagent',
      'tool-subagent-fork',
      'workflow-ptc',
      'tool-workflow',
    ],
    presetRows: {
      standard: ['delegation', 'tool-subagent-control', 'tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow'],
      ptc: ['delegation', 'tool-subagent-control', 'tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow'],
      cordis: ['delegation', 'tool-subagent-control', 'tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow'],
    },
    packages: [],
    platformPackages: {},
    manifestOnly: [],
    replaces: {},
    host: Object.freeze({}),
    dropRules: [],
    offReason: 'the model could not delegate, which is most of what a long turn is',
  },
  {
    id: 'plugins',
    verdict: 'required',
    summary: 'the in-Session plugin manager and market: how a person switches a plugin on without leaving the Session',
    rows: ['tool-plugin-manager'],
    presetRows: {
      standard: ['tool-plugin-manager', 'tool-plugin-market'],
      ptc: ['tool-plugin-manager', 'tool-plugin-market'],
      cordis: ['tool-plugin-manager', 'tool-plugin-market'],
    },
    packages: [],
    platformPackages: {},
    manifestOnly: [],
    replaces: {},
    host: Object.freeze({}),
    dropRules: [],
    offReason: 'a Session could not change which plugins the node composes',
  },
  {
    id: 'cordis-tools',
    verdict: 'required',
    summary: 'the Cordis introspection tool, which reads the inspect providers composed above',
    rows: [],
    presetRows: { cordis: ['tool-cordis'] },
    packages: [],
    platformPackages: {},
    manifestOnly: [],
    replaces: {},
    host: Object.freeze({}),
    dropRules: [],
    offReason: 'the `cordis` preset would lose the one tool that makes it that preset',
  },
  {
    id: 'terminal',
    verdict: 'required',
    summary: 'the PTY plane the `minimal` preset owns: a persistent shell and its bash/pwsh implementations',
    /**
     * The composition carries no terminal row of its own — `terminal-controller` belongs to
     * `remote-host`, because the desktop's terminal tab calls it. What this record adds is
     * the preset side: `minimal` is copied verbatim from upstream and its rows are a node's
     * only PTY capability, so losing them removes a whole preset's behaviour while the
     * preset row itself still lists.
     */
    rows: [],
    presetRows: {
      minimal: [
        'persistent-shell',
        'pty',
        'terminal-bash',
        'persistent-bash',
        'terminal-pwsh',
        'persistent-pwsh',
      ],
    },
    packages: [],
    platformPackages: {},
    manifestOnly: [],
    replaces: {},
    host: Object.freeze({}),
    dropRules: [],
    offReason: 'the `minimal` preset would compose a Session with no shell',
  },
  {
    id: 'ptc-executor',
    verdict: 'required',
    summary: 'the programmatic tool-calling executor that only the `ptc` preset selects',
    rows: [],
    presetRows: { ptc: ['tool-executor-ptc'] },
    packages: [],
    platformPackages: {},
    manifestOnly: [],
    replaces: {},
    host: Object.freeze({}),
    dropRules: [],
    offReason: 'the `ptc` preset would compose without its executor, so its tools could not run',
  },

  // ── 3. office: the capability that started this refactor ───────────────────
  {
    id: 'office',
    verdict: 'required',
    summary: 'render/convert/recalculate Office documents: the kit row, the skills row, the model-facing tool, and the engine that makes any of it work',
    /**
     * `workspace-dependencies` belongs here rather than to a capability of its own: it is
     * the Python environment the packaged Office skills use. Its own `disabled:` expression
     * switches it off outside the `desktop` profile, so on a node it is present but inert —
     * and "present but inert" is that row's designed state, not a missing capability.
     */
    rows: ['office-kit', 'skill-office', 'workspace-dependencies'],
    presetRows: {
      standard: ['tool-office'],
      ptc: ['tool-office'],
    },
    /**
     * The whole chain, not just the packages a drop rule could otherwise reach:
     * `dsh-office-kit` resolves `@deepseek-ai/libreoffice-kit` at call time through
     * `import.meta.resolve`, the driver selects its engine by platform, and the tool row is
     * what the model sees. Leaving any link out is exactly the shipped bug — driver kept,
     * engine dropped, tools advertised, every call threw.
     */
    packages: [
      '@deepseek-ai/dsh-office-kit',
      '@deepseek-ai/dsh-skill-office',
      '@deepseek-ai/dsh-tool-office',
      '@deepseek-ai/libreoffice-kit',
    ],
    /**
     * The engine, per OS. Linux takes the portable WASM build; macOS and Windows take a
     * native payload. The trim drops every engine for a platform that is not the one being
     * packed; that rule lives on this record, because it removes a *different platform's*
     * copy of this capability rather than a different capability.
     */
    platformPackages: Object.freeze({
      linux: ['@deepseek-ai/libreoffice-kit-wasm'],
      win32: ['@deepseek-ai/libreoffice-kit-win32-x64'],
      darwin: ['@deepseek-ai/libreoffice-kit-darwin-arm64', '@deepseek-ai/libreoffice-kit-darwin-x64'],
    }),
    manifestOnly: [],
    replaces: {},
    /**
     * `dsoffice` is the native engine's CLI, and it is **not** a prerequisite on Linux: the
     * WASM engine runs in-process and ships inside the artefact, so the published node
     * platform satisfies this record with no setup on the node at all. On a native-engine
     * platform the engine package carries `bin/dsoffice` itself, which is why the
     * requirement is scoped by `requiredExecutableOn` rather than stated unconditionally.
     */
    host: Object.freeze({
      executable: Object.freeze(['dsoffice']),
      requiredExecutableOn: Object.freeze(['win32', 'darwin']),
    }),
    /**
     * The narrowed engine rule. It used to be `^libreoffice-kit`, which also removed the
     * driver and the WASM engine — the two packages every Linux node resolves.
     */
    dropRules: ['^libreoffice-kit-(?:win32|darwin)-'],
    offReason: 'no engine is packed, so the tools are not declared instead of declared-then-broken',
  },

  // ── 4. the model plane: not a row here, a row copied from the Host ─────────
  {
    id: 'model-plane',
    verdict: 'required',
    summary: 'the provider routes, the default model and the permission preset a prompt needs — copied from the desktop at connect time, because a fresh node has none',
    /**
     * These rows live in the **base** bundle, not in this patch, so `rows` is empty and that
     * is not a gap: a node composes `dsh-base` first, and the plugin then copies the
     * desktop's effective configuration of these rows into the node's own profile patch
     * (`src/host/provision.js`). Listing them under `provisionRows` is what makes that copy
     * a registered fact instead of a regex buried in the plugin.
     *
     * `capabilityOfRow` therefore cannot classify them, and `check-capabilities` asserts
     * exactly that — if one of them ever *did* appear in the composition, one row would have
     * two owners.
     */
    rows: [],
    presetRows: {},
    packages: [],
    platformPackages: {},
    manifestOnly: [],
    replaces: {},
    host: Object.freeze({}),
    provisionRows: Object.freeze({
      /** Copied verbatim: the default model and the permission preset. */
      copied: Object.freeze(['agent-default-model', 'permission']),
      /**
       * Every `llm-*` row *except* an account login: an account route carries a sign-in
       * session belonging to this machine, not to the node.
       */
      providerPattern: '^@deepseek-ai/dsh-llm-(?!.*account)',
    }),
    dropRules: [],
    offReason: 'the node would answer `session/list` and then fail its first prompt',
  },

  // ── 5. what a node must never have ─────────────────────────────────────────
  {
    id: 'browser-surface',
    verdict: 'never',
    summary: 'everything that exists to draw or drive a window: the SPA, the client roster, HMR, native dialogs, downloads, telemetry',
    rows: [
      'web-runtime',
      'modules',
      'client-hmr',
      'directory-picker',
      'open-in-app',
      'session-log-download',
      'product-analytics',
      'desktop-product-telemetry',
      'harness-dev-context',
    ],
    presetRows: {},
    /**
     * The roster, as families: the 66 `dsh-client-ui-*` packages, the SPA dist, and the
     * packages behind the nine rows above. Only two of these patterns are matched by a
     * `DROP_RULES` entry today, which is the 4.8 MiB of dead packages measured in §2.3 C9 —
     * this record states what belongs to it; a symmetry gate that deletes the rest is a
     * later batch, not a licence to hand-edit rules now.
     */
    packages: [
      '@deepseek-ai/dsh-client-ui-*',
      '@deepseek-ai/dsh-web-frontend',
      '@deepseek-ai/dsh-client-hmr',
      '@deepseek-ai/dsh-client-modules',
      '@deepseek-ai/dsh-host-directory-picker*',
      '@deepseek-ai/dsh-host-open-in-app',
      '@deepseek-ai/dsh-session-log-export',
      '@deepseek-ai/dsh-client-product-analytics',
      '@deepseek-ai/dsh-host-product-telemetry-otel',
      '@deepseek-ai/dsh-harness-dev-context',
    ],
    platformPackages: {},
    manifestOnly: [],
    replaces: {},
    host: Object.freeze({}),
    dropRules: ['^dsh-client-ui-', '^dsh-web-frontend$'],
    offReason: 'a node renders nothing, so a window is dead weight on somebody else’s machine',
  },
  {
    id: 'desktop-shell',
    verdict: 'never',
    summary: 'the Electron application and its publisher: a node is reached over SSH, never through a window',
    rows: [],
    presetRows: {},
    packages: [
      '@deepseek-ai/dsh-desktop',
      '@deepseek-ai/dsh-desktop-host',
      '@deepseek-ai/dsh-desktop-publisher',
    ],
    platformPackages: {},
    manifestOnly: [],
    replaces: {},
    host: Object.freeze({}),
    dropRules: ['^dsh-desktop(?:-|$)'],
    offReason: 'the desktop half lives on the desktop; a node has no display server',
  },
  {
    id: 'computer-use',
    verdict: 'never',
    summary: 'screen control and browser automation: needs a screen and a browser on the node, and the node has neither',
    rows: [],
    presetRows: {},
    packages: [
      '@deepseek-ai/dsh-cua',
      '@deepseek-ai/dsh-cua-bundle',
      '@deepseek-ai/dsh-cua-macos',
      '@deepseek-ai/dsh-cua-mcp',
      '@deepseek-ai/dsh-cua-windows',
      '@deepseek-ai/dsh-browser-use',
    ],
    platformPackages: {},
    manifestOnly: [],
    replaces: {},
    host: Object.freeze({}),
    dropRules: ['^dsh-cua(?:-|$)', '^dsh-browser-use$'],
    offReason: 'a headless node has no screen to drive and no browser to automate',
  },
  {
    id: 'experimental-bundles',
    verdict: 'never',
    summary: 'the `dsh-experimental-*` family: evaluated ideas with no product commitment, and no row in this composition',
    rows: [],
    presetRows: {},
    packages: ['@deepseek-ai/dsh-experimental-*'],
    platformPackages: {},
    manifestOnly: [],
    replaces: {},
    host: Object.freeze({}),
    dropRules: ['^dsh-experimental-'],
    offReason: 'nothing here is committed, so shipping it would be an unowned dependency on every node',
  },
  {
    id: 'developer-tooling',
    verdict: 'never',
    summary: 'test, replay and mock harnesses plus editor hooks: they belong to a developer machine, not to a node',
    rows: [],
    presetRows: {},
    packages: [
      '@deepseek-ai/dsh-client-test-runtime',
      '@deepseek-ai/dsh-agent-loop-testkit',
      '@deepseek-ai/dsh-llm-mock-server',
      '@deepseek-ai/dsh-llm-replay',
      '@deepseek-ai/dsh-loader-smoke',
      '@deepseek-ai/dsh-remote-mock',
      '@deepseek-ai/dsh-session-snapshot',
      '@deepseek-ai/dsh-tool-testkit',
      '@deepseek-ai/dsh-typert-generator',
      '@deepseek-ai/dsh-hooks-claude-code',
      '@deepseek-ai/dsh-hooks-codex',
    ],
    platformPackages: {},
    manifestOnly: [],
    replaces: {},
    host: Object.freeze({}),
    dropRules: [
      '^dsh-client-test-runtime$',
      '^dsh-(?:llm-mock-server|llm-replay|loader-smoke|session-snapshot|remote-mock|tool-testkit|agent-loop-testkit|typert-generator)$',
      '^dsh-hooks-(?:claude-code|codex)$',
    ],
    offReason: 'test doubles and editor hooks would make a node run something nobody asked it to',
  },
  {
    id: 'foreign-agent-bundles',
    verdict: 'never',
    summary: 'on-demand subagent bundles a node never installs: another agent runtime is not a node capability',
    rows: [],
    presetRows: {},
    packages: [
      '@deepseek-ai/dsh-subagent-claude-code',
      '@deepseek-ai/dsh-subagent-codex',
      '@deepseek-ai/dsh-subagent-acp',
      '@deepseek-ai/dsh-subagent-dsh-sdk',
    ],
    platformPackages: {},
    manifestOnly: [],
    replaces: {},
    host: Object.freeze({}),
    dropRules: ['^dsh-subagent-(?:claude-code|codex|acp|dsh-sdk)$'],
    offReason: 'a node runs its own agent; a second runtime would be installed and never used',
  },
])

/** One capability by id; throws rather than returning `undefined`, because a typo is a bug. */
export function capabilityById(id) {
  const found = CAPABILITIES.find(entry => entry.id === id)
  if (found === undefined) throw new Error(`unknown capability: ${id}`)
  return found
}

/**
 * The packages a capability needs **in the tree being packed**, for one platform.
 *
 * Platform packages are additive: `office` needs its driver everywhere and exactly one
 * engine, and which engine is a property of the artefact rather than of the capability.
 * @param {(typeof CAPABILITIES)[number]} capability
 * @param {{ platform?: string }} [env]
 * @returns {string[]} full package names (patterns belong to `never` records, which keep
 *   nothing and therefore contribute nothing here).
 */
export function packagesOf(capability, env = {}) {
  const platform = env.platform ?? DEFAULT_PLATFORM
  const engine = capability.platformPackages[platformOs(platform)] ?? []
  return [...capability.packages, ...engine]
}

/**
 * Whether a capability's prerequisites hold, given what the caller has probed.
 *
 * `env` carries **facts**, not intentions: `{ platform, nodeMajor, executables }`, where
 * `executables` is what somebody actually found on the node. The asymmetry between the two
 * verdicts is the design:
 *
 * - an **unverified** requirement never turns a `required` capability off. Composing a
 *   brain without its transport because no caller passed `executables` would be a worse
 *   failure than starting and reporting honestly;
 * - an **unverified** requirement does hold an `optional` capability off, because the other
 *   direction — declaring something nobody verified — is the shipped failure this file
 *   exists to end.
 * @param {(typeof CAPABILITIES)[number]} capability
 * @param {{ platform?: string, nodeMajor?: number, executables?: readonly string[] }} [env]
 * @returns {{ met: boolean, reason?: string, unverified?: string[] }}
 */
export function meetsRequirements(capability, env = {}) {
  const os = platformOs(env.platform ?? DEFAULT_PLATFORM)
  const host = capability.host ?? {}
  const problems = []
  const unverified = []

  if (typeof host.node === 'string') {
    const floor = Number(/^>=?\s*(\d+)$/u.exec(host.node)?.[1] ?? '0')
    if (typeof env.nodeMajor === 'number') {
      if (env.nodeMajor < floor) problems.push(`node ${String(env.nodeMajor)} < ${host.node}`)
    } else {
      unverified.push(`node ${host.node}`)
    }
  }

  const gated = Array.isArray(host.requiredExecutableOn) ? host.requiredExecutableOn : undefined
  const executableApplies = gated === undefined || gated.includes(os)
  if (executableApplies && Array.isArray(host.executable) && host.executable.length > 0) {
    if (!Array.isArray(env.executables)) {
      unverified.push(`executables ${host.executable.join('/')}`)
    } else {
      const missing = host.executable.filter(name => !env.executables.includes(name))
      if (missing.length > 0) problems.push(`missing executable ${missing.join(', ')}`)
    }
  }

  if (problems.length > 0) return { met: false, reason: problems.join('; '), unverified }
  if (unverified.length > 0 && capability.verdict === 'optional') {
    return { met: false, reason: `unverified: ${unverified.join('; ')}`, unverified }
  }
  return { met: true, unverified }
}

/**
 * The capabilities a node with this environment has, with the state a status surface shows.
 *
 * `state: 'off'` always means "probed and not satisfied" — never "not asked". `required`
 * records come back even when off, because the caller has to decide whether that is a
 * refusal (a probed-missing required capability) or merely unverified; `optional` records
 * vanish when unsatisfied, because declaring them would be the failure this file prevents.
 * @param {{ platform?: string, nodeMajor?: number, executables?: readonly string[] }} [env]
 * @returns {Array<{ capability: (typeof CAPABILITIES)[number], state: 'on' | 'off', reason?: string }>}
 */
export function enabledCapabilities(env = {}) {
  const out = []
  for (const capability of CAPABILITIES) {
    if (capability.verdict === 'never') continue
    const check = meetsRequirements(capability, env)
    if (!check.met) {
      if (capability.verdict === 'optional') continue
      out.push({ capability, state: 'off', reason: check.reason })
      continue
    }
    out.push({ capability, state: 'on' })
  }
  return out
}

/**
 * Every composition row a node with this environment composes.
 *
 * The union of the enabled records' `rows` minus every `never` record's rows. The
 * subtraction is written out although it removes nothing today: it is the rule that keeps a
 * row from being both composed and forbidden when somebody adds one, and a `never` record
 * naming an upstream row it replaces is exactly where that collision would appear.
 * @param {{ platform?: string, nodeMajor?: number, executables?: readonly string[] }} [env]
 * @returns {string[]}
 */
export function composedRowIds(env = {}) {
  const on = new Set()
  for (const entry of enabledCapabilities(env)) {
    if (entry.state === 'off') continue
    for (const row of entry.capability.rows) on.add(row)
  }
  for (const capability of CAPABILITIES) {
    if (capability.verdict !== 'never') continue
    for (const row of capability.rows) on.delete(row)
  }
  // Declaration order, so a diff against the generated file reads row by row.
  const order = []
  for (const capability of CAPABILITIES) {
    for (const row of capability.rows) if (on.has(row) && !order.includes(row)) order.push(row)
  }
  return order
}

/**
 * Every package that must stay in the tree for this environment.
 *
 * Only packages a drop rule could otherwise reach — or that an enabled capability owns
 * outright — are named. A package no rule matches survives without being declared, and
 * pretending otherwise is what made the old `RETAINED` useless: four names, none of which
 * ever matched a rule, so the "retain" mechanism never once did anything.
 * @param {{ platform?: string, nodeMajor?: number, executables?: readonly string[] }} [env]
 * @returns {string[]}
 */
export function keptPackages(env = {}) {
  const keep = []
  for (const entry of enabledCapabilities(env)) {
    if (entry.state === 'off') continue
    for (const name of packagesOf(entry.capability, env)) {
      if (!keep.includes(name)) keep.push(name)
    }
  }
  return keep
}

/**
 * The names of every preset this module knows about.
 *
 * Derived rather than listed: a preset added to the composition without a record here would
 * otherwise be silently unmanaged, and `check-capabilities` compares this against the
 * `presets/` directory and the bundle manifest.
 * @returns {string[]}
 */
export function presetNames() {
  const names = []
  for (const capability of CAPABILITIES) {
    for (const preset of Object.keys(capability.presetRows ?? {})) {
      if (!names.includes(preset)) names.push(preset)
    }
  }
  return names
}

/**
 * The row ids one preset should mount on a node with this environment.
 *
 * Returned as `{ rows, dropped }`: `rows` is the enabled records' `presetRows` for that
 * preset, and `dropped` names what an off or `never` record withheld **and why** — a preset
 * silently missing a row is otherwise indistinguishable from one that never had it.
 * @param {string} preset - `standard` | `ptc` | `minimal` | `cordis`
 * @param {{ platform?: string, nodeMajor?: number, executables?: readonly string[] }} [env]
 * @returns {{ rows: string[], dropped: Array<{ row: string, capability: string, reason: string }> }}
 */
export function presetRowIds(preset, env = {}) {
  const states = new Map(enabledCapabilities(env).map(entry => [entry.capability.id, entry]))
  const rows = []
  const dropped = []
  for (const capability of CAPABILITIES) {
    const declared = capability.presetRows?.[preset] ?? []
    if (declared.length === 0) continue
    if (capability.verdict === 'never') {
      for (const row of declared) dropped.push({ row, capability: capability.id, reason: capability.offReason })
      continue
    }
    const entry = states.get(capability.id)
    if (entry === undefined || entry.state === 'off') {
      const reason = entry?.reason ?? capability.offReason
      for (const row of declared) dropped.push({ row, capability: capability.id, reason })
      continue
    }
    for (const row of declared) if (!rows.includes(row)) rows.push(row)
  }
  return { rows, dropped }
}

/** The capability that composes one row id, or `undefined` when no record claims it. */
export function capabilityOfRow(rowId) {
  for (const capability of CAPABILITIES) {
    if (capability.rows.includes(rowId)) return capability.id
  }
  for (const capability of CAPABILITIES) {
    for (const rows of Object.values(capability.presetRows ?? {})) {
      if (rows.includes(rowId)) return capability.id
    }
  }
  return undefined
}

/**
 * The capability a full package name belongs to, or `undefined`.
 *
 * First match wins in declaration order, which is why `remote-host` is declared first: the
 * browser surface must not claim `@deepseek-ai/dsh-web-app`, whose manifest is what keeps
 * the brain's kept rows resolvable.
 */
export function capabilityOfPackage(name) {
  for (const capability of CAPABILITIES) {
    for (const pattern of capability.packages) {
      if (matchesPattern(pattern, name)) return capability.id
    }
    for (const names of Object.values(capability.platformPackages ?? {})) {
      if (names.includes(name)) return capability.id
    }
  }
  return undefined
}

/** Whether one pattern in a capability's `packages` matches a name (for the checker). */
export function packagePatternMatches(pattern, name) {
  return matchesPattern(pattern, name)
}

/** Every `DROP_RULES` regex source a capability declares, with its owner. */
export function declaredDropRules() {
  const out = []
  for (const capability of CAPABILITIES) {
    for (const source of capability.dropRules ?? []) {
      out.push({ source, capability: capability.id, verdict: capability.verdict })
    }
  }
  return out
}

/**
 * Whether one Office engine belongs to a platform other than this artefact's.
 *
 * This is the question `DROP_RULES`' engine rule answers at build time, stated once here so
 * the rule can be checked against it instead of trusted.
 * @param {string} name - full package name, e.g. `@deepseek-ai/libreoffice-kit-win32-x64`
 * @param {string} [platform]
 * @returns {boolean}
 */
export function isForeignEngine(name, platform = DEFAULT_PLATFORM) {
  const office = capabilityById('office')
  const own = Object.values(office.platformPackages).flat()
  if (!own.includes(name)) return false
  return !(office.platformPackages[platformOs(platform)] ?? []).includes(name)
}
