/* AC-45 -- § 5.2 `tag`: dry run prints resolved identity/date/key/signature
 * time; --apply creates a signed annotated tag on HEAD with tagger
 * identity/date from the policy and --date; refuses an existing tag name
 * (no --force -- that is resign-tags's job) and a --date at or before the
 * target commit's own committer date. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

function taggerLine(repo: string, gpg: H.Gpg, tag: string): string {
  const raw = H.catFile(repo, gpg, tag, '-p');
  const m = /^tagger (.*) (\d+) ([+-]\d{4})$/m.exec(raw);
  return m ? m[1] + '|' + m[2] + '|' + m[3] : '';
}

/** D8's no-persisted-config guarantee -- see ac-42's own copy of this helper. */
function gitConfigBytes(repo: string): Buffer {
  return fs.readFileSync(path.join(repo, '.git', 'config'));
}

{
  const gpg = H.setupGpg('ac45-tag');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac45-tag', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const policy = H.writePolicy('ac45-tag', {
      identity: { name: 'Policy Person', email: 'policy@example.invalid' },
      signingKey: gpg.fingerprint,
      timezone: 'UTC',
    });

    const dryObjBefore = H.objectStoreSnapshot(repo, gpg);
    const dry = H.runBin('git-sign',
      ['tag', repo, 'v1.0', '--message=release v1.0', '--date=2001-09-10T01:46:40Z', '--policy=' + policy],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-45 dry run: exit 0', dry, 0);
    T.contains('AC-45 dry run: reports the policy identity', dry.stdout, 'Policy Person <policy@example.invalid>');
    T.contains('AC-45 dry run: says no ref changed', dry.stdout, 'dry run, no ref changed');
    T.eq('AC-45 dry run: no tag created', H.gitRaw(repo, gpg, ['tag', '-l', 'v1.0']).trim(), '');
    const dryObjAfter = H.objectStoreSnapshot(repo, gpg);
    T.eq('AC-45 dry run: no new objects written (D2)', H.objectStoreDiff(dryObjBefore, dryObjAfter).added, []);

    const configBefore = gitConfigBytes(repo);
    const apply = H.runBin('git-sign',
      ['tag', repo, 'v1.0', '--message=release v1.0', '--date=2001-09-10T01:46:40Z', '--policy=' + policy, '--apply'],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-45 apply: exit 0', apply, 0);
    T.check('AC-45 apply: .git/config is byte-identical (D8, no persisted identity/key)', gitConfigBytes(repo).equals(configBefore));
    T.eq('AC-45 apply: tagger identity/date/offset from policy and --date', taggerLine(repo, gpg, 'v1.0'),
      'Policy Person <policy@example.invalid>|1000086400|+0000');
    T.eq('AC-45 apply: tag points at HEAD', H.revParse(repo, gpg, 'v1.0^{commit}'), H.revParse(repo, gpg, 'HEAD'));
    const verify = H.gitIn(repo, gpg)(['verify-tag', 'v1.0']);
    T.check('AC-45 apply: tag has a valid signature', verify.status === 0, verify.stderr);

    const again = H.runBin('git-sign',
      ['tag', repo, 'v1.0', '--message=again', '--date=2001-09-11T00:00:00Z', '--policy=' + policy, '--apply'],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-45: an existing tag name is refused, exit 1', again, 1);
    T.contains('AC-45: refusal mentions resign-tags', again.stderr, 'resign-tags');

    const tooEarly = H.runBin('git-sign',
      ['tag', repo, 'v2.0', '--message=too early', '--date=2001-01-01T00:00:00Z', '--policy=' + policy, '--apply'],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-45: a --date not after the target\'s committer date is refused', tooEarly, 1);
    T.eq('AC-45: no v2.0 tag created', H.gitRaw(repo, gpg, ['tag', '-l', 'v2.0']).trim(), '');
  }
}

/* ---- missing --date: usage error, nothing written ------------------- */
{
  const gpg = H.setupGpg('ac45-nodate');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac45-nodate', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const policy = H.writePolicy('ac45-nodate', { signingKey: gpg.fingerprint, timezone: 'UTC' });

    const r = H.runBin('git-sign',
      ['tag', repo, 'v-nodate', '--message=x', '--policy=' + policy, '--apply'],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-45 missing --date: usage error, exit 2', r, 2);
    T.contains('AC-45 missing --date: names the problem', r.stderr, 'missing --date');
    T.eq('AC-45 missing --date: nothing on stdout', r.stdout, '');
    T.eq('AC-45 missing --date: no tag created', H.gitRaw(repo, gpg, ['tag', '-l', 'v-nodate']).trim(), '');
  }
}

T.finish();
