/* AC-51 -- § 5.5 `resign-commits <repo> <range> [--apply] [--map-out=<file>]`:
 * re-signs every commit in <range> AND every descendant on any local
 * branch/tag (since its parent hash changes too), keeping tree/parents
 * (mapped)/author/committer/message byte-identical except the signature;
 * refuses on a non-policy-identity commit or a merge; moves every affected
 * branch and lightweight tag, re-creates every affected annotated tag on
 * the new hash; dry run writes nothing; --apply creates a backup bundle,
 * verifies afterwards, and never pushes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

function cat(repo: string, gpg: H.Gpg, rev: string): string {
  return H.catFile(repo, gpg, rev, '-p');
}

/* Re-signing a real (non-anonymous) commit pins its signature to the
 * commit's OWN committer date -- which must postdate the throwaway gpg
 * key's (real) creation time, or gpg refuses as a "time warp". Base every
 * real-dated fixture commit here safely in the future. */
const FUTURE_BASE = Math.floor(Date.now() / 1000) + 10 * 86400;
function futureDate(offsetSeconds: number): string {
  return '@' + (FUTURE_BASE + offsetSeconds) + ' +0000';
}

/* ---- 1: basic linear chain, descendant beyond <upper>, a second branch,
 *         an annotated tag and a lightweight tag, both inside the
 *         rewritten set -------------------------------------------------- */
{
  const gpg = H.setupGpg('ac51-basic');
  if (gpg) {
    const repo = H.initRepo('ac51-basic', gpg);
    const c0 = H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: futureDate(0) }).sha!;
    const c1 = H.commit(repo, gpg, 'second', { 'b.txt': 'two\n' }, { date: futureDate(100) }).sha!;
    const c2 = H.commit(repo, gpg, 'third (tagged)', { 'c.txt': 'three\n' }, { date: futureDate(200) }).sha!;
    H.tagSigned(repo, gpg, 'v1'); // annotated, on c2
    const oldTagObj = H.revParse(repo, gpg, 'refs/tags/v1');
    const c3 = H.commit(repo, gpg, 'fourth (beyond upper)', { 'd.txt': 'four\n' }, { date: futureDate(300) }).sha!;
    H.tagLightweight(repo, gpg, 'v1-lw'); // lightweight, on c3

    const git = H.gitIn(repo, gpg);
    git(['checkout', '-q', '-b', 'feature', c2]);
    const c4 = H.commit(repo, gpg, 'feature commit, also a descendant of c0', { 'e.txt': 'five\n' }, { date: futureDate(150) }).sha!;
    git(['checkout', '-q', 'main']);

    const policy = H.writePolicy('ac51-basic', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const range = c0 + '..' + c2; // upper = c2; c3/c4 are descendants beyond upper

    const dry = H.runBin('git-sign', ['resign-commits', repo, range, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-51.1: dry run exit 0', dry, 0);
    for (const c of [c1, c2, c3, c4]) {
      T.contains('AC-51.1: dry run lists ' + c.slice(0, 7) + ' as to-be-resigned', dry.stdout, c.slice(0, 7) + ' would be re-signed');
    }
    T.check('AC-51.1: dry run does NOT list the excluded lower bound c0', !dry.stdout.includes(c0.slice(0, 7) + ' would be re-signed'));
    T.contains('AC-51.1: dry run names both branches that would move', dry.stdout, 'branch main would move');
    T.contains('AC-51.1: dry run names both branches that would move', dry.stdout, 'branch feature would move');
    T.contains('AC-51.1: dry run names the annotated tag', dry.stdout, 'tag v1 would be re-signed and moved');
    T.contains('AC-51.1: dry run names the lightweight tag', dry.stdout, 'tag v1-lw would be moved');

    const beforeObjects = H.objectStoreSnapshot(repo, gpg);
    const dry2 = H.runBin('git-sign', ['resign-commits', repo, range, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    const afterDryObjects = H.objectStoreSnapshot(repo, gpg);
    T.eq('AC-51.1: dry run writes no objects', JSON.stringify(H.objectStoreDiff(beforeObjects, afterDryObjects)),
      JSON.stringify({ added: [], removed: [], countChanged: false }));

    const mapOutDir = H.freshDir('ac51-basic-mapout');
    const mapOut = path.join(mapOutDir, 'map.txt');
    const out = H.runBin('git-sign', ['resign-commits', repo, range, '--apply', '--map-out=' + mapOut, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.contains('AC-51.1: verify tree delta OK', out.stdout, 'verify: resign-commits: headers preserved: OK');
    T.contains('AC-51.1: verify parents mapped OK', out.stdout, 'verify: resign-commits: parents mapped: OK');
    T.contains('AC-51.1: verify check signature/sig-time OK', out.stdout, 'verify: resign-commits: check (signature/sig-time): OK');
    T.exit('AC-51.1: apply exit 0', out, 0);

    const mapText = fs.readFileSync(mapOut, 'utf8');
    const mapLines = mapText.trim().split('\n');
    T.eq('AC-51.1: map-out has one line per rewritten commit + moved tag', mapLines.length, 4 + 2 /* c1,c2,c3,c4 + v1 + v1-lw */);
    const mapByOld = new Map(mapLines.map((l) => { const [a, b] = l.split(' '); return [a, b] as const; }));
    T.check('AC-51.1: map-out has an entry for every rewritten commit', [c1, c2, c3, c4].every((c) => mapByOld.has(c)));

    const newMain = H.revParse(repo, gpg, 'refs/heads/main');
    const newFeature = H.revParse(repo, gpg, 'refs/heads/feature');
    T.eq('AC-51.1: main moved to the mapped c3', newMain, mapByOld.get(c3));
    T.eq('AC-51.1: feature moved to the mapped c4', newFeature, mapByOld.get(c4));
    T.check('AC-51.1: main actually changed (not a no-op)', newMain !== c3);

    const newC1 = mapByOld.get(c1)!, newC2 = mapByOld.get(c2)!, newC3 = mapByOld.get(c3)!, newC4 = mapByOld.get(c4)!;
    T.eq('AC-51.1: new c1 has no parent (was root\'s child... wait c0 unchanged)', H.gitRaw(repo, gpg, ['rev-parse', newC1 + '^']).trim(), c0);
    T.eq('AC-51.1: new c2\'s parent is the mapped new c1', H.gitRaw(repo, gpg, ['rev-parse', newC2 + '^']).trim(), newC1);
    T.eq('AC-51.1: new c3\'s parent is the mapped new c2', H.gitRaw(repo, gpg, ['rev-parse', newC3 + '^']).trim(), newC2);
    T.eq('AC-51.1: new c4\'s parent is the mapped new c2 (feature forked there)', H.gitRaw(repo, gpg, ['rev-parse', newC4 + '^']).trim(), newC2);

    T.eq('AC-51.1: tree unchanged for c2', H.treeOf(repo, gpg, newC2), H.treeOf(repo, gpg, c2));
    T.eq('AC-51.1: author/committer/message unchanged for c2 (minus parent+sig)',
      cat(repo, gpg, newC2).replace(/^parent .*\n/m, '').replace(/^gpgsig[\s\S]*?\n\n/m, '\n\n'),
      cat(repo, gpg, c2).replace(/^parent .*\n/m, '').replace(/^gpgsig[\s\S]*?\n\n/m, '\n\n'));

    const newTagObj = H.revParse(repo, gpg, 'refs/tags/v1');
    T.eq('AC-51.1: tag v1 now points at the new c2 (dereferenced)', H.gitRaw(repo, gpg, ['rev-parse', 'v1^{commit}']).trim(), newC2);
    T.check('AC-51.1: tag v1 is still annotated (not flattened to lightweight)', newTagObj !== newC2);
    T.eq('AC-51.1: lightweight tag v1-lw now points straight at the new c3', H.gitRaw(repo, gpg, ['rev-parse', 'refs/tags/v1-lw']).trim(), newC3);
    /* Hardening (Lead-directed): v1 was ALREADY signed before this run --
     * exactly the case the %(contents) bug corrupted (its own prior
     * signature embedded as literal message text, with a genuinely new
     * one appended after it, undetected by any assertion above). */
    T.eq('AC-51.1: tag v1 has exactly 1 signature block, not 2',
      (cat(repo, gpg, newTagObj).match(/-----BEGIN PGP SIGNATURE-----/g) || []).length, 1);

    const checkOut = H.runBin('git-sign', ['check', repo, c0 + '..refs/heads/main', '--tags', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.check('AC-51.1: a `check --tags` over the new history reports 0 violations', checkOut.stdout.startsWith('check: 0 violation'), checkOut.stdout);

    T.check('AC-51.1: push-hint for main names the OLD sha', out.stdout.includes('# git push --force-with-lease=main:' + c3 + ' <remote> main'));
    T.check('AC-51.1: push-hint for feature names the OLD sha', out.stdout.includes('# git push --force-with-lease=feature:' + c4 + ' <remote> feature'));
    T.check('AC-51.1: push-hint for the tag names the old tag object sha, not the old commit sha',
      out.stdout.includes('# git push --force-with-lease=refs/tags/v1:' + oldTagObj + ' <remote> refs/tags/v1'), out.stdout);
    T.check('AC-51.1: a backup bundle was created', H.findBackupBundle(repo) !== null);
  }
}

/* ---- 2: identity precondition -- refuses, naming the commit, never
 *         silently resigning a commit by someone else --------------------- */
{
  const gpg = H.setupGpg('ac51-identity');
  if (gpg) {
    const repo = H.initRepo('ac51-identity', gpg);
    const c0 = H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' }).sha!;
    const r = spawnSync('git', ['commit', '--allow-empty', '-q', '-S', '-m', 'someone else entirely'],
      { cwd: repo, env: Object.assign({}, gpg.env, {
        GIT_AUTHOR_NAME: 'Someone Else', GIT_AUTHOR_EMAIL: 'someone@example.invalid',
        GIT_COMMITTER_NAME: 'Someone Else', GIT_COMMITTER_EMAIL: 'someone@example.invalid',
        GIT_AUTHOR_DATE: '@1000000100 +0000', GIT_COMMITTER_DATE: '@1000000100 +0000',
      }), encoding: 'utf8' });
    T.check('fixture: a commit by a different identity', r.status === 0, r.stderr);
    const c1 = H.revParse(repo, gpg, 'HEAD');

    const policy = H.writePolicy('ac51-identity', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const out = H.runBin('git-sign', ['resign-commits', repo, c0 + '..' + c1, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-51.2: a non-policy-identity commit is a refusal, exit 1', out, 1);
    T.contains('AC-51.2: names the offending commit', out.stderr, c1.slice(0, 7));
    T.contains('AC-51.2: says identities are never changed', out.stderr, 'never changed');
  }
}

/* ---- 3: merge commits are refused, same as release-squash --------------- */
{
  const gpg = H.setupGpg('ac51-merge');
  if (gpg) {
    const repo = H.initRepo('ac51-merge', gpg);
    const c0 = H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' }).sha!;
    const git = H.gitIn(repo, gpg);
    git(['checkout', '-q', '-b', 'side', c0]);
    H.commit(repo, gpg, 'side commit', { 'side.txt': 'x\n' }, { date: '@1000000100 +0000' });
    git(['checkout', '-q', 'main']);
    H.commit(repo, gpg, 'main commit', { 'main.txt': 'y\n' }, { date: '@1000000100 +0000' });
    const m = spawnSync('git', ['merge', '--no-ff', '-q', '-S', '-m', 'merge side', 'side'],
      { cwd: repo, env: Object.assign({}, gpg.env, { GIT_AUTHOR_DATE: '@1000000200 +0000', GIT_COMMITTER_DATE: '@1000000200 +0000' }), encoding: 'utf8' });
    T.check('fixture: merge commit created', m.status === 0, m.stderr);
    const mergeSha = H.revParse(repo, gpg, 'HEAD');

    const policy = H.writePolicy('ac51-merge', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const out = H.runBin('git-sign', ['resign-commits', repo, c0 + '..' + mergeSha, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-51.3: a merge commit in range is a refusal, exit 1', out, 1);
    T.contains('AC-51.3: names it a merge commit', out.stderr, 'merge commits are not supported');
    T.contains('AC-51.3: names the merge sha', out.stderr, mergeSha.slice(0, 7));
  }
}

/* ---- 4: anonymous commits are re-signed at the D1 pin, not their own
 *         committer date -------------------------------------------------- */
{
  const gpg = H.setupGpg('ac51-anon');
  if (gpg) {
    const repo = H.initRepo('ac51-anon', gpg);
    const c0 = H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' }).sha!;
    const c1 = H.commit(repo, gpg, 'anonymous commit', { 'b.txt': 'two\n' }, { date: '@1296000 +0000' }).sha!;

    const r = spawnSync('gpg', ['--batch', '--list-keys', '--with-colons', gpg.fingerprint], { env: gpg.env, encoding: 'utf8' });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('pub:'));
    const pin = parseInt((line || '').split(':')[5], 10) + 60;

    const policyFile = H.writePolicy('ac51-anon', { signingKey: gpg.fingerprint, timezone: 'UTC' });
    const raw = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
    raw.anonymousBefore = '1971-01-01T00:00:00Z';
    fs.writeFileSync(policyFile, JSON.stringify(raw));

    const out = H.runBin('git-sign', ['resign-commits', repo, c0 + '..' + c1, '--apply', '--policy=' + policyFile], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-51.4: apply exit 0', out, 0);
    const newC1 = H.revParse(repo, gpg, 'refs/heads/main');
    const sigBlock = H.gitRaw(repo, gpg, ['cat-file', 'commit', newC1]);
    const m = /gpgsig -----BEGIN PGP SIGNATURE-----\n([\s\S]*?)\n -----END PGP SIGNATURE-----/.exec(sigBlock);
    T.check('AC-51.4: embedded signature present', !!m);
    if (m) {
      const armored = '-----BEGIN PGP SIGNATURE-----\n' + m[1].replace(/\n /g, '\n') + '\n-----END PGP SIGNATURE-----\n';
      const pk = spawnSync('gpg', ['--list-packets'], { env: gpg.env, input: armored, encoding: 'utf8' });
      const pm = /version \d+, created (\d+),/.exec(pk.stdout || '');
      T.check('AC-51.4: signature creation time parsed', !!pm, pk.stdout);
      if (pm) T.eq('AC-51.4: signature pinned to key-creation+60s, not the anonymous committer date', parseInt(pm[1], 10), pin);
    }
  }
}

/* ---- 5: a REAL commit older than the signing key is clamped up to the
 *         key, not re-signed at its own (older) date -- D1's "a signature
 *         can never predate its own key" rule, found missing here while
 *         dogfooding against nanojira's actual history (a real commit from
 *         before the policy's current key existed). Signing a commit at a
 *         date before the key's own creation is not just wrong, gpg
 *         refuses it outright ("time warp"). The floor is NOT the raw
 *         `created+60s` pin -- that instant can itself land inside a
 *         forbidden window, which this test deliberately arranges, so the
 *         clamp must land on the first policy-ALLOWED minute at or after
 *         it (D13), not the pin itself (D11's first fix, superseded). ---- */
{
  const gpg = H.setupGpg('ac51-old-real');
  if (gpg) {
    const r = spawnSync('gpg', ['--batch', '--list-keys', '--with-colons', gpg.fingerprint], { env: gpg.env, encoding: 'utf8' });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('pub:'));
    const created = parseInt((line || '').split(':')[5], 10);
    const created60 = created + 60;

    /* A forbidden window deliberately covering created60's own weekday/
     * time through the end of that day -- the raw pin would land inside
     * it, forcing the clamp to walk forward to the window's own end.
     * `inWindow` is this test's own, independent replica of the single-
     * window check (never imports lib/policy.ts -- every AC test here
     * goes through the built binary only), used to assert both halves of
     * the fixture rather than reasoning about it indirectly. */
    const wd = new Date(created60 * 1000);
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(wd).toLowerCase();
    const hh = String(wd.getUTCHours()).padStart(2, '0');
    const mm = String(wd.getUTCMinutes()).padStart(2, '0');
    const from = (hh + ':' + mm) >= '23:59' ? '23:58' : hh + ':' + mm;
    const to = '23:59';
    const expectedFloor = Math.floor(Date.UTC(wd.getUTCFullYear(), wd.getUTCMonth(), wd.getUTCDate(), 23, 59, 0) / 1000);
    function inWindow(epoch: number): boolean {
      const d = new Date(epoch * 1000);
      const w = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(d).toLowerCase();
      const t = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
      return w === weekday && t >= from && t < to;
    }
    T.check('fixture: the raw created+60s pin falls inside the forbidden window (sanity check)', inWindow(created60));
    T.check('fixture: the expected floor itself is NOT inside the forbidden window', !inWindow(expectedFloor));

    const repo = H.initRepo('ac51-old-real', gpg);
    /* 1000 days before created60 -- safely before the key (which was just
     * created "now") and, since 1000 mod 7 != 0, guaranteed to fall on a
     * DIFFERENT weekday than the forbidden window above, so the fixture
     * commits' own (real, unexempted) dates never themselves collide with
     * it. */
    const base = created60 - 1000 * 86400;
    const c0 = H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@' + base + ' +0000' }).sha!;
    const c1 = H.commit(repo, gpg, 'real commit, older than the key', { 'b.txt': 'two\n' }, { date: '@' + (base + 100) + ' +0000' }).sha!;
    T.check('fixture: the fixture commit dates predate the throwaway key\'s own creation', base + 100 < created);

    const policy = H.writePolicy('ac51-old-real', { signingKey: gpg.fingerprint, timezone: 'UTC', forbiddenWindows: [{ days: [weekday], from, to: '23:59' }] });
    const out = H.runBin('git-sign', ['resign-commits', repo, c0 + '..' + c1, '--apply', '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-51.5: apply succeeds, no gpg "time warp" crash', out, 0);

    const newC1 = H.revParse(repo, gpg, 'refs/heads/main');
    const sigBlock = H.gitRaw(repo, gpg, ['cat-file', 'commit', newC1]);
    const m = /gpgsig -----BEGIN PGP SIGNATURE-----\n([\s\S]*?)\n -----END PGP SIGNATURE-----/.exec(sigBlock);
    T.check('AC-51.5: embedded signature present', !!m);
    if (m) {
      const armored = '-----BEGIN PGP SIGNATURE-----\n' + m[1].replace(/\n /g, '\n') + '\n-----END PGP SIGNATURE-----\n';
      const pk = spawnSync('gpg', ['--list-packets'], { env: gpg.env, input: armored, encoding: 'utf8' });
      const pm = /version \d+, created (\d+),/.exec(pk.stdout || '');
      T.check('AC-51.5: signature creation time parsed', !!pm, pk.stdout);
      if (pm) {
        T.eq('AC-51.5: signature clamped to the first ALLOWED minute at/after key-creation+60s, not the raw pin (D13)',
          parseInt(pm[1], 10), expectedFloor);
      }
    }
    /* The commit's OWN recorded date, unlike the signature, is untouched. */
    T.contains('AC-51.5: the commit\'s own committer date is still the original, real date', sigBlock, String(base + 100));
  }
}

T.finish();
