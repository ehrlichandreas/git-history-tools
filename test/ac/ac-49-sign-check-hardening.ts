/* AC-49 -- § 5.4 `check` hardening, from Lead's dogfood run against real
 * repos:
 * 1. signatureCreationTime() must read the signature PACKET line's own
 *    epoch (`version 4, created <epoch>,`), not the human-readable date on
 *    the hashed subpacket a few lines down (`(sig created 2026-10-17)`,
 *    whose leading digits the old regex mis-parsed as a truncated, silently
 *    wrong epoch) -- and a present-but-unreadable time must fail closed
 *    (a violation), never a silent pass.
 * 2. `check <repo> <rev-range>` (positional) must be honoured, not
 *    silently ignored in favour of the @{upstream}..HEAD default; extra
 *    positionals are a usage error everywhere (§ 0), and --range together
 *    with a positional range is a usage error, not a silent pick-one.
 * 3. `anonymousBefore` exempts only the forbidden-WINDOW check on author/
 *    committer/tagger dates -- never identity, message, or the signature's
 *    own creation time.
 * 4. forbiddenMessagePatterns match case-insensitively.
 * 5. the `signature` violation names which specific case it is: missing,
 *    unknown key (not in keyring), or a good signature by the wrong key.
 * 6. for an object exempted by anonymousBefore, sig-time does not apply the
 *    forbidden-window rule at all -- it must equal the signing key's own
 *    creation time + 60s (D1's anonymous pin) EXACTLY; a real-dated object
 *    keeps the window rule unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

/** A gpg wrapper that fakes the signing time to `fakeEpoch`, independent of
 * whatever GIT_AUTHOR_DATE/GIT_COMMITTER_DATE the commit itself carries --
 * exactly how a real leaked signature time arises (the commit claims one
 * date, gpg stamps the signature with whenever it actually ran). */
function fakeTimeWrapper(fakeEpoch: number): string {
  const dir = H.freshDir('faketime');
  const p = path.join(dir, 'gpg-wrapper.sh');
  fs.writeFileSync(p, '#!/bin/sh\nexec gpg --faked-system-time ' + fakeEpoch + '! "$@"\n');
  fs.chmodSync(p, 0o755);
  return p;
}

/** A gpg wrapper that makes `--list-packets` produce no usable output (so
 * signatureCreationTime() reads nothing), while every OTHER invocation
 * (verify-commit's own gpg call, signing) still delegates to the real gpg --
 * isolates "the signature is cryptographically good" from "its creation
 * time happens to be unreadable", the two independent facts `check` must
 * track separately. */
function noPacketsWrapper(): string {
  const dir = H.freshDir('nopackets');
  const p = path.join(dir, 'gpg-wrapper.sh');
  fs.writeFileSync(p,
    '#!/bin/sh\n' +
    'for a in "$@"; do\n' +
    '  if [ "$a" = "--list-packets" ]; then cat >/dev/null; exit 0; fi\n' +
    'done\n' +
    'exec gpg "$@"\n');
  fs.chmodSync(p, 0o755);
  return p;
}

/* A Thursday at least a week out from whenever this test actually runs --
 * gpg refuses to sign with a faked time before the signing key's own
 * (real) creation time ("time warp"), so this must stay safely in the
 * future relative to the throwaway key setupGpg() generates moments ago. */
function thursdayAtLeastAWeekOut(): { Y: number; Mo: number; D: number } {
  const d = new Date(Date.now() + 7 * 86400000);
  while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() + 1);
  return { Y: d.getUTCFullYear(), Mo: d.getUTCMonth(), D: d.getUTCDate() };
}
/** `gpg --list-keys --with-colons`'s `pub` line, field 6 -- the same source
 * lib/signer.ts's `keyCreationTime()` reads, re-derived here independently
 * (black-box: no importing lib/*.ts) so the test can compute the expected
 * D1 pin on its own. */
function readKeyCreationTime(gpg: H.Gpg): number {
  const r = spawnSync('gpg', ['--batch', '--list-keys', '--with-colons', gpg.fingerprint], { env: gpg.env, encoding: 'utf8' });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('pub:'));
  return parseInt((line || '').split(':')[5], 10);
}

const THU = thursdayAtLeastAWeekOut();
const THU_2115_UTC = Math.floor(Date.UTC(THU.Y, THU.Mo, THU.D, 21, 15, 0) / 1000); // allowed (evening)
const THU_1417_UTC = Math.floor(Date.UTC(THU.Y, THU.Mo, THU.D, 14, 17, 0) / 1000); // forbidden (workday) -- mirrors c8d5657
const ANON_DATE = Math.floor(Date.UTC(1970, 0, 15, 12, 0, 0) / 1000); // Thu 1970-01-15 12:00 UTC: pre-1971, and would be forbidden if not exempt
const WEEKDAY_WINDOW = [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '07:00', to: '19:00' }];

/* ---- 1: sig-time leak detection + fail-closed ------------------------ */
{
  const gpg = H.setupGpg('ac49-sigtime');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac49-sigtime', gpg);
    const upstream = H.initRepoNoSignConfig('ac49-sigtime-up', gpg);
    H.commit(upstream, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });

    const git = H.gitIn(repo, gpg);
    git(['remote', 'add', 'origin', upstream]);
    git(['fetch', '-q', 'origin']);
    git(['checkout', '-q', '-B', 'main', 'origin/main']);

    fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    git(['add', '-A']);
    const wrapper = fakeTimeWrapper(THU_1417_UTC);
    const dateStr = '@' + THU_2115_UTC + ' +0000';
    const r = spawnSync('git', ['-c', 'user.signingkey=' + gpg.fingerprint, '-c', 'gpg.program=' + wrapper,
      'commit', '-q', '-S', '-m', 'a leaked-signature-time commit'],
      { cwd: repo, env: Object.assign({}, gpg.env, { GIT_AUTHOR_DATE: dateStr, GIT_COMMITTER_DATE: dateStr }), encoding: 'utf8' });
    T.check('fixture: commit dated evening, signed at a faked workday time', r.status === 0, r.stderr);

    const policy = H.writePolicy('ac49-sigtime', { signingKey: gpg.fingerprint, timezone: 'UTC', forbiddenWindows: WEEKDAY_WINDOW });
    const sha = H.shortSha(repo, gpg, 'HEAD');
    const out = H.runBin('git-sign', ['check', repo, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-49.1: a leaked signature time is caught, exit 1', out, 1);
    /* Specifically the "falls in a forbidden window" wording, not just any
     * sig-time line -- a regex that mis-parses the epoch back into null
     * would otherwise still pass via the (correct, but DIFFERENT) fail-
     * closed "could not be read" case, masking a regression in the epoch
     * parse itself. */
    T.contains('AC-49.1: flags sig-time with the actual (correctly parsed) signature time', out.stdout, sha + ' sig-time signature created');
    T.contains('AC-49.1: the parsed signature time is the faked workday hour, not the commit date', out.stdout, '14:17:00');
    T.check('AC-49.1: does NOT also flag the (allowed) commit date', !out.stdout.includes(sha + ' date'));
  }
}

/* ---- 1b: fail-closed on an unreadable signature time ----------------- */
{
  const gpg = H.setupGpg('ac49-unreadable');
  if (gpg) {
    const repo = H.initRepo('ac49-unreadable', gpg);
    H.commit(repo, gpg, 'signed normally', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const sha = H.shortSha(repo, gpg, 'HEAD');

    /* The policy's own `gpgProgram` (D17) -- git-sign never takes
     * `gpg.program` from git config, so the wrapper is named there. */
    const wrapper = noPacketsWrapper();
    const policy = H.writePolicy('ac49-unreadable', { signingKey: gpg.fingerprint, timezone: 'UTC', gpgProgram: wrapper });
    const out = H.runBin('git-sign', ['check', repo, sha, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.check('AC-49.1b: the signature itself still verifies fine (not flagged as bad/missing)', !out.stdout.includes(sha + ' signature'));
    T.contains('AC-49.1b: an unreadable signature time is a violation, not a silent pass', out.stdout, sha + ' sig-time');
    T.contains('AC-49.1b: names it as unreadable', out.stdout, 'could not be read');
    T.exit('AC-49.1b: exit 1', out, 1);
  }
}

/* ---- 2: positional range + usage errors ------------------------------ */
{
  const gpg = H.setupGpg('ac49-range');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac49-range', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const base = H.revParse(repo, gpg, 'HEAD');
    H.commit(repo, gpg, 'second commit', { 'b.txt': 'two\n' }, { date: '@1000000100 +0000' });
    const tip = H.revParse(repo, gpg, 'HEAD');
    const policy = H.writePolicy('ac49-range', {
      identity: { name: 'Policy Person', email: 'policy@example.invalid' }, signingKey: gpg.fingerprint, timezone: 'UTC',
    });

    const viaPositional = H.runBin('git-sign', ['check', repo, base + '..' + tip, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-49.2: a positional range is actually used, exit 1 (identity mismatch)', viaPositional, 1);
    T.contains('AC-49.2: flags the one commit named by the positional range', viaPositional.stdout, 'identity');

    const both = H.runBin('git-sign', ['check', repo, base + '..' + tip, '--range=' + base + '..' + tip, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-49.2: positional range + --range together is a usage error, exit 2', both, 2);

    const extra = H.runBin('git-sign', ['check', repo, base + '..' + tip, 'bogus-extra', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-49.2: check with an unexpected third positional is a usage error, exit 2', extra, 2);

    const commitExtra = H.runBin('git-sign', ['commit', repo, 'bogus-extra', '--message=x', '--date=auto', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-49.2: commit with an unexpected second positional is a usage error, exit 2', commitExtra, 2);

    const tagExtra = H.runBin('git-sign', ['tag', repo, 'v1', 'bogus-extra', '--message=x', '--date=auto', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-49.2: tag with an unexpected third positional is a usage error, exit 2', tagExtra, 2);
  }
}

/* ---- 3: anonymousBefore exemption ------------------------------------ */
{
  const gpg = H.setupGpg('ac49-anon');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac49-anon', gpg);
    /* git-release-squash's own anonymous-date convention: a placeholder date
     * well before any realistic anonymousBefore cutoff, landing (by
     * construction) inside the forbidden window below -- otherwise this
     * fixture couldn't tell "exempted" apart from "never would have fired". */
    H.commit(repo, gpg, 'anonymous release commit', { 'a.txt': 'one\n' }, { date: '@' + ANON_DATE + ' +0000' });
    const sha = H.shortSha(repo, gpg, 'HEAD');

    /* A policy identity deliberately different from the fixture's own
     * committer identity -- so an identity violation fires regardless of
     * anonymousBefore, proving that exemption is scoped to the date check
     * alone. */
    const mismatchedIdentity = { name: 'Policy Person', email: 'policy@example.invalid' };
    const policyFile = H.writePolicy('ac49-anon', { identity: mismatchedIdentity, signingKey: gpg.fingerprint, timezone: 'UTC', forbiddenWindows: WEEKDAY_WINDOW });

    const withoutExemption = H.runBin('git-sign', ['check', repo, sha, '--policy=' + policyFile], { gnupgHome: gpg.gnupgHome });
    T.contains('AC-49.3: without anonymousBefore, the 1970 placeholder date is flagged', withoutExemption.stdout, sha + ' date');
    T.contains('AC-49.3: identity is flagged regardless', withoutExemption.stdout, sha + ' identity');

    const raw = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
    raw.anonymousBefore = '1971-01-01T00:00:00Z';
    fs.writeFileSync(policyFile, JSON.stringify(raw));
    const withExemption = H.runBin('git-sign', ['check', repo, sha, '--policy=' + policyFile], { gnupgHome: gpg.gnupgHome });
    T.check('AC-49.3: with anonymousBefore, the date rule no longer fires', !withExemption.stdout.includes(sha + ' date'));
    T.contains('AC-49.3: identity is still checked (never exempt)', withExemption.stdout, sha + ' identity');

    /* D3 (Lead-directed): the EXACT boundary instant, `epoch ===
     * anonymousBefore`, must NOT be exempt -- `isAnonymous` (lib/policy.ts)
     * is `epochSeconds < policy.anonymousBefore`, strictly less-than, so
     * the cutoff moment itself is still real, dateable history. Landing
     * the boundary itself inside the forbidden window (a Wednesday noon
     * UTC, not the exemption's own midnight) is what lets this leg tell
     * "still checked" apart from "would never have fired regardless". A
     * mutation to `<=` here would wrongly exempt this exact commit and
     * turn this check red. */
    const boundaryEpoch = 1166400; // 1970-01-14T12:00:00Z
    H.commit(repo, gpg, 'boundary release commit', { 'boundary.txt': 'one\n' }, { date: '@' + boundaryEpoch + ' +0000' });
    const boundarySha = H.shortSha(repo, gpg, 'HEAD');
    const boundaryPolicy = H.writePolicy('ac49-anon-boundary', {
      identity: { name: 'GHT Test', email: H.FIXTURE_EMAIL }, signingKey: gpg.fingerprint, timezone: 'UTC',
      forbiddenWindows: WEEKDAY_WINDOW, anonymousBefore: new Date(boundaryEpoch * 1000).toISOString(),
    });
    const atBoundary = H.runBin('git-sign', ['check', repo, boundarySha, '--policy=' + boundaryPolicy], { gnupgHome: gpg.gnupgHome });
    T.contains('AC-49.3: the exact anonymousBefore instant itself is still checked, not exempt',
      atBoundary.stdout, boundarySha + ' date');
  }
}

/* ---- 4: case-insensitive message patterns ----------------------------- */
{
  const gpg = H.setupGpg('ac49-ci');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac49-ci', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    H.commit(repo, gpg, 'fix: thing\n\nCo-authored-by: Someone <someone@example.invalid>', { 'b.txt': 'two\n' }, { date: '@1000000100 +0000' });
    const sha = H.shortSha(repo, gpg, 'HEAD');
    const policy = H.writePolicy('ac49-ci', {
      signingKey: gpg.fingerprint, timezone: 'UTC', forbiddenMessagePatterns: ['Co-Authored-By:'],
    });
    const out = H.runBin('git-sign', ['check', repo, sha + '^..' + sha, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.contains('AC-49.4: "Co-authored-by:" (GitHub casing) matches a "Co-Authored-By:" pattern case-insensitively', out.stdout, sha + ' message');
  }
}

/* ---- 5: specific signature violation wording -------------------------- */
{
  const gpg = H.setupGpg('ac49-sig-a');
  const other = H.setupGpg('ac49-sig-b');
  if (gpg && other) {
    const repo = H.initRepoNoSignConfig('ac49-sig-a', gpg);
    H.commit(repo, gpg, 'unsigned', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const shaMissing = H.shortSha(repo, gpg, 'HEAD');

    H.commit(repo, gpg, 'to be amended', { 'b.txt': 'two\n' }, { date: '@1000000100 +0000' });
    const wrongEnv = Object.assign({}, gpg.env, {
      GNUPGHOME: other.gnupgHome, GIT_AUTHOR_DATE: '@1000000100 +0000', GIT_COMMITTER_DATE: '@1000000100 +0000',
    });
    const rr = spawnSync('git', ['-c', 'user.signingkey=' + other.fingerprint, 'commit', '--amend', '-q', '-S', '-m', 'signed by the wrong key'],
      { cwd: repo, env: wrongEnv, encoding: 'utf8' });
    T.check('fixture: amended commit signed by the OTHER key', rr.status === 0, rr.stderr);
    const shaWrong = H.shortSha(repo, gpg, 'HEAD');

    const policy = H.writePolicy('ac49-sig-a', { signingKey: gpg.fingerprint, timezone: 'UTC' });

    /* other.gnupgHome has the wrong-key's own public key, so verify-commit
     * can crypto-verify it (VALIDSIG) -- that's what distinguishes
     * "wrong-key" from "unknown-key" below. */
    const out = H.runBin('git-sign', ['check', repo, shaWrong, '--policy=' + policy], { gnupgHome: other.gnupgHome });
    T.contains('AC-49.5: an unsigned commit is reported as "missing"', out.stdout, shaMissing + ' signature missing');
    T.contains('AC-49.5: a good signature by the wrong key names the fingerprint', out.stdout, shaWrong + ' signature good signature but by ' + other.fingerprint);

    /* No gnupgHome at all -- the harness's own guaranteed-nonexistent
     * GNUPGHOME default, i.e. a keyring with neither key. */
    const unknownOut = H.runBin('git-sign', ['check', repo, shaWrong + '^..' + shaWrong, '--policy=' + policy]);
    T.contains('AC-49.5: a signature by a key not in the keyring is "unknown key"', unknownOut.stdout, shaWrong + ' signature signed by unknown key');
    T.contains('AC-49.5: names the key id', unknownOut.stdout, other.fingerprint.slice(-16));
  }
}

/* ---- 6: anonymous objects pinned to key-creation+60s, exactly --------- */
{
  const gpg = H.setupGpg('ac49-pin');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac49-pin', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const target = H.revParse(repo, gpg, 'HEAD');
    const pin = readKeyCreationTime(gpg) + 60;
    const policy = H.writePolicy('ac49-pin', { signingKey: gpg.fingerprint, timezone: 'UTC', forbiddenWindows: WEEKDAY_WINDOW });
    const raw = JSON.parse(fs.readFileSync(policy, 'utf8'));
    raw.anonymousBefore = '1971-01-01T00:00:00Z';
    fs.writeFileSync(policy, JSON.stringify(raw));

    function signAnonTag(theGpg: H.Gpg, name: string, signTime: number) {
      const wrapper = fakeTimeWrapper(signTime);
      const taggerEnv = Object.assign({}, theGpg.env, {
        GIT_COMMITTER_NAME: 'GHT Test', GIT_COMMITTER_EMAIL: H.FIXTURE_EMAIL, GIT_COMMITTER_DATE: '@' + ANON_DATE + ' +0000',
      });
      const r = spawnSync('git', ['-c', 'user.signingkey=' + theGpg.fingerprint, '-c', 'gpg.program=' + wrapper,
        'tag', '-s', '-m', 'anonymous release', name, target], { cwd: repo, env: taggerEnv, encoding: 'utf8' });
      T.check('fixture: signed anonymous tag ' + name, r.status === 0, r.stderr);
    }

    signAnonTag(gpg, 'v-pinned', pin);
    const pinnedOut = H.runBin('git-sign', ['check', repo, target + '..' + target, '--tags', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.check('AC-49.6: an anonymous tag signed exactly at the D1 pin is clean (no sig-time, despite a would-be-forbidden tagger hour)',
      !pinnedOut.stdout.includes('v-pinned sig-time'), pinnedOut.stdout);
    T.exit('AC-49.6: ...and nothing else flags it either, exit 0', pinnedOut, 0);

    signAnonTag(gpg, 'v-wrong-pin', pin + 3600);
    const wrongOut = H.runBin('git-sign', ['check', repo, target + '..' + target, '--tags', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.contains('AC-49.6: an anonymous tag NOT signed at the pin is a violation naming expected/got',
      wrongOut.stdout, 'v-wrong-pin sig-time anonymous object not signed at the pinned time (expected');
    T.check('AC-49.6: ...and does NOT fall back to the forbidden-window wording',
      !wrongOut.stdout.includes('v-wrong-pin sig-time signature created'));

    /* Regression guard: a real-dated (non-anonymous) object keeps the
     * ordinary forbidden-window sig-time rule, unaffected by the new pin
     * branch -- already covered end-to-end by AC-49.1, re-asserted here
     * right next to the new code path it shares a function with. */
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    H.gitIn(repo, gpg)(['add', '-A']);
    const realWrapper = fakeTimeWrapper(THU_1417_UTC);
    const realDateStr = '@' + THU_2115_UTC + ' +0000';
    const rc = spawnSync('git', ['-c', 'user.signingkey=' + gpg.fingerprint, '-c', 'gpg.program=' + realWrapper,
      'commit', '-q', '-S', '-m', 'real-dated commit, leaked sig time'],
      { cwd: repo, env: Object.assign({}, gpg.env, { GIT_AUTHOR_DATE: realDateStr, GIT_COMMITTER_DATE: realDateStr }), encoding: 'utf8' });
    T.check('fixture: real-dated commit signed at a faked workday time', rc.status === 0, rc.stderr);
    const realSha = H.shortSha(repo, gpg, 'HEAD');
    const realOut = H.runBin('git-sign', ['check', repo, realSha, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.contains('AC-49.6: a real-dated commit still gets the forbidden-window sig-time rule, not the pin rule',
      realOut.stdout, realSha + ' sig-time signature created');
  }
}

T.finish();
