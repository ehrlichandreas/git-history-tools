/* AC-104 -- § 1.1 (D23): what `plan` prints for each tag.
 *
 *   plan: <tag> folds <N> commit(s) (<oldest-short>..<tag-short>) into "<subject>"
 *   plan: <tag> tree equals <tag-short>'s own tree: OK
 *
 * `<subject>` is the subject `apply` writes, `<name> <tag>: <title>`, not
 * the bare title. `<tag-short>` is the preview of the new squash commit:
 * the unsigned commit `apply` would build (tree, parent chain, subject,
 * dates), never the tag object's own sha nor the tagged commit's. The
 * oracle builds that commit with `git commit-tree` in a clone; plan itself
 * writes no object. `<title>` is the first line of an annotated tag's
 * message (§ 0), so a tag whose message starts with two lines is not
 * joined into one, and `apply` keeps that tag's message as it was. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-release-squash');

const anon = (i: number) => '@' + ((i + 1) * 86400 + 43200) + ' +0000';
const MSG = 'first line\nsecond line\n\nbody text\n';

const gpg = H.setupGpg('ac104');
if (gpg) {
  const repo = H.initRepo('ac104', gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  H.commit(repo, gpg, 'second', { 'a.txt': 'two\n' });
  H.gitIn(repo, gpg)(['tag', '-s', 'v1', '-F', '-'], { input: MSG });
  H.commit(repo, gpg, 'third', { 'a.txt': 'three\n' });
  H.tagLightweight(repo, gpg, 'v2');

  /* The oracle: the two unsigned squash commits apply would build, made
   * in a clone so the fixture's own object store stays as it was. */
  const clone = path.join(H.freshDir('ac104-oracle'), 'clone');
  spawnSync('git', ['clone', '-q', repo, clone], { env: gpg.env });
  const ct = (tree: string, parent: string | null, date: string, subject: string): string => {
    const r = spawnSync('git', ['-c', 'user.name=GHT Test', '-c', 'user.email=' + H.FIXTURE_EMAIL, '-c', 'commit.gpgsign=false',
      'commit-tree', tree].concat(parent ? ['-p', parent] : []),
    { cwd: clone, input: subject + '\n', encoding: 'utf8', env: Object.assign({}, gpg.env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }) });
    return (r.stdout || '').trim();
  };
  const tree1 = H.revParse(repo, gpg, 'v1^{tree}');
  const tree2 = H.revParse(repo, gpg, 'v2^{tree}');
  const p1 = ct(tree1, null, anon(0), 'proj v1: first line');
  const p2 = ct(tree2, p1, anon(1), 'proj v2: third');
  T.check('AC-104 fixture: the oracle built both preview commits', /^[0-9a-f]{40}$/.test(p1) && /^[0-9a-f]{40}$/.test(p2), p1 + ' ' + p2);

  const before = H.objectStoreSnapshot(repo, gpg);
  const r = H.runBin('git-release-squash', ['plan', repo, '--name=proj'], { gnupgHome: gpg.gnupgHome });
  const after = H.objectStoreSnapshot(repo, gpg);
  T.exit('AC-104 plan: exit 0', r, 0);
  if (!r.missing) {
    const lines = r.stdout.split('\n');
    const fold = (tag: string) => new RegExp('^plan: ' + tag + ' folds \\d+ commit\\(s\\) \\(([0-9a-f]+)\\.\\.([0-9a-f]+)\\) into "(.*)"$')
      .exec(lines.find((l) => l.startsWith('plan: ' + tag + ' folds')) || '');
    const f1 = fold('v1');
    const f2 = fold('v2');
    T.check('AC-104 plan: both fold lines have the documented shape', !!f1 && !!f2, r.stdout);
    if (f1 && f2) {
      T.eq('AC-104 plan: v1\'s <subject> is "<name> <tag>: <title>", the title the first line of the tag message',
        f1[3], 'proj v1: first line');
      T.eq('AC-104 plan: v2 (lightweight) has the subject of its commit after "<name> <tag>: "', f2[3], 'proj v2: third');
      T.check('AC-104 plan: v1\'s <tag-short> is not the tag object\'s sha',
        !H.revParse(repo, gpg, 'refs/tags/v1').startsWith(f1[2]), f1[2]);
      T.check('AC-104 plan: nor the tagged commit\'s',
        !H.revParse(repo, gpg, 'v1^{commit}').startsWith(f1[2]), f1[2]);
      T.check('AC-104 plan: v1\'s <tag-short> is the preview of its unsigned squash commit',
        f1[2].length >= 4 && p1.startsWith(f1[2]), f1[2] + ' vs ' + p1);
      T.check('AC-104 plan: v2\'s <tag-short> is the preview parented on v1\'s',
        f2[2].length >= 4 && p2.startsWith(f2[2]), f2[2] + ' vs ' + p2);
      T.contains('AC-104 plan: v1\'s tree line names the same preview', r.stdout, 'plan: v1 tree equals ' + f1[2] + '\'s own tree: OK');
      T.contains('AC-104 plan: v2\'s tree line names the same preview', r.stdout, 'plan: v2 tree equals ' + f2[2] + '\'s own tree: OK');
    }
    const d = H.objectStoreDiff(before, after);
    T.check('AC-104 plan: writes no object (the preview is hashed, not stored)',
      d.added.length === 0 && d.removed.length === 0 && !d.countChanged, JSON.stringify(d));
  }

  const dry = H.runBin('git-release-squash', ['apply', repo, '--name=proj', '--map', path.join(H.freshDir('ac104-map0'), 'map.txt')], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-104 apply dry run: exit 0', dry, 0);
  T.check('AC-104 apply dry run: the same per-tag lines as plan',
    !dry.missing && !r.missing && dry.stdout.startsWith(r.stdout), dry.stdout);

  const map = path.join(H.freshDir('ac104-map'), 'map.txt');
  const applied = H.runBin('git-release-squash', ['apply', repo, '--name=proj', '--map', map, '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-104 apply --apply: exit 0', applied, 0);
  if (!applied.missing && applied.status === 0) {
    T.eq('AC-104 apply: v1\'s commit subject is the subject plan printed',
      H.gitRaw(repo, gpg, ['log', '-1', '--format=%s', 'v1^{commit}']).trim(), 'proj v1: first line');
    const tagObj = H.catFile(repo, gpg, 'refs/tags/v1', 'tag');
    const msg = tagObj.slice(tagObj.indexOf('\n\n') + 2).replace(/-----BEGIN PGP SIGNATURE-----[\s\S]*$/, '');
    T.eq('AC-104 apply: v1 keeps its message as it was, the two first lines not joined', msg, MSG);
  }
  fs.rmSync(path.dirname(clone), { recursive: true, force: true });
}

/* The preview's identity is the repo's own; with none at all
 * (user.useConfigOnly, no user.name/email) plan, read-only, still runs and
 * writes `unknown <unknown>` into the preview. With i18n.commitEncoding
 * set, apply writes no `encoding` header (AC-106), and neither has the
 * preview: it is the written commit without its signature. */
const plainTag = (gpg: H.Gpg, label: string): string => {
  const repo = H.initRepo(label, gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
  H.tagSigned(repo, gpg, 'v1', 'release one');
  return repo;
};
const tagShort = (out: string) => (/^plan: v1 folds 1 commit\(s\) \([0-9a-f]+\.\.([0-9a-f]+)\)/m.exec(out) || [])[1] || '';

const gpgN = H.setupGpg('ac104n');
if (gpgN) {
  const repo = plainTag(gpgN, 'ac104n');
  const g = H.gitIn(repo, gpgN);
  g(['config', '--unset', 'user.name']);
  g(['config', '--unset', 'user.email']);
  g(['config', 'user.useConfigOnly', 'true']);
  const v = spawnSync('git', ['var', 'GIT_COMMITTER_IDENT'], { cwd: repo, env: gpgN.env, encoding: 'utf8' });
  T.check('AC-104 [no identity] fixture: git var has no identity here', v.status !== 0, v.stdout);
  const oracle = (spawnSync('git', ['hash-object', '-t', 'commit', '--stdin'], { cwd: repo, env: gpgN.env, encoding: 'utf8',
    input: 'tree ' + H.revParse(repo, gpgN, 'v1^{tree}') + '\nauthor unknown <unknown> 129600 +0000\ncommitter unknown <unknown> 129600 +0000\n\nproj v1: release one\n' }).stdout || '').trim();
  const r = H.runBin('git-release-squash', ['plan', repo, '--name=proj'], { gnupgHome: gpgN.gnupgHome });
  T.exit('AC-104 [no identity] plan: exit 0', r, 0);
  T.eq('AC-104 [no identity] plan: nothing on stderr', r.stderr, '');
  const t = tagShort(r.stdout);
  T.check('AC-104 [no identity] plan: <tag-short> is the preview with "unknown <unknown>"',
    t.length >= 4 && oracle.startsWith(t), t + ' vs ' + oracle);
}

/* A title is one clean line (D23): a CRLF message's trailing CR is
 * trimmed, as git trims a subject, and any other control character (a
 * lone CR, ESC) is a space, so neither plan's line nor the release
 * commit's subject carries one. The tag message gets `git tag`'s default
 * cleanup, as every message apply re-creates. */
const gpgC = H.setupGpg('ac104c');
if (gpgC) {
  const repo = H.initRepo('ac104c', gpgC);
  const g = H.gitIn(repo, gpgC);
  const MSG1 = 'Title crlf\r\n\r\nbody line\r\n';
  H.commit(repo, gpgC, 'root', { 'a.txt': 'one\n' });
  g(['tag', '-s', '--cleanup=verbatim', 'v1', '-F', '-'], { input: MSG1 });
  H.commit(repo, gpgC, 'second', { 'a.txt': 'two\n' });
  g(['tag', '-s', '--cleanup=verbatim', 'v2', '-F', '-'], { input: 'a\rb\x1bc\u009bd\n' });
  /* Controls become spaces before the trim: a trailing ESC leaves no
   * trailing space, and a line of nothing but controls (or a CRLF alone)
   * is "(no title)". A lightweight tag's title, git's %s, keeps an ESC
   * git does not strip; it goes through the same rule. */
  const TITLED: [string, string | null, string][] = [
    ['v3', 'v3\x1b\n', 'v3'], ['v4', '\x1b\nbody\n', '(no title)'], ['v5', '\r\n', '(no title)'], ['v6', null, 'light weight'],
  ];
  for (const [tag, msg] of TITLED) {
    H.commit(repo, gpgC, msg === null ? 'light\x1bweight' : 'before ' + tag, { 'a.txt': tag + '\n' });
    if (msg === null) H.tagLightweight(repo, gpgC, tag);
    else g(['tag', '-s', '--cleanup=verbatim', tag, '-F', '-'], { input: msg });
  }
  T.check('AC-104 [CR] fixture: v1\'s message has its CRLFs', H.catFile(repo, gpgC, 'refs/tags/v1', 'tag').includes('Title crlf\r\n'));
  const r = H.runBin('git-release-squash', ['plan', repo, '--name=proj'], { gnupgHome: gpgC.gnupgHome });
  T.exit('AC-104 [CR] plan: exit 0', r, 0);
  T.check('AC-104 [CR] plan: no CR, ESC or C1 control in its output', !/[\r\x1b\u0080-\u009f]/.test(r.stdout), JSON.stringify(r.stdout));
  T.contains('AC-104 [CR] plan: v1\'s subject without the CR', r.stdout, ' into "proj v1: Title crlf"\n');
  T.contains('AC-104 [CR] plan: v2\'s lone CR, ESC and CSI (U+009B) are spaces', r.stdout, ' into "proj v2: a b c d"\n');
  for (const [tag, , title] of TITLED) {
    T.contains('AC-104 [CR] plan: ' + tag + '\'s subject is "proj ' + tag + ': ' + title + '"', r.stdout, ' into "proj ' + tag + ': ' + title + '"\n');
  }
  const shorts = [...r.stdout.matchAll(/^plan: (v\d) folds \d+ commit\(s\) \([0-9a-f]+\.\.([0-9a-f]+)\)/gm)].map((m) => m[2]);
  const map = path.join(H.freshDir('ac104c-map'), 'map.txt');
  const a = H.runBin('git-release-squash', ['apply', repo, '--name=proj', '--map', map, '--apply'], { gnupgHome: gpgC.gnupgHome });
  T.exit('AC-104 [CR] apply --apply: exit 0', a, 0);
  if (!a.missing && a.status === 0) {
    const SUBJ = ['proj v1: Title crlf', 'proj v2: a b c d'].concat(TITLED.map(([tag, , title]) => 'proj ' + tag + ': ' + title));
    ['v1', 'v2'].concat(TITLED.map(([tag]) => tag)).forEach((tag, i) => {
      const raw = H.catFile(repo, gpgC, tag + '^{commit}', 'commit');
      const end = raw.indexOf('\n\n');
      T.eq('AC-104 [CR] apply: ' + tag + '\'s commit message is the subject plan printed, no control character',
        raw.slice(end + 2), SUBJ[i] + '\n');
      const unsigned = raw.slice(0, end).split('\n').filter((l) => !l.startsWith('gpgsig') && !l.startsWith(' ')).join('\n') + raw.slice(end);
      const h = (spawnSync('git', ['hash-object', '-t', 'commit', '--stdin'], { cwd: repo, env: gpgC.env, input: unsigned, encoding: 'utf8' }).stdout || '').trim();
      /* v2's preview is parented on v1's unsigned preview, apply's on the
       * signed v1 (§ 1.1), so only the root group's can be the same bytes. */
      if (i === 0) T.check('AC-104 [CR] apply: v1\'s written commit without its signature is the preview', !!shorts[0] && h.startsWith(shorts[0]), h + ' vs ' + shorts[0]);
    });
    const tagObj = H.catFile(repo, gpgC, 'refs/tags/v1', 'tag');
    T.eq('AC-104 [CR] apply: v1\'s message is as git tag\'s default cleanup leaves it, both lines kept',
      tagObj.slice(tagObj.indexOf('\n\n') + 2).replace(/-----BEGIN PGP SIGNATURE-----[\s\S]*$/, ''), 'Title crlf\n\nbody line\n');
  }
  /* tail --tag takes its title by the same rule. */
  const repoT = H.initRepo('ac104t', gpgC);
  H.commit(repoT, gpgC, 'root', { 'a.txt': 'one\n' });
  H.tagSigned(repoT, gpgC, 'v1', 'release one');
  H.commit(repoT, gpgC, 'second', { 'a.txt': 'two\n' });
  const mf = path.join(H.freshDir('ac104t-msg'), 'msg.txt');
  fs.writeFileSync(mf, 'Tail crlf\r\n\r\nbody\r\n');
  const t = H.runBin('git-release-squash', ['tail', repoT, '--name=proj', '--tag=v2', '--message-file=' + mf, '--apply'], { gnupgHome: gpgC.gnupgHome });
  T.exit('AC-104 [CR] tail --tag --apply: exit 0', t, 0);
  if (!t.missing && t.status === 0) {
    const raw = H.catFile(repoT, gpgC, 'HEAD', 'commit');
    T.eq('AC-104 [CR] tail: the commit message has no CR', raw.slice(raw.indexOf('\n\n') + 2), 'proj v2: Tail crlf\n');
  }
  /* ... and so does untagged tail, from HEAD's subject (git's %s). */
  const repoU = H.initRepo('ac104u', gpgC);
  H.commit(repoU, gpgC, 'root', { 'a.txt': 'one\n' });
  H.tagSigned(repoU, gpgC, 'v1', 'release one');
  H.commit(repoU, gpgC, 'tail\x1bsubject', { 'a.txt': 'two\n' });
  const u = H.runBin('git-release-squash', ['tail', repoU, '--name=proj', '--apply'], { gnupgHome: gpgC.gnupgHome });
  T.exit('AC-104 [CR] untagged tail --apply: exit 0', u, 0);
  if (!u.missing && u.status === 0) {
    const raw = H.catFile(repoU, gpgC, 'HEAD', 'commit');
    T.eq('AC-104 [CR] untagged tail: HEAD\'s ESC is a space', raw.slice(raw.indexOf('\n\n') + 2), 'proj (untagged): tail subject\n');
  }
}

const gpgE = H.setupGpg('ac104e');
if (gpgE) {
  const repo = plainTag(gpgE, 'ac104e');
  H.gitIn(repo, gpgE)(['config', 'i18n.commitEncoding', 'ISO-8859-1']);
  const r0 = spawnSync('git', ['-c', 'user.name=GHT Test', '-c', 'user.email=' + H.FIXTURE_EMAIL, '-c', 'commit.gpgsign=false',
    '-c', 'i18n.commitEncoding=UTF-8', 'commit-tree', H.revParse(repo, gpgE, 'v1^{tree}')],
  { cwd: repo, input: 'proj v1: release one\n', encoding: 'utf8', env: Object.assign({}, gpgE.env, { GIT_AUTHOR_DATE: anon(0), GIT_COMMITTER_DATE: anon(0) }) });
  const oracle = (r0.stdout || '').trim();
  T.check('AC-104 [i18n.commitEncoding] fixture: the oracle has no encoding header',
    /^[0-9a-f]{40}$/.test(oracle) && !/^encoding /m.test(H.catFile(repo, gpgE, oracle, 'commit')), oracle);
  const r = H.runBin('git-release-squash', ['plan', repo, '--name=proj'], { gnupgHome: gpgE.gnupgHome });
  T.exit('AC-104 [i18n.commitEncoding] plan: exit 0', r, 0);
  const t = tagShort(r.stdout);
  T.check('AC-104 [i18n.commitEncoding] plan: <tag-short> is the preview, no encoding header',
    t.length >= 4 && oracle.startsWith(t), t + ' vs ' + oracle);
  const map = path.join(H.freshDir('ac104e-map'), 'map.txt');
  const a = H.runBin('git-release-squash', ['apply', repo, '--name=proj', '--map', map, '--apply'], { gnupgHome: gpgE.gnupgHome });
  T.exit('AC-104 [i18n.commitEncoding] apply --apply: exit 0', a, 0);
  if (!a.missing && a.status === 0) {
    const raw = H.catFile(repo, gpgE, 'v1^{commit}', 'commit');
    const end = raw.indexOf('\n\n');
    const unsigned = raw.slice(0, end).split('\n').filter((l) => !l.startsWith('gpgsig') && !l.startsWith(' ')).join('\n') + raw.slice(end);
    const h = (spawnSync('git', ['hash-object', '-t', 'commit', '--stdin'], { cwd: repo, env: gpgE.env, input: unsigned, encoding: 'utf8' }).stdout || '').trim();
    T.eq('AC-104 [i18n.commitEncoding] apply: the written commit without its signature is the preview', h, oracle);
  }
}

T.finish();
