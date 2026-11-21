/**
 * The gate that keeps "the fork differs from the tag in exactly what we recorded" checkable.
 *
 * An unrecorded commit above the tag and a hand-edited file are the same failure seen twice:
 * the archive stops matching its own ledger, and nothing downstream can tell. So each case is
 * exercised against a scratch repository — asserting that the gate *fires* is the whole point,
 * and "it did not throw" proves nothing.
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { BUILD_SIDE_COMMITS, PATCH_DIR, checkForkBase } from '../scripts/node-patches.mjs'

const packageRoot = new URL('..', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/u, '')
const log = message => process.stdout.write(`[fork-base-unit] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const git = (repo, args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

/** A package root with one patch that touches `behaviour.js`, plus a scratch git repository. */
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'fork-base-'))
  const pkg = join(root, 'package')
  const repo = join(root, 'fork')
  mkdirSync(join(pkg, PATCH_DIR), { recursive: true })
  mkdirSync(join(pkg, 'docs'), { recursive: true })
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(pkg, 'docs', 'node-patches.zh.md'), [
    '# ledger', '',
    '| 补丁 | 改了什么 | 移除了什么 | 为什么节点不需要 | 怎么验证的 | 上游改到同一处怎么办 |',
    '|---|---|---|---|---|---|',
    '| `0001-drop-a.patch` | behaviour.js | behaviour A | a node has no window | ran it | regenerate |',
    '', '',
  ].join('\n'), 'utf8')
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'test@example.invalid'])
  git(repo, ['config', 'user.name', 'test'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(repo, 'behaviour.js'), 'line1\nline2\nline3\n', 'utf8')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'base'])
  git(repo, ['tag', 'dsh-v0.2.2-rc.5'])
  writeFileSync(join(repo, 'behaviour.js'), 'line1\nline2-PATCHED\nline3\n', 'utf8')
  writeFileSync(join(pkg, PATCH_DIR, '0001-drop-a.patch'), git(repo, ['diff', '--', 'behaviour.js']).stdout, 'utf8')
  git(repo, ['checkout', '--', 'behaviour.js'])
  return { root, pkg, repo }
}

const message = fn => {
  try {
    fn()
    return ''
  } catch (error) {
    return String(error.message)
  }
}

// ---- a fork on the tag is accepted ----
{
  const { root, pkg, repo } = fixture()
  try {
    const base = checkForkBase(pkg, repo, '0.2.2-rc.5')
    check(base.head === base.base && base.extra.length === 0,
      'a fork sitting exactly on the pinned tag is accepted with no build-side commits', base.head)
    writeFileSync(join(repo, 'behaviour.js'), 'line1\nline2-PATCHED\nline3\n', 'utf8')
    const after = checkForkBase(pkg, repo, '0.2.2-rc.5')
    check(after.head === after.base,
      'and the tree a previous build left patched is still accepted on rebuild')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- an unrecorded commit above the tag is refused, by hash ----
{
  const { root, pkg, repo } = fixture()
  try {
    writeFileSync(join(repo, 'tool.js'), 'export const x = 1\n', 'utf8')
    git(repo, ['add', 'tool.js'])
    git(repo, ['commit', '-qm', 'unrecorded'])
    const head = String(git(repo, ['rev-parse', 'HEAD']).stdout ?? '').trim().slice(0, 8)
    const text = message(() => checkForkBase(pkg, repo, '0.2.2-rc.5'))
    check(text.includes('BUILD_SIDE_COMMITS'), 'a commit above the tag that nobody recorded stops the build')
    check(text.includes(head), 'and names that commit, so the reader knows what to record', head)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- a commit that IS on the list is accepted and reported ----
{
  const { root, pkg, repo } = fixture()
  try {
    writeFileSync(join(repo, 'tool.js'), 'export const x = 1\n', 'utf8')
    git(repo, ['add', 'tool.js'])
    git(repo, ['commit', '-qm', 'a build-side change'])
    const head = String(git(repo, ['rev-parse', 'HEAD']).stdout ?? '').trim().slice(0, 8)
    // A scratch repository cannot reproduce the real SHA, so the entry is supplied. This proves
    // the allow-list path works; the real hashes are exercised against the real fork below.
    const base = checkForkBase(pkg, repo, '0.2.2-rc.5', { known: [{ commit: head }] })
    check(base.extra.length === 1 && base.extra[0] === head,
      'a commit on the allow-list is accepted and reported', base.extra.join(', '))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- a hand-edited file no patch touches is refused, by path ----
{
  const { root, pkg, repo } = fixture()
  try {
    writeFileSync(join(repo, 'README.md'), 'sneaky\n', 'utf8')
    const text = message(() => checkForkBase(pkg, repo, '0.2.2-rc.5'))
    check(text.includes('unrecorded local change'), 'an edit no patch touches stops the build')
    check(text.includes('README.md'), 'and names the file, not just "dirty tree"')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- a missing tag is its own message ----
{
  const { root, pkg, repo } = fixture()
  try {
    check(message(() => checkForkBase(pkg, repo, '9.9.9')).includes('has no tag dsh-v9.9.9'),
      'asking for a version the fork is not tagged for says so, rather than diffing nonsense')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---- the real fork, if it is on this machine ----
{
  const fork = process.env.DSH_FORK_DIR ?? 'D:\\ProjectHub\\dsh-fork\\deepseek-harness'
  if (!spawnSync('git', ['-C', fork, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim()) {
    log('note: no fork checkout on this machine; skipping the real-fork assertions')
  } else {
    const version = JSON.parse(
      spawnSync('git', ['-C', fork, 'show', 'dsh-v0.2.2-rc.5:package.json'], { encoding: 'utf8' }).stdout ?? '{}',
    ).version ?? '0.2.2-rc.5'
    const base = checkForkBase(packageRoot, fork, version)
    check(true, 'the real fork passes the same gate the build runs', `${base.head} on ${base.tag}`)
    check(base.extra.every(sha => BUILD_SIDE_COMMITS.some(entry => sha.startsWith(entry.commit))),
      'and every commit it reports is one the ledger documents', base.extra.join(', '))
  }
}

if (failures.length > 0) {
  log(`${failures.length} failed: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all assertions passed')
}
