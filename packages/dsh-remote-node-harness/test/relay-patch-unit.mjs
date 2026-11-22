/**
 * `host/relay-patch.js` — the patch that lets a routed Session read its own files.
 *
 * The patch edits a file this project does not own, so the interesting cases are the ones
 * where it must **refuse**: an unknown bundle, a moved anchor, a bundle that would no
 * longer parse. A test that only proved the happy path would leave the one failure mode
 * that matters — a half-patched relay that reads some files and not others — untested.
 *
 * What this proves:
 *
 *   1. the patch applies to a bundle shaped like the installed relay, and the result parses;
 *   2. applying it twice changes nothing the second time (every Host start runs it);
 *   3. an unknown bundle is refused whole, with the anchor counts in the reason;
 *   4. a bundle whose anchor appears twice is refused, not guessed;
 *   5. a bundle that would not parse leaves the original file untouched;
 *   6. the replacement is a **rename**, so a hard-linked sibling keeps the old bytes —
 *      measured on this machine: pnpm links one `index.js` into every profile;
 *   7. `revert` restores the original bytes exactly.
 *
 * Usage: node test/relay-patch-unit.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RELAY_MARKER,
  RELAY_PACKAGE,
  applyRelayPatch,
  planPatch,
  resolveRelayInstall,
  revertRelayPatch,
} from '../src/host/relay-patch.js'

let failed = 0
const check = (ok, label, detail) => {
  if (ok) {
    process.stdout.write(`[relay-patch-unit] ok   ${label}\n`)
    return
  }
  failed += 1
  process.stdout.write(`[relay-patch-unit] FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}\n`)
}
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')

/**
 * A bundle with the three shapes the patch looks for, laid out the way the real one is:
 * the helper's anchor near the payload helpers, and both guards inside one method, wrapped
 * over a line break the way the esbuild output does.
 */
const FIXTURE = `var WORKSPACE_FILE_READ_ENDPOINTS = new Set(["workspaceFiles/read", "workspaceFiles/stat"]);
function requestArgs(payload) {
  const root2 = record10(payload);
  const args = isRecord25(root2.args) ? root2.args : root2;
  return record10(args.request ?? args._request ?? args);
}
var HarnessRemoteBridge = class {
  async call(input) {
    const params = callSchema.parse(input);
    try {
      if (params.endpoint === "workspaceFiles/search") {
        const search = workspaceSearchPayloadSchema.parse(nativePayload);
        if (!await this.resolveWorkspaceRootForSession(search.args.workspaceFileScopeId, signal)) {
          throw workspaceFileFailure("WORKSPACE_UNAVAILABLE", "The workspace is unavailable.", "authority-unavailable");
        }
        nativePayload = search;
      } else if (this.resolveWorkspaceRoot !== void 0 && WORKSPACE_FILE_READ_ENDPOINTS.has(params.endpoint)) {
        nativePayload = await this.assertNativeWorkspaceFileCall(params.endpoint, nativePayload, signal);
      }
      return this.gateway.dispatch(params.endpoint, nativePayload, signal);
    } catch (error) {
      throw error;
    }
  }
};
export { HarnessRemoteBridge };
`

/** Write a profile-shaped tree: `<dir>/node_modules/ds-harness-remote/dist/index.js`. */
function profileWith(dist, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rnh-relay-'))
  const pkg = join(root, 'node_modules', RELAY_PACKAGE)
  mkdirSync(join(pkg, 'dist'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), `${JSON.stringify({ name: RELAY_PACKAGE, version: options.version ?? '0.6.6' })}\n`)
  const file = join(pkg, 'dist', 'index.js')
  writeFileSync(file, dist)
  return { root, file, profileDir: root }
}
const clean = root => { try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ } }

// ---- 1. it applies, and the result parses -----------------------------------
{
  const tree = profileWith(FIXTURE)
  try {
    const plan = planPatch(FIXTURE)
    check(plan.missing.length === 0, 'every anchor matches the fixture once', JSON.stringify(plan.missing))
    check(plan.applied.length === 3, 'all three edits are applied', plan.applied.join(','))
    check(plan.patched.includes(RELAY_MARKER), 'the result carries the marker')
    check(plan.patched.includes('!__rnhRemoteScope(search.args.workspaceFileScopeId)'),
      'the search branch skips the local check for a routed Session')
    check(plan.patched.includes('WORKSPACE_FILE_READ_ENDPOINTS.has(params.endpoint) && !__rnhRemoteScope(requestArgs(nativePayload).workspaceFileScopeId)'),
      'the read branch skips it too, reading the scope the way the relay does')
    check(plan.patched.includes('export { HarnessRemoteBridge }'),
      'nothing else in the module is disturbed')

    const result = applyRelayPatch({ profileDir: tree.profileDir })
    check(result.patched === true && result.anchors === 3, 'apply() reports three sites',
      JSON.stringify(result))
    check(readFileSync(tree.file, 'utf8').includes(RELAY_MARKER), 'the file on disk is the patched one')
    check(existsSync(`${tree.file}.rnh-orig`), 'the pristine bytes are kept beside it')
    check(existsSync(`${tree.file}.rnh-patch.json`), 'a sidecar records both hashes')
  } finally {
    clean(tree.root)
  }
}

// ---- 2. a second start changes nothing --------------------------------------
{
  const tree = profileWith(FIXTURE)
  try {
    applyRelayPatch({ profileDir: tree.profileDir })
    const after = sha(tree.file)
    const again = applyRelayPatch({ profileDir: tree.profileDir })
    check(again.patched === true, 'a second apply still reports patched', JSON.stringify(again))
    check(sha(tree.file) === after, 'and the bytes are untouched — every Host start runs this')
    const text = readFileSync(tree.file, 'utf8')
    check(text.split('function __rnhRemoteScope').length - 1 === 1,
      'the helper is inserted exactly once, not once per start')
  } finally {
    clean(tree.root)
  }
}

// ---- 3. an unknown bundle is refused whole ----------------------------------
{
  const tree = profileWith('export { x };\nexport const y = 1;\n')
  try {
    const before = sha(tree.file)
    const result = applyRelayPatch({ profileDir: tree.profileDir, log: () => {} })
    check(result.patched === false, 'a bundle with no anchors is refused', JSON.stringify(result))
    check(typeof result.reason === 'string' && result.reason.includes('matched 0 times'),
      'and the reason counts the misses, so a relay upgrade is diagnosable', result.reason)
    check(sha(tree.file) === before, 'the file is byte-identical after a refusal')
    check(!existsSync(`${tree.file}.rnh-orig`), 'a refusal does not even leave a backup')
  } finally {
    clean(tree.root)
  }
}

// ---- 4. an ambiguous anchor is refused, never guessed -----------------------
{
  // The read-branch anchor written twice: a bundle that has grown a second call site the
  // patch does not understand. Picking the first one would fix half the endpoints.
  const anchor = '} else if (this.resolveWorkspaceRoot !== void 0 && WORKSPACE_FILE_READ_ENDPOINTS.has(params.endpoint)) {'
  const bundle = FIXTURE.replace(
    anchor,
    `${anchor}\n        void 0;\n      ${anchor}`,
  )
  const tree = profileWith(bundle)
  try {
    const before = sha(tree.file)
    const result = applyRelayPatch({ profileDir: tree.profileDir, log: () => {} })
    check(result.patched === false, 'an anchor that appears twice is refused', JSON.stringify(result))
    check(typeof result.reason === 'string' && result.reason.includes('read-branch'),
      'and the reason names which anchor', result.reason)
    check(sha(tree.file) === before, 'nothing is written when the patch cannot be placed exactly')
  } finally {
    clean(tree.root)
  }
}

// ---- 5. a bundle that would not parse leaves the original alone -------------
{
  // The guard exists for a bundle whose anchors all match but whose surrounding text is
  // broken — the only way the parse check can ever fire, since an anchor needs the text
  // around it to be recognisable in the first place.
  const broken = FIXTURE.replace('function requestArgs(payload) {', 'function requestArgs(payload) { ]')
  const tree = profileWith(broken)
  try {
    const before = sha(tree.file)
    const result = applyRelayPatch({ profileDir: tree.profileDir, log: () => {} })
    check(result.patched === false, 'a bundle that would not parse is refused', JSON.stringify(result))
    check(typeof result.reason === 'string' && result.reason.includes('did not parse'),
      'and the reason says the parse check failed', result.reason)
    check(sha(tree.file) === before, 'the original file is untouched after a failed parse')
    check(!existsSync(`${tree.file}.rnh-${before.slice(0, 8)}.tmp`),
      'the temporary file is cleaned up')
  } finally {
    clean(tree.root)
  }
}

// ---- 6. renaming, not writing, so a hard-linked sibling survives ------------
{
  const tree = profileWith(FIXTURE)
  const siblingDir = mkdtempSync(join(tmpdir(), 'rnh-relay-sib-'))
  try {
    const sibling = join(siblingDir, 'index.js')
    linkSync(tree.file, sibling)
    const siblingBefore = sha(sibling)
    check(statSync(tree.file).nlink === 2, 'the fixture starts hard-linked, as pnpm installs it',
      String(statSync(tree.file).nlink))

    applyRelayPatch({ profileDir: tree.profileDir })
    check(statSync(tree.file).nlink === 1,
      'after the patch this profile has its own inode (rename broke the link)',
      String(statSync(tree.file).nlink))
    check(sha(sibling) === siblingBefore,
      'and the other profile\'s copy still holds the original bytes', sha(sibling))
  } finally {
    clean(tree.root)
    clean(siblingDir)
  }
}

// ---- 7. revert restores the original bytes ---------------------------------
{
  const tree = profileWith(FIXTURE)
  try {
    const before = sha(tree.file)
    applyRelayPatch({ profileDir: tree.profileDir })
    check(sha(tree.file) !== before, 'control: patched bytes differ')
    const reverted = revertRelayPatch({ profileDir: tree.profileDir, log: () => {} })
    check(reverted.reverted === true, 'revert() reports success', JSON.stringify(reverted))
    check(sha(tree.file) === before, 'and the file is byte-identical to the original again')
    check(!existsSync(`${tree.file}.rnh-patch.json`), 'the sidecar is removed with it')
  } finally {
    clean(tree.root)
  }
}

// ---- 8. no relay installed is not a failure --------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'rnh-relay-empty-'))
  try {
    const located = resolveRelayInstall({ profileDir: root })
    check('reason' in located, 'a profile without the relay reports a reason', JSON.stringify(located))
    const result = applyRelayPatch({ profileDir: root, log: () => {} })
    check(result.patched === false && result.installed === null,
      'and apply() answers "nothing to do" rather than throwing', JSON.stringify(result))
    const noProfile = applyRelayPatch({ profileDir: '', log: () => {} })
    check(noProfile.patched === false && typeof noProfile.reason === 'string',
      'an unknown profile directory is refused with a sentence', JSON.stringify(noProfile))
  } finally {
    clean(root)
  }
}

// ---- 9. the bundle really installed here, when there is one ----------------
{
  // Not part of the offline contract — it is a live check of this machine's relay, and the
  // layer must stay green on a machine that has none.
  const profileDir = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'desktop')
  const file = join(profileDir, 'node_modules', RELAY_PACKAGE, 'dist', 'index.js')
  if (!existsSync(file)) {
    process.stdout.write('[relay-patch-unit] ok   (no live relay on this machine; the anchor check is skipped)\n')
  } else {
    const plan = planPatch(readFileSync(file, 'utf8'))
    check(plan.missing.length === 0,
      'this machine\'s installed relay still matches every anchor', JSON.stringify(plan.missing))
    check(plan.applied.length === 3, 'so a real Host start would patch it', plan.applied.join(','))
  }
}

process.stdout.write(
  failed === 0
    ? '[relay-patch-unit] all checks passed\n'
    : `[relay-patch-unit] FAILED: ${String(failed)} check(s)\n`,
)
process.exitCode = failed === 0 ? 0 : 1
