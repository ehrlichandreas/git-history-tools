/* AC-90 -- § 4.1: the backup bundle's restore recipe works as written.
 * The spec called it "(D14, tested)", but no test restored from a bundle.
 * After `replace --apply` and `apply --apply` (every branch and tag
 * moved), the plain `git fetch <bundle> 'refs/*:refs/*' --force` is
 * refused while HEAD is on a branch it would overwrite; the recipe
 * (detach, fetch, check out) then puts every ref back to its pre-run sha,
 * with a clean work tree; and `git clone --mirror <bundle>` shows the same
 * refs without touching the repo. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-history-rewrite');
H.requireBin('git-release-squash');

const outside = H.freshDir('ac90-files');
const rules = path.join(outside, 'rules.tsv');
fs.writeFileSync(rules, 'alpha\tomega\n');

for (const [label, bin, args] of [
  ['replace --apply', 'git-history-rewrite', (r: string) => ['replace', r, '--rules', rules, '--apply']],
  ['apply --apply', 'git-release-squash', (r: string) => ['apply', r, '--map', path.join(outside, 'map-' + path.basename(r)), '--apply']],
] as [string, string, (r: string) => string[]][]) {
  const gpg = H.setupGpg('ac90');
  if (!gpg) continue;
  const repo = H.initRepo('ac90', gpg);
  const git = H.gitIn(repo, gpg);
  H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' });
  H.tagSigned(repo, gpg, 'v1', 'release one');
  H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' });
  H.tagLightweight(repo, gpg, 'light');
  H.commit(repo, gpg, 'third', { 'a.txt': 'alpha beta gamma\n' });
  H.tagSigned(repo, gpg, 'v2', 'release two');
  git(['branch', 'side', 'v1']);
  const refs = () => H.gitRaw(repo, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const before = refs();
  const l = 'AC-90 [' + label + ']';

  const r = H.runBin(bin, args(repo), { gnupgHome: gpg.gnupgHome });
  T.exit(l + ': the rewrite succeeds', r, 0);
  const after = refs();
  T.check(l + ': refs moved', after !== before, after);
  const bundle = H.findBackupBundle(repo);
  T.check(l + ': one backup bundle', bundle !== null, String(bundle));
  if (!bundle) continue;

  const mirror = path.join(H.freshDir('ac90-mirror'), 'm.git');
  H.gitRaw(repo, gpg, ['clone', '-q', '--mirror', bundle, mirror]);
  T.eq(l + ': clone --mirror <bundle> shows the pre-run refs', H.gitRaw(mirror, gpg, ['for-each-ref', '--format=%(refname) %(objectname)']), before);
  T.eq(l + ': the mirror clone left the repo alone', refs(), after);

  const plain = git(['fetch', bundle, 'refs/*:refs/*', '--force']);
  T.check(l + ': fetch without detaching is refused', plain.status !== 0 && /refusing to fetch into branch/.test(plain.stderr || ''),
    plain.status + ' ' + plain.stderr);

  const detach = git(['checkout', '-q', '--detach', 'HEAD']);
  const fetch = git(['fetch', '-q', bundle, 'refs/*:refs/*', '--force']);
  const back = git(['checkout', '-q', 'main']);
  T.check(l + ': the recipe runs (detach, fetch, check out)', detach.status === 0 && fetch.status === 0 && back.status === 0,
    [detach, fetch, back].map((x) => x.status + ' ' + x.stderr).join(' | '));
  T.eq(l + ': every ref is back at its pre-run sha', refs(), before);
  T.eq(l + ': HEAD is on main again', H.gitRaw(repo, gpg, ['symbolic-ref', 'HEAD']).trim(), 'refs/heads/main');
  T.eq(l + ': the work tree is clean (untracked files aside)', H.gitRaw(repo, gpg, ['status', '--porcelain', '--untracked-files=no']), '');
  T.eq(l + ': the work tree has the pre-run content', fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'alpha beta gamma\n');
}

T.finish();
