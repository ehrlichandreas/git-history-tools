/* AC-71 -- § 3 (D20): git-history-rewrite re-creates every annotated tag
 * with its message byte-exact and exactly one signature. It used to take
 * the message from `for-each-ref --format=%(contents)`, which for a
 * signed tag includes the old signature block (git-sign's D14 bug), so
 * every re-created signed tag carried two blocks while `verify:
 * signatures` said OK; and `git tag -F` cleaned the message up (a `#`
 * line and trailing spaces gone). The message now comes from the raw
 * object minus its trailing signature (the one boundary walk git-sign
 * uses), and is written verbatim. The replace rules' "a tag message would
 * change" refusal reads the same message, so a rule that only matches
 * inside the old signature no longer refuses. A tag whose message ends in
 * a signature-shaped block gpg cannot verify or attribute is refused, as
 * in git-sign (D18), rather than guessed at. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-history-rewrite');

function sigBlocks(raw: string): number {
  return (raw.match(/^-----BEGIN PGP SIGNATURE-----$/mg) || []).length;
}
/* The tag's message: the raw object after the header, up to the one trailing signature. */
function tagMessage(raw: string): string {
  const rest = raw.slice(raw.indexOf('\n\n') + 2);
  const i = rest.lastIndexOf('-----BEGIN PGP SIGNATURE-----');
  return i === -1 ? rest : rest.slice(0, i);
}

const outside = H.freshDir('ac71-files');
const rules = path.join(outside, 'rules.tsv');
fs.writeFileSync(rules, 'hello\tbye\n');
const addSrc = path.join(outside, 'NOTICE');
fs.writeFileSync(addSrc, 'notice\n');
/* A message `git tag -F` would clean up: a `#` line, trailing spaces, a trailing blank line. */
const verbatimMsg = 'release two\n\n# not a comment, part of the notes  \nend of notes\n\n';

for (const [label, args] of [
  ['replace', (repo: string) => ['replace', repo, '--rules', rules, '--apply']],
  ['add-file', (repo: string) => ['add-file', repo, addSrc, '--apply']],
] as [string, (repo: string) => string[]][]) {
  const gpg = H.setupGpg('ac71-' + label);
  if (!gpg) continue;
  const repo = H.initRepo('ac71-' + label, gpg);
  const git = H.gitIn(repo, gpg);
  H.commit(repo, gpg, 'first', { 'a.txt': 'hello\n' });
  H.tagSigned(repo, gpg, 'v1', 'release one');
  H.commit(repo, gpg, 'second', { 'b.txt': 'hello again\n' });
  git(['tag', '-s', '--cleanup=verbatim', '-F', '-', 'v2'], { input: verbatimMsg });
  T.eq('fixture [' + label + ']: v1 has 1 signature block', sigBlocks(H.catFile(repo, gpg, 'refs/tags/v1')), 1);
  T.eq('fixture [' + label + ']: v2 keeps its verbatim message', tagMessage(H.catFile(repo, gpg, 'refs/tags/v2')), verbatimMsg);

  const r = H.runBin('git-history-rewrite', args(repo), { gnupgHome: gpg.gnupgHome });
  T.exit('AC-71 [' + label + ']: --apply exits 0', r, 0);
  T.contains('AC-71 [' + label + ']: verify: signatures: OK', r.stdout, 'verify: signatures: OK');
  for (const [tag, msg] of [['v1', 'release one\n'], ['v2', verbatimMsg]]) {
    const raw = H.catFile(repo, gpg, 'refs/tags/' + tag);
    T.eq('AC-71 [' + label + ']: ' + tag + ' has exactly 1 signature block, not 2', sigBlocks(raw), 1);
    T.eq('AC-71 [' + label + ']: ' + tag + "'s message is byte-exact, nothing embedded or cleaned up", tagMessage(raw), msg);
    T.eq('AC-71 [' + label + ']: git tag -v ' + tag + ' accepts it', git(['tag', '-v', tag]).status, 0);
  }
}

/* A rule that only matches inside the old signature armor changes no message: no refusal. */
{
  const gpg = H.setupGpg('ac71-armor');
  if (gpg) {
    const repo = H.initRepo('ac71-armor', gpg);
    H.commit(repo, gpg, 'first', { 'a.txt': 'PGP SIGNATURE in a file\n' });
    H.tagSigned(repo, gpg, 'v1', 'release one');
    const armorRules = path.join(outside, 'armor.tsv');
    fs.writeFileSync(armorRules, 'PGP SIGNATURE\tSIG\n');
    const r = H.runBin('git-history-rewrite', ['replace', repo, '--rules', armorRules, '--apply'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-71 [armor-only rule]: not refused as a tag message change, exit 0', r, 0);
    T.eq('AC-71 [armor-only rule]: the file content was rewritten', H.gitRaw(repo, gpg, ['show', 'main:a.txt']), 'SIG in a file\n');
    T.eq('AC-71 [armor-only rule]: v1 has 1 signature block', sigBlocks(H.catFile(repo, gpg, 'refs/tags/v1')), 1);
  }
}

/* An unsigned tag whose message ENDS in a signature-shaped block nothing can verify: refused (D18). */
{
  const gpg = H.setupGpg('ac71-ambiguous');
  if (gpg) {
    const repo = H.initRepo('ac71-ambiguous', gpg);
    H.commit(repo, gpg, 'first', { 'a.txt': 'hello\n' });
    H.tagAnnotatedUnsigned(repo, gpg, 'v-quote',
      'advisory, quoted:\n\n-----BEGIN PGP SIGNATURE-----\n\nnot a real signature\n-----END PGP SIGNATURE-----');
    const refsBefore = H.gitRaw(repo, gpg, ['show-ref']);
    const objectsBefore = H.objectStoreSnapshot(repo, gpg);
    for (const apply of [false, true]) {
      const r = H.runBin('git-history-rewrite', ['replace', repo, '--rules', rules].concat(apply ? ['--apply'] : []), { gnupgHome: gpg.gnupgHome });
      const l = 'AC-71 [ambiguous tag' + (apply ? ', --apply' : '') + ']';
      T.exit(l + ': refused, exit 1', r, 1);
      T.contains(l + ': the refusal names the tag', r.stderr, 'git-history-rewrite: tag v-quote ends with a signature-shaped block');
      T.eq(l + ': nothing on stdout', r.stdout, '');
    }
    T.eq('AC-71 [ambiguous tag]: no ref moved', H.gitRaw(repo, gpg, ['show-ref']), refsBefore);
    T.eq('AC-71 [ambiguous tag]: no object written', JSON.stringify(H.objectStoreDiff(objectsBefore, H.objectStoreSnapshot(repo, gpg))),
      JSON.stringify({ added: [], removed: [], countChanged: false }));
    T.eq('AC-71 [ambiguous tag]: no backup bundle', H.findBackupBundle(repo), null);
  }
}

T.finish();
