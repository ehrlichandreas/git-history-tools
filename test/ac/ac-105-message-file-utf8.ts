/* AC-105 -- § 0 (D23): a `--message-file` whose bytes are not valid UTF-8
 * is one usage-error line, `<bin>: --message-file: not valid UTF-8:
 * <path>` (`-` for stdin), exit 2. It was decoded to U+FFFD and written
 * into the new tag or commit without a word. squash `tail --tag` and
 * git-sign `commit`/`tag`, dry run and `--apply`; git-sign also with
 * `--message-file=-`. Nothing is written: no bundle, no ref moved, no
 * object, nothing on stdout. A valid non-ASCII message still goes
 * through, byte for byte, a leading BOM too. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const T = H.T;

const BINS = ['git-release-squash', 'git-sign'];
for (const b of BINS) H.requireBin(b);

const BAD = Buffer.from([0x72, 0x65, 0x6c, 0x20, 0xe9, 0xff, 0x0a]);
const bad = path.join(H.freshDir('ac105-files'), 'bad.txt');
fs.writeFileSync(bad, BAD);

let policy = '';
const CASES: [string, (repo: string, f: string) => string[]][] = [
  ['git-release-squash', (r, f) => ['tail', r, '--tag=v2', '--message-file=' + f]],
  ['git-sign', (r, f) => ['commit', r, '--message-file=' + f, '--date=auto', '--policy=' + policy]],
  ['git-sign', (r, f) => ['tag', r, 'v2', '--message-file=' + f, '--date=auto', '--policy=' + policy]],
];

const fixture = (gpg: H.Gpg): string => {
  const repo = H.initRepo('ac105', gpg);
  H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
  H.tagSigned(repo, gpg, 'v1', 'release one');
  H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
  return repo;
};

const gpg = H.setupGpg('ac105');
if (gpg) {
  policy = H.writePolicy('ac105', { signingKey: gpg.fingerprint, timezone: 'UTC' });
  const runs: [string, string[], string, Buffer | undefined][] = [];
  for (const [bin, args] of CASES) {
    for (const apply of [false, true]) {
      const a = (r: string) => args(r, bad).concat(apply ? ['--apply'] : []);
      runs.push([bin, a('REPO'), bad, undefined]);
      if (bin === 'git-sign') runs.push([bin, args('REPO', '-').concat(apply ? ['--apply'] : []), '-', BAD]);
    }
  }
  for (const [bin, tmpl, named, input] of runs) {
    const repo = fixture(gpg);
    const a = tmpl.map((x) => (x === 'REPO' ? repo : x));
    const refs = () => H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']);
    const before = refs();
    const objs = H.objectStoreSnapshot(repo, gpg);
    const l = 'AC-105 [' + bin + ' ' + a[0] + ' --message-file=' + (named === '-' ? '-' : '<f>') +
      (a.includes('--apply') ? ' --apply' : '') + ']';

    const r = H.runBin(bin, a, { gnupgHome: gpg.gnupgHome, input });
    T.exit(l + ': a usage error, exit 2', r, 2);
    T.eq(l + ': one stderr line', r.stderr, bin + ': --message-file: not valid UTF-8: ' + named + '\n');
    T.eq(l + ': nothing on stdout', r.stdout, '');
    T.eq(l + ': no ref moved', refs(), before);
    T.eq(l + ': no backup bundle', H.findBackupBundle(repo), null);
    const d = H.objectStoreDiff(objs, H.objectStoreSnapshot(repo, gpg));
    T.check(l + ': no object written', d.added.length === 0 && !d.countChanged, JSON.stringify(d));
  }

  /* The control: valid UTF-8 beyond ASCII is taken as it is. */
  const good = path.join(H.freshDir('ac105-good'), 'good.txt');
  fs.writeFileSync(good, 'Release café ✓\n');
  const repo = fixture(gpg);
  const r = H.runBin('git-release-squash', ['tail', repo, '--tag=v2', '--message-file=' + good, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-105 control [tail --tag --apply, valid UTF-8]: exit 0', r, 0);
  if (!r.missing && r.status === 0) {
    const tagObj = H.catFile(repo, gpg, 'refs/tags/v2', 'tag');
    const msg = tagObj.slice(tagObj.indexOf('\n\n') + 2).replace(/-----BEGIN PGP SIGNATURE-----[\s\S]*$/, '');
    T.eq('AC-105 control: the tag message is the file\'s text', msg, 'Release café ✓\n');
  }

  /* A leading BOM is text, not a marker to drop: kept as it was. */
  const bom = path.join(H.freshDir('ac105-bom'), 'bom.txt');
  fs.writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Release BOM\n')]));
  const repoB = fixture(gpg);
  const rb = H.runBin('git-release-squash', ['tail', repoB, '--tag=v2', '--message-file=' + bom, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-105 control [tail --tag --apply, leading BOM]: exit 0', rb, 0);
  if (!rb.missing && rb.status === 0) {
    const raw = spawnSync('git', ['cat-file', 'tag', 'refs/tags/v2'], { cwd: repoB, env: gpg.env }).stdout as Buffer;
    const body = raw.subarray(raw.indexOf('\n\n') + 2, raw.indexOf('Release BOM') + 'Release BOM'.length);
    T.eq('AC-105 control: the BOM bytes are kept in the tag message', body.toString('hex'), Buffer.from('\ufeffRelease BOM').toString('hex'));
  }
}

T.finish();
