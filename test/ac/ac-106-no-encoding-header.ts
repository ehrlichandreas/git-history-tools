/* AC-106 -- § 0 (D21, D23): a commit ght writes has no `encoding`
 * header, whatever the repo's `i18n.commitEncoding`. ght writes UTF-8
 * (D21), and a source commit with any other encoding is refused, so a
 * new commit gets no header (an explicit UTF-8 one: AC-107). With
 * `i18n.commitEncoding=ISO-8859-1` set after the history was made,
 * `commit-tree` and `git commit` stamped `encoding ISO-8859-1` over the
 * UTF-8 bytes they were given -- a viewer that honours the header shows
 * `cafÃ©` -- and resign-commits added a header the commit never had.
 * `i18n.logOutputEncoding` (its default is `i18n.commitEncoding`) made
 * `log --format` re-encode a message on its way to a rewrite, or to scan
 * and check, which then missed a UTF-8 term or pattern.
 * squash `apply`/`tail --tag`, rewrite `replace`, git-sign
 * `resign-commits` and `commit`, each `--apply`: exit 0, no header, the
 * message bytes UTF-8 as given. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const T = H.T;

const BINS = ['git-release-squash', 'git-history-rewrite', 'git-sign', 'git-leak-scan'];
for (const b of BINS) H.requireBin(b);

const CAFE = Buffer.from('café').toString('hex');

/** The header lines of a commit (gpgsig and its continuation lines
 * dropped) and its message, as bytes. */
const commitOf = (repo: string, gpg: H.Gpg, rev: string): { header: string[]; message: Buffer } => {
  const raw = spawnSync('git', ['cat-file', 'commit', rev], { cwd: repo, env: gpg.env }).stdout as Buffer;
  const end = raw.indexOf('\n\n');
  const header = raw.subarray(0, end).toString('latin1').split('\n').filter((l) => !l.startsWith(' ') && !l.startsWith('gpgsig'));
  return { header, message: raw.subarray(end + 2) };
};
const check = (l: string, repo: string, gpg: H.Gpg, rev: string) => {
  const c = commitOf(repo, gpg, rev);
  T.eq(l + ': no encoding header', c.header.filter((h) => h.startsWith('encoding ')).join(' '), '');
  T.check(l + ': the message has "café" as UTF-8 (c3 a9)', c.message.toString('hex').includes(CAFE), c.message.toString('hex'));
};

const gpg = H.setupGpg('ac106');
if (gpg) {
  const policy = H.writePolicy('ac106', { signingKey: gpg.fingerprint, timezone: 'UTC' });
  const fixture = (label: string, tagged: boolean, key = 'i18n.commitEncoding'): { repo: string; c0: string; c1: string } => {
    const repo = H.initRepo('ac106-' + label, gpg);
    const c0 = H.commit(repo, gpg, 'café root', { 'a.txt': 'alpha\n' }, { date: '@1000000000 +0000' }).sha!;
    if (tagged) H.tagSigned(repo, gpg, 'v1', 'café release');
    const c1 = H.commit(repo, gpg, 'café second', { 'a.txt': 'alpha beta\n' }, { date: '@1000000100 +0000' }).sha!;
    H.gitIn(repo, gpg)(['config', key, 'ISO-8859-1']);
    T.eq('AC-106 [' + label + '] fixture: the history has no encoding header',
      commitOf(repo, gpg, 'HEAD').header.filter((h) => h.startsWith('encoding ')).join(' '), '');
    return { repo, c0, c1 };
  };
  const run = (l: string, bin: string, args: string[]) => {
    const r = H.runBin(bin, args, { gnupgHome: gpg.gnupgHome });
    T.exit(l + ': exit 0', r, 0);
    return !r.missing && r.status === 0;
  };

  {
    const { repo } = fixture('apply', true);
    H.gitIn(repo, gpg)(['tag', '-s', 'v2', '-m', 'café two']);
    const map = path.join(H.freshDir('ac106-map'), 'map.txt');
    const l = 'AC-106 [apply --apply]';
    if (run(l, 'git-release-squash', ['apply', repo, '--name=proj', '--map', map, '--apply'])) {
      check(l + ' v1', repo, gpg, 'v1^{commit}');
      check(l + ' v2', repo, gpg, 'v2^{commit}');
    }
  }
  {
    const { repo } = fixture('tail', true);
    const l = 'AC-106 [tail --tag --apply]';
    if (run(l, 'git-release-squash', ['tail', repo, '--tag=v2', '--message=café two', '--apply'])) check(l, repo, gpg, 'HEAD');
  }
  {
    const { repo } = fixture('replace', false);
    const rules = path.join(H.freshDir('ac106-rules'), 'rules.tsv');
    fs.writeFileSync(rules, 'alpha\tomega\n');
    const l = 'AC-106 [replace --apply]';
    if (run(l, 'git-history-rewrite', ['replace', repo, '--rules', rules, '--apply'])) {
      check(l + ' root', repo, gpg, 'HEAD~1');
      check(l + ' HEAD', repo, gpg, 'HEAD');
    }
  }
  {
    /* i18n.logOutputEncoding alone: `log --format` handed the message
     * over in ISO-8859-1, and replace wrote those bytes back. */
    const { repo } = fixture('replace-log', false, 'i18n.logOutputEncoding');
    const rules = path.join(H.freshDir('ac106-rules2'), 'rules.tsv');
    fs.writeFileSync(rules, 'alpha\tomega\n');
    const l = 'AC-106 [replace --apply, i18n.logOutputEncoding]';
    if (run(l, 'git-history-rewrite', ['replace', repo, '--rules', rules, '--apply'])) check(l, repo, gpg, 'HEAD');
  }
  {
    /* Readers too: with i18n.logOutputEncoding=ISO-8859-1, scan and check
     * got each message re-encoded, so a UTF-8 term or pattern never
     * matched. */
    const { repo, c0, c1 } = fixture('read', false, 'i18n.logOutputEncoding');
    const terms = path.join(H.freshDir('ac106-terms'), 'terms.txt');
    fs.writeFileSync(terms, 'café\n');
    const s = H.runBin('git-leak-scan', ['scan', repo, '--terms', terms], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-106 [scan --terms, i18n.logOutputEncoding]: exit 1, a hit', s, 1);
    T.check('AC-106 [scan --terms, i18n.logOutputEncoding]: the hit is the UTF-8 term', s.stdout.includes('café'), s.stdout + s.stderr);
    const pol = H.writePolicy('ac106-check', { signingKey: gpg.fingerprint, timezone: 'UTC', forbiddenMessagePatterns: ['café'] });
    const c = H.runBin('git-sign', ['check', repo, c0 + '..' + c1, '--policy=' + pol], { gnupgHome: gpg.gnupgHome });
    T.contains('AC-106 [git-sign check, i18n.logOutputEncoding]: the message pattern matches',
      c.stdout, ' message matches forbidden pattern: café');
  }
  {
    const { repo, c0, c1 } = fixture('resign', false);
    const l = 'AC-106 [resign-commits --apply]';
    if (run(l, 'git-sign', ['resign-commits', repo, c0 + '..' + c1, '--apply', '--policy=' + policy])) check(l, repo, gpg, 'HEAD');
  }
  {
    const { repo } = fixture('commit', false);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    H.gitIn(repo, gpg)(['add', '-A']);
    const l = 'AC-106 [git-sign commit --apply]';
    if (run(l, 'git-sign', ['commit', repo, '--message=café three', '--date=auto', '--policy=' + policy, '--apply'])) check(l, repo, gpg, 'HEAD');
  }
}

T.finish();
