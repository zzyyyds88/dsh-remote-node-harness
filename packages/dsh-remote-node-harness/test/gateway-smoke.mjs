/**
 * Smoke test for the two transports the routing layer stands on.
 *
 * It needs a reachable SSH node with a resident DSH host already installed (connect
 * it once through the settings page, or let another node-backed test do it). Nothing
 * is mocked: the test fails if the remote refuses the cookie, the carrier, or the
 * call.
 *
 * Run: RNH_TEST_HOST=… node test/gateway-smoke.mjs
 */
import { randomUUID } from 'node:crypto'
import { Client } from 'ssh2'
import { cookiesOf, httpOverSsh } from '../src/host/ssh-http.js'
import { upgradeWebSocket } from '../src/host/ws.js'
import { nodeConfig } from './node.mjs'

const TARGET = nodeConfig()
// Where the node keeps its resident host. The recorded `remoteRoot` is the only correct
// answer — a node registered under a different root keeps its status file there instead of
// in `~/.dsh-remote-node-harness` — so the runner hands it down through the environment.
// The fallback chain is for running this script by hand.
const ROOT = process.env.RNH_TEST_REMOTE_ROOT
  ?? process.env.RNH_TEST_ROOT
  ?? `${process.env.RNH_TEST_HOME ?? '/root'}/.dsh-remote-node-harness`

const log = message => process.stderr.write(`[gateway-smoke] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/** The smallest `SshConnection` stand-in: one client, one forwardOut. */
function adaptSsh(client) {
  return {
    async forwardOut(host, port) {
      const stream = await new Promise((resolve, reject) => {
        client.forwardOut('127.0.0.1', 0, host, port, (error, channel) => {
          if (error) reject(error)
          else resolve(channel)
        })
      })
      return { stream, close: () => { try { stream.destroy() } catch { /* gone */ } } }
    },
  }
}

async function main() {
  const client = new Client()
  await new Promise((resolve, reject) => {
    client.on('ready', resolve).on('error', reject).connect({ ...TARGET, readyTimeout: 20_000 })
  })
  log('ssh ready')
  const connection = adaptSsh(client)

  const exec = script => new Promise((resolve, reject) => {
    client.exec(`sh -c '${script.replaceAll("'", `'\\''`)}'`, (error, stream) => {
      if (error) return reject(error)
      const out = []
      stream.on('data', chunk => out.push(chunk))
      stream.on('close', code => resolve({ code: code ?? 0, stdout: Buffer.concat(out).toString('utf8') }))
    })
  })

  const statusText = (await exec(`cat ${ROOT}/run/status.json 2>/dev/null || echo '{}'`)).stdout.trim()
  const status = JSON.parse(statusText === '' ? '{}' : statusText)
  check(Number.isInteger(status.port), 'a resident host is recorded', JSON.stringify(status).slice(0, 120))
  if (!Number.isInteger(status.port)) throw new Error('start the resident host first (run the probe scripts)')

  const alive = (await exec(`kill -0 ${status.pid} 2>/dev/null && echo alive || echo dead`)).stdout.includes('alive')
  check(alive, 'the resident host process is alive', `pid ${String(status.pid)}`)
  if (!alive) throw new Error('the resident host is not running')

  // --- cookie ---------------------------------------------------------------
  const minted = await httpOverSsh(connection, status.port, { path: `/?token=${status.token}` })
  const cookies = cookiesOf(minted.headers)
  check(minted.status === 303, 'the launch token answers 303', `HTTP ${String(minted.status)}`)
  check(cookies.length > 0, 'the launch token issues a cookie', cookies[0]?.split('=')[0])
  const cookie = cookies.join('; ')

  // --- unary RPC ------------------------------------------------------------
  const call = async (endpoint, args) => {
    const payload = JSON.stringify({
      type: 'client-request', rpcId: `t-${randomUUID()}`, method: endpoint, payload: { args },
    })
    const response = await httpOverSsh(connection, status.port, {
      path: `/api/${endpoint}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
        cookie,
      },
      body: payload,
    })
    return { status: response.status, body: JSON.parse(response.body.toString('utf8')) }
  }

  const list = await call('session/list', { _request: {} })
  check(list.status === 200, 'session/list answers 200', `HTTP ${String(list.status)}`)
  check(list.body?.result?.ok === true, 'session/list reports ok')
  const items = list.body?.result?.value?.items
  check(Array.isArray(items), 'session/list returns an item array', `${String(items?.length ?? '?')} rows`)

  // --- stream carrier -------------------------------------------------------
  const channel = await connection.forwardOut('127.0.0.1', status.port)
  const frames = []
  const carrier = await upgradeWebSocket(channel.stream, {
    host: `127.0.0.1:${String(status.port)}`,
    path: '/api/remote.mux',
    origin: `http://127.0.0.1:${String(status.port)}`,
    cookie,
  }, {
    onText: text => {
      try { frames.push(JSON.parse(text)) } catch { /* ignore */ }
    },
    onClose: () => {},
  })
  check(carrier !== undefined, 'the stream carrier upgrades')

  carrier.send(JSON.stringify({
    type: 'open', streamId: 'smoke-ws', endpoint: 'workspace/follow', payload: { args: {} },
  }))
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && frames.filter(frame => frame.streamId === 'smoke-ws').length === 0) {
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const mine = frames.filter(frame => frame.streamId === 'smoke-ws')
  check(mine.length > 0, 'workspace/follow delivers a frame', JSON.stringify(mine[0]?.value ?? mine[0]).slice(0, 160))
  check(mine[0]?.value?.type === 'baseline' || mine[0]?.type === 'item', 'the first workspace frame is the baseline')
  carrier.close()

  client.end()
  if (failures.length > 0) {
    log(`FAILED: ${failures.join(', ')}`)
    process.exitCode = 1
    return
  }
  log('all checks passed')
}

main().catch(error => {
  log(`failed: ${error?.stack ?? error?.message ?? error}`)
  process.exitCode = 1
})
