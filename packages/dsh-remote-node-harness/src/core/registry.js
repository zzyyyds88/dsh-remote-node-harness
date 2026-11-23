/**
 * Node registry: the durable list of remote machines this profile knows about.
 *
 * Stored under the plugin's own directory (`$DSH_HOME/rnh/nodes.json`) so a
 * remote node's data never mixes with local DSH sessions, credentials or
 * workspaces. Secrets never appear here — only the credential reference kind.
 *
 * @module @greatbaby/dsh-remote-node-harness/core/registry
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { apiError } from './http-error.js'

/** Absolute root of this plugin's own data. */
export function rnhHome() {
  return process.env.DSH_HOME === undefined
    ? join(homedir(), '.dsh', 'rnh')
    : join(process.env.DSH_HOME, 'rnh')
}

/**
 * One remote machine.
 * @typedef {object} NodeRecord
 * @property {string} id - stable local identity, `n` plus 12 hex characters.
 * @property {string} name - user-facing label.
 * @property {'ssh'} transport
 * @property {string} host
 * @property {number} port - SSH port.
 * @property {string} username
 * @property {{ kind: 'password' | 'key' | 'agent', secretRef?: string }} auth
 * @property {string} [jumpHost] - optional `host` or `user@host:port` jump target.
 * @property {string} [remoteRoot] - absolute install directory on the machine.
 * @property {string} [hostKey] - the SSH host key fingerprint recorded on first connect,
 *   `SHA256:…` as OpenSSH spells it. Absent means this machine has never been verified.
 * @property {boolean} [enabled] - whether opening the profile tries to connect.
 * @property {string} [lastError]
 * @property {number} [lastConnectedAt]
 * @property {number} [lastSeenVersion]
 * @property {number} createdAt
 * @property {number} updatedAt
 */

const ID_PATTERN = /^n[0-9a-f]{12}$/u

/** Mint one new node identity. */
export function newNodeId() {
  return `n${randomBytes(6).toString('hex')}`
}

/** Whether a string is a well-formed node identity. */
export function isNodeId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

/**
 * Validate and normalize one record read from disk or written by a client.
 *
 * Every rejection carries `code: 'node-invalid'` so a settings page can tell "the
 * form is wrong" from "the server is broken": the HTTP layer maps a bare `Error`
 * to 500, which used to make a one-character typo in a name read as a server
 * fault. The message text stays as it was — it is read in logs and bug reports.
 */
export function normalizeNode(input) {
  if (typeof input !== 'object' || input === null) throw apiError('node-invalid', 'rnh: a node must be an object')
  const id = input.id
  if (!isNodeId(id)) throw apiError('node-invalid', 'rnh: node id must be "n" plus 12 hex characters')
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name.length === 0 || name.length > 120) throw apiError('node-invalid', 'rnh: node name must be 1-120 characters')
  const host = typeof input.host === 'string' ? input.host.trim() : ''
  if (host.length === 0 || host.length > 255 || /\s/u.test(host)) throw apiError('node-invalid', 'rnh: node host is invalid')
  const port = Number(input.port ?? 22)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw apiError('node-invalid', 'rnh: node port must be 1-65535')
  const username = typeof input.username === 'string' ? input.username.trim() : ''
  if (username.length === 0 || username.length > 64) throw apiError('node-invalid', 'rnh: node username must be 1-64 characters')
  const authKind = input.auth?.kind ?? 'password'
  if (authKind !== 'password' && authKind !== 'key' && authKind !== 'agent') {
    throw apiError('node-invalid', 'rnh: node auth kind must be password, key, or agent')
  }
  const remoteRoot = typeof input.remoteRoot === 'string' && input.remoteRoot.trim().length > 0
    ? input.remoteRoot.trim()
    : '~/.dsh-remote-node-harness'
  return {
    id,
    name,
    transport: 'ssh',
    host,
    port,
    username,
    auth: { kind: authKind },
    ...(typeof input.jumpHost === 'string' && input.jumpHost.trim().length > 0
      ? { jumpHost: input.jumpHost.trim() }
      : {}),
    remoteRoot,
    ...(typeof input.hostKey === 'string' && input.hostKey.length > 0
      ? { hostKey: input.hostKey }
      : {}),
    enabled: input.enabled !== false,
    ...(typeof input.lastError === 'string' ? { lastError: input.lastError.slice(0, 500) } : {}),
    ...(Number.isFinite(input.lastConnectedAt) ? { lastConnectedAt: input.lastConnectedAt } : {}),
    ...(typeof input.lastSeenVersion === 'string' ? { lastSeenVersion: input.lastSeenVersion } : {}),
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : Date.now(),
  }
}

/**
 * One record that was skipped because it could not be normalized.
 * @typedef {object} SkippedRecord
 * @property {number} index - position in the stored list.
 * @property {string} [id] - the record's id when it had one, so a person can find it in the backup.
 * @property {string} reason - the validator's sentence.
 */

/**
 * How the last load went.
 *
 * `corrupt` means the file existed but could not be read as a node list at all, so
 * the original bytes were renamed aside (`backupPath`) instead of being lost on the
 * next save. `skipped` is the milder case: the file parsed, the listed records were
 * kept, and these few were dropped. A missing file is neither — that is first run.
 *
 * @typedef {object} RegistryLoadState
 * @property {boolean} corrupt
 * @property {string} [reason]
 * @property {string} [backupPath]
 * @property {SkippedRecord[]} skipped
 */

/** Durable node list with atomic whole-file publication. */
export class NodeRegistry {
  /** @type {NodeRecord[] | undefined} */
  #nodes
  #listeners = new Set()
  /** @type {RegistryLoadState | undefined} */
  #loadState
  /**
   * Whether a save would destroy the only copy of something a person may want back.
   *
   * Set by a corrupt load (until the original has been renamed aside) and by a
   * partial load (so the records that failed validation survive in a backup before
   * the first save rewrites the file without them).
   */
  #evidenceAtRisk = false

  file() {
    return join(rnhHome(), 'nodes.json')
  }

  /**
   * How the last load went, loading the file first if that has not happened yet.
   *
   * This is the only channel the module has for saying "your node list could not be
   * read" — the registry has no logger, and a caller that sees an empty list must be
   * able to tell first run from data loss.
   * @returns {RegistryLoadState}
   */
  loadState() {
    if (this.#nodes === undefined) this.#load()
    return { ...this.#loadState, skipped: [...this.#loadState.skipped] }
  }

  /** Read the list, loading it once. */
  list() {
    if (this.#nodes === undefined) this.#load()
    return this.#nodes.map(node => ({ ...node, auth: { ...node.auth } }))
  }

  /** Read one node. */
  get(id) {
    return this.list().find(node => node.id === id)
  }

  /** Whether a node exists. */
  has(id) {
    return this.list().some(node => node.id === id)
  }

  /** Insert or replace one node, then publish. A new node mints its own id. */
  put(input) {
    if (this.#nodes === undefined) this.#load()
    const next = normalizeNode({ ...input, id: input.id ?? newNodeId(), updatedAt: Date.now() })
    // Validate and protect before touching memory: a write that cannot be made durable
    // must not leave the list showing a node that disappears on the next start.
    this.#protectEvidence()
    const index = this.#nodes.findIndex(node => node.id === next.id)
    if (index === -1) this.#nodes.push(next)
    else this.#nodes[index] = next
    this.#save()
    this.#publish()
    return { ...next }
  }

  /** Patch mutable label fields without touching connectivity facts. */
  rename(id, name) {
    const existing = this.get(id)
    if (existing === undefined) throw new Error(`rnh: no node ${id}`)
    return this.put({ ...existing, name })
  }

  /** Record the outcome of one connection attempt. */
  recordOutcome(id, outcome) {
    const existing = this.get(id)
    if (existing === undefined) return undefined
    const next = { ...existing }
    if (outcome.ok) {
      next.lastConnectedAt = Date.now()
      delete next.lastError
      if (typeof outcome.version === 'string') next.lastSeenVersion = outcome.version
    } else if (typeof outcome.error === 'string') {
      next.lastError = outcome.error.slice(0, 500)
    }
    return this.put(next)
  }

  /** Remove one node. */
  remove(id) {
    if (this.#nodes === undefined) this.#load()
    const kept = this.#nodes.filter(node => node.id !== id)
    if (kept.length === this.#nodes.length) return false
    // Same rule as `put`: prove the write can be made before showing the new list.
    this.#protectEvidence()
    this.#nodes = kept
    this.#save()
    this.#publish()
    return true
  }

  /** Subscribe to list changes; returns the unsubscribe. */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #publish() {
    const snapshot = this.list()
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot)
      } catch {
        // A failing observer must never break the registry write.
      }
    }
  }

  #load() {
    const file = this.file()
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      // A missing file is the normal first run. Any other read failure means the file is
      // there but this process cannot open it — the same data-loss trap as bad JSON, so
      // it is treated the same way rather than silently becoming "no nodes".
      if (error?.code === 'ENOENT') {
        this.#nodes = []
        this.#loadState = { corrupt: false, skipped: [] }
        return
      }
      this.#corrupt(`could not read ${file}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.#corrupt(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    const list = Array.isArray(parsed) ? parsed : parsed?.nodes
    if (!Array.isArray(list)) {
      // Parsed, but not the shape a node list has. Keeping the file is the only way a
      // person can repair it by hand, so it is moved aside before the empty table can be
      // written back over it.
      this.#corrupt(`${file} is valid JSON but not a node list (expected an array or { nodes: [...] })`)
      return
    }

    // One bad record must not take the whole table with it: keep what validates and
    // report the rest, so a single hand-edited field cannot erase every other node.
    const nodes = []
    /** @type {SkippedRecord[]} */
    const skipped = []
    for (const [index, entry] of list.entries()) {
      try {
        nodes.push(normalizeNode(entry))
      } catch (error) {
        skipped.push({
          index,
          ...(isNodeId(entry?.id) ? { id: entry.id } : {}),
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    this.#nodes = nodes
    this.#loadState = { corrupt: false, skipped }
    // The file on disk still contains the records that were dropped. Back it up before
    // the first save rewrites the list without them, so "skipped" stays recoverable.
    this.#evidenceAtRisk = skipped.length > 0
  }

  /**
   * Adopt an empty table after a file this process could not read as a node list.
   *
   * The original is renamed aside here, at the moment the damage is found, rather than
   * only guarded against inside `#save()`: this is the only point where the bytes are
   * known to still be on disk. Making the backup now also means the ordinary edits that
   * follow a corrupt load (add the node again by hand) do not fail.
   *
   * @param {string} reason
   */
  #corrupt(reason) {
    this.#nodes = []
    const backupPath = this.#backup()
    // A backup that could not be made is not silently accepted: the next save retries it
    // and refuses to publish if it still fails, so the only copy is never replaced.
    this.#evidenceAtRisk = backupPath === undefined && existsSync(this.file())
    this.#loadState = {
      corrupt: true,
      reason,
      ...(backupPath === undefined ? {} : { backupPath }),
      skipped: [],
    }
  }

  /**
   * Rename the current file aside, keeping its bytes for whoever has to repair it.
   * @returns {string | undefined} the backup path, or `undefined` when there was nothing to move.
   */
  #backup() {
    const file = this.file()
    if (!existsSync(file)) return undefined
    const stamp = new Date().toISOString().replace(/:/gu, '-')
    // Two loads inside the same millisecond must not make the second rename fail.
    let backup = `${file}.corrupt-${stamp}`
    for (let attempt = 1; existsSync(backup); attempt += 1) {
      backup = `${file}.corrupt-${stamp}-${String(attempt)}`
    }
    try {
      renameSync(file, backup)
      return backup
    } catch {
      // If the file cannot be moved there is no backup; the caller still gets a reason.
      return undefined
    }
  }

  /**
   * Preserve the file on disk before a write replaces it, when the load could not read
   * all of it.
   *
   * The rename itself happens at load time for a corrupt file, where the original bytes
   * are known to still be there; this method covers the two cases that can only be
   * decided at write time: a partial load (the dropped records are still in the file) and
   * a corrupt load whose backup rename failed (retry it, and refuse the write if it fails
   * again rather than publish the empty table over the only copy).
   */
  #protectEvidence() {
    if (!this.#evidenceAtRisk) return
    if (existsSync(this.file()) && this.#backup() === undefined) {
      throw apiError(
        'registry-write-failed',
        `rnh: refusing to overwrite ${this.file()} before its unreadable records have been backed up`,
        500,
      )
    }
    this.#evidenceAtRisk = false
  }

  #save() {
    this.#protectEvidence()
    const directory = rnhHome()
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const file = this.file()
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.#nodes ?? [], null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, file)
    try {
      chmodSync(file, 0o600)
    } catch {
      // A platform without POSIX modes keeps the file readable to its owner.
    }
  }
}
