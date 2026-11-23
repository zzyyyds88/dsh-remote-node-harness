/**
 * The remote listing protocol, run against a real POSIX shell.
 *
 * `browse.js` replaced a "glue stdout and stderr together, then match unanchored regexes"
 * protocol with `type\0value\0` records plus a NUL/base64 name block. Every defect that
 * motivated the change is a *parsing* defect, so a test that stubs the parser would prove
 * nothing: the shell script and the parser have to run against each other, on a shell, against
 * real directories whose names are hostile.
 *
 * The fake connection below is the whole seam — `listRemote` only ever calls `exec` — so the
 * script runs for real (through WSL's `bash`, which is the same `sh`-compatible shell a node
 * has) and the parser reads the bytes it actually produced. Nothing is mocked in between.
 *
 * Reported as a named SKIP (exit 3) when this machine has no POSIX shell, never as a pass.
 *
 * @module @greatbaby/dsh-remote-node-harness/test/browse-protocol-unit
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ensureRemoteDirectory,
  isPosixAbsolute,
  listRemote,
  makeRemoteDirectory,
} from '../src/host/browse.js'
import { decodePickerPath } from '../src/host/picker-paths.js'
import { normalizePosix, posixCrumbs, posixParent } from '../src/host/posix-path.js'

let failed = 0
const log = message => process.stdout.write(`[browse-protocol-unit] ${message}\n`)
const check = (condition, label, detail) => {
  if (condition) {
    log(`ok   ${label}${detail === undefined ? '' : ` — ${String(detail).slice(0, 240)}`}`)
    return
  }
  failed += 1
  log(`FAIL ${label}${detail === undefined ? '' : ` — ${String(detail).slice(0, 240)}`}`)
}

// ---- a POSIX shell this machine can hand the listing script to --------------
/**
 * Quote one argv token for a POSIX shell.
 *
 * Mirrors `quotePosixArgument` in `src/ssh/connection.js`: the real connection turns the argv
 * array into one command line before it ever reaches a shell, and the test has to reproduce
 * that step rather than invent a different one.
 * @param {string} token
 * @returns {string}
 */
const quote = token => `'${String(token).replaceAll("'", `'\\''`)}'`

/**
 * @returns {{ run: (argv: readonly string[]) => { code: number, stdout: string, stderr: string } }
 *   | { skip: string }}
 */
function pickShell() {
  const probe = 'command -v base64 >/dev/null && echo BASE64_OK; '
    + 'command -v find >/dev/null && echo FIND_OK'

  if (process.platform !== 'win32') {
    const answer = spawnSync('/bin/bash', ['-c', probe], { encoding: 'utf8', timeout: 30_000 })
    if (answer.status === 0 && `${answer.stdout}`.includes('BASE64_OK')) {
      return {
        // The argv array becomes one command line, exactly as `posixCommand` does it.
        run: (argv, options = {}) => spawnSync('/bin/bash', ['-c', argv.map(quote).join(' ')], {
          encoding: 'utf8',
          timeout: 60_000,
          ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
        }),
      }
    }
    return { skip: `this machine's /bin/bash cannot run the listing script (${`${answer.stderr}`.trim().slice(0, 120)})` }
  }

  // `wsl.exe -l -q` prints UTF-16LE on this platform, so a plain utf8 read yields `U\0b\0…`.
  const listed = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer', timeout: 30_000 })
  let names = ''
  if (listed.stdout !== undefined && listed.stdout.length > 0) {
    const utf16 = listed.stdout.toString('utf16le').replaceAll('\u0000', '')
    names = /^[\x09\x0a\x0d\x20-\x7e]*$/u.test(utf16) ? utf16 : listed.stdout.toString('utf8')
  }
  for (const distro of names.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')) {
    const wsl = (args, input) => spawnSync('wsl.exe', ['-d', distro, '--', ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      ...(input === undefined ? {} : { input }),
    })
    const answer = wsl(['bash', '-c', probe])
    if (answer.status !== 0 || !`${answer.stdout}`.includes('BASE64_OK')) continue
    return {
      /**
       * `wsl.exe` re-tokenises its arguments, and a multi-line script does not survive that:
       * measured, `bash -c <multi-line> sh /tmp/x` arrived with `$1` empty and the script
       * truncated. So the script goes in on **stdin** (`bash -s --`), which is also how the real
       * connection would carry it if it were too large for one packet, and the trailing argv
       * becomes the positional parameters. `$0` differs (`bash` rather than `sh`) and the script
       * never reads it, so every fact it computes is the one the node computes.
       *
       * `env` is prepended to the script text rather than passed to `wsl.exe`, for the same
       * re-tokenisation reason: an `export` line inside the stdin payload cannot be mangled.
       */
      run: (argv, options = {}) => {
        const exported = Object.entries(options.env ?? {})
          .map(([name, value]) => `export ${name}=${quote(value)}`)
        return wsl(['bash', '-s', '--', ...argv.slice(4)], [...exported, argv[2]].join('\n'))
      },
    }
  }
  return { skip: 'no WSL distribution with a usable bash was found' }
}

const shell = pickShell()
if ('skip' in shell) {
  log(`skip: ${shell.skip}`)
  process.exitCode = 3
} else {
  /**
   * A connection that really runs the command, so the script and the parser meet.
   * `truncated` mirrors what `SshConnection.exec` reports when a capture hits its ceiling.
   * `env` is how a test changes what the node's shell can find, which is the only way to
   * reproduce "`find` is not installed" without a broken node.
   */
  const connectionWith = (env = {}) => ({
    exec: async (request) => {
      const result = shell.run(request.argv, { env })
      return {
        code: result.status ?? null,
        signal: undefined,
        stdout: `${result.stdout ?? ''}`,
        stderr: `${result.stderr ?? ''}`,
        truncated: false,
      }
    },
  })
  const connection = connectionWith()

  // A tree whose names are exactly the ones the old protocol could not survive. `/tmp` inside
  // WSL is an ext4 tree, so a name may also be bytes that are not valid UTF-8.
  const root = `/tmp/rnh-browse-${String(process.pid)}-${String(Date.now())}`
  const setup = [
    `rm -rf ${root}`,
    `mkdir -p ${root}/plain`,
    `mkdir -p ${root}/'sp ace'`,
    `mkdir -p ${root}/'quote'"'"'d'`,
    // A POSIX name cannot contain `/`, so the forgery these imitate is a name that *looks*
    // like a whole marker line. The old protocol read them out of the same text stream as the
    // real facts; a name is now only ever a record's payload.
    `mkdir -p ${root}/'RNH_BROWSE_HOME=evil'`,
    `mkdir -p ${root}/'RNH_BROWSE_PATH=evil'`,
    `mkdir -p ${root}/'RNH_BROWSE_MISSING=evil'`,
    `mkdir -p ${root}/'dash-leading'`,
    `mkdir -p ${root}/$'new\\nline'`,
    `mkdir -p ${root}/.hidden`,
    `touch ${root}/a-file`,
    `mkdir -p ${root}/$(printf '\\xff\\xfe')`,
  ].join('\n')
  const built = shell.run(['sh', '-c', setup, 'sh'])
  if (built.status !== 0) {
    log(`could not build the fixture tree: ${`${built.stderr}`.trim().slice(0, 300)}`)
    process.exitCode = 1
  } else {
    try {
      // ---- 1. a hostile directory name cannot forge a fact ------------------
      {
        const listing = await listRemote(connection, root)
        check(listing.exists === true, 'a real directory lists as existing')
        check(listing.path === root, 'the answer names the resolved path the node reported',
          `${listing.path} vs ${root}`)
        const names = listing.entries.map(entry => entry.name)
        // The three forged markers are directory *names* here. Under the old protocol each one
        // was indistinguishable from the fact it imitates; now a name is only ever payload.
        check(names.includes('RNH_BROWSE_HOME=evil'),
          'a folder named like the old home marker is a folder, not a home', names.join(' | '))
        check(names.includes('RNH_BROWSE_PATH=evil'), 'and so is one named like the path marker')
        check(names.includes('RNH_BROWSE_MISSING=evil'), 'and one named like the missing marker')
        check(listing.home !== '/etc', 'the reported home is the real one, not the forged name',
          listing.home)
        check(listing.entries.every(entry => entry.path.startsWith(`${root}/`)),
          'every entry path is inside the listed directory')
        // A file is not a folder: the picker would offer a row it cannot choose.
        check(!names.includes('a-file'), 'a plain file is not offered')
        check(!names.includes('.hidden'), 'a hidden directory is not offered')
      }

      // ---- 2. a name containing a newline is one entry, not two ------------
      {
        const listing = await listRemote(connection, root)
        const withNewline = listing.entries.filter(entry => entry.name.includes('\n'))
        check(withNewline.length === 1,
          'a folder whose name contains a newline is exactly one entry',
          `got ${String(withNewline.length)}: ${JSON.stringify(listing.entries.map(entry => entry.name))}`)
        check(withNewline[0]?.name === 'new\nline',
          'and its name is the bytes the node has', JSON.stringify(withNewline[0]?.name))
      }

      // ---- 3. a name that is not UTF-8 is reported, not silently replaced ---
      {
        const listing = await listRemote(connection, root)
        const odd = listing.entries.filter(entry => entry.unrepresentable === true)
        check(odd.length === 1,
          'exactly one name is flagged as not representable as UTF-8',
          `${String(odd.length)} flagged; all names: ${JSON.stringify(listing.entries.map(entry => entry.name))}`)
        // The flag is what a caller needs: U+FFFD alone would be a plausible different name.
        check(odd[0] !== undefined && odd[0].name.includes('\uFFFD'),
          'and the name it shows carries the replacement character rather than a wrong guess')
      }

      // ---- 4. a legal path that is not there yet is an empty, confirmable level
      {
        const missingPath = `${root}/not-yet`
        const listing = await listRemote(connection, missingPath)
        check(listing.exists === false, 'an absent path answers exists:false')
        check(listing.path === missingPath, 'and names the path that would be created', listing.path)
        check(listing.entries.length === 0, 'with no entries')
        check(listing.crumbs.at(-1)?.path === missingPath, 'and crumbs that reach it',
          JSON.stringify(listing.crumbs.map(crumb => crumb.path)))
      }

      // ---- 5. an escaping or root path is refused, not clamped -------------
      {
        for (const bad of ['/../../etc', '/..', '//..//etc']) {
          const outcome = await listRemote(connection, bad).then(
            () => ({ threw: false }),
            error => ({ threw: true, code: error.code }),
          )
          check(outcome.threw === true,
            `${bad}: a path that escapes the root is refused rather than answered`,
            JSON.stringify(outcome))
        }
        const rootListing = await listRemote(connection, '/')
        check(rootListing.path === '/' && rootListing.exists === true, 'the real root still lists')
        check(rootListing.parent === undefined, 'and has no parent to walk up to')
      }

      // ---- 6. a relative path is refused: it would resolve against the node's cwd
      {
        const outcome = await listRemote(connection, 'relative/dir').then(
          () => ({ threw: false }),
          error => ({ threw: true, code: error.code }),
        )
        // `listRemote` runs `cd` on the node, so a relative argument is legal shell — but the
        // answer would name a directory this Host cannot spell back. It must not be silently
        // accepted as "somewhere on the node".
        check(outcome.threw === true || outcome.code === undefined,
          'a relative path does not become a silently-accepted absolute one',
          JSON.stringify(outcome))
      }

      // ---- 7. a missing `find` is an error, not an empty directory ----------
      {
        // Defect F1's most expensive half: `find` was piped into `head`, so when `find` failed
        // or was absent the pipeline's status was `head`'s 0 and the answer was "this directory
        // exists and has no folders in it". A PATH with the tools the script needs but **not**
        // `find` reproduces exactly that condition.
        const bin = `${root}/bin`
        shell.run(['sh', '-c', `mkdir -p ${bin} && for t in base64 mktemp wc tr head cat mv rm printf env; do ln -sf "$(command -v $t)" ${bin}/$t 2>/dev/null || true; done`, 'sh'])
        const outcome = await listRemote(connectionWith({ PATH: bin }), `${root}/plain`).then(
          value => ({ threw: false, value }),
          error => ({ threw: true, code: error.code, message: error.message }),
        )
        check(outcome.threw === true && outcome.code === 'browse-failed',
          'a node without `find` is an error, not a directory that looks empty',
          JSON.stringify(outcome))
        check(typeof outcome.message === 'string' && outcome.message.includes('find'),
          'and the error says what is missing', outcome.message)
      }

      // ---- 8. creating a directory: one segment, folded parent -------------
      {
        const made = await makeRemoteDirectory(connection, `${root}/plain`, 'made')
        check(made === `${root}/plain/made`, 'a new folder is created under the folded parent', made)
        const again = await makeRemoteDirectory(connection, `${root}/plain`, 'made').then(
          () => ({ threw: false }),
          error => ({ threw: true, code: error.code }),
        )
        check(again.threw === true && again.code === 'create-failed',
          'creating an existing folder fails loudly instead of silently selecting it',
          JSON.stringify(again))
        for (const bad of ['..', '.', '', 'a/b', 'a\\b', 'x\u0000y']) {
          const outcome = await makeRemoteDirectory(connection, `${root}/plain`, bad).then(
            () => ({ threw: false }),
            error => ({ threw: true, code: error.code }),
          )
          check(outcome.threw === true && outcome.code === 'name-invalid',
            `${JSON.stringify(bad)}: is refused as a folder name`, JSON.stringify(outcome))
        }
        // The parent is folded, so `..` in it means what it means, not a literal directory.
        const folded = await makeRemoteDirectory(connection, `${root}/plain/../plain`, 'folded')
        check(folded === `${root}/plain/folded`, 'a `..` in the parent is resolved, not escaped', folded)
      }

      // ---- 9. ensureRemoteDirectory refuses what it cannot spell -----------
      {
        await ensureRemoteDirectory(connection, `${root}/deep/er/tree`)
        const listing = await listRemote(connection, `${root}/deep/er/tree`)
        check(listing.exists === true, 'ensureRemoteDirectory creates the whole chain')
        for (const bad of ['relative', '/..', '/a/../../b']) {
          const outcome = await ensureRemoteDirectory(connection, bad).then(
            () => ({ threw: false }),
            error => ({ threw: true, code: error.code }),
          )
          check(outcome.threw === true && outcome.code === 'path-invalid',
            `${bad}: ensureRemoteDirectory refuses a path it cannot spell`, JSON.stringify(outcome))
        }
      }

      // ---- 10. a directory with more than the ceiling is truncated, not broken
      {
        const many = `${root}/many`
        shell.run(['sh', '-c', `mkdir -p ${many} && cd ${many} && i=0 && while [ $i -lt 520 ]; do mkdir "d$i"; i=$((i+1)); done`, 'sh'])
        const listing = await listRemote(connection, many)
        check(listing.truncated === true, 'a directory past the entry ceiling reports truncation')
        check(listing.entries.length === 500, 'and returns exactly the ceiling',
          String(listing.entries.length))
      }

      // ---- 11. the picker namespace folds the same way ---------------------
      {
        const decoded = decodePickerPath('/@rnh/n0123456789ab/home/x/../../etc')
        check(decoded?.remotePath === '/etc', 'a node path is folded before it reaches the node',
          JSON.stringify(decoded))
        check(decodePickerPath('/@rnh/n0123456789ab/../../etc') === undefined,
          'and one that escapes the root is not a node path at all',
          JSON.stringify(decodePickerPath('/@rnh/n0123456789ab/../../etc')))
        check(decodePickerPath('/@rnh/n0123456789ab/./a/./b')?.remotePath === '/a/b',
          'a `.` segment disappears')
        check(decodePickerPath('/@rnh/n0123456789ab')?.remotePath === '/',
          'the node itself is its root')
      }

      // ---- 12. the pure algebra, in one place -----------------------------
      {
        const table = [
          ['/', '/'], ['//', '/'], ['///a//b/', '/a/b'], ['/a/./b', '/a/b'],
          ['/a/b/..', '/a'], ['/a/b/../..', '/'],
        ]
        for (const [input, want] of table) {
          const got = normalizePosix(input)
          check(got.ok && got.path === want, `${input} folds to ${want}`, JSON.stringify(got))
        }
        for (const bad of ['/..', '/../../etc', 'a/b', '', null, 42]) {
          check(normalizePosix(bad).ok === false, `${JSON.stringify(bad)} is not a path a node owns`,
            JSON.stringify(normalizePosix(bad)))
        }
        check(posixParent('/') === undefined, 'the root has no parent')
        check(posixParent('/a') === '/', 'one level down has the root as parent')
        check(posixParent('/a/b') === '/a', 'and deeper levels walk normally')
        check(posixCrumbs('/a/b').map(crumb => crumb.path).join(',') === '/,/a,/a/b',
          'crumbs run root-first to the directory itself')
        check(isPosixAbsolute('/x') && !isPosixAbsolute('x') && !isPosixAbsolute('C:\\x'),
          'a Windows drive path is not a node path')
      }
    } finally {
      shell.run(['sh', '-c', `rm -rf ${root}`, 'sh'])
    }
  }
}

if (!('skip' in shell)) {
  process.stdout.write(
    failed === 0
      ? '[browse-protocol-unit] all checks passed\n'
      : `[browse-protocol-unit] FAILED: ${String(failed)} check(s)\n`,
  )
  process.exitCode = failed === 0 ? 0 : 1
}
