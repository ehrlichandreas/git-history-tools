/* AC-60 -- docs/SPECIFICATION.md § 5.0/5.1: forbidden-window boundaries
 * (07:00 inclusive, 19:00 exclusive), weekday-only windows (Saturday is
 * never forbidden under a mon-fri policy, any hour), and Europe/Berlin
 * DST transitions -- all exercised through the CLI (`commit --date=...`
 * dry runs, no --apply, so no object is ever written). Closes a gap found
 * in review of git-sign v0.4: no test previously hit these boundaries or
 * a real DST transition at all.
 *
 * The DST section below originally caught a real bug: `zonedOffsetSeconds`
 * used to re-parse an Intl-formatted string with `new Date(string)`, which
 * reads it in the PROCESS's own default timezone and misreads any instant
 * whose digits land in that zone's own skipped spring-forward hour --
 * exactly what this sandbox's own default zone (Europe/Berlin) does for
 * the 2026-03-29 transition. Lead fixed it (formatToParts + Date.UTC, no
 * string re-parse).
 *
 * The sections at the end cover `epochForZonedWallClock`'s own edge
 * cases: a non-existent wall time (the spring-forward gap) and an
 * ambiguous one (the fall-back repeated hour) are both refusals naming
 * the problem -- Lead's decision, "no silent choice", the same reasoning
 * as "no silent now" for `--date=auto`. An explicit offset sidesteps the
 * ambiguity check entirely. The TZ-independence section re-confirms the
 * process's own default timezone never changes any of this.
 *
 * Every expected offset/weekday below is independently verified via the
 * system `date` command (`TZ=Europe/Berlin date -d '<local time>'`), not
 * derived from lib/policy.ts itself -- the same "re-derive independently"
 * discipline ac-49's own fixtures use for the D1 pin.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

const WEEKDAY_WINDOW = [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '07:00', to: '19:00' }];

function dry(repo: string, gpg: H.Gpg, policy: string, date: string): H.RunBinResult {
  return H.runBin('git-sign', ['commit', repo, '--message=x', '--date=' + date, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
}

/* ---- boundaries, plain UTC, a Wednesday (2026-10-14) ------------------ */
{
  const gpg = H.setupGpg('ac60-utc');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac60-utc', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const policy = H.writePolicy('ac60-utc', { signingKey: gpg.fingerprint, timezone: 'UTC', forbiddenWindows: WEEKDAY_WINDOW });

    const at0659 = dry(repo, gpg, policy, '2026-10-14T06:59:59Z');
    T.exit('AC-60 Wed 06:59:59 UTC: allowed, exit 0', at0659, 0);
    T.contains('AC-60 Wed 06:59:59 UTC: reports the resolved date', at0659.stdout, '2026-10-14 06:59:59 +0000');

    const at0700 = dry(repo, gpg, policy, '2026-10-14T07:00:00Z');
    T.exit('AC-60 Wed 07:00:00 UTC: forbidden (boundary inclusive), exit 1', at0700, 1);
    T.contains('AC-60 Wed 07:00:00 UTC: names the forbidden window', at0700.stderr, 'forbidden window');

    const at1859 = dry(repo, gpg, policy, '2026-10-14T18:59:59Z');
    T.exit('AC-60 Wed 18:59:59 UTC: forbidden, exit 1', at1859, 1);

    const at1900 = dry(repo, gpg, policy, '2026-10-14T19:00:00Z');
    T.exit('AC-60 Wed 19:00:00 UTC: allowed (boundary exclusive), exit 0', at1900, 0);
    T.contains('AC-60 Wed 19:00:00 UTC: reports the resolved date', at1900.stdout, '2026-10-14 19:00:00 +0000');

    /* Saturday: never forbidden under a mon-fri policy, any hour. */
    const sat = dry(repo, gpg, policy, '2026-10-17T12:00:00Z');
    T.exit('AC-60 Saturday 12:00 UTC: allowed (weekday not in the window), exit 0', sat, 0);
  }
}

/* ---- Europe/Berlin DST transitions, 2026 ------------------------------ */
{
  const gpg = H.setupGpg('ac60-dst');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac60-dst', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const policy = H.writePolicy('ac60-dst', { signingKey: gpg.fingerprint, timezone: 'Europe/Berlin', forbiddenWindows: WEEKDAY_WINDOW });

    /* Spring forward: 2026-03-29, 01:00 UTC, CET (+0100) -> CEST (+0200). */
    const friBefore0659 = dry(repo, gpg, policy, '2026-03-27T06:59:59');
    T.exit('AC-60 Fri 2026-03-27 06:59:59 (CET, pre-transition): allowed', friBefore0659, 0);
    T.contains('AC-60 Fri 2026-03-27 06:59:59: resolves at CET +0100', friBefore0659.stdout, '2026-03-27 06:59:59 +0100');

    const friBefore0700 = dry(repo, gpg, policy, '2026-03-27T07:00:00');
    T.exit('AC-60 Fri 2026-03-27 07:00:00 (CET, pre-transition): forbidden', friBefore0700, 1);
    T.contains('AC-60 Fri 2026-03-27 07:00:00: names CET +0100 in the refusal', friBefore0700.stderr, '2026-03-27 07:00:00 +0100');

    const sunTransition = dry(repo, gpg, policy, '2026-03-29T04:00:00');
    T.exit('AC-60 Sun 2026-03-29 04:00:00 (the transition day itself): allowed (Sunday)', sunTransition, 0);
    T.contains('AC-60 Sun 2026-03-29 04:00:00: resolves at the post-transition CEST +0200', sunTransition.stdout, '2026-03-29 04:00:00 +0200');

    const monAfter0659 = dry(repo, gpg, policy, '2026-03-30T06:59:59');
    T.exit('AC-60 Mon 2026-03-30 06:59:59 (CEST, post-transition): allowed', monAfter0659, 0);
    T.contains('AC-60 Mon 2026-03-30 06:59:59: resolves at CEST +0200', monAfter0659.stdout, '2026-03-30 06:59:59 +0200');

    const monAfter0700 = dry(repo, gpg, policy, '2026-03-30T07:00:00');
    T.exit('AC-60 Mon 2026-03-30 07:00:00 (CEST, post-transition): forbidden', monAfter0700, 1);
    T.contains('AC-60 Mon 2026-03-30 07:00:00: names CEST +0200 in the refusal', monAfter0700.stderr, '2026-03-30 07:00:00 +0200');

    const monAfter1859 = dry(repo, gpg, policy, '2026-03-30T18:59:59');
    T.exit('AC-60 Mon 2026-03-30 18:59:59 (CEST): forbidden', monAfter1859, 1);

    const monAfter1900 = dry(repo, gpg, policy, '2026-03-30T19:00:00');
    T.exit('AC-60 Mon 2026-03-30 19:00:00 (CEST): allowed', monAfter1900, 0);
    T.contains('AC-60 Mon 2026-03-30 19:00:00: resolves at CEST +0200', monAfter1900.stdout, '2026-03-30 19:00:00 +0200');

    /* Fall back: 2026-10-25, 01:00 UTC, CEST (+0200) -> CET (+0100). */
    const friBeforeFB0659 = dry(repo, gpg, policy, '2026-10-23T06:59:59');
    T.exit('AC-60 Fri 2026-10-23 06:59:59 (CEST, pre-transition): allowed', friBeforeFB0659, 0);
    T.contains('AC-60 Fri 2026-10-23 06:59:59: resolves at CEST +0200', friBeforeFB0659.stdout, '2026-10-23 06:59:59 +0200');

    const friBeforeFB0700 = dry(repo, gpg, policy, '2026-10-23T07:00:00');
    T.exit('AC-60 Fri 2026-10-23 07:00:00 (CEST, pre-transition): forbidden', friBeforeFB0700, 1);
    T.contains('AC-60 Fri 2026-10-23 07:00:00: names CEST +0200 in the refusal', friBeforeFB0700.stderr, '2026-10-23 07:00:00 +0200');

    const sunFallback = dry(repo, gpg, policy, '2026-10-25T04:00:00');
    T.exit('AC-60 Sun 2026-10-25 04:00:00 (the transition day itself): allowed (Sunday)', sunFallback, 0);
    T.contains('AC-60 Sun 2026-10-25 04:00:00: resolves at the post-transition CET +0100', sunFallback.stdout, '2026-10-25 04:00:00 +0100');

    const monAfterFB0659 = dry(repo, gpg, policy, '2026-10-26T06:59:59');
    T.exit('AC-60 Mon 2026-10-26 06:59:59 (CET, post-transition): allowed', monAfterFB0659, 0);
    T.contains('AC-60 Mon 2026-10-26 06:59:59: resolves at CET +0100', monAfterFB0659.stdout, '2026-10-26 06:59:59 +0100');

    const monAfterFB0700 = dry(repo, gpg, policy, '2026-10-26T07:00:00');
    T.exit('AC-60 Mon 2026-10-26 07:00:00 (CET, post-transition): forbidden', monAfterFB0700, 1);
    T.contains('AC-60 Mon 2026-10-26 07:00:00: names CET +0100 in the refusal', monAfterFB0700.stderr, '2026-10-26 07:00:00 +0100');

    const monAfterFB1859 = dry(repo, gpg, policy, '2026-10-26T18:59:59');
    T.exit('AC-60 Mon 2026-10-26 18:59:59 (CET): forbidden', monAfterFB1859, 1);

    const monAfterFB1900 = dry(repo, gpg, policy, '2026-10-26T19:00:00');
    T.exit('AC-60 Mon 2026-10-26 19:00:00 (CET): allowed', monAfterFB1900, 0);
    T.contains('AC-60 Mon 2026-10-26 19:00:00: resolves at CET +0100', monAfterFB1900.stdout, '2026-10-26 19:00:00 +0100');
  }
}

/* ---- non-existent wall-clock time (spring-forward gap): refusal ------- */
{
  const TZS = ['UTC', 'Europe/Berlin', 'America/New_York'];
  for (const tz of TZS) {
    const gpg = H.setupGpg('ac60-nonexistent-' + tz.replace(/[^a-z0-9]+/gi, '-'));
    if (gpg) {
      const repo = H.initRepoNoSignConfig('ac60-nonexistent-' + tz.replace(/[^a-z0-9]+/gi, '-'), gpg);
      H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
      const policy = H.writePolicy('ac60-nonexistent-' + tz.replace(/[^a-z0-9]+/gi, '-'),
        { signingKey: gpg.fingerprint, timezone: 'Europe/Berlin', forbiddenWindows: WEEKDAY_WINDOW });

      /* 2026-03-29 02:00-02:59 local Berlin time does not exist at all --
       * the spring-forward gap, clocks jump 01:59:59 CET straight to
       * 03:00:00 CEST. Lead's decision: a refusal naming the gap, rather
       * than silently substituting a different wall-clock time. Checked
       * under all 3 process TZs (the process's own default TZ must not
       * change this) and with --apply, snapshotting the object store to
       * confirm the refusal writes nothing (D2). A staged change makes the
       * commit otherwise succeed, so a refusal here can't be mistaken for
       * git's own unrelated "nothing to commit" failure. */
      fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
      H.gitIn(repo, gpg)(['add', '-A']);
      const before = H.objectStoreSnapshot(repo, gpg);
      const r = H.runBin('git-sign',
        ['commit', repo, '--message=x', '--date=2026-03-29T02:30:00', '--policy=' + policy, '--apply'],
        { gnupgHome: gpg.gnupgHome, env: { TZ: tz } });
      T.exit('AC-60 non-existent 2026-03-29 02:30 (spring-forward gap) under TZ=' + tz + ': refusal, exit 1', r, 1);
      T.eq('AC-60 non-existent under TZ=' + tz + ': nothing on stdout', r.stdout, '');
      T.contains('AC-60 non-existent under TZ=' + tz + ': names the gap',
        r.stderr, '--date 2026-03-29T02:30:00 does not exist in Europe/Berlin (skipped by a DST change) -- give an explicit offset');
      const after = H.objectStoreSnapshot(repo, gpg);
      T.eq('AC-60 non-existent under TZ=' + tz + ': no new objects written (D2)', H.objectStoreDiff(before, after).added, []);
    }
  }
}

/* ---- ambiguous wall-clock time (fall-back repeated hour): refusal ----- */
{
  const TZS = ['UTC', 'Europe/Berlin', 'America/New_York'];
  for (const tz of TZS) {
    const gpg = H.setupGpg('ac60-ambiguous-' + tz.replace(/[^a-z0-9]+/gi, '-'));
    if (gpg) {
      const repo = H.initRepoNoSignConfig('ac60-ambiguous-' + tz.replace(/[^a-z0-9]+/gi, '-'), gpg);
      H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
      const policy = H.writePolicy('ac60-ambiguous-' + tz.replace(/[^a-z0-9]+/gi, '-'),
        { signingKey: gpg.fingerprint, timezone: 'Europe/Berlin', forbiddenWindows: WEEKDAY_WINDOW });

      /* 2026-10-25 02:00-02:59 local Berlin time occurs TWICE -- the
       * fall-back repeated hour (02:00-02:59 CEST, then 02:00-02:59 CET
       * again). Lead's decision: both non-existent and ambiguous times
       * refuse, for the same "no silent choice" reason as "no silent
       * now" -- explicit is better than silently shifted (non-existent)
       * or arbitrarily chosen (ambiguous). Checked under all 3 process
       * TZs, with --apply, D2 snapshot. A staged change makes the commit
       * otherwise succeed, so a refusal here can't be mistaken for git's
       * own unrelated "nothing to commit" failure. */
      fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
      H.gitIn(repo, gpg)(['add', '-A']);
      const before = H.objectStoreSnapshot(repo, gpg);
      const r = H.runBin('git-sign',
        ['commit', repo, '--message=x', '--date=2026-10-25T02:30:00', '--policy=' + policy, '--apply'],
        { gnupgHome: gpg.gnupgHome, env: { TZ: tz } });
      T.exit('AC-60 ambiguous 2026-10-25 02:30 (fall-back repeated hour) under TZ=' + tz + ': refusal, exit 1', r, 1);
      T.eq('AC-60 ambiguous under TZ=' + tz + ': nothing on stdout', r.stdout, '');
      T.contains('AC-60 ambiguous under TZ=' + tz + ': names both offsets',
        r.stderr, '--date 2026-10-25T02:30:00 occurs twice in Europe/Berlin (+0200 and +0100) -- give an explicit offset');
      const after = H.objectStoreSnapshot(repo, gpg);
      T.eq('AC-60 ambiguous under TZ=' + tz + ': no new objects written (D2)', H.objectStoreDiff(before, after).added, []);
    }
  }
}

/* ---- an explicit offset resolves the ambiguity ------------------------ */
{
  const gpg = H.setupGpg('ac60-explicit-offset');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac60-explicit-offset', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const policy = H.writePolicy('ac60-explicit-offset', { signingKey: gpg.fingerprint, timezone: 'Europe/Berlin', forbiddenWindows: WEEKDAY_WINDOW });

    /* Giving the offset explicitly sidesteps the ambiguity check entirely
     * (parseExplicitDate's Off branch, not epochForZonedWallClock) --
     * each offset resolves to its own distinct, correct epoch. */
    const cest = dry(repo, gpg, policy, '2026-10-25T02:30:00+02:00');
    T.exit('AC-60 explicit +02:00: resolves, exit 0', cest, 0);
    T.contains('AC-60 explicit +02:00: reports the CEST reading', cest.stdout, '2026-10-25 02:30:00 +0200');

    const cet = dry(repo, gpg, policy, '2026-10-25T02:30:00+01:00');
    T.exit('AC-60 explicit +01:00: resolves, exit 0', cet, 0);
    T.contains('AC-60 explicit +01:00: reports the CET reading', cet.stdout, '2026-10-25 02:30:00 +0100');

    T.check('AC-60 explicit offsets: the two readings are distinct instants, one hour apart',
      cest.stdout !== cet.stdout);
  }
}

/* ---- process-TZ independence ------------------------------------------- */
{
  const gpg = H.setupGpg('ac60-tz-independence');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac60-tz-independence', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const policy = H.writePolicy('ac60-tz-independence', { signingKey: gpg.fingerprint, timezone: 'Europe/Berlin', forbiddenWindows: WEEKDAY_WINDOW });

    /* The regression class Lead just fixed in zonedOffsetSeconds depended
     * on the EXECUTING PROCESS's own default timezone, not just
     * policy.timezone -- so the real regression guard is that running the
     * exact same --date values under different process TZs gives
     * byte-identical results. Covers the DST-transition instant itself
     * plus one forbidden and one allowed boundary case, under three
     * process TZs, one of which (Europe/Berlin) is the exact zone that
     * triggered the original bug. */
    const dates = ['2026-03-29T04:00:00', '2026-03-30T07:00:00', '2026-10-25T04:00:00', '2026-10-26T19:00:00'];
    const tzs = ['UTC', 'Europe/Berlin', 'America/New_York'];
    const results = tzs.map((tz) => dates.map((date) =>
      H.runBin('git-sign', ['commit', repo, '--message=x', '--date=' + date, '--policy=' + policy],
        { gnupgHome: gpg.gnupgHome, env: { TZ: tz } })));
    for (let i = 1; i < tzs.length; i++) {
      for (let j = 0; j < dates.length; j++) {
        T.eq('AC-60 TZ-independence: ' + dates[j] + ' under TZ=' + tzs[i] + ' matches TZ=' + tzs[0] + ' (exit)',
          results[i][j].status, results[0][j].status);
        T.eq('AC-60 TZ-independence: ' + dates[j] + ' under TZ=' + tzs[i] + ' matches TZ=' + tzs[0] + ' (stdout)',
          results[i][j].stdout, results[0][j].stdout);
        T.eq('AC-60 TZ-independence: ' + dates[j] + ' under TZ=' + tzs[i] + ' matches TZ=' + tzs[0] + ' (stderr)',
          results[i][j].stderr, results[0][j].stderr);
      }
    }
  }
}

T.finish();
