/* AC-43 -- § 5.1 `commit --amend`: author date = committer date = the
 * chosen --date even under --amend. Git's own `commit --amend` otherwise
 * silently keeps the ORIGINAL author date unless --date is passed on the
 * command line (GIT_AUTHOR_DATE alone is ignored under --amend) -- this is
 * exactly the quirk git-sign must paper over. Amending also moves the
 * parent back to HEAD^, so the lower bound for --date is the grandparent's
 * committer date, not HEAD's own. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

function identLine(repo: string, gpg: H.Gpg, rev: string, field: string): string {
  const raw = H.catFile(repo, gpg, rev, '-p');
  const m = new RegExp('^' + field + ' (.*) (\\d+) ([+-]\\d{4})$', 'm').exec(raw);
  return m ? m[1] + '|' + m[2] + '|' + m[3] : '';
}

/** D8's no-persisted-config guarantee, under --amend specifically -- the
 * one commit path that also passes --author/--date on the command line
 * (not only via env vars), so worth its own byte-identical check. */
function gitConfigBytes(repo: string): Buffer {
  return fs.readFileSync(path.join(repo, '.git', 'config'));
}

{
  const gpg = H.setupGpg('ac43-amend');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac43-amend', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const grandparent = H.revParse(repo, gpg, 'HEAD');
    H.commit(repo, gpg, 'original message, real author date', { 'b.txt': 'two\n' }, { date: '@1000050000 +0000' });
    const original = H.revParse(repo, gpg, 'HEAD');

    const policy = H.writePolicy('ac43-amend', {
      identity: { name: 'Policy Person', email: 'policy@example.invalid' },
      signingKey: gpg.fingerprint,
      timezone: 'UTC',
    });

    /* Strictly after the GRANDPARENT's committer date (1000000000), not
     * the amended-away original commit's own date -- amending moves the
     * effective parent back one step. */
    const configBefore = gitConfigBytes(repo);
    const r = H.runBin('git-sign',
      ['commit', repo, '--amend', '--message=amended message', '--date=2001-09-10T01:46:40Z', '--policy=' + policy, '--apply'],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-43 amend --apply: exit 0', r, 0);
    T.check('AC-43 amend --apply: .git/config is byte-identical (D8, no persisted identity/key)', gitConfigBytes(repo).equals(configBefore));

    const newHead = H.revParse(repo, gpg, 'HEAD');
    T.check('AC-43 amend: HEAD replaced (not a new child commit)', newHead !== original);
    const parent = H.gitIn(repo, gpg)(['rev-parse', 'HEAD^']).stdout.trim();
    T.eq('AC-43 amend: parent is still the grandparent', parent, grandparent);

    const author = identLine(repo, gpg, 'HEAD', 'author');
    const committer = identLine(repo, gpg, 'HEAD', 'committer');
    T.eq('AC-43 amend: author date is the CHOSEN date, not the original commit\'s', author, 'Policy Person <policy@example.invalid>|1000086400|+0000');
    T.eq('AC-43 amend: committer date equals author date', committer, author);

    const msg = H.gitIn(repo, gpg)(['log', '-1', '--format=%B', 'HEAD']).stdout.trim();
    T.eq('AC-43 amend: message is the new one', msg, 'amended message');

    /* A --date before the grandparent's own committer date is refused,
     * even though it is comfortably after the (now amended-away) original
     * commit's parent chain would suggest. */
    const before = H.revParse(repo, gpg, 'HEAD');
    const tooEarly = H.runBin('git-sign',
      ['commit', repo, '--amend', '--message=amended again', '--date=2001-01-01T00:00:00Z', '--policy=' + policy, '--apply'],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-43 amend: --date before the grandparent is refused', tooEarly, 1);
    T.eq('AC-43 amend: HEAD unchanged after refusal', H.revParse(repo, gpg, 'HEAD'), before);
  }
}

T.finish();
