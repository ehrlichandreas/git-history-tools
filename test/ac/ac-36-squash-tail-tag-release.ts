/* AC-36 -- § 1.3 (D2, commit a4e8b9f): `tail --tag=<tag>
 * (--message=<text>|--message-file=<path>)` finishes a full, anonymous
 * release in one call: subject naming the tag and the message's first
 * line, an annotated signed tag whose own message is the full text and
 * whose tagger date equals the commit's own date under anon, and a
 * refusal if the tag already exists. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-release-squash');

function identDate(repo: string, gpg: H.Gpg, rev: string, field: string): string | null {
  const raw = H.catFile(repo, gpg, rev, '-p');
  const m = new RegExp('^' + field + ' .* (\\d+ [+-]\\d{4})$', 'm').exec(raw);
  return m ? m[1] : null;
}
function tagMessage(repo: string, gpg: H.Gpg, tag: string): string | null {
  /* A signed tag object appends the PGP signature directly after the
   * message text, with no blank line in between -- cut there, or the
   * signature block ends up folded into the "message". */
  const raw = H.catFile(repo, gpg, tag, '-p');
  const lines = raw.split('\n');
  const blank = lines.indexOf('');
  if (blank < 0) return null;
  const sigIdx = lines.indexOf('-----BEGIN PGP SIGNATURE-----');
  const end = sigIdx >= 0 ? sigIdx : lines.length;
  return lines.slice(blank + 1, end).join('\n').replace(/\n$/, '');
}
function taggerDate(repo: string, gpg: H.Gpg, tag: string): string | null {
  const raw = H.catFile(repo, gpg, tag, '-p');
  const m = /^tagger .* (\d+ [+-]\d{4})$/m.exec(raw);
  return m ? m[1] : null;
}

/* ---- usage errors -------------------------------------------------- */
{
  const gpg = H.setupGpg('ac36-usage');
  if (gpg) {
    const repo = H.initRepo('ac36-usage', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });

    const noMsg = H.runBin('git-release-squash', ['tail', repo, '--tag=v1'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-36: --tag without --message/--message-file is a usage error, exit 2', noMsg, 2);

    const msgFile = path.join(H.freshDir("ac36-msg"), "ac36-msg.txt");
    fs.writeFileSync(msgFile, 'release one\n');
    const both = H.runBin('git-release-squash',
      ['tail', repo, '--tag=v1', '--message=release one', '--message-file=' + msgFile],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-36: --message AND --message-file together is a usage error, exit 2', both, 2);

    const msgNoTag = H.runBin('git-release-squash', ['tail', repo, '--message=release one'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-36: --message without --tag is a usage error, exit 2', msgNoTag, 2);

    const msgFileNoTag = H.runBin('git-release-squash', ['tail', repo, '--message-file=' + msgFile], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-36: --message-file without --tag is a usage error, exit 2', msgFileNoTag, 2);
  }
}

/* ---- basic release, --message ---------------------------------------- */
{
  const gpg = H.setupGpg('ac36-basic');
  if (gpg) {
    const repo = H.initRepo('ac36-basic', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });

    const dry = H.runBin('git-release-squash', ['tail', repo, '--tag=v1', '--message=release one'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-36 dry run: exit 0', dry, 0);
    if (!dry.missing) {
      T.contains('AC-36 dry run: the planned tag name and title appear (in place of "(untagged)")',
        dry.stdout, 'v1');
      T.contains('AC-36 dry run: still prints the dry-run line, writes nothing',
        dry.stdout, 'git-release-squash: dry run, no ref changed (use --apply to write)');
      const tags = H.gitRaw(repo, gpg, ['tag', '-l']);
      T.eq('AC-36 dry run: no tag was created', tags.trim(), '');
    }

    const branch = H.branchName(repo, gpg);
    const headBefore = H.revParse(repo, gpg, 'HEAD');

    const applied = H.runBin('git-release-squash', ['tail', repo, '--tag=v1', '--message=release one', '--apply'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-36 apply: exit 0', applied, 0);
    if (!applied.missing) {
      const headSha = H.revParse(repo, gpg, 'HEAD');
      T.eq('AC-36: HEAD is now exactly v1\'s commit', H.revParse(repo, gpg, 'v1^{commit}'), headSha);

      /* Bundle order: a bundle taken AFTER the write would carry the
       * branch's NEW tip under refs/heads/<branch> -- comparing against
       * the PRE-run sha (captured above, before v1 existed at all)
       * catches that. */
      const bundlePath = H.findBackupBundle(repo);
      T.check('AC-36: tail --tag --apply created a backup bundle', !!bundlePath, bundlePath);
      if (bundlePath) {
        const heads = H.bundleListHeads(bundlePath);
        T.eq('AC-36: the bundle\'s branch head is the PRE-release commit (bundled before the rewrite)',
          heads['refs/heads/' + branch], headBefore);
        T.check('AC-36: the bundle has no refs/tags/v1 yet (v1 did not exist before this release)',
          !('refs/tags/v1' in heads), JSON.stringify(heads));
      }

      const raw = H.catFile(repo, gpg, headSha, '-p');
      T.contains('AC-36: subject is "<name> v1: release one" (first line of the message)',
        raw, 'v1: release one');

      const t = spawnSync('git', ['cat-file', '-t', 'v1'], { cwd: repo, env: gpg.env, encoding: 'utf8' });
      T.eq('AC-36: v1 is an annotated tag object (not lightweight)', t.stdout.trim(), 'tag');
      T.eq('AC-36: the tag\'s own message is the full given text', tagMessage(repo, gpg, 'v1'), 'release one');

      T.eq('AC-36: the tag\'s tagger date equals the commit\'s own author/committer date (anon)',
        taggerDate(repo, gpg, 'v1'), identDate(repo, gpg, headSha, 'author'));
      T.eq('AC-36: committer date matches too', identDate(repo, gpg, headSha, 'committer'), identDate(repo, gpg, headSha, 'author'));

      const vc = spawnSync('git', ['verify-commit', headSha], { cwd: repo, env: gpg.env, encoding: 'utf8' });
      T.check('AC-36: git verify-commit accepts the new commit', vc.status === 0, vc.stderr);
      const vt = spawnSync('git', ['verify-tag', 'v1'], { cwd: repo, env: gpg.env, encoding: 'utf8' });
      T.check('AC-36: git verify-tag accepts v1', vt.status === 0, vt.stderr);
    }
  }
}

/* ---- --message-file, multi-line ---------------------------------------- */
{
  const gpg = H.setupGpg('ac36-file');
  if (gpg) {
    const repo = H.initRepo('ac36-file', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });

    const msgFile = path.join(H.freshDir("ac36-multiline-msg"), "ac36-multiline-msg.txt");
    fs.writeFileSync(msgFile, 'release two\n\nSome further release notes.\n');

    const applied = H.runBin('git-release-squash', ['tail', repo, '--tag=v2', '--message-file=' + msgFile, '--apply'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-36 (--message-file) apply: exit 0', applied, 0);
    if (!applied.missing) {
      const headSha = H.revParse(repo, gpg, 'HEAD');
      const raw = H.catFile(repo, gpg, headSha, '-p');
      T.contains('AC-36 (--message-file): subject uses only the FIRST line as title',
        raw, 'v2: release two');
      T.check('AC-36 (--message-file): subject does not also carry the second line',
        !raw.includes('Some further release notes'), raw);
      T.eq('AC-36 (--message-file): the tag\'s own message is the file\'s full contents',
        tagMessage(repo, gpg, 'v2'), 'release two\n\nSome further release notes.');
    }
  }
}

/* ---- refuses an existing tag -------------------------------------------- */
{
  const gpg = H.setupGpg('ac36-exists');
  if (gpg) {
    const repo = H.initRepo('ac36-exists', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' });
    H.tagSigned(repo, gpg, 'v1', 'unrelated pre-existing tag');
    H.commit(repo, gpg, 'untagged follow-up', { 'a.txt': 'two\n' });

    const refsBefore = H.gitRaw(repo, gpg, ['show-ref']);
    const r = H.runBin('git-release-squash', ['tail', repo, '--tag=v1', '--message=release one', '--apply'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-36: refuses when the tag already exists', r, 1);
    if (!r.missing) {
      T.contains('AC-36: refusal names the existing tag', r.stderr, 'tag v1 already exists');
      const refsAfter = H.gitRaw(repo, gpg, ['show-ref']);
      T.eq('AC-36: nothing written -- refs are byte-identical to before the refused attempt', refsAfter, refsBefore);
    }
  }
}

T.finish();
