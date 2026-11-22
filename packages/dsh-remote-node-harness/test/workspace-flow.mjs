/**
 * The flow the user actually asked for: use a remote workspace like a local one.
 *
 * Every step goes through the LOCAL Host's `/api`, which is what the desktop
 * sidebar and `ds-harness-remote` both call. A pass means the ordinary gestures
 * work on a remote workspace:
 *
 *   1. the merged `workspace/follow` baseline lists the remote workspace,
 *   2. `session/create` naming it creates the Session ON THE NODE,
 *   3. `session/prompt` runs the node's own bash, and the tool result arrives on
 *      the merged `session/follow` stream,
 *   4. the file the command wrote exists on the node,
 *   5. the Session is grouped under the workspace and listed in `session/list`
 *      with the node's absolute cwd.
 *
 * Usage: node test/workspace-flow.mjs <hostBase> <launchToken>
 */
import { Client } from 'ssh2'
import { nodeConfig } from './node.mjs'
import { authenticate, call as rawCall, liveStream, openCarrier } from './carrier.mjs'

const [base, token] = process.argv.slice(2)
if (base === undefined || token === undefined) {
  process.stderr.write('usage: node test/workspace-flow.mjs <hostBase> <launchToken>\n')
  process.exit(2)
}

const NODE = nodeConfig()

const log = message => process.stderr.write(`[workspace-flow] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Run one command on the node itself, bypassing DSH entirely. */
async function nodeExec(command) {
  const client = new Client()
  await new Promise((resolve, reject) => {
    client.on('ready', resolve).on('error', reject).connect({ ...NODE, readyTimeout: 20_000 })
  })
  try {
    return await new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) return reject(error)
        const out = []
        stream.on('data', chunk => out.push(chunk))
        stream.on('close', () => resolve(Buffer.concat(out).toString('utf8')))
      })
    })
  } finally {
    client.end()
  }
}

const cookie = await authenticate(base, token)
const call = (endpoint, args) => rawCall(base, cookie, endpoint, args)
const carrier = await openCarrier({ base, cookie })

// ---- 1. the remote workspace, as the sidebar sees it ---------------------
const wsStream = liveStream(carrier, 'workspace/follow', {})
for (let attempt = 0; attempt < 100 && wsStream.frames.length === 0; attempt += 1) await sleep(150)
const baseline = wsStream.frames.find(frame => frame.value?.type === 'baseline')?.value
const items = baseline?.value?.items ?? []
const remoteWorkspace = items.find(item => String(item.workspaceId).startsWith('rnh_'))
check(remoteWorkspace !== undefined, 'the merged baseline lists the remote workspace',
  `${String(items.length)} total, ${String(items.filter(i => String(i.workspaceId).startsWith('rnh_')).length)} remote`)
if (remoteWorkspace === undefined) {
  wsStream.stop()
  carrier.close()
  process.exit(1)
}
check(String(remoteWorkspace.path).startsWith('/'), 'the remote workspace keeps its real path', remoteWorkspace.path)
check(Array.isArray(remoteWorkspace.sessionIds) && remoteWorkspace.sessionIds.every(id => String(id).startsWith('rnh_')),
  'its sessions are wrapped identities')
log(`remote workspace ${remoteWorkspace.workspaceId} → ${remoteWorkspace.path}`)

// ---- 2. a NEW session inside that workspace ------------------------------
const marker = `WS_FLOW_${Date.now()}`
const targetFile = `${remoteWorkspace.path}/WS_FLOW.txt`
const created = await call('session/create', { request: { workspaceId: remoteWorkspace.workspaceId } })
const sessionId = created?.sessionId
check(typeof sessionId === 'string' && String(sessionId).startsWith('rnh_'),
  'session/create in a remote workspace returns a routed session', sessionId)
if (sessionId === undefined) {
  wsStream.stop()
  carrier.close()
  process.exit(1)
}

// The Session must be materialised on the NODE, under the node's sessions root.
//
// The directory name is derived from the workspace path the Session reports, not spelled out:
// DSH names a Session directory after its cwd (`/root/rnh-second` → `--root-rnh-second--`),
// and this assertion used to hard-code one particular fixture's name — so it failed on every
// node whose first remote workspace happened to be a different folder.
const sessionDir = `--${String(remoteWorkspace.path).replace(/^\/+|\/+$/gu, '').replaceAll('/', '-')}--`
const nodeSessions = await nodeExec(`ls -1 ~/.dsh/sessions/ 2>/dev/null | tr '\\n' ' '`)
check(nodeSessions.includes(sessionDir),
  'the node holds the session directory for that workspace',
  `${sessionDir} in ${nodeSessions.trim().slice(0, 120)}`)

// ---- 3. prompt it: the remote brain must run the command -----------------
const follow = liveStream(carrier, 'session/follow', {
  request: { address: { kind: 'session', sessionId }, maxMessages: 64 },
})
await sleep(2_000)

await call('session/prompt', {
  request: {
    sessionId,
    requestId: `wf-${Date.now()}`,
    mode: 'queue',
    content: [{
      type: 'text',
      text: `只用 bash 工具执行这条命令并贴回输出：\n`
        + `echo ${marker} > ${targetFile} && cat ${targetFile}`,
    }],
  },
})
log('prompt accepted; waiting for the node to run it')

/** Whether a frame carries a tool RESULT mentioning the marker. */
const hasResult = frames => frames.some(frame => {
  const records = frame.value?.records
  if (Array.isArray(records)) {
    return records.some(record => record?.event?.type === 'tool/result' && JSON.stringify(record).includes(marker))
  }
  return frame.value?.event?.type === 'tool/result' && JSON.stringify(frame).includes(marker)
})

let sawResult = false
const deadline = Date.now() + 300_000
while (Date.now() < deadline) {
  await sleep(2_000)
  if (hasResult(follow.frames)) { sawResult = true; break }
}
check(sawResult, 'the merged session/follow stream carried the tool result',
  `${String(follow.frames.length)} frames, types ${String([...new Set(follow.frames.map(f => (Array.isArray(f.value?.records) ? 'snapshot' : (f.value?.event?.type ?? f.value?.type ?? f.type))))].join(','))}`)

// ---- 4. the command really ran on the node ------------------------------
const onNode = await nodeExec(`cat ${targetFile} 2>/dev/null || echo __MISSING__`)
check(onNode.trim() === marker, 'the command really ran on the node, in the workspace directory',
  onNode.trim().slice(0, 80))

// ---- 5. grouped under the remote workspace ------------------------------
let grouped = false
let groupedCount = 0
const regroupDeadline = Date.now() + 30_000
while (Date.now() < regroupDeadline && !grouped) {
  const probe = liveStream(carrier, 'workspace/follow', {})
  for (let attempt = 0; attempt < 60 && probe.frames.length === 0; attempt += 1) await sleep(150)
  const probeItems = probe.frames.find(frame => frame.value?.type === 'baseline')?.value?.value?.items ?? []
  const workspace = probeItems.find(item => item.workspaceId === remoteWorkspace.workspaceId)
  groupedCount = workspace?.sessionIds?.length ?? 0
  grouped = (workspace?.sessionIds ?? []).includes(sessionId)
  probe.stop()
  if (!grouped) await sleep(2_000)
}
check(grouped, 'the new session is grouped under the remote workspace', `${String(groupedCount)} sessions`)

// ---- 6. listed with the node's absolute cwd ----------------------------
const listed = await call('session/list', { _request: {} })
const row = (listed.items ?? []).find(item => item.sessionId === sessionId)
check(row !== undefined, 'the new session appears in session/list')
check(String(row?.cwd ?? '').startsWith('/'), 'its cwd is the remote absolute path', row?.cwd)

// ---- 7. adding a second remote workspace from the settings surface -----
// The local directory picker browses THIS machine, so it can never select a node
// path. The plugin API is how a remote workspace gets added, and it must round-trip
// through the node's own registry.
//
// The path is under the node's own home, asked for rather than spelled `/root`: a node
// whose user is not root refuses the latter, and the failure reads like a broken API.
const homeEcho = (await nodeExec('printf %s "$HOME"')).trim()
const nodeHome = homeEcho.startsWith('/') ? homeEcho : '/root'
const secondPath = `${nodeHome}/rnh-second`
const nodesResponse = await fetch(`${base}/rnh/api/nodes`, { headers: { cookie } })
const nodesBody = await nodesResponse.json()
const nodeId = (nodesBody.nodes ?? [])[0]?.id
check(typeof nodeId === 'string', 'the plugin API names the connected node', nodeId)
const response = await fetch(`${base}/rnh/api/workspaces`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ nodeId, path: secondPath }),
})
const body = await response.json()
// The reply is `{ok, workspace, created}` — the same shape `workspace/create` answers
// with on a local Host, so a caller does not have to know which side made the workspace.
const added = body.workspace
check(response.ok && body.ok === true, 'the plugin API adds a remote workspace by path',
  body.error ?? added?.path)
if (body.ok === true) {
  check(String(added?.workspaceId).startsWith('rnh_'),
    'the added workspace comes back with a routed identity', added?.workspaceId)
  check(added?.path === secondPath, 'and keeps the path that was asked for', added?.path)
}

// ---- 8. and it merges into the sidebar baseline ------------------------
const afterAdd = liveStream(carrier, 'workspace/follow', {})
for (let attempt = 0; attempt < 80 && afterAdd.frames.length === 0; attempt += 1) await sleep(150)
const allItems = afterAdd.frames.find(frame => frame.value?.type === 'baseline')?.value?.value?.items ?? []
afterAdd.stop()
const remotePaths = allItems.filter(item => String(item.workspaceId).startsWith('rnh_')).map(item => item.path)
check(remotePaths.includes(secondPath), 'the added workspace appears in the merged baseline',
  remotePaths.join(',') || '(none)')

follow.stop()
wsStream.stop()
carrier.close()
if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
  process.exit(0)
}
