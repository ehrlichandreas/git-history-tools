/* AC-82 -- D21 (Scout N3): a repository's own config cannot run code
 * through ght's git calls. D17 pinned the signing programs, but
 * `core.hooksPath` and `core.fsmonitor` still ran: `git-sign commit
 * --apply` ran the repo's pre-commit/commit-msg/post-commit hooks and its
 * fsmonitor, and every tool's `update-ref` ran a reference-transaction
 * hook. Every git call ght makes now runs with `-c core.hooksPath=/dev/null
 * -c core.fsmonitor=false`. Each case points both at marker scripts
 * that exit 0 and checks neither ran. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');
H.requireBin('git-release-squash');
H.requireBin('git-history-rewrite');

const outside = H.freshDir('ac82-files');
const rules = path.join(outside, 'rules.tsv');
fs.writeFileSync(rules, 'alpha\tomega\n');

/* core.hooksPath and core.fsmonitor in `repo`'s config, all logging to one marker file. */
function hostile(repo: string, gpg: H.Gpg, label: string): string {
  const dir = H.freshDir('ac82-hooks');
  const marker = path.join(outside, 'marker-' + label);
  for (const h of ['pre-commit', 'commit-msg', 'post-commit', 'reference-transaction', 'post-rewrite']) {
    fs.writeFileSync(path.join(dir, h), '#!/bin/sh\necho "' + h + ' $*" >> ' + JSON.stringify(marker) + '\nexit 0\n');
    fs.chmodSync(path.join(dir, h), 0o755);
  }
  const fsmon = path.join(dir, 'fsmonitor.sh');
  fs.writeFileSync(fsmon, '#!/bin/sh\necho "fsmonitor $*" >> ' + JSON.stringify(marker) + '\nexit 1\n');
  fs.chmodSync(fsmon, 0o755);
  H.gitIn(repo, gpg)(['config', 'core.hooksPath', dir]);
  H.gitIn(repo, gpg)(['config', 'core.fsmonitor', fsmon]);
  return marker;
}
const ran = (marker: string) => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '');

function history(gpg: H.Gpg): string {
  const repo = H.initRepo('ac82', gpg);
  H.commit(repo, gpg, 'first', { 'a.txt': 'alpha\n' }, { date: '@1000000000 +0000' });
  H.tagSigned(repo, gpg, 'v1', 'release one');
  H.commit(repo, gpg, 'second', { 'a.txt': 'alpha beta\n' }, { date: '@1000086400 +0000' });
  return repo;
}

const gpg = H.setupGpg('ac82');
if (gpg) {
  const policy = H.writePolicy('ac82', { signingKey: gpg.fingerprint });
  const opts = { gnupgHome: gpg.gnupgHome };

  /* The fixture's own git does run them: the markers are live. */
  {
    const repo = history(gpg);
    const marker = hostile(repo, gpg, 'live');
    H.gitIn(repo, gpg)(['status', '--porcelain']);
    H.gitIn(repo, gpg)(['update-ref', 'refs/heads/probe', 'HEAD']);
    T.check('AC-82 fixture: plain git runs the fsmonitor and the reference-transaction hook',
      /fsmonitor/.test(ran(marker)) && /reference-transaction/.test(ran(marker)), ran(marker));
  }

  {
    const repo = history(gpg);
    const marker = hostile(repo, gpg, 'commit');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    H.gitIn(repo, gpg)(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'add', 'b.txt']);
    const r = H.runBin('git-sign', ['commit', repo, '--message=third', '--date=2026-01-05T12:00Z', '--policy=' + policy, '--apply'], opts);
    T.exit('AC-82 [git-sign commit --apply]: exit 0', r, 0);
    T.eq('AC-82 [git-sign commit --apply]: no hook, no fsmonitor ran', ran(marker), '');
  }

  for (const [label, bin, args] of [
    ['tail --tag --apply', 'git-release-squash', (r: string) => ['tail', r, '--tag=v2', '--message=release two', '--apply']],
    ['replace --apply', 'git-history-rewrite', (r: string) => ['replace', r, '--rules', rules, '--apply']],
    ['resign-tags --apply', 'git-sign', (r: string) => ['resign-tags', r, 'v1', '--policy=' + policy, '--apply']],
  ] as [string, string, (r: string) => string[]][]) {
    const repo = history(gpg);
    const marker = hostile(repo, gpg, label.replace(/ /g, '-'));
    const r = H.runBin(bin, args(repo), opts);
    T.exit('AC-82 [' + label + ']: exit 0', r, 0);
    T.eq('AC-82 [' + label + ']: no hook, no fsmonitor ran', ran(marker), '');
  }
}

T.finish();
