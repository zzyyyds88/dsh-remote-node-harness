/**
 * Tool parity: does a remote Session's agent use the same tools, against the same
 * real files, as a local one?
 *
 * This is the check that the previous plugin failed. Its remote workspaces were
 * local mirror directories (`...\.dsh\dshb\mirrors\<node>\...`), so the agent's
 * own `read` / `write` / `edit` tools — which are local `node:fs` calls against
 * the Session cwd — pointed at paths that do not exist on the node. Only `bash`
 * worked, and every real file operation had to be smuggled through a heredoc.
 *
 * With the brain on the node there is no mirror: the agent's fs tools run in the
 * node's own processes against the node's real paths. This test proves that by
 * driving a real task and then auditing every tool call and its result.
 *
 * Usage: node test/tool-parity.mjs <hostBase> <launchToken>
 */
import { Client } from 'ssh2'
import { nodeConfig } from './node.mjs'
import { authenticate, call as rawCall, liveStream, openCarrier } from './carrier.mjs'

const [base, token] = process.argv.slice(2)
if (base === undefined || token === undefined) {
  process.stderr.write('usage: node test/tool-parity.mjs <hostBase> <launchToken>\n')
  process.exit(2)
}

const NODE = nodeConfig()

const log = message => process.stderr.write(`[tool-parity] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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

// ---- pick (or make) a workspace on the node ------------------------------
const wsStream = liveStream(carrier, 'workspace/follow', {})
for (let attempt = 0; attempt < 100 && wsStream.frames.length === 0; attempt += 1) await sleep(150)
const items = wsStream.frames.find(frame => frame.value?.type === 'baseline')?.value?.value?.items ?? []
wsStream.stop()
let remoteWorkspace = items.find(item => String(item.workspaceId).startsWith('rnh_'))
if (remoteWorkspace === undefined) {
  // A fixture workspace, under the node's own home: a node whose user is not root refuses
  // `/root/...`, and the failure would read as "workspace/create is broken".
  const homeEcho = (await nodeExec('printf %s "$HOME"')).trim()
  const nodeHome = homeEcho.startsWith('/') ? homeEcho : '/root'
  const created = await call('workspace/create', { request: { path: `${nodeHome}/rnh-tools` } })
  void created
}
if (remoteWorkspace === undefined) {
  const refreshed = liveStream(carrier, 'workspace/follow', {})
  for (let attempt = 0; attempt < 100 && refreshed.frames.length === 0; attempt += 1) await sleep(150)
  const again = refreshed.frames.find(frame => frame.value?.type === 'baseline')?.value?.value?.items ?? []
  refreshed.stop()
  remoteWorkspace = again.find(item => String(item.workspaceId).startsWith('rnh_'))
}
check(remoteWorkspace !== undefined, 'a remote workspace is available',
  remoteWorkspace?.path)
if (remoteWorkspace === undefined) {
  carrier.close()
  process.exit(1)
}
const workspacePath = remoteWorkspace.path
log(`workspace ${workspacePath}`)

// A scratch directory inside the remote workspace, so the audit is unambiguous.
const dir = `${workspacePath}/tool-parity`
await nodeExec(`rm -rf ${dir} && mkdir -p ${dir} && printf 'alpha\\nbeta\\ngamma\\n' > ${dir}/seed.txt`)

// ---- a task that only passes if the agent's OWN tools work ---------------
const created = await call('session/create', { request: { workspaceId: remoteWorkspace.workspaceId } })
const sessionId = created?.sessionId
check(typeof sessionId === 'string', 'a remote session was created', sessionId)
if (sessionId === undefined) { carrier.close(); process.exit(1) }
// The Session's cwd is the workspace root; the task works in ./tool-parity.

const follow = liveStream(carrier, 'session/follow', {
  request: { address: { kind: 'session', sessionId }, maxMessages: 128 },
})
await sleep(2_000)

const prompt = `在 ${dir} 里完成下面几步，全部用你自己的工作区文件工具，不要只用 bash 兜底：

1. 用 \`read\` 读取 ${dir}/seed.txt，告诉我它有几行。
2. 用 \`write\` 新建 ${dir}/created.txt，内容写三行：ONE / TWO / THREE。
3. 用 \`read\` 读回 ${dir}/created.txt 确认写入成功。
4. 用 \`edit\` 把 ${dir}/seed.txt 里的 beta 改成 BETA。
5. 用 \`grep\` 在 ${dir} 里搜索 BETA。
6. 用 \`glob\` 在 ${dir} 里找出所有 .txt 文件。
7. 用 \`bash\` 跑 \`cat ${dir}/created.txt\` 作为交叉验证。

每一步都要真的调用对应工具，最后汇总每步的真实输出。`

await call('session/prompt', {
  request: {
    sessionId,
    requestId: `tp-${Date.now()}`,
    mode: 'queue',
    content: [{ type: 'text', text: prompt }],
  },
})
log('task sent; waiting for the turn to finish')

/** The whole turn is done when a `turn/end` shows up after the prompt. */
let done = false
const deadline = Date.now() + 420_000
while (Date.now() < deadline && !done) {
  await sleep(2_000)
  done = follow.frames.some(frame => frame.value?.event?.type === 'turn/end')
}
follow.stop()
check(done, 'the turn completed', `${String(follow.frames.length)} frames`)

// ---- audit every tool call and its result -------------------------------
await sleep(1_000)
const page = await call('session/page', {
  request: { address: { kind: 'session', sessionId }, maxMessages: 256 },
})
const records = (page?.records ?? []).map(record => record?.event).filter(Boolean)
const calls = new Map()
for (const event of records) {
  if (event.type === 'tool/call') {
    const data = event.data ?? {}
    calls.set(data.callId ?? event.seq, {
      name: data.name,
      args: data.arguments,
      result: undefined,
      isError: undefined,
    })
  } else if (event.type === 'tool/result') {
    const message = event.data?.message ?? {}
    const callId = message.toolCallId ?? event.data?.toolCallId
    const existing = calls.get(callId)
    const text = (message.content ?? [])
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n')
    if (existing !== undefined) {
      existing.result = text
      existing.isError = message.isError === true
    }
  }
}
const names = [...calls.values()].map(call => call.name)
log(`tools used: ${names.join(', ') || '(none)'}`)

for (const [id, tool] of calls) {
  const preview = String(tool.result ?? '').replaceAll('\n', ' ⏎ ').slice(0, 120)
  log(`  ${tool.name}${tool.isError === true ? ' [ERROR]' : ''}: ${preview}`)
  void id
}

// 1. The fs tools must have been used at all. If the agent silently fell back to
//    bash for everything, parity is broken even though files appeared.
//    NB: `calls.values()` is an iterator, and Node 22's iterator helpers make
//    `.filter()` return another iterator — spread first, or `length` is undefined.
const toolList = [...calls.values()]
for (const expected of ['read', 'write', 'edit', 'grep', 'glob', 'bash']) {
  const used = toolList.filter(tool => tool.name === expected).length
  check(used > 0, `the agent used its own \`${expected}\` tool`, `${String(used)} call(s)`)
}

// 2. No tool may have failed for a *path* reason. A mirror-based plugin fails here
//    with ENOENT against a Windows path.
const pathFailures = toolList.filter(tool => {
  if (tool.name === 'bash') return false
  const text = String(tool.result ?? '')
  return /ENOENT|no such file or directory|not found|不存在|is not a file|is a directory/iu.test(text)
    && !/0 (个|matches?|files?)/iu.test(text)
})
check(pathFailures.length === 0, 'no file tool failed on a path',
  pathFailures.map(tool => `${String(tool.name)}: ${String(tool.result).slice(0, 90)}`).join(' | ') || 'none')

// 3. No tool call may touch the old mirror directory or a real Windows path.
//    A bare `[A-Za-z]:\\` regex is useless: agent-written code contains escapes
//    like `except Exception as e:\n`, and `e:\` looks exactly like a drive root.
const mirrorSignature = toolList.filter(tool => {
  const text = `${String(tool.args ?? '')}${String(tool.result ?? '')}`
  return /dshb[\\/]mirrors|\.dsh[\\/]dshb|[A-Za-z]:[\\/]+Users[\\/]/u.test(text)
})
check(mirrorSignature.length === 0, 'no tool call touches the old mirror directory',
  mirrorSignature.map(tool => String(tool.args).slice(0, 90)).join(' | ') || 'none')

const windowsPaths = toolList.filter(tool => {
  const text = `${String(tool.args ?? '')}${String(tool.result ?? '')}`
  return /[A-Za-z]:[\\/]{1,2}[A-Za-z0-9_.\-]+[\\/]{1,2}/u.test(text)
})
check(windowsPaths.length === 0, 'no tool call mentions a real Windows path',
  windowsPaths.map(tool => String(tool.args).slice(0, 90)).join(' | ') || 'none')

// 3b. The path-addressed tools must report a path inside the remote workspace.
//     `grep` and `glob` deliberately answer with workspace-relative paths, so they
//     are checked by the Windows-path rule above instead.
const absoluteTools = toolList.filter(tool => ['read', 'write', 'edit'].includes(String(tool.name)))
check(absoluteTools.length > 0, 'the path-addressed tools answered', `${String(absoluteTools.length)} call(s)`)
check(absoluteTools.every(tool => String(tool.result ?? '').includes(workspacePath)),
  'every path-addressed tool names a path on the node', workspacePath)

// 4. The effects must be real on the node.
const createdOnNode = await nodeExec(`cat ${dir}/created.txt 2>/dev/null || echo __MISSING__`)
check(createdOnNode.trim() === 'ONE\nTWO\nTHREE', '`write` really wrote the file on the node',
  createdOnNode.trim().replaceAll('\n', '/'))
const editedOnNode = await nodeExec(`cat ${dir}/seed.txt 2>/dev/null || echo __MISSING__`)
check(editedOnNode.includes('BETA') && !editedOnNode.includes('\nbeta'),
  '`edit` really changed the file on the node', editedOnNode.trim().replaceAll('\n', '/'))

// 5. And the local file API reads the same bytes through the node.
//    `workspaceFiles/read` declares `range` as a *present* object field (not an
//    optional one), so the wire argument has to be `{}` rather than absent.
const readBack = await call('workspaceFiles/read', {
  workspaceFileScopeId: sessionId,
  path: `${dir}/created.txt`.slice(workspacePath.length + 1),
  range: {},
}).catch(error => ({ error: `${String(error.code ?? '')} ${error.message}` }))
const localText = readBack?.text
check(String(localText ?? '').includes('TWO'), 'the local file API reads the node file',
  readBack?.error ?? String(localText ?? '').replaceAll('\n', '/'))
check(String(readBack?.absolutePath ?? '').startsWith(workspacePath),
  'and resolves it to the node path, not a local mirror', readBack?.absolutePath)

carrier.close()
if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
  process.exitCode = 0
}
await sleep(250)
process.exit(process.exitCode ?? 0)
