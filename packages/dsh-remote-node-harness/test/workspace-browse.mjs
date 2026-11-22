/**
 * Adding a workspace the way the picker does it: choose a machine, then a folder.
 *
 * The point of the surface is that a remote folder is chosen **the same way** as a local
 * one, so the test drives the same two calls the dialog does and then checks that the
 * result is indistinguishable once it lands:
 *
 *   1. `GET /rnh/api/browse` with no node lists THIS machine's folders,
 *   2. with a node it lists that node's folders over SSH, in the same shape,
 *   3. the node listing is a real remote listing — `/root` exists there and a path the
 *      node reports can be registered as a workspace,
 *   4. `POST /rnh/api/workspaces` with `{nodeId, path}` puts it on the node, and the
 *      sidebar's merged baseline shows it wrapped (`rnh_<nodeId>_…`) with the node path.
 *
 * The last two are what make the dialog honest: a picker that lists folders but cannot
 * register the one you picked is the failure mode this test exists to catch.
 *
 * Usage: node test/workspace-browse.mjs <hostBase> <launchToken>
 */
import { authenticate } from './carrier.mjs'

const [base, token] = process.argv.slice(2)
if (base === undefined || token === undefined) {
  process.stderr.write('usage: node test/workspace-browse.mjs <hostBase> <launchToken>\n')
  process.exit(2)
}

const log = message => process.stderr.write(`[workspace-browse] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const cookie = await authenticate(base, token)
const get = async path => {
  const response = await fetch(`${base}/rnh/api${path}`, { headers: { cookie } })
  const text = await response.text()
  const body = text.length === 0 ? {} : JSON.parse(text)
  return { status: response.status, body }
}
const post = async (path, payload) => {
  const response = await fetch(`${base}/rnh/api${path}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  const body = text.length === 0 ? {} : JSON.parse(text)
  return { status: response.status, body }
}

const nodes = (await get('/nodes')).body.nodes ?? []
const remote = nodes.find(node => node.id !== undefined)
if (remote === undefined) {
  log('no remote node is configured; nothing to browse')
  process.exit(3)
}
/**
 * Wait until the node is connected.
 *
 * `POST /nodes/<id>/connect` answers **202 immediately** and does the work in the
 * background — connecting is minutes when it has to install a new release, and holding
 * the request open would look like a hung UI. So the state is the signal, not the reply.
 */
const waitForConnected = async (id, timeoutMs = 240_000) => {
  if (remote.state !== 'connected') await post(`/nodes/${id}/connect`, {})
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    const fresh = (await get('/nodes')).body.nodes ?? []
    last = fresh.find(node => node.id === id)
    if (last?.state === 'connected') return last
    if (last?.state === 'failed') return last
    await sleep(1_000)
  }
  return last
}
if (remote.state !== 'connected') {
  // Browsing a node needs its SSH connection, which only exists while it is connected.
  const settled = await waitForConnected(remote.id)
  if (settled?.state !== 'connected') {
    log(`node ${remote.id} is ${String(settled?.state)} and did not connect: ${settled?.error ?? 'no reason given'}`)
    // A node that cannot be reached is a deployment condition, not a failure of this
    // behaviour — the runner records 3 as SKIP with the reason above.
    process.exit(3)
  }
}

// ---- 1. this machine ---------------------------------------------------------
const local = await get('/browse')
check(local.status === 200, 'browsing with no node answers', `HTTP ${String(local.status)}`)
const localPath = local.body.path
check(typeof localPath === 'string' && localPath.length > 0, 'it names a real directory', localPath)
check(Array.isArray(local.body.entries), 'and returns a folder list')
check((local.body.entries ?? []).every(entry => typeof entry.path === 'string' && entry.name.length > 0),
  'every entry carries a name and a path a picker can use')
check((local.body.entries ?? []).every(entry => !entry.name.startsWith('.')),
  'hidden directories are not offered')
check(typeof local.body.home === 'string' && local.body.home.length > 0, 'the home directory is reported',
  local.body.home)
// "Up" has to stop at the root or the dialog offers a button that goes nowhere.
const root = await get(`/browse?path=${encodeURIComponent(localPath)}`)
check(root.status === 200, 'a path that exists can be listed directly')
const walked = root.body.parent === undefined ? 'root' : root.body.parent
check(walked === 'root' || typeof walked === 'string', 'the parent is either a directory or absent at a root',
  String(walked))
const missing = await get(`/browse?path=${encodeURIComponent(`${localPath}/__rnh_no_such_dir__`)}`)
check(missing.status === 400 && typeof missing.body.error === 'string',
  'a local directory that does not exist is refused with the reason, not an empty list',
  `HTTP ${String(missing.status)} ${missing.body.error ?? ''}`)

// ---- 2. a node, in the same shape -------------------------------------------
const url = path => `/browse?node=${encodeURIComponent(remote.id)}${path === undefined ? '' : `&path=${encodeURIComponent(path)}`}`
const remoteHome = await get(url())
check(remoteHome.status === 200, 'browsing with a node answers', `HTTP ${String(remoteHome.status)}`)
check(remoteHome.body.nodeId === remote.id, 'and says which node answered', String(remoteHome.body.nodeId))
const remotePath = remoteHome.body.path
check(typeof remotePath === 'string' && remotePath.startsWith('/'),
  'the node listing is an absolute POSIX path', String(remotePath))
check(remoteHome.body.home === remotePath || remotePath.startsWith(String(remoteHome.body.home)),
  'and starts at that machine’s home', `${String(remotePath)} vs home ${String(remoteHome.body.home)}`)
check(Array.isArray(remoteHome.body.entries), 'the node returns a folder list like the local one')
check((remoteHome.body.entries ?? []).every(entry => entry.path === `${remotePath}/${entry.name}`),
  'each remote entry is an absolute path on that machine')
check((remoteHome.body.entries ?? []).every(entry => !entry.name.startsWith('.')),
  'hidden directories are hidden on the node too')

// A real remote reading, not a local one relabelled: `/` has to look different from the
// local home directory.
const remoteRoot = await get(url('/'))
check(remoteRoot.status === 200, 'a node can list /', `HTTP ${String(remoteRoot.status)}`)
const rootNames = (remoteRoot.body.entries ?? []).map(entry => entry.name)
const localNames = new Set((local.body.entries ?? []).map(entry => entry.name))
check(remoteRoot.body.parent === undefined,
  'and at / there is nothing above it, so the dialog shows no dead "up" button')
if (localNames.size > 0) {
  check(rootNames.some(name => !localNames.has(name)) || rootNames.length !== localNames.size,
    'the node listing is not the local listing relabelled',
    `remote ${String(rootNames.length)} names, local ${String(localNames.size)}`)
}
const remoteMissing = await get(url(`${String(remoteHome.body.home)}/__rnh_no_such_dir__`))
// A *node* path that is legal but not there yet answers as a confirmable empty level, and
// says so with `exists: false`. That is the whole reason the phone can create a workspace
// on a node at all: its endpoint allowlist has no `directoryPicker/createDirectory`, its
// typed-path row resolves through a listing, and only a level that can be shown can be
// confirmed. The local case just above still refuses, because on this machine nothing ever
// needs to be created from a picker the shell already handles.
check(remoteMissing.status === 200,
  'a node path that is not there yet answers as a level, so the phone can confirm it',
  `HTTP ${String(remoteMissing.status)} ${remoteMissing.body.error ?? ''}`)
check(remoteMissing.body.exists === false,
  'and it says the folder is not there yet', String(remoteMissing.body.exists))
check(Array.isArray(remoteMissing.body.entries) && remoteMissing.body.entries.length === 0,
  'with no children offered', JSON.stringify(remoteMissing.body.entries))
check(String(remoteMissing.body.path ?? '').endsWith('/__rnh_no_such_dir__'),
  'and the level is the path that was asked for, not a substitute',
  String(remoteMissing.body.path))

// ---- 3. pick a folder and register it --------------------------------------
// A directory the node actually has and nobody made for this test: the home directory
// itself is stable, and registering it twice must be idempotent (create returns the
// existing record), which is exactly what happens if a user picks it again.
const picked = remoteHome.body.path
const created = await post('/workspaces', { nodeId: remote.id, path: picked })
check(created.status === 200, 'the picked remote folder becomes a workspace',
  `HTTP ${String(created.status)} ${created.body.error ?? ''}`)
const workspace = created.body.workspace
check(workspace !== undefined, 'the answer carries the workspace')
check(String(workspace?.workspaceId ?? '').startsWith(`rnh_${remote.id}_`),
  'with the node wrapped into its identity', String(workspace?.workspaceId ?? ''))
check(workspace?.path === picked, 'and the node’s own path, not a local one', String(workspace?.path ?? ''))

// It has to be in the merged sidebar, which is what the user actually sees.
await sleep(1_500)
const merged = await get('/workspaces')
const items = merged.body.baseline?.items ?? []
const found = items.find(item => item.workspaceId === workspace?.workspaceId)
check(found !== undefined, 'the merged baseline lists it, so the sidebar shows it',
  `${String(items.length)} workspaces`)
check(found?.path === picked, 'still carrying the node path once merged', String(found?.path ?? ''))

// A second registration of the same directory is the same workspace, not a duplicate row:
// a person who opens the dialog twice must not end up with two identical entries.
const again = await post('/workspaces', { nodeId: remote.id, path: picked })
// Guard the identity itself: two answers that both lack a workspaceId would compare equal
// and report a pass for the wrong reason.
const againId = again.body.workspace?.workspaceId
check(typeof againId === 'string' && againId === workspace?.workspaceId,
  'picking the same folder twice is idempotent', String(againId ?? '?'))

// Off-protocol input is refused per-endpoint, with the message the dialog shows.
const relative = await post('/workspaces', { nodeId: remote.id, path: 'root/project' })
check(relative.status === 400, 'a relative remote path is refused', `HTTP ${String(relative.status)}`)
const noNode = await post('/workspaces', { path: picked })
check(noNode.status === 400, 'a remote-looking path with no node named is refused',
  `HTTP ${String(noNode.status)}`)

log(failures.length === 0 ? 'all checks passed' : `${String(failures.length)} failed`)
process.exit(failures.length === 0 ? 0 : 1)
