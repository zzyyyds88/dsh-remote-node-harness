/**
 * Plugin applicability: is a switched-on bundle actually usable on *this* node?
 *
 * A per-plugin switch means "this plugin also runs on that machine". Two things can make that
 * sentence false, and they take different routes to become visible:
 *
 * 1. The bundle's composition names a path that only exists on another OS — derivable from its
 *    own bytes, so it is refused with the file and line;
 * 2. The bundle needs a configuration file outside DSH that this desktop cannot supply —
 *    declared in `capabilities.mjs`, so it is refused with the reason and left out of the
 *    composition rather than composed and broken.
 *
 * Both are exercised here against **synthetic bundles written into a temp directory**, because
 * the point is the general answer for a real user: they write a Windows-only plugin, they set
 * up a Linux node, and the program has to say so instead of composing it.
 *
 * Usage: node test/plugin-applicability-unit.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compositionFilesOf,
  hostBoundPaths,
  manifestPlatforms,
  nodeApplies,
  nodeOsOf,
} from '../src/core/plugin-applicability.js'
import { assembleConfig, configDiffers, readConfigFile } from '../src/host/plugin-config.js'
import { RemoteHost } from '../src/remote/daemon.js'

const log = message => process.stderr.write(`[applicability-unit] ${message}\n`)
const failures = []
const check = (ok, label, detail) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const root = mkdtempSync(join(tmpdir(), 'rnh-applicability-'))
const bundle = (name, manifest, files = {}) => {
  const dir = join(root, name.replaceAll('/', '__'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

try {
  // ---- 1. the node's OS is narrowed, never guessed ---------------------------
  check(nodeOsOf({ os: 'linux' }) === 'linux', 'a Linux probe answer is read')
  check(nodeOsOf({ os: 'win32' }) === 'win32', 'a Windows probe answer is read')
  check(nodeOsOf({ os: 'freebsd' }) === undefined, 'an unknown OS is undefined rather than assumed')
  check(nodeOsOf(undefined) === undefined, 'a missing probe answer is undefined');
  {
    // An unknown OS must not refuse anything: a refusal based on a fact nobody read is a
    // capability disappearing for no reason.
    const dir = bundle('unknown-os', { name: 'x', dsh: { bundle: { patch: './cordis.patch.yml' } } },
      { 'cordis.patch.yml': "- id: mcp-rhino\n  config:\n    command: 'C:\\tools\\rhinomcp.exe'\n" })
    const verdict = nodeApplies({ bundle: 'x', dir, facts: { os: 'freebsd' } })
    check(verdict.fits === true, 'an unrecognised node OS refuses nothing', verdict.reason)
  }

  // ---- 2. a Windows-only composition is refused on Linux, with the line ------
  const windowsOnly = bundle('win-only', {
    name: '@local/win-only',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, {
    'cordis.patch.yml': [
      '- insert:',
      '    - id: preset-win',
      '      plugins:',
      '        - id: mcp-rhino',
      "          command: 'C:\\Users\\someone\\rhinomcp.exe'",
      '',
    ].join('\n'),
  })
  {
    const verdict = nodeApplies({ bundle: '@local/win-only', dir: windowsOnly, facts: { os: 'linux' } })
    check(verdict.fits === false, 'a Windows path in the composition is refused on a Linux node')
    check(verdict.reason.includes('cordis.patch.yml:5'),
      'and the reason names the file and line', verdict.reason)
    check(verdict.reason.includes('C:\\Users\\someone\\rhinomcp.exe'),
      'and quotes the literal, so nobody has to grep for it')
    check(verdict.reason.includes('linux'), 'and says what the node actually is')
    check(nodeApplies({ bundle: '@local/win-only', dir: windowsOnly, facts: { os: 'win32' } }).fits === true,
      'the same bundle is fine on a Windows node')
  }

  // ---- 3. a bundle with no such literal is never refused --------------------
  const portable = bundle('portable', {
    name: '@local/portable',
    dsh: { bundle: { patch: ['./a.patch.yml', './b.patch.yml'] } },
  }, {
    'a.patch.yml': '- id: tool-fs\n',
    'b.patch.yml': '- id: tool-bash\n',
  })
  check(nodeApplies({ bundle: '@local/portable', dir: portable, facts: { os: 'linux' } }).fits === true,
    'a portable bundle is left alone')
  check(compositionFilesOf(portable).length === 2, 'both patch files are read',
    String(compositionFilesOf(portable).length))
  check(hostBoundPaths(compositionFilesOf(portable)).length === 0, 'and neither holds a drive path')

  // A **POSIX** absolute path is not evidence of anything: `/v1/messages` and package-relative
  // paths look the same. Refusing on it would drop plugins that work.
  const posixy = bundle('posixy', {
    name: '@local/posixy',
    dsh: { bundle: { patch: './p.patch.yml' } },
  }, { 'p.patch.yml': "- id: row\n  config:\n    baseURL: 'https://api.example.test/v1'\n    root: /usr/local/share\n" })
  check(nodeApplies({ bundle: '@local/posixy', dir: posixy, facts: { os: 'linux' } }).fits === true,
    'a POSIX path is not treated as a platform signal')

  // ---- 4. a declared `os` is respected, in both npm forms -------------------
  const declaredWin = bundle('declared-win', { name: '@local/declared-win', os: ['win32'] },
    { 'cordis.patch.yml': '- id: x\n' })
  check(nodeApplies({ bundle: '@local/declared-win', dir: declaredWin, facts: { os: 'linux' } }).fits === false,
    'package.json os: ["win32"] is refused on Linux')
  check(manifestPlatforms(declaredWin)?.includes('win32') === true, 'and the declaration is readable')
  const negated = bundle('negated', { name: '@local/negated', os: ['!win32'] },
    { 'cordis.patch.yml': '- id: x\n' })
  check(nodeApplies({ bundle: '@local/negated', dir: negated, facts: { os: 'linux' } }).fits === true,
    'npm\'s negated form os: ["!win32"] admits Linux')
  check(nodeApplies({ bundle: '@local/negated', dir: negated, facts: { os: 'win32' } }).fits === false,
    'and refuses the OS it excludes')

  // ---- 5. configuration: whitelisted keys only, never the whole file -------
  const home = join(root, 'home')
  mkdirSync(join(home, '.hindsight'), { recursive: true })
  writeFileSync(join(home, '.hindsight', 'coding-agent.json'), JSON.stringify({
    serverMode: 'self-hosted',
    apiUrl: 'http://server.invalid:8888',
    apiToken: 'not-a-real-token',
    bankId: 'main',
    // Not whitelisted: these must never travel.
    banks: { other: { apiToken: 'another-servers-token' } },
    personalPath: 'C:\\Users\\someone\\private',
  }, undefined, 2))
  const registry = [{
    bundle: '@vectorize-io/hindsight-coding-agents',
    path: '.hindsight/coding-agent.json',
    format: 'json',
    mode: '0600',
    keys: ['serverMode', 'apiUrl', 'apiToken', 'bankId'],
  }]
  {
    const read = readConfigFile(registry[0], home)
    check(read.available === true, 'a config file present on the desktop is readable')
    check(Object.keys(read.values ?? {}).sort().join(',') === 'apiToken,apiUrl,bankId,serverMode',
      'only the whitelisted keys are read', Object.keys(read.values ?? {}).join(','))
    check(read.values?.banks === undefined, 'a nested `banks` section never leaves this machine')
    check(read.values?.personalPath === undefined, 'an unlisted field never leaves this machine')

    const assembled = assembleConfig({ bundles: ['@vectorize-io/hindsight-coding-agents'], registry, home })
    check(assembled.files.length === 1, 'one file is produced for one declared bundle')
    check(assembled.unavailable.length === 0, 'and nothing is reported unavailable')
    const content = assembled.files[0].content
    check(!content.includes('another-servers-token'), 'the assembled content holds no other server\'s token')
    check(!content.includes('private'), 'and no personal path')
    check(JSON.parse(content).bankId === 'main', 'the bank id travels, so both sides share one memory')
    check(assembled.files[0].mode === '0600', 'the file is marked 0600')
  }

  // ---- 6. "absent here" is a refusal, not an empty config ------------------
  {
    const assembled = assembleConfig({ bundles: ['@vectorize-io/hindsight-coding-agents'], registry, home: join(root, 'empty-home') })
    check(assembled.files.length === 0, 'a bundle whose config is absent here produces no file')
    check(assembled.unavailable.length === 1, 'it is reported instead of silently skipped')
    check(assembled.unavailable[0].bundle === '@vectorize-io/hindsight-coding-agents',
      'against the bundle that needs it', assembled.unavailable[0].bundle)
    check(assembled.unavailable[0].reason.includes('not on this desktop'),
      'with a reason a person can act on', assembled.unavailable[0].reason)
  }

  // ---- 7. a bundle the registry does not know needs nothing ---------------
  check(assembleConfig({ bundles: ['@local/rhino-mode'], registry, home }).files.length === 0,
    'an unregistered plugin is not given a config it never asked for')
  check(assembleConfig({ bundles: ['@local/rhino-mode'], registry, home }).unavailable.length === 0,
    'and is not reported as broken either')

  // ---- 8. unchanged content is not rewritten ------------------------------
  {
    const file = { content: '{\n  "a": 1\n}\n' }
    check(configDiffers(file, '{\n  "a": 1\n}\n') === false, 'identical content is not rewritten')
    check(configDiffers(file, undefined) === true, 'a missing file is written')
    check(configDiffers(file, '{\n  "a": 2\n}\n') === true, 'changed content is written')
  }

  // ---- 9. the remote write itself: stdin, mode, and the path guard ---------
  // The shell body was proven against a real node; what this checks is the JS side of it —
  // that the content never rides `argv`, that the mode is interpolated as a validated literal,
  // and that a path which would leave the home directory is refused before any SSH call.
  {
    const calls = []
    const connection = {
      exec: async request => {
        calls.push(request)
        return { code: 0, stdout: 'written', stderr: '' }
      },
    }
    const host = new RemoteHost({ connection, version: '0.2.2-rc.3' })
    const secret = 'a-token-that-must-not-appear-in-argv'
    const result = await host.writeNodeFile('.hindsight/coding-agent.json', `{"apiToken":${JSON.stringify(secret)}}`, { mode: '0600' })
    check(result.changed === true, 'a write reports whether the bytes changed', String(result.changed))
    check(result.mode === '0600', 'and the mode it applied', result.mode)
    const call = calls.at(-1)
    const argv = (call?.argv ?? []).join(' ')
    check(argv.includes('chmod 0600'), 'the mode is interpolated as a literal', argv.slice(0, 60))
    check(argv.includes('umask 077'), 'other users cannot read the file while it is being created')
    check(!argv.includes(secret), 'the content does NOT ride the command line')
    check(call?.stdin === `{"apiToken":${JSON.stringify(secret)}}`, 'it rides stdin instead')
    check(argv.includes('cmp -s'), 'and an unchanged file is left alone')

    for (const bad of ['/etc/passwd', '~/.ssh/authorized_keys', '../escape', 'a/../b', '', 'a\\b', '.hindsight/../../x']) {
      let threw = false
      try {
        await host.writeNodeFile(bad, '{}')
      } catch {
        threw = true
      }
      check(threw, `a path that leaves the home is refused: ${JSON.stringify(bad)}`)
    }
    let badMode = false
    try {
      await host.writeNodeFile('.x/y.json', '{}', { mode: '777' })
    } catch {
      badMode = true
    }
    check(badMode, 'a world-writable mode is refused')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

if (failures.length > 0) {
  log(`FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  log('all checks passed')
  process.exitCode = 0
}