/* AC-52 -- D13: `commit --date=<date before the signing key's own
 * creation>` must not sign at an instant that falls inside a forbidden
 * window. The naive clamp (`max(chosenEpoch, keyCreated + 60)`, the rule
 * before this fix) pins the signature to the raw `keyCreated + 60s`
 * instant whenever the chosen date predates the key -- but that raw
 * instant can itself land inside a forbidden window (a key created on a
 * weekday morning, say), so the newly-signed commit would immediately
 * fail `check`'s own `sig-time` rule it was supposed to satisfy. The fix
 * (`signTimeFor`, lib/policy.ts) clamps instead to the first policy-
 * ALLOWED minute at or after `keyCreated + 60s` -- itself a constant for
 * a given key+policy, so it leaks nothing either, same reasoning as the
 * D1/D10 anonymous pin. This test deliberately arranges a forbidden
 * window that covers the raw pin, to prove the floor actually moves. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

{
  const gpg = H.setupGpg('ac52-datebeforekey');
  if (gpg) {
    const r = spawnSync('gpg', ['--batch', '--list-keys', '--with-colons', gpg.fingerprint], { env: gpg.env, encoding: 'utf8' });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('pub:'));
    const created = parseInt((line || '').split(':')[5], 10);
    const created60 = created + 60;

    /* A forbidden window deliberately covering created60's own weekday/
     * time through the end of that day. */
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

    const repo = H.initRepoNoSignConfig('ac52-datebeforekey', gpg);
    /* 1000 days before created60 -- safely before the key (just created
     * "now") and, since 1000 mod 7 != 0, guaranteed to fall on a
     * DIFFERENT weekday than the forbidden window above, so --date's own
     * (real) instant never itself collides with it. */
    const chosen = created60 - 1000 * 86400;
    T.check('fixture: the chosen --date predates the key\'s own creation', chosen < created);
    const iso = new Date(chosen * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    H.gitIn(repo, gpg)(['add', '-A']);

    const policy = H.writePolicy('ac52-datebeforekey', { signingKey: gpg.fingerprint, timezone: 'UTC', forbiddenWindows: [{ days: [weekday], from, to }] });
    const out = H.runBin('git-sign', ['commit', repo, '--message=old date, new key', '--date=' + iso, '--policy=' + policy, '--apply'],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-52: apply succeeds, no gpg "time warp" crash and no forbidden-window refusal', out, 0);

    const head = H.revParse(repo, gpg, 'HEAD');
    const raw = H.gitRaw(repo, gpg, ['cat-file', 'commit', head]);
    const m = /gpgsig -----BEGIN PGP SIGNATURE-----\n([\s\S]*?)\n -----END PGP SIGNATURE-----/.exec(raw);
    T.check('AC-52: embedded signature present', !!m);
    if (m) {
      const armored = '-----BEGIN PGP SIGNATURE-----\n' + m[1].replace(/\n /g, '\n') + '\n-----END PGP SIGNATURE-----\n';
      const pk = spawnSync('gpg', ['--list-packets'], { env: gpg.env, input: armored, encoding: 'utf8' });
      const pm = /version \d+, created (\d+),/.exec(pk.stdout || '');
      T.check('AC-52: signature creation time parsed', !!pm, pk.stdout);
      if (pm) {
        T.eq('AC-52: signature clamped to the first ALLOWED minute at/after key-creation+60s, not the raw pin (D13)',
          parseInt(pm[1], 10), expectedFloor);
      }
    }
    /* The commit's OWN recorded date, unlike the signature, is untouched. */
    T.contains('AC-52: the commit\'s own committer date is still the original, chosen date', raw, String(chosen));

    const checkOut = H.runBin('git-sign', ['check', repo, head, '--policy=' + policy], { gnupgHome: gpg.gnupgHome });
    T.check('AC-52: a follow-up `check` over the new commit reports 0 violations -- the new sig-time rule needs no special case for this', checkOut.stdout.startsWith('check: 0 violation'), checkOut.stdout);
  }
}

T.finish();
