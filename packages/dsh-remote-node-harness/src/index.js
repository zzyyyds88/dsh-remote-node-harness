/**
 * `@greatbaby/dsh-remote-node-harness` Host half: remote Linux machines as first-class workspaces.
 *
 * The architectural choice this plugin makes is the one that decides whether
 * remote tools work: **the brain stays on the node**. Each machine runs its own
 * DeepSeek Harness host, so `bash`, `grep`, `git`, `read_image`, PTYs, MCP servers
 * and skills all execute there, against that machine's filesystem and binaries,
 * with nothing mirrored, translated or proxied.
 *
 * The local Host is the *conductor*: it keeps one warm SSH connection per node,
 * routes the four Remote namespaces that name a Session or a Workspace
 * (`session`, `workspace`, `workspaceFiles`, `terminal`) to the node that owns the
 * identity, and merges every node's workspaces into the one `workspace/follow`
 * stream the local sidebar already renders.
 *
 * Concretely that means a remote Session appears in the local sidebar as a real
 * Session with a real history, so `ds-harness-remote` forwards it to a phone
 * without knowing this plugin exists — its `session/list`, `session/follow` and
 * `session/prompt` endpoints simply answer with more rows and route accordingly.
 *
 * Routing never touches a class, a Loader row or an upstream import: each
 * replacement is an own property on the live Service instance, which the Gateway
 * resolves at dispatch time and ignores during discovery. Undecorated endpoints
 * keep their exact upstream behaviour.
 *
 * @module @greatbaby/dsh-remote-node-harness
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiError, describeFailure, readJsonBody, sendJson } from './core/http-error.js'
import { classifyFailure } from './core/errors.js'
import { decideGate } from './core/version.js'
import { Rnh, BRAIN_BUNDLES } from './host/rnh.js'
import { NODE_STATUS_KIND, STATUS_EVENT } from './host/node-status.js'
import { RnhControl } from './host/rnh-control.js'
import {
  ensureRemoteDirectory,
  isPosixAbsolute,
  listLocal,
  listRemote,
  makeLocalDirectory,
  makeRemoteDirectory,
} from './host/browse.js'
import { RemoteControl } from './host/remote-control.js'
import { RemoteEvents } from './host/remote-events.js'
import { RemoteWaterfalls } from './host/remote-waterfall.js'
import { RemoteWorkspaces } from './host/remote-workspaces.js'
import { Router } from './host/router.js'
import { SyncSwitches } from './host/sync-switches.js'
import { applyRelayPatch } from './host/relay-patch.js'
import { overrideAgentLookup, overrideWorkspaceFileScope } from './host/lookups.js'
import {
  decorateDirectoryPickerController,
  decorateJobController,
  decorateSessionController,
  decorateSessionQuery,
  decorateTerminalController,
  decorateTeamService,
  decorateWorkspaceController,
  decorateWorkspaceFiles,
} from './host/decorators.js'
import {
  decorateAgentPresets,
  decorateCommands,
  decorateFileReferences,
  decorateGoals,
  decorateMessageFeedback,
  decorateSchedule,
  decorateSessionReferenceResolver,
  decorateSubagents,
  decorateUserQuestions,
} from './host/decorators-extra.js'
// `router.toLocalWorkspace` handles workspace identities; this import keeps the
// management route honest about which identities it answers for.
import { decodeRemoteId } from './host/routing.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-remote-node-harness'

/** Every service this plugin reads; all ship with a standard Host. */
export const inject = ['webServer', 'credentials']

/** Where the settings surface talks to this plugin. */
const API_MOUNT = '/rnh/api'

/**
 * This plugin's own version, which doubles as the brain build's.
 *
 * The bundle a node receives is generated from this package (`embed-into-rnh.mjs`),
 * so the two always ship together and one number describes both. It is read from the
 * package manifest rather than hard-coded so a release bump cannot forget it.
 */
function localBrainVersion() {
  try {
    const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (typeof manifest.version === 'string') return manifest.version
  } catch {
    // An unreadable manifest is not worth failing the whole plugin over; the version
    // gate degrades to "unknown brain build", which triggers a refresh.
  }
  return '0.0.0'
}

/**
 * Read the DSH version this profile runs, so every node is installed to match.
 * A version skew between Host and node would desynchronise the Session format.
 */
function localDshVersion() {
  const installDir = process.env.DSH_INSTALL_DIR
  if (typeof installDir === 'string' && installDir.length > 0) {
    try {
      const manifest = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8'))
      if (typeof manifest.version === 'string') return manifest.version
    } catch {
      // Fall through to the version the Desktop shell publishes.
    }
  }
  return process.env.DSH_CLIENT_VERSION ?? '0.0.0'
}

/**
 * Register the plugin: durable node records, live connections, the routing
 * decorators, and the management API a settings surface reads.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ enabled?: boolean, autoConnect?: boolean, sources?: Array<{kind: 'prefix' | 'template', prefix?: string, template?: string}> }} [config]
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const log = message => ctx.logger?.info?.(message)
  const version = localDshVersion()
  const brainVersion = localBrainVersion()
  /** @type {SyncSwitches | undefined} — composed once `configEditor` exists. */
  let switches
  /**
   * The live Workspace controller.
   *
   * The management surface needs it for one thing the shell cannot do: naming a local
   * workspace at creation time. Held here rather than reached for on every request,
   * because a Host without that row must answer "not composed yet" instead of throwing.
   * @type {object | undefined}
   */
  let workspaceController
  const rnh = new Rnh({
    credentials: ctx.credentials,
    version,
    brainVersion,
    sources: config.sources,
    configEditor: () => configEditor,
    // Read on every connect and every sync: a switch flipped in the settings surface has
    // to reach a running node now, not on the next connect.
    nodeBundles: () => switches?.nodeBundles() ?? BRAIN_BUNDLES,
    pluginSpecs: () => switches,
    log,
  })
  const workspaces = new RemoteWorkspaces(rnh)
  const router = new Router({ rnh, log })
  const control = new RemoteControl(rnh, router, log)
  /** @type {Array<() => void>} */
  const disposers = []
  // The service a node-control agent session acts through. Narrow on purpose: it exposes
  // the node registry and nothing else, so "this session may only manage nodes" is a
  // property of the surface rather than a rule in a prompt. `ctx.provide` registers a
  // fiber-owned effect, so unloading this plugin removes the service on its own.
  ctx.provide('rnhControl', new RnhControl({ rnh, log }))

  /**
   * Let routed Sessions read their own files through the relay.
   *
   * The relay authorises file reads against **this** machine's filesystem before it
   * dispatches, so a remote Session (`cwd` on the node) is refused with
   * `WORKSPACE_UNAVAILABLE` before rnh ever sees the call. The fix is a small edit to the
   * *installed* relay bundle; the upstream repositories stay untouched, and the edit is
   * re-checked on every Host start because a relay upgrade replaces those bytes. Why it
   * cannot be solved any other way, and what happens when an anchor disappears, is in
   * `docs/adr-0008-relay-artifact-patch.zh.md`.
   */
  const relay = config.relayPatch === false
    ? { installed: null, patched: false, reason: 'disabled by config (relayPatch: false)' }
    : applyRelayPatch({
      // `profileContext` is the composition's own record of which profile this Host is;
      // `DSH_PROFILE_DIR` is the same fact when a caller started it from a shell.
      profileDir: ctx.get('profileContext')?.dir ?? process.env.DSH_PROFILE_DIR,
      log,
    })
  if (relay.patched !== true && relay.reason !== undefined) {
    log(`rnh: routed Sessions cannot read files through the relay — ${relay.reason}`)
  }

  /** One request handler over the management API, with uniform failures. */
  const guard = handler => async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      const failure = describeFailure(error)
      log(`rnh api: ${failure.error}`)
      sendJson(res, failure.status, { ok: false, code: failure.code, error: failure.error })
    }
  }

  // ---- Management API -------------------------------------------------------
  disposers.push(ctx.webServer.register({
    kind: 'prefix',
    path: API_MOUNT,
    handler: guard(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const segments = url.pathname.slice(API_MOUNT.length).split('/').filter(Boolean)
      const [head, id, action] = segments

      if (head === 'nodes' && id === undefined) {
        if (req.method === 'GET') {
          sendJson(res, 200, {
            ok: true,
            version,
            local: { version, role: 'conductor', relay },
            nodes: rnh.list().map(runtime => runtime.describe()),
          })
          return
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          const node = body.node ?? body
          const runtime = await rnh.put(node)
          sendJson(res, 200, { ok: true, node: runtime.describe() })
          return
        }
        throw apiError('method-not-allowed', 'use GET or POST on the node collection', 405)
      }

      if (head === 'nodes' && id !== undefined && action === undefined) {
        if (req.method === 'DELETE') {
          const removed = await rnh.remove(id)
          sendJson(res, removed ? 200 : 404, { ok: true })
          return
        }
        const runtime = rnh.get(id)
        if (runtime === undefined) throw apiError('node-not-found', `no node ${id}`, 404)
        if (req.method === 'PATCH' || req.method === 'POST') {
          const body = await readJsonBody(req)
          const node = body.node ?? body
          const updated = await rnh.put({ ...runtime.record, ...node })
          sendJson(res, 200, { ok: true, node: updated.describe() })
          return
        }
        sendJson(res, 200, { ok: true, node: runtime.describe() })
        return
      }

      if (head === 'nodes' && id !== undefined) {
        const runtime = rnh.get(id)
        if (runtime === undefined) throw apiError('node-not-found', `no node ${id}`, 404)
        // `log` is the one action that is a **read**: the card polls it while a node is
        // failing, and a GET is what `fetch` sends when no `init` is passed. Gating it behind
        // POST made the button answer 405 every time — measured against a running Host:
        // `GET /rnh/api/nodes/<id>/log` → `{"code":"method-not-allowed","error":"node actions
        // use POST"}`. Everything that changes a node stays POST-only.
        if (action === 'log') {
          // The node's own recent lines, redacted on write (see host/node-log.js).
          if (req.method !== 'GET' && req.method !== 'POST') {
            throw apiError('method-not-allowed', 'read the node log with GET', 405)
          }
          sendJson(res, 200, { ok: true, id, lines: runtime.logs.lines(), text: runtime.logs.text() })
          return
        }
        if (req.method !== 'POST') throw apiError('method-not-allowed', 'node actions use POST', 405)
        if (action === 'connect') {
          // Answer at once; the settings surface polls while the node comes up.
          setImmediate(() => { void rnh.connect(runtime).catch(() => undefined) })
          sendJson(res, 202, { ok: true, node: runtime.describe() })
          return
        }
        if (action === 'disconnect') {
          sendJson(res, 200, { ok: true, node: await rnh.disconnect(runtime) })
          return
        }
        if (action === 'probe') {
          // A probe is a **fact about the machine**, not a lifecycle event of its own: it
          // refreshes the cached `facts` either way, and only a failure has to change what the
          // card says. Dispatching it instead of assigning a field is what keeps `state` from
          // saying "green" after the machine stopped answering (the old route left it unchanged
          // and answered 500, so the card kept a green dot over an unreachable host).
          try {
            runtime.facts = await runtime.host.probe()
            runtime.dispatch({ type: STATUS_EVENT.PROBE_FINISHED, ok: true })
          } catch (error) {
            runtime.dispatch({
              type: STATUS_EVENT.PROBE_FINISHED,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              failure: classifyFailure(error, { phase: 'probe' }),
            })
            throw error
          }
          sendJson(res, 200, { ok: true, node: runtime.describe() })
          return
        }
        if (action === 'forget-host-key') {
          // The one recovery a host-key mismatch has. `normalizeNode` keeps `hostKey` only
          // when it is a non-empty string, so passing `null` drops the record and the next
          // connect trusts whatever the machine presents — the same TOFU rule as the first
          // connect, which is what "review and accept the new key" has to mean in a surface
          // with no side-by-side comparison dialog.
          const cleared = await rnh.put({ ...runtime.record, hostKey: null })
          sendJson(res, 200, { ok: true, node: cleared.describe() })
          return
        }
        if (action === 'reinstall') {
          // **Events only, and inside the serial queue.** The reinstall used to write
          // `runtime.phase` from here, outside the queue and without the phase clock or a
          // publish — so the settings page could read `connecting`/`install` with no start time,
          // or miss the whole thing, a failed reinstall left no failure on the card (A3's status
          // half), and a concurrent connect raced it. Every fact this route learns is now an
          // event the state machine owns, delivered where the connect path delivers its own.
          const node = await rnh.serial(runtime, async () => {
            const wasConnected = runtime.status.kind === NODE_STATUS_KIND.CONNECTED
            const started = runtime.dispatch({ type: STATUS_EVENT.REINSTALL_REQUESTED })
            await Promise.allSettled(started.pending)
            try {
              runtime.facts = await runtime.host.probe()
              // Same gate as a connect: a reinstall is a forced provisioning, not a
              // way to bypass the version check.
              const installed = await runtime.host.inspectRuntime()
              const decision = decideGate({
                hostVersion: version,
                hostBrain: brainVersion,
                nodeVersion: installed.version,
                // No independent brain version on the node: see the long note in
                // `host/rnh.js` (the bundle is written as files, its stamp is a content digest).
                nodeBrain: undefined,
                nodeRuntime: installed.usable ? undefined : installed.reason,
                nodeVia: installed.via,
              })
              runtime.dispatch({ type: STATUS_EVENT.GATE_DECIDED, gate: decision })
              if (decision.action === 'ahead' || decision.action === 'unknown') {
                throw apiError('node-ahead', decision.message, 409)
              }
              const reinstalled = await runtime.host.install(runtime.facts, {
                sources: config.sources,
              })
              runtime.dispatch({ type: STATUS_EVENT.RUNTIME_ROUTE_KNOWN, via: reinstalled.via })
              // **The running resident host is the old tree.** Replacing the files on disk while
              // the process keeps running is the A3 defect: `serving` names a pid whose modules
              // were already removed, so the node looks connected and serves nothing. A connected
              // node is therefore restarted onto the tree that was just installed, and the new
              // endpoint travels with the finish event.
              const service = wasConnected
                ? await runtime.host.ensureServing({ force: true })
                : undefined
              runtime.dispatch({ type: STATUS_EVENT.REINSTALL_FINISHED, service })
            } catch (error) {
              runtime.dispatch({
                type: STATUS_EVENT.REINSTALL_FAILED,
                error: error instanceof Error ? error.message : String(error),
                failure: classifyFailure(error, { phase: 'install' }),
              })
              throw error
            }
            return runtime.describe()
          })
          sendJson(res, 200, { ok: true, node })
          return
        }
        throw apiError('action-not-found', `unknown node action ${action}`, 404)
      }

      if (head === 'workspaces' && id === undefined) {
        if (req.method === 'GET') {
          await workspaces.sync()
          sendJson(res, 200, { ok: true, baseline: workspaces.baseline() })
          return
        }
        if (req.method === 'POST') {
          // Register a folder as a workspace, on either machine.
          //
          // A remote folder is the case the shell cannot do at all: only that machine's
          // Host can register a directory there. A local folder only comes through here
          // when the person typed a name — the shell creates the row itself and takes the
          // title from the folder name, so naming one is the one thing left over.
          const body = await readJsonBody(req)
          const nodeId = typeof body.nodeId === 'string' && body.nodeId.length > 0 ? body.nodeId : undefined
          const path = typeof body.path === 'string' ? body.path.trim() : ''
          // The name a person typed. Upstream derives a Workspace's title from the
          // folder name and has no create-time title, so a custom name is a rename
          // applied to the row we just created — the node records one workspace
          // either way, and the sidebar shows what was asked for.
          const title = typeof body.title === 'string' ? body.title.trim() : ''
          if (path.length === 0) throw apiError('path-required', 'a folder path is required', 400)
          if (nodeId === undefined) {
            // A local folder, reached only because a name was asked for: without one the
            // picker hands the path straight to the shell, which creates the row itself.
            // Answering a nameless local request here would silently take over a job the
            // shell already owns, so it stays refused exactly as it was.
            if (title.length === 0) {
              throw apiError('node-required', 'name the node this directory lives on', 400)
            }
            if (workspaceController === undefined) {
              throw apiError('not-composed', 'the workspace controller is not available yet', 503)
            }
            let value = await workspaceController.create({ path })
            const createdId = Reflect.get(Reflect.get(value ?? {}, 'workspace') ?? {}, 'workspaceId')
            if (typeof createdId === 'string') {
              value = await workspaceController.rename({ workspaceId: createdId, title })
            }
            sendJson(res, 200, { ok: true, ...value })
            return
          }
          if (!isPosixAbsolute(path)) {
            throw apiError('path-invalid', 'a remote workspace path must be absolute, e.g. /root/project', 400)
          }
          const runtime = rnh.get(nodeId)
          if (runtime === undefined) throw apiError('node-not-found', `no node ${nodeId}`, 404)
          if (!runtime.routable) throw apiError('node-offline', `${runtime.record.name} is not connected`, 409)
          // Make the directory on the node first, exactly as the `workspace/create` decorator
          // does for the same request. Without this the two entry points disagree: the phone
          // and the picker can create a workspace at a path that is not there yet, while this
          // settings-page form answered `ENOENT: realpath` — measured, and it read like a
          // broken API rather than a missing step.
          try {
            await ensureRemoteDirectory(runtime.connection, path)
          } catch (error) {
            throw apiError('create-failed', error instanceof Error ? error.message : String(error), 400)
          }
          let value = await router.call(nodeId, 'workspace/create', { request: { path } })
          const createdId = Reflect.get(Reflect.get(value ?? {}, 'workspace') ?? {}, 'workspaceId')
          if (title.length > 0 && typeof createdId === 'string') {
            // A rename that fails must not lose the workspace that was just created:
            // report the row, and let the surface show its own default name.
            try {
              value = await router.call(nodeId, 'workspace/rename', {
                request: { workspaceId: createdId, title },
              })
            } catch (error) {
              log(`rnh: created ${path} on ${nodeId} but could not name it: ${error.message}`)
            }
          }
          await workspaces.sync()
          // Same shape as the `workspace/create` decorator returns, because the surface
          // reads one shape: `{workspace, created}`. Wrapping the whole reply rather than
          // its `.workspace` left the identity one level too deep, and a caller asking for
          // `workspace.workspaceId` got `undefined` from a request that had succeeded.
          sendJson(res, 200, { ok: true, ...router.toLocalWorkspace(value, nodeId) })
          return
        }
        throw apiError('method-not-allowed', 'use GET or POST on the workspace collection', 405)
      }

      // ---- Browsing folders to make a workspace from --------------------------
      // One endpoint for both sides, because the picker offers both: with no `nodeId` it
      // lists this machine, with one it lists that node over the SSH connection this
      // plugin already holds. The answer has the same shape either way, so the surface
      // has one rendering path — that is what makes a remote folder feel like a local one.
      //
      // `POST` on the same path creates one folder inside the directory being shown: the
      // picker needs to make a project directory without leaving the dialog, on both
      // sides. The name is one path segment and the parent is whatever the dialog is
      // displaying, so a caller cannot create outside it.
      if (head === 'browse' && id === undefined) {
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          const nodeId = typeof body.nodeId === 'string' && body.nodeId.length > 0 ? body.nodeId : undefined
          const parent = typeof body.path === 'string' ? body.path.trim() : ''
          const name = typeof body.name === 'string' ? body.name : ''
          let created
          try {
            if (nodeId === undefined) {
              created = await makeLocalDirectory(parent, name)
            } else {
              const runtime = rnh.get(nodeId)
              if (runtime === undefined) throw apiError('node-not-found', `no node ${nodeId}`, 404)
              if (!runtime.routable) throw apiError('node-offline', `${runtime.record.name} is not connected`, 409)
              created = await makeRemoteDirectory(runtime.connection, parent, name)
            }
          } catch (error) {
            if (error?.code === 'node-not-found' || error?.code === 'node-offline') throw error
            const code = error?.code === 'name-invalid' || error?.code === 'path-invalid' ? 'name-invalid' : 'create-failed'
            throw apiError(code, error instanceof Error ? error.message : String(error), 400)
          }
          sendJson(res, 200, { ok: true, nodeId, path: created, parent })
          return
        }
        if (req.method !== 'GET') throw apiError('method-not-allowed', 'use GET to browse folders, POST to create one', 405)
        const nodeId = url.searchParams.get('node') ?? undefined
        const path = url.searchParams.get('path') ?? ''
        if (nodeId === undefined || nodeId.length === 0) {
          let listing
          try {
            listing = await listLocal(path)
          } catch (error) {
            throw apiError('browse-failed', error instanceof Error ? error.message : String(error), 400)
          }
          sendJson(res, 200, { ok: true, nodeId: undefined, ...listing })
          return
        }
        const runtime = rnh.get(nodeId)
        if (runtime === undefined) throw apiError('node-not-found', `no node ${nodeId}`, 404)
        let listing
        try {
          listing = await listRemote(runtime.connection, path)
        } catch (error) {
          throw apiError('browse-failed', error instanceof Error ? error.message : String(error), 400)
        }
        sendJson(res, 200, { ok: true, nodeId, ...listing })
        return
      }

      if (head === 'workspaces' && id !== undefined && req.method === 'POST' && action === 'rename') {
        const decoded = decodeRemoteId(id)
        if (decoded === undefined) throw apiError('workspace-local', 'this is not a remote workspace', 400)
        const body = await readJsonBody(req)
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        if (title.length === 0) throw apiError('title-required', 'a title is required', 400)
        const value = await router.call(decoded.nodeId, 'workspace/rename', {
          request: { workspaceId: decoded.remoteId, title },
        })
        await workspaces.sync()
        sendJson(res, 200, { ok: true, workspace: router.toLocalWorkspace(value, decoded.nodeId) })
        return
      }

      if (head === 'workspaces' && id !== undefined) {
        throw apiError('not-supported', 'remove a remote workspace from its own Harness', 400)
      }

      // ---- Per-plugin sync switches -------------------------------------------
      // One row per plugin **this desktop installed**, with two independent facts: the
      // effective switch (what a node loads) and where that answer came from. The unit is
      // the bundle, not the internal service row — a person installs plugins, and 207
      // toggles describing the composition is not a decision anyone can make.
      if (head === 'plugins' && id === undefined) {
        if (req.method === 'GET') {
          if (switches === undefined) {
            throw apiError('not-ready', 'the plugin list is not composed yet; retry in a moment', 503)
          }
          sendJson(res, 200, { ok: true, rows: switches.list() })
          return
        }
        throw apiError('method-not-allowed', 'use GET on the plugin collection', 405)
      }

      if (head === 'plugins' && id !== undefined) {
        if (switches === undefined) {
          throw apiError('not-ready', 'the plugin list is not composed yet; retry in a moment', 503)
        }
        if (req.method !== 'POST') throw apiError('method-not-allowed', 'switch a plugin with POST', 405)
        const body = await readJsonBody(req)
        if (typeof body.sync !== 'boolean') {
          throw apiError('sync-required', 'a `sync` boolean is required', 400)
        }
        const bundle = decodeURIComponent(id)
        const row = switches.set(bundle, body.sync)
        // Answer with what each node actually did, not with "accepted": switching a plugin
        // on installs a package over SSH, which can fail on the node's own registry, and a
        // checkbox that reports success while the node composes nothing is the exact bug
        // this surface exists to prevent.
        let applied
        try {
          applied = await rnh.syncConfig('plugin switches changed')
        } catch (error) {
          throw apiError('sync-failed', error instanceof Error ? error.message : String(error), 502)
        }
        const failures = applied.filter(report => report.error !== undefined || (report.plugins?.failed.length ?? 0) > 0)
        sendJson(res, 200, {
          ok: true,
          row,
          nodes: applied.map(report => ({
            id: report.id,
            name: report.name,
            ...(report.error === undefined ? {} : { error: report.error }),
            ...(report.plugins === undefined ? {} : { plugins: report.plugins }),
            ...(report.bundles === undefined ? {} : { bundles: report.bundles }),
          })),
          ...(failures.length === 0 ? {} : {
            warning: `${String(failures.length)} node(s) did not take the change`,
          }),
        })
        return
      }

      throw apiError('route-not-found', `no rnh route for ${req.method ?? 'GET'} ${url.pathname}`, 404)
    }),
  }))

  // ---- Routing decorators ---------------------------------------------------
  // Installed once the Host has composed the controllers they decorate. A missing
  // service (a --no-web composition) simply leaves routing absent rather than
  // failing the plugin.
  ctx.inject(['sessionController', 'workspaceController', 'workspaceFiles'], scope => {
    const session = scope.get('sessionController')
    const workspace = scope.get('workspaceController')
    const files = scope.get('workspaceFiles')
    if (session === undefined || workspace === undefined || files === undefined) return
    workspaceController = workspace
    const undo = [
      decorateSessionController(session, router, workspaces, control),
      decorateWorkspaceController(workspace, router, workspaces),
      decorateWorkspaceFiles(files, router),
    ]
    // The job roster is how a remote Session's background work shows up in its
    // panel; without this a node's job list reads as empty, which is
    // indistinguishable from "this Session started nothing".
    const jobs = scope.get('jobController')
    if (jobs !== undefined) undo.push(decorateJobController(jobs, router))
    const terminal = scope.get('terminalController')
    if (terminal !== undefined) undo.push(decorateTerminalController(terminal, router))
    // The composer's 智能体协作 switch names a remote Session's Agent, which only the
    // node that hosts it can act on. See `decorateTeamService` for why the
    // placeholder Agent is not enough on its own.
    const teams = scope.get('agentTeams')
    if (teams !== undefined) undo.push(decorateTeamService(teams, router))
    // A remote Session's events are not in this Host's query engine, so the route that
    // backs "open in file manager" could not find the event it was asked about and
    // answered 404. See `decorateSessionQuery` for the read it now gets instead.
    const query = scope.get('sessionQuery')
    if (query !== undefined) undo.push(decorateSessionQuery(query, router))
    // A remote Session id is not a local Session, so the Gateway's own lookup
    // cannot resolve a file scope for it; teach that lookup about wrapped ids.
    const undoLookup = overrideWorkspaceFileScope(scope)
    // The same problem one level up: every `agent: Agent` parameter is resolved from
    // `agentId` before the method runs, so `terminal/create|attach|close|…` fails for
    // a remote Session before its decorator can route anything.
    const undoAgent = overrideAgentLookup(scope)
    // The remaining identity-carrying namespaces. Each one is installed from its **own**
    // `ctx.inject`, not from a `scope.get` inside this block: a service the composition
    // mounts later would never be seen here, and the failure mode is silent — the namespace
    // keeps answering from this Host, which for a remote Session is a confidently wrong
    // answer rather than an error.
    for (const [name, decorate] of [
      ['goals', decorateGoals],
      ['userQuestions', decorateUserQuestions],
      ['subagents', decorateSubagents],
      ['commands', decorateCommands],
      ['messageFeedback', decorateMessageFeedback],
      ['sessionReferenceResolver', decorateSessionReferenceResolver],
      ['sessionFileReferences', decorateFileReferences],
      ['schedule', service => decorateSchedule(service, router, { log })],
      // The mode seat in the composer recomposes an Agent; for a remote Session
      // only its node can do that. See `decorateAgentPresets`.
      ['agentPresets', decorateAgentPresets],
    ]) {
      ctx.inject([name], inner => {
        const service = inner.get(name)
        if (service === undefined) {
          console.log(`rnh: ${name} is not composed; it stays local`)
          return
        }
        try {
          const restore = decorate(service, router)
          console.log(`rnh: routing ${name}`)
          inner.effect(() => () => {
            try { restore() } catch { /* the instance may already be disposed */ }
          }, `dsh-remote-node-harness: ${name} routing`)
        } catch (error) {
          // Say so once, at load: a namespace that merely *looks* routed is the failure
          // this whole module exists to prevent.
          console.log(`rnh: could not route ${name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
    }
    log(`rnh: routing session, workspace, workspaceFiles${jobs === undefined ? '' : ', job'}${terminal === undefined ? '' : ', terminal'}`)
    scope.effect(() => () => {
      for (const restore of undo) {
        try { restore() } catch { /* the instance may already be disposed */ }
      }
      try { undoLookup?.() } catch { /* already gone */ }
      try { undoAgent?.() } catch { /* already gone */ }
      workspaceController = undefined
    }, 'dsh-remote-node-harness: routing decorators')
  })

  // ---- Directory picking ------------------------------------------------------
  // A Remote caller's in-app browser asks this Host for absolute paths, so a node has to
  // be addressable inside that syntax (see `host/picker-paths.js`). The service is not
  // guaranteed to be composed — a `--no-web` Host has no picker at all — so it is read
  // optionally rather than added to `inject`, where its absence would fail the plugin.
  ctx.inject(['directoryPickerController'], scope => {
    const picker = scope.get('directoryPickerController')
    if (picker === undefined) return
    const undo = decorateDirectoryPickerController(picker, router)
    log('rnh: routing directoryPicker (nodes are browsable as /@rnh/<nodeId>/…)')
    scope.effect(() => () => {
      try { undo() } catch { /* the instance may already be disposed */ }
    }, 'dsh-remote-node-harness: directory picker')
  })

  // ---- Provisioning ---------------------------------------------------------
  // A node is a separate DSH installation, so it needs this Host's model rows and
  // API keys to be usable as a brain. `configEditor` only exists once the Host has
  // composed it; until then the accessor returns `undefined` and provisioning
  // degrades to "start the node as-is" instead of failing the connection.
  /** @type {object | undefined} */
  let configEditor
  ctx.inject(['configEditor'], scope => {
    configEditor = scope.get('configEditor')
    // The switch list describes what this desktop installed, so it can only be built once
    // the profile is known. Until then a node composes `BRAIN_BUNDLES`, which is the
    // "nothing extra was chosen" answer.
    switches = new SyncSwitches({
      home: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
      // Read through the live profile context rather than `DSH_HOME` alone: `--profile`
      // is how this Host was launched, and `$DSH_HOME/profiles/<name>` would need the
      // name duplicated here.
      profileDir: () => ctx.get('profileContext')?.dir,
      log,
    })
  })

  // ---- Keeping connected nodes in step --------------------------------------
  // The local Host is the only source of truth for "which model, whose key", so a
  // change here has to reach a running node without asking the user to reconnect.
  // Two upstream signals cover every way that configuration can change:
  //
  //   `app-boot/config-reload`        — emitted after `configEditor` rewrites config
  //   `credentials/reference-updated` — emitted when a key value is written
  //
  // Both are plain Cordis events, so subscribing needs no upstream import. The sync
  // itself writes the node's *profile* patch, which the node host hot-reloads
  // (see `docs/adr-0001`) — no restart, no dropped session.
  //
  // `app-boot/config-reload` fires while the Loader is still settling and
  // `credentials/reference-updated` can fire several times for one edit, so the sync
  // is coalesced onto one timer rather than run per event. Reading configuration
  // synchronously inside the event would see a half-applied composition.
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let pendingSync
  const scheduleSync = reason => {
    clearTimeout(pendingSync)
    pendingSync = setTimeout(() => {
      void rnh.syncConfig(reason).catch(error => log(`rnh: config sync failed: ${error.message}`))
    }, 250)
    pendingSync.unref?.()
  }
  for (const event of ['app-boot/config-reload', 'credentials/reference-updated']) {
    ctx.on(event, () => scheduleSync(event))
  }

  // ---- Node events -----------------------------------------------------------
  // `session/list` and `workspace/follow` are snapshots. The sidebar also *listens*:
  // upstream's client half keeps its list live from five `api-session/*` events, and
  // a remote Session emits none locally. This relays a node's forwarded-event stream
  // into this Host's own bus with the identities wrapped, so a remote row updates
  // through exactly the path a local one uses.
  //
  // The same stream carries the two scoped waterfalls — `approval/request` and
  // `user-questions/request`. Those need the Gateway the Host composed, so the relay
  // is created inside `inject` and this holder starts out empty; until it exists the
  // older behaviour (answer with the node's default) still applies.
  /** @type {import('./host/remote-waterfall.js').RemoteWaterfalls | undefined} */
  let waterfalls
  const remoteEvents = new RemoteEvents(rnh, router, {
    emit: (event, args) => ctx.emit(event, ...args),
    log,
  }, {
    forNode: runtime => waterfalls?.forNode(runtime),
  })
  ctx.inject(['typertGateway'], scope => {
    const gateway = scope.get('typertGateway')
    if (gateway === undefined) return
    waterfalls = new RemoteWaterfalls(rnh, router, gateway, { log })
    waterfalls.sync()
    remoteEvents.adopt(waterfalls)
    scope.effect(() => () => {
      waterfalls?.dispose()
      waterfalls = undefined
    }, 'dsh-remote-node-harness: relayed waterfalls')
  })

  // ---- Boot and teardown ----------------------------------------------------
  // One subscription drives every merged picture that is *not* a per-call read:
  // the forwarded events, the per-Session control blocks, and the workspace
  // registry. The workspace half belongs here for the same reason the other two
  // do — a page that attached before the node connected never reads the merged
  // baseline again, so without this its sidebar keeps the pre-connect picture
  // until someone reloads. Measured: a node that finished connecting four
  // seconds after the page painted showed no workspaces at all; reloading the
  // same page showed every one of them.
  //
  // `sync()` is idempotent and publishes only when the node set or a node's row
  // count actually changed, so a noisy lifecycle event costs nothing.
  disposers.push(rnh.subscribe(() => {
    remoteEvents.sync()
    control.sync()
    void workspaces.sync().catch(error => {
      log(`rnh: refreshing merged workspaces failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }))
  disposers.push(ctx.effect(() => () => {
    remoteEvents.dispose()
    control.dispose()
  }, 'dsh-remote-node-harness: node events and control'))

  disposers.push(ctx.effect(() => {
    if (config.autoConnect === false) return () => undefined
    const timer = rnh.autoConnect(2_000)
    return () => clearTimeout(timer)
  }, 'dsh-remote-node-harness: automatic connection'))

  disposers.push(ctx.effect(() => () => {
    clearTimeout(pendingSync)
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* already disposed */ }
    }
    router.dispose()
    workspaces.dispose()
    rnh.dispose()  }, 'dsh-remote-node-harness: routes and connections'))
}
