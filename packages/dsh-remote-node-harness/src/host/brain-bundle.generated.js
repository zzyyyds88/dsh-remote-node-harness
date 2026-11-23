/**
 * The node-side brain composition, embedded.
 *
 * GENERATED — do not edit. Source of truth:
 *   packages/rnh-brain/{cordis.patch.yml, presets/*.yml, src/runtime.js, package.json}
 * Regenerate:
 *   cd packages/rnh-brain
 *   node scripts/sync-from-upstream.mjs && node scripts/embed-into-rnh.mjs
 *
 * Embedded sources (7):
 *   package.json
 *   cordis.patch.yml
 *   presets/cordis.patch.yml
 *   presets/minimal.patch.yml
 *   presets/ptc.patch.yml
 *   presets/standard.patch.yml
 *   src/runtime.js
 *
 * @module @greatbaby/dsh-remote-node-harness/host/brain-bundle.generated
 */

/** Package name the node profile lists in `dsh.profile.bundles`. */
export const BRAIN_PACKAGE = '@local/rnh-brain'

/** Package-relative path → file contents, for everything a node needs. */
export const BRAIN_FILES = Object.freeze({
  "package.json": `{
  "name": "@local/rnh-brain",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "The node-side DeepSeek Harness composition: a brain that runs agents and serves the Remote API, with the browser surface removed. Derived from @deepseek-ai/dsh-web-app by scripts/sync-from-upstream.mjs, so an upstream change shows up as a reviewable diff.",
  "exports": {
    ".": "./src/runtime.js",
    "./runtime": "./src/runtime.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./presets/*.patch.yml": "./presets/*.patch.yml",
    "./package.json": "./package.json"
  },
  "files": [
    "src",
    "presets/*.patch.yml",
    "cordis.patch.yml",
    "scripts",
    "README.md"
  ],
  "dsh": {
    "bundle": {
      "patch": [
        "./cordis.patch.yml",
        "./presets/standard.patch.yml",
        "./presets/ptc.patch.yml",
        "./presets/minimal.patch.yml",
        "./presets/cordis.patch.yml"
      ]
    }
  },
  "scripts": {
    "sync": "node scripts/sync-from-upstream.mjs",
    "check": "node scripts/check-composition.mjs"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-base": "*",
    "@deepseek-ai/dsh-web-app": "*"
  },
  "peerDependenciesMeta": {
    "@deepseek-ai/cordis": { "optional": true },
    "@deepseek-ai/dsh-base": { "optional": true },
    "@deepseek-ai/dsh-web-app": { "optional": true }
  },
  "engines": {
    "node": ">=22"
  },
  "license": "MIT"
}
`,
  "cordis.patch.yml": `# ══════════════════════════════════════════════════════════════════════════════
# @local/rnh-brain — the node-side composition.
#
# A node is a BRAIN: it runs agents and serves the Remote API that the desktop
# app (and ds-harness-remote from a phone) talks to. It serves no browser, so
# this layer is \`@deepseek-ai/dsh-web-app\` minus its browser surface.
#
# GENERATED — do not hand-edit the row blocks below.
#   node scripts/sync-from-upstream.mjs   (then read the diff)
#
# Every row here is copied verbatim from the official patch of the DSH release
# this profile runs, so an upstream change appears as a reviewable diff instead
# of a silent divergence. See scripts/sync-from-upstream.mjs for the keep/drop
# rule and the reason each dropped row is dropped.
# ══════════════════════════════════════════════════════════════════════════════

# ── surface values shared with the Web surface ───────────────────────────────

- id: system-prompt
  config:
    personaPrefix: >-
      You are a coding agent powered by the {{model}} model.

- id: session-query-sqlite
  config:
    path: ':memory:'
    openAt: never

# ── host-plane rows: the Remote API, its transport, and the services behind it ─

- insert:
    # Host-owned authorization sampled at Agent creation. The Plugins page
    # edits this settings namespace independently of the selected preset.
    - id: subagent-model-selection-settings
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'

    - id: message-feedback
      name: '@deepseek-ai/dsh-message-feedback'
      config:
        maxNoteBytes: 8192

    - id: workspace
      name: '@deepseek-ai/dsh-workspace'

    - id: session-reference
      name: '@deepseek-ai/dsh-session-reference'

    - id: file-reference-local
      name: '@deepseek-ai/dsh-file-reference-local'

    # Whole-log turn/step counts for the chat stats strip (the sessionStats
    # projection key); the projection registry itself is a base-layer row.
    - id: session-stats
      name: '@deepseek-ai/dsh-session-stats'

    # Whole-log turn outline for the chat turn rail (the turnOutline
    # projection key): every turn stays navigable before its events page in.
    - id: session-turn-outline
      name: '@deepseek-ai/dsh-session-turn-outline'

    # Read-only projection of current Loader entries for trusted client RPCs.
    - id: plugin-inventory
      name: '@deepseek-ai/dsh-host-plugin-inventory'

    # Session commands, cold reads, and live control over Typert Remote.
    - id: session-controller
      name: '@deepseek-ai/dsh-api-session-controller'

    # One background job's observation record streamed over Typert Remote;
    # the roster rides the session control stream above.
    - id: job-controller
      name: '@deepseek-ai/dsh-api-job-controller'

    # Workspace file service: bounded read, directory listing, and the
    # agent-write change feed inside the session workspace root.
    - id: terminal-controller
      name: '@deepseek-ai/dsh-api-terminal-controller'

    - id: workspace-files
      name: '@deepseek-ai/dsh-api-workspace-files'

    # The Schedule service owns the task store and delivers each due occurrence
    # as a follow-up to the task's target Session. The clock reading and the four
    # reminder tools belong to the \`standard\`, \`cordis\`, and \`ptc\` presets,
    # which declare them in their own scope.
    - id: schedule
      name: '@deepseek-ai/dsh-schedule'

    - id: settings-controller
      name: '@deepseek-ai/dsh-api-settings-controller'

    # One shared MCP server fleet: Settings-configured servers plus servers
    # that installed plugins register, with status and recovery over Remote.
    # Credential templates and OAuth grants resolve through the credentials
    # provider, so the manager starts after it.
    - id: mcp-manager
      name: '@deepseek-ai/dsh-mcp-manager'
      inject: [credentials]

    # Workspace commands and reconnect-safe projection over Typert Remote.
    - id: workspace-controller
      name: '@deepseek-ai/dsh-api-workspace-controller'

    - id: cordis-host-runner
      name: '@deepseek-ai/dsh-cordis-host-runner'

    # The Host inspect providers are process-global: the registry rejects a
    # duplicate id, so they register here once and every preset's \`tool-cordis\`
    # row reads them.
    - id: cordis-inspect-providers
      name: '@deepseek-ai/dsh-tool-cordis/host'

    # Ordinary provider for the parsed Web flags. Its plugin-level injection
    # waits for cmdlineArgs; no launcher metadata or special row kind is needed.
    - id: web-startup
      name: '@deepseek-ai/dsh-web-app/startup'

    # ── layer 2: transport/service ──────────────────────────────────────────────
    # Plain route-registration carrier; host and port come from the app's
    # webStartup provider, with these deployment fallbacks. The dist is served
    # by the web-runtime row below through the fallback seat. Routing and
    # browser-facing asset paths do not depend on the advertised URL, which the
    # web-runtime row owns; Connection reads trust authorities from webStartup.
    # This row rejects wildcard binds.
    - id: webserver
      name: '@deepseek-ai/dsh-host-webserver'
      inject: [webStartup]
      config:
        host: !!js ctx.webStartup.host ?? '127.0.0.1'
        port: !!js ctx.webStartup.port ?? 3080
        tls: !!js ctx.webStartup.tls
        compression: gzip
        compressionLevel: 1
        compressionThresholdBytes: 1024

    # Owns both ends of the web transport: node half binds the gateway to the
    # webserver under /api; browser half is the fetch/SSE client. Every API
    # request and upgrade passes the loopback, listener-bind, or trustedHosts
    # policy; an advertised public URL contributes nothing to it.
    - id: connection
      name: '@deepseek-ai/dsh-client-connection'
      inject: [webStartup]
      config:
        # Keep invocation authorities (each --trusted-host value) when adding
        # deployment values, for example: ['app.internal', ...ctx.webStartup.trustedHosts].
        # The listener's bind IP is accepted separately from this list.
        trustedHosts: !!js ctx.webStartup.trustedHosts

    # Raw Blob and ReadableStream uploads run independently of Connection's
    # RPC and generation service.
    - id: file-upload
      name: '@deepseek-ai/dsh-client-file-upload'

    - id: api-remotes
      name: '@deepseek-ai/dsh-api-remotes'

    - id: cordis-client-runner
      name: '@deepseek-ai/dsh-cordis-client-runner'

    - id: locale
      name: '@deepseek-ai/dsh-client-locale'

    - id: shortcuts
      name: '@deepseek-ai/dsh-client-shortcuts'

    # Unified resource model: protocol providers behind the useResource hook.
    - id: resources
      name: '@deepseek-ai/dsh-client-resources'

    - id: office-kit
      name: '@deepseek-ai/dsh-office-kit'
      config:
        outputDirectory: !!js dshHomePath('office-kit', 'outputs')

    # Every profile uses the packaged Office skills. Desktop supplies their Python
    # environment through the primary runtime named by DSH_PRIMARY_RUNTIME and
    # selects \`workspace-dependencies\`. A Desktop profile launched without a
    # nonempty value disables workspace-dependencies and, like the other
    # profiles, selects \`user\` to direct the model to the user's Python.
    - id: workspace-dependencies
      name: '@deepseek-ai/dsh-tool-workspace-dependencies'
      disabled: !!js "ctx.get('profileContext')?.name !== 'desktop' || !process.env.DSH_PRIMARY_RUNTIME"
      config:
        source: !!js process.env.DSH_PRIMARY_RUNTIME
        root: !!js dshHomePath('dsh-runtimes', 'dsh-primary-runtime')

    - id: skill-office
      name: '@deepseek-ai/dsh-skill-office'
      config:
        pythonEnvironment: !!js "ctx.get('profileContext')?.name === 'desktop' && process.env.DSH_PRIMARY_RUNTIME ? 'workspace-dependencies' : 'user'"

    - id: message-quotes
      name: '@deepseek-ai/dsh-message-quotes'

    - id: deliverable-file-references
      name: '@deepseek-ai/dsh-deliverable-file-references'

    # Records each top-level turn's changed files from git working-tree
    # snapshots; the changed-files card above renders its events.
    - id: workspace-changes
      name: '@deepseek-ai/dsh-workspace-changes'

    # The brain’s own runtime glue: prints the entry URL and provides \`webApp\`
    # WITHOUT mounting a frontend dist. Replaces the upstream \`web-runtime\` row,
    # which would try to serve a SPA this node does not have.
    - id: brain-runtime
      name: '@local/rnh-brain/runtime'
      inject: [webStartup]
      config:
        printUrl: true

# ── the agent plane moves behind agent presets (same as the Web surface) ─────

- id: tool-plugin-manager
  disabled: true

- id: tool-bash
  disabled: true

- id: tool-pwsh
  disabled: true


- id: tool-jobs
  disabled: true

- id: tool-fs
  disabled: true

- id: tool-fs-search
  disabled: true


- id: skill-filesystem
  disabled: true

- id: tool-skill
  disabled: true


- id: command-goal
  disabled: true

- id: tool-goal
  disabled: true

- id: plan-mode
  disabled: true


- id: compaction-basic
  disabled: true

- id: command-compact
  disabled: true

- id: tool-result-pruner
  disabled: true


- id: tool-subagent-control
  disabled: true

- id: tool-subagent
  disabled: true

- id: tool-subagent-fork
  disabled: true

- id: workflow-ptc
  disabled: true

- id: tool-workflow
  disabled: true

- id: agent-instructions
  disabled: true

- id: tool-todo
  disabled: true

- id: tool-web
  disabled: true

- insert:
    - id: agent-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: standard

# ── rows no brain needs ──────────────────────────────────────────────────────
#
# 57 \`dsh-client-ui-*\` rows are absent above: a node renders nothing, so their
# whole reason to exist is missing. The rest each drive a browser or a desktop
# window; the reason is recorded here so the next reader does not re-add one.
#
#   web-runtime                  mounts the SPA dist; replaced by brain-runtime
#   harness-dev-context          “inspect the harness serving this GUI” — there is no GUI
#   client-hmr                   browser reload chain over --watch
#   modules                      composes window.__DSH_BOOT__ and serves /plugins/*/client.js
#   directory-picker             opens a native OS dialog on the node, for the node’s own screen
#   open-in-app                  launches a desktop application on the node
#   session-log-download         browser download dialog
#   product-analytics            telemetry for a desktop app
#   desktop-product-telemetry    telemetry for a desktop app
`,
  "presets/cordis.patch.yml": `# Copied verbatim from @deepseek-ai/dsh-web-app/presets/cordis.patch.yml
# Regenerate with: node scripts/sync-from-upstream.mjs

# Agent preset cordis: one \`@deepseek-ai/dsh-agent-preset\` declaration inserted
# after the web patch. Edits saved from the Web editor override this row's
# \`config.plugins\` by id from the profile patch.
- insert:
    - id: preset-cordis
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: cordis
        order: 4
        plugins:
          # The dsh-doc skill owns plugin implementation and authorization guidance.
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: >-
                You are a coding agent powered by the {{model}} model.
                You help the user customize DeepSeek Harness itself.
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config:
              maxBytes: 65536
          - id: time-context
            name: '@deepseek-ai/dsh-time-context'
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
            disabled: !!js process.platform === 'win32'
          - id: tool-pwsh
            name: '@deepseek-ai/dsh-tool-pwsh'
            disabled: !!js process.platform !== 'win32'
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config:
              # Set true to add the apply_patch tool beside edit.
              applyPatch: false
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
            config:
              sampleOverCapGlobResults: false
          - id: tool-jobs
            name: '@deepseek-ai/dsh-tool-jobs'
          - id: tool-schedule
            name: '@deepseek-ai/dsh-tool-schedule'
          - id: command-goal
            name: '@deepseek-ai/dsh-command-goal'
          - id: tool-goal
            name: '@deepseek-ai/dsh-tool-goal'
          - id: planning
            name: cordis:group
            group: true
            isolate:
              planMode: true
            config:
              - id: plan-mode
                name: '@deepseek-ai/dsh-plan-mode'
                config:
                  section: |
                    You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

                    Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

                    The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

                    Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

                    Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

                    When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
              toolResultPruner: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
              - id: tool-result-pruner
                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
                config:
                  thresholdChars: 8192
                  headChars: 4096
                  tailChars: 1024
          - id: delegation
            name: cordis:group
            group: true
            isolate:
              workflowEngine: true
            config:
              - id: tool-subagent-control
                name: '@deepseek-ai/dsh-tool-subagent-control'
                config:
                  interrupt: false
              - id: tool-subagent
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: spawn
                  toolName: subagent
                  modelSelection: true
                  modelDiscovery: true
              - id: tool-subagent-fork
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: fork
                  toolName: subagent_fork
              - id: workflow-ptc
                name: '@deepseek-ai/dsh-workflow-ptc'
                config:
                  provider: spawn
              - id: tool-workflow
                name: '@deepseek-ai/dsh-tool-workflow'
          - id: tool-ask-user
            name: '@deepseek-ai/dsh-tool-ask-user'
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
            config:
              allowParallelInProgress: true
          - id: tool-web
            name: '@deepseek-ai/dsh-tool-web'
            config:
              fetch: true
              searchTimeoutMs: 60000
          - id: tool-cordis
            name: '@deepseek-ai/dsh-tool-cordis'
          - id: skill-filesystem
            name: '@deepseek-ai/dsh-skill-filesystem'
            config:
              customSkillDirs:
                - !!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')
          - id: tool-skill
            name: '@deepseek-ai/dsh-tool-skill'
          - id: present
            name: '@deepseek-ai/dsh-tool-present'
          - id: tool-plugin-manager
            name: '@deepseek-ai/dsh-plugin-manager/tools'
            disabled: !!js "!ctx.get('profileContext')"
          - id: tool-plugin-market
            name: '@deepseek-ai/dsh-plugin-market/tools'
            disabled: !!js "!ctx.get('profileContext')"
`,
  "presets/minimal.patch.yml": `# Copied verbatim from @deepseek-ai/dsh-web-app/presets/minimal.patch.yml
# Regenerate with: node scripts/sync-from-upstream.mjs

# Agent preset minimal: one \`@deepseek-ai/dsh-agent-preset\` declaration inserted
# after the web patch. Edits saved from the Web editor override this row's
# \`config.plugins\` by id from the profile patch.
- insert:
    - id: preset-minimal
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: minimal
        order: 3
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You are a helpful software engineer assistant.
              complete: true
              includeRuntimeContext: false
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config:
              read: false
              readImage: true
              write: false
              edit: false
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
          - id: persistent-shell
            name: cordis:group
            group: true
            isolate:
              terminals: true
            config:
              - id: pty
                name: '@deepseek-ai/dsh-terminal'
              - id: terminal-bash
                name: '@deepseek-ai/dsh-terminal-bash'
                disabled: !!js process.platform === 'win32'
                config:
                  timeoutMs: 300000
              - id: persistent-bash
                name: '@deepseek-ai/dsh-tool-bash-persistent'
                disabled: !!js process.platform === 'win32'
                config:
                  timeoutMs: 300000
                  description: |-
                    Run commands in a bash shell
                    * When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
                    * Network access depends on the task environment. Prefer configured mirrors/proxies when they are available.
                    * State is persistent across command calls and discussions with the user.
                    * To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
                    * Please avoid commands that may produce a very large amount of output.
                    * Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.
              - id: terminal-pwsh
                name: '@deepseek-ai/dsh-terminal-bash'
                disabled: !!js process.platform !== 'win32'
                config:
                  shellDialect: pwsh
                  timeoutMs: 300000
              - id: persistent-pwsh
                name: '@deepseek-ai/dsh-tool-pwsh-persistent'
                disabled: !!js process.platform !== 'win32'
                config:
                  timeoutMs: 300000
                  description: |-
                    Run commands in a PowerShell shell
                    * When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
                    * You don't have access to the internet via this tool.
                    * State is persistent across command calls and discussions with the user.
                    * Use native Windows paths (C:\\...) and $env:NAME variables; this is PowerShell, not bash.
                    * Please avoid commands that may produce a very large amount of output.
                    * Please run long lived commands in the background, e.g. 'Start-Job' or start a server with Start-Process.
`,
  "presets/ptc.patch.yml": `# Copied verbatim from @deepseek-ai/dsh-web-app/presets/ptc.patch.yml
# Regenerate with: node scripts/sync-from-upstream.mjs

# Agent preset ptc: one \`@deepseek-ai/dsh-agent-preset\` declaration inserted
# after the web patch. Edits saved from the Web editor override this row's
# \`config.plugins\` by id from the profile patch.
- insert:
    - id: preset-ptc
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: ptc
        order: 2
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You are a coding agent powered by the {{model}} model.
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config:
              maxBytes: 65536
          - id: time-context
            name: '@deepseek-ai/dsh-time-context'
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
            disabled: !!js process.platform === 'win32'
          - id: tool-pwsh
            name: '@deepseek-ai/dsh-tool-pwsh'
            disabled: !!js process.platform !== 'win32'
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config:
              # Set true to add the apply_patch tool beside edit.
              applyPatch: false
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
            config:
              sampleOverCapGlobResults: false
          - id: tool-jobs
            name: '@deepseek-ai/dsh-tool-jobs'
          - id: tool-schedule
            name: '@deepseek-ai/dsh-tool-schedule'
          - id: skill-filesystem
            name: '@deepseek-ai/dsh-skill-filesystem'
          - id: tool-skill
            name: '@deepseek-ai/dsh-tool-skill'
          - id: command-goal
            name: '@deepseek-ai/dsh-command-goal'
          - id: tool-goal
            name: '@deepseek-ai/dsh-tool-goal'
          - id: planning
            name: cordis:group
            group: true
            isolate:
              planMode: true
            config:
              - id: plan-mode
                name: '@deepseek-ai/dsh-plan-mode'
                config:
                  section: |
                    You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

                    Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

                    The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

                    Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

                    Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

                    When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
              toolResultPruner: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
              - id: tool-result-pruner
                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
                config:
                  thresholdChars: 8192
                  headChars: 4096
                  tailChars: 1024
          - id: delegation
            name: cordis:group
            group: true
            isolate:
              workflowEngine: true
            config:
              - id: tool-subagent-control
                name: '@deepseek-ai/dsh-tool-subagent-control'
                config:
                  interrupt: false
              - id: tool-subagent
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: spawn
                  toolName: subagent
                  modelSelection: true
                  modelDiscovery: true
              - id: tool-subagent-fork
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: fork
                  toolName: subagent_fork
              - id: workflow-ptc
                name: '@deepseek-ai/dsh-workflow-ptc'
                disabled: true
                config:
                  provider: spawn
              - id: tool-workflow
                name: '@deepseek-ai/dsh-tool-workflow'
                disabled: true
          - id: tool-ask-user
            name: '@deepseek-ai/dsh-tool-ask-user'
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
            config:
              allowParallelInProgress: true
          - id: tool-web
            name: '@deepseek-ai/dsh-tool-web'
            config:
              fetch: true
              searchTimeoutMs: 60000
          - id: tool-executor-ptc
            name: '@deepseek-ai/dsh-tool-executor-ptc'
          - id: present
            name: '@deepseek-ai/dsh-tool-present'
          - id: tool-office
            name: '@deepseek-ai/dsh-tool-office'
          - id: tool-plugin-manager
            name: '@deepseek-ai/dsh-plugin-manager/tools'
            disabled: true
          - id: tool-plugin-market
            name: '@deepseek-ai/dsh-plugin-market/tools'
            disabled: true
`,
  "presets/standard.patch.yml": `# Copied verbatim from @deepseek-ai/dsh-web-app/presets/standard.patch.yml
# Regenerate with: node scripts/sync-from-upstream.mjs

# Agent preset standard: one \`@deepseek-ai/dsh-agent-preset\` declaration inserted
# after the web patch. Edits saved from the Web editor override this row's
# \`config.plugins\` by id from the profile patch.
- insert:
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You are a coding agent powered by the {{model}} model.
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config:
              maxBytes: 65536
          - id: time-context
            name: '@deepseek-ai/dsh-time-context'
          - id: tool-bash
            name: '@deepseek-ai/dsh-tool-bash'
            disabled: !!js process.platform === 'win32'
          - id: tool-pwsh
            name: '@deepseek-ai/dsh-tool-pwsh'
            disabled: !!js process.platform !== 'win32'
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config:
              # Set false to drop the apply_patch tool beside edit.
              applyPatch: false
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
            config:
              sampleOverCapGlobResults: false
          - id: tool-jobs
            name: '@deepseek-ai/dsh-tool-jobs'
          - id: tool-schedule
            name: '@deepseek-ai/dsh-tool-schedule'
          - id: skill-filesystem
            name: '@deepseek-ai/dsh-skill-filesystem'
            config:
              customSkillDirs:
                - !!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')
          - id: tool-skill
            name: '@deepseek-ai/dsh-tool-skill'
          - id: command-goal
            name: '@deepseek-ai/dsh-command-goal'
          - id: tool-goal
            name: '@deepseek-ai/dsh-tool-goal'
          - id: planning
            name: cordis:group
            group: true
            isolate:
              planMode: true
            config:
              - id: plan-mode
                name: '@deepseek-ai/dsh-plan-mode'
                config:
                  section: |
                    You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

                    Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

                    The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

                    Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

                    Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

                    When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
              toolResultPruner: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
              - id: tool-result-pruner
                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
                config:
                  thresholdChars: 8192
                  headChars: 4096
                  tailChars: 1024
          - id: delegation
            name: cordis:group
            group: true
            isolate:
              workflowEngine: true
            config:
              - id: tool-subagent-control
                name: '@deepseek-ai/dsh-tool-subagent-control'
                config:
                  interrupt: false
              - id: tool-subagent
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: spawn
                  toolName: subagent
                  modelSelection: true
                  modelDiscovery: true
              - id: tool-subagent-fork
                name: '@deepseek-ai/dsh-tool-subagent'
                config:
                  provider: fork
                  toolName: subagent_fork
              - id: workflow-ptc
                name: '@deepseek-ai/dsh-workflow-ptc'
                config:
                  provider: spawn
              - id: tool-workflow
                name: '@deepseek-ai/dsh-tool-workflow'
          - id: tool-ask-user
            name: '@deepseek-ai/dsh-tool-ask-user'
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
            config:
              allowParallelInProgress: true
          - id: tool-web
            name: '@deepseek-ai/dsh-tool-web'
            config:
              fetch: true
              searchTimeoutMs: 60000
          - id: present
            name: '@deepseek-ai/dsh-tool-present'
          - id: tool-office
            name: '@deepseek-ai/dsh-tool-office'
          - id: tool-plugin-manager
            name: '@deepseek-ai/dsh-plugin-manager/tools'
            disabled: !!js "!ctx.get('profileContext')"
          - id: tool-plugin-market
            name: '@deepseek-ai/dsh-plugin-market/tools'
            disabled: true
`,
  "src/runtime.js": `/**
 * The brain's runtime glue: print the entry URL, provide \`webApp\`, mount nothing.
 *
 * Upstream's \`web-runtime\` row (\`@deepseek-ai/dsh-web-app\`) does four things: it
 * mounts the built SPA dist through \`frontend-static\`, registers \`DSH_WEB_URL\`,
 * prints the tokenized entry URL, and hands that URL to a desktop browser. A brain
 * wants the middle two and neither of the ends: there is no dist on a node to serve,
 * and no browser on it to open.
 *
 * That is the whole reason this package exists. Everything else a brain needs comes
 * verbatim from \`@deepseek-ai/dsh-web-app\`'s patch, which
 * \`scripts/sync-from-upstream.mjs\` copies.
 *
 * @module @local/rnh-brain/runtime
 */

/** Stable Cordis plugin name. */
export const name = 'brain-runtime'

/**
 * Services this row reads.
 *
 * Cordis requires every service a plugin touches to be declared here — reading
 * \`ctx.webServer\` without it throws \`cannot get property "webServer" without inject\`,
 * and because that happens inside a promise chain the only visible symptom is a Host
 * that boots, listens, and prints nothing. \`webStartup\` carries the parsed
 * \`dsh --profile <p>\` flags; \`webServer\` is the listener this row advertises;
 * \`connection\` owns the launch token (see \`ctx.inject\` below for why it is optional).
 */
export const inject = ['webStartup', 'webServer']

/** The advertised application surface this Host serves. */
export const WEB_APP_SERVICE = 'webApp'

/**
 * Exchange a launch token for a browser cookie, with no SPA behind it.
 *
 * In the shipped Web composition this is \`frontend-static\`'s fallback seat: the
 * browser hits \`/?token=…\`, the fallback calls \`connection.authorizeIndex\`, which
 * mints the session cookie and answers \`303 → ./\`; everything else is the dist.
 *
 * A brain has no dist, but it does need the exchange — the plugin and
 * \`ds-harness-remote\` both speak cookie-authenticated \`/api\`, and the launch URL is
 * where that cookie comes from. Without this seat, \`/?token=…\` falls through to no
 * fallback at all and the webserver answers **404**, which looks like "the node has
 * no Remote API" while the API itself is fine.
 *
 * So the seat is claimed with only the authentication half: index requests behave
 * exactly as in the Web composition, and every other unmatched path is 404.
 * @param {import('@deepseek-ai/cordis').Context} ctx - a context carrying \`webServer\` and \`connection\`.
 */
function claimIndexSeat(ctx) {
  /**
   * Run \`connection.authorizeIndex\` against a WHATWG request.
   *
   * \`authorizeIndex\` speaks the node:http shape (\`req.url\`, \`req.method\`,
   * \`req.headers\`) and writes through a \`res\`-like object. A \`Request\` already has
   * the first three, and this adapter captures the writes.
   * @param {Request} request
   * @returns {Response | undefined} the response to send instead of the document.
   */
  const authorize = request => {
    let status = 401
    let headers = new Headers()
    /** @type {string | undefined} */
    let body
    const handled = ctx.connection.authorizeIndex(request, {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus
        headers = new Headers(nextHeaders)
      },
      end(text) {
        body = text
      },
    })
    if (handled) return undefined
    return new Response(body ?? null, { status, headers })
  }

  ctx.effect(() => ctx.webServer.registerFallback({
    resource: (request) => {
      // Only the entry path belongs to the cookie exchange; anything else is a
      // browser asset this node does not have.
      const path = new URL(request.url).pathname
      if (path !== '/' && path !== '/index.html') return Promise.resolve(new Response(null, { status: 404 }))
      const denied = authorize(request)
      if (denied !== undefined) return Promise.resolve(denied)
      // The token was accepted and the cookie is set; there is no page to render.
      return Promise.resolve(new Response(
        'the brain serves the Remote API only; there is no browser UI here\\n',
        { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } },
      ))
    },
  }), 'brain-runtime: index seat')
}

/**
 * Mount the brain runtime.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {{ printUrl?: boolean }} [config] - resolved row config.
 */
export function apply(ctx, config) {
  const printUrl = config?.printUrl !== false
  // The advertised root: \`--public-url\` when given, otherwise the listener's origin.
  const appRootUrl = () => ctx.webStartup.publicUrl ?? ctx.webServer.getOrigin()

  // \`webApp.getAdvertisedUrl()\` is the Host's own answer to "where is this served
  // from". A brain has no GUI, but the service is part of the Host contract — other
  // rows and Remote callers read it — so it is provided rather than omitted.
  ctx.provide(WEB_APP_SERVICE, { getAdvertisedUrl: appRootUrl })

  // The cookie exchange lives on the fallback seat, which nothing else claims on a
  // brain (no dist server is composed), and the launch token lives on \`connection\`.
  // One injection covers both: a brain composed without \`connection\` still serves
  // the API to a caller that supplies its own credentials, instead of failing the
  // whole composition at load time.
  ctx.inject(['connection'], connectionCtx => {
    claimIndexSeat(connectionCtx)

    if (!printUrl) return
    const announce = () => {
      console.log(\`dsh web: \${connectionCtx.connection.authenticatedUrl(appRootUrl())}\`)
    }
    // Print after the Loader settles so the line describes a fully composed Host.
    // The publication is what the desktop app and this plugin's daemon both parse.
    const settled = connectionCtx.get('loader')?.await()
    if (settled === undefined) {
      announce()
      return
    }
    connectionCtx.effect(() => {
      let live = true
      void settled.then(() => {
        if (live) announce()
      }).catch(() => {
        // The Loader owns startup diagnostics; a failed composition prints nothing
        // here and the launcher reports why.
      })
      return () => { live = false }
    }, 'brain-runtime: announce entry URL')
  })
}
`,
})
