/**
 * Where a node keeps its resident host, derived from what the Host records.
 *
 * Every end-to-end suite used to spell `~/.dsh-remote-node-harness` and `~/.dsh/profiles/rnh`
 * by hand. Both are only correct for the **default** `remoteRoot`; a node registered with a
 * different root (`~/.dsh-fleet` on the machine this was measured against) keeps its runtime,
 * its status file and its profile somewhere else entirely, and the suite failed with a
 * missing-file error that said nothing about the real problem.
 *
 * The registry already knows the answer: `/rnh/api/nodes` reports each node's `remoteRoot`,
 * and `src/remote/daemon.js` is the single source for how that becomes a directory layout.
 * This module connects the two so a suite asks instead of assuming.
 *
 * @module @greatbaby/dsh-remote-node-harness/test/layout
 */
import { remoteLayout } from '../src/remote/daemon.js'

/**
 * The first connected node's layout, as the Host itself would compute it.
 *
 * @param {string} base - the Host's base URL.
 * @param {string} cookie - an authenticated cookie.
 * @returns {Promise<{ node: object, layout: ReturnType<typeof remoteLayout>, home: string }>}
 */
export async function nodeLayout(base, cookie) {
  const response = await fetch(`${base}/rnh/api/nodes`, { headers: { cookie } })
  if (!response.ok) throw new Error(`/rnh/api/nodes answered ${String(response.status)}`)
  const body = await response.json()
  const nodes = Array.isArray(body.nodes) ? body.nodes : []
  const node = nodes.find(candidate => candidate.state === 'connected') ?? nodes[0]
  if (node === undefined) throw new Error('no node is recorded in this profile')
  const layout = remoteLayout(node.remoteRoot)
  // `remote` carries what the node's own `uname`/`$HOME` answered during the probe. When a
  // node has never been probed this is absent, and `/root` would be a guess — so callers get
  // `undefined` and are expected to ask the node instead of assuming a home directory.
  const home = typeof node.remote?.home === 'string' && node.remote.home.length > 0
    ? node.remote.home
    : undefined
  return { node, layout, home }
}

/**
 * The node's home directory, reading it from the node when the registry does not say.
 *
 * @param {string} base
 * @param {string} cookie
 * @param {(command: string) => Promise<string>} exec - a command runner bound to that node.
 * @returns {Promise<string>}
 */
export async function nodeHome(base, cookie, exec) {
  const { home } = await nodeLayout(base, cookie)
  if (home !== undefined) return home
  const echoed = (await exec('printf %s "$HOME"')).trim()
  if (echoed.length === 0) throw new Error('the node did not report a home directory')
  return echoed
}
