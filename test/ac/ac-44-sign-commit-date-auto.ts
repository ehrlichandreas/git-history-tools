/* AC-44 -- § 5.1 `--date=auto`: the latest allowed minute <= now, strictly
 * after the parent's committer date; refuses, naming the next allowed
 * start, when the whole gap between parent and now is forbidden. `now` is
 * GHT_NOW (unix seconds) for a deterministic test -- there is no other way
 * to pin "now" against a policy's real-world forbidden windows. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

function committerEpoch(repo: string, gpg: H.Gpg, rev: string): number {
  const raw = H.catFile(repo, gpg, rev, '-p');
  const m = /^committer .* (\d+) [+-]\d{4}$/m.exec(raw);
  return m ? parseInt(m[1], 10) : NaN;
}

const WEEKDAY_WINDOW = [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '07:00', to: '19:00' }];

{
  const gpg = H.setupGpg('ac44-auto-allowed');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac44-auto-allowed', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const policy = H.writePolicy('ac44-auto-allowed', { signingKey: gpg.fingerprint, timezone: 'UTC', forbiddenWindows: WEEKDAY_WINDOW });

    /* 2026-10-15 02:00 UTC (a Thursday) is outside the window -- "auto"
     * resolves to exactly now, truncated to the minute. */
    const nowEpoch = Math.floor(new Date('2026-10-15T02:00:30Z').getTime() / 1000);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    H.gitIn(repo, gpg)(['add', '-A']);

    const r = H.runBin('git-sign',
      ['commit', repo, '--message=auto-dated', '--date=auto', '--policy=' + policy, '--apply'],
      { gnupgHome: gpg.gnupgHome, env: { GHT_NOW: String(nowEpoch) } });
    T.exit('AC-44 auto (allowed now): exit 0', r, 0);
    T.eq('AC-44 auto (allowed now): resolves to now truncated to the minute', committerEpoch(repo, gpg, 'HEAD'), nowEpoch - (nowEpoch % 60));
  }
}

{
  const gpg = H.setupGpg('ac44-auto-forbidden');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac44-auto-forbidden', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const policy = H.writePolicy('ac44-auto-forbidden', { signingKey: gpg.fingerprint, timezone: 'UTC', forbiddenWindows: WEEKDAY_WINDOW });
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    H.gitIn(repo, gpg)(['add', '-A']);

    /* 2026-10-15 12:00 UTC (a Thursday) is inside the window -- "auto"
     * walks back to 06:59 the same day (the latest allowed minute). */
    const nowEpoch = Math.floor(new Date('2026-10-15T12:00:00Z').getTime() / 1000);
    const r = H.runBin('git-sign',
      ['commit', repo, '--message=auto-dated', '--date=auto', '--policy=' + policy, '--apply'],
      { gnupgHome: gpg.gnupgHome, env: { GHT_NOW: String(nowEpoch) } });
    T.exit('AC-44 auto (now forbidden): exit 0', r, 0);
    const expected = Math.floor(new Date('2026-10-15T06:59:00Z').getTime() / 1000);
    T.eq('AC-44 auto (now forbidden): walks back to 06:59 the same day', committerEpoch(repo, gpg, 'HEAD'), expected);
  }
}

{
  const gpg = H.setupGpg('ac44-auto-none');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac44-auto-none', gpg);
    /* The root commit's own committer date sits one second before "now",
     * and both now and the parent are inside the same forbidden window --
     * no allowed minute exists strictly between them. */
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' },
      { date: '@' + (Math.floor(new Date('2026-10-15T12:00:00Z').getTime() / 1000)) + ' +0000' });
    const policy = H.writePolicy('ac44-auto-none', { signingKey: gpg.fingerprint, timezone: 'UTC', forbiddenWindows: WEEKDAY_WINDOW });
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    H.gitIn(repo, gpg)(['add', '-A']);

    const nowEpoch = Math.floor(new Date('2026-10-15T12:00:01Z').getTime() / 1000);
    const r = H.runBin('git-sign',
      ['commit', repo, '--message=auto-dated', '--date=auto', '--policy=' + policy, '--apply'],
      { gnupgHome: gpg.gnupgHome, env: { GHT_NOW: String(nowEpoch) } });
    T.exit('AC-44 auto (no allowed minute in range): refusal, exit 1', r, 1);
    T.contains('AC-44 auto (no allowed minute): names the next allowed start', r.stderr, '19:00');
  }
}

T.finish();
