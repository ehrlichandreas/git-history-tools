'use strict';
/* AC-35 -- § 4.3 (D1, commit bd16ac2): `tail` keeps every EXISTING
 * commit's date unchanged; each NEW commit it writes gets the anon date
 * for its own position in the resulting history, continuing from
 * wherever `apply` left off -- not starting over at position 1, and not
 * based on wall-clock time. A history squashed by `apply` and later
 * extended by `tail` ends up with exactly the same per-commit tree, date
 * and subject as an independently-built repo that goes through the same
 * two steps -- proving the dating is purely positional, not tied to when
 * each command happened to run. */
const path = require('path');
const H = require('../lib/harness.js');
const T = H.T;

H.requireBin('ght-squash');

function identDate(repo, gpg, rev, field) {
  const raw = H.catFile(repo, gpg, rev, '-p');
  const m = new RegExp('^' + field + ' .* (\\d+ [+-]\\d{4})$', 'm').exec(raw);
  return m ? m[1] : null;
}
function unix1970(i) { return Math.floor(Date.UTC(1970, 0, i + 1, 12, 0, 0) / 1000); }

/* Builds, independently, a repo that: tags v1 on a root commit and runs
 * apply --apply; THEN adds two more (untagged) commits and runs
 * tail --apply. Returns the ordered (oldest-first) {tree, date, subject}
 * row for each of the two resulting commits -- S1 (v1's squash) and S2
 * (the tail's squash). */
function buildAndRun(label, gpg) {
  const repo = H.initRepo(label, gpg);
  H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '2020-01-01T10:00:00 +0000' });
  H.tagSigned(repo, gpg, 'v1', 'release v1');

  /* --name is pinned to a fixed value (not left to default to the repo's
   * own mkdtemp'd basename, which differs between the two independently
   * built repos this file compares) so the subject text is comparable
   * across both. */
  const map = path.join(H.freshDir(label + '-map'), label + '-map.txt');
  const applied = H.runBin('ght-squash', ['apply', repo, '--map', map, '--name=ac35', '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit(label + ': apply --apply (release 1): exit 0', applied, 0);

  /* These two commits are added only AFTER apply already ran and wrote
   * S1 -- the point being that S1's date must not move when tail later
   * runs, and S2's date must continue the position count from S1, not
   * restart it. */
  H.commit(repo, gpg, 'tail 1', { 'a.txt': 'two\n' }, { date: '2020-02-01T10:00:00 +0000' });
  H.commit(repo, gpg, 'tail 2 subject', { 'a.txt': 'three\n' }, { date: '2020-03-01T10:00:00 +0000' });

  const tailed = H.runBin('ght-squash', ['tail', repo, '--name=ac35', '--apply'], { gnupgHome: gpg.gnupgHome });
  T.exit(label + ': tail --apply (continuing): exit 0', tailed, 0);
  if (applied.missing || tailed.missing) return null;

  const s1 = H.revParse(repo, gpg, 'v1^{commit}');
  const s2 = H.revParse(repo, gpg, 'HEAD');
  return {
    repo,
    rows: [
      { tree: H.treeOf(repo, gpg, s1), date: identDate(repo, gpg, s1, 'author'), subject: subjectOf(repo, gpg, s1) },
      { tree: H.treeOf(repo, gpg, s2), date: identDate(repo, gpg, s2, 'author'), subject: subjectOf(repo, gpg, s2) },
    ],
  };
}
function subjectOf(repo, gpg, rev) {
  const raw = H.catFile(repo, gpg, rev, '-p');
  const lines = raw.split('\n');
  const blank = lines.indexOf('');
  return blank >= 0 ? lines[blank + 1] : null;
}
function rowsKey(rows) { return rows.map(r => r.tree + '\t' + r.date + '\t' + r.subject).join('\n'); }

const gpg = H.setupGpg('ac35');
if (gpg) {
  const a = buildAndRun('ac35-a', gpg);
  const b = buildAndRun('ac35-b', gpg);

  if (a && b) {
    T.eq('AC-35: S1 (v1\'s squash) keeps position 1 -- the anon date apply originally wrote, unmoved by the later tail',
      a.rows[0].date, unix1970(1) + ' +0000');
    T.eq('AC-35: S2 (tail\'s squash) continues at position 2, not restarted at position 1',
      a.rows[1].date, unix1970(2) + ' +0000');

    T.eq('AC-35: two independently-built repos going through [apply now, tail later] ' +
      'produce byte-identical trees/dates/subjects, commit by commit -- the dating is ' +
      'purely positional, not tied to literal wall-clock timing between the two commands',
      rowsKey(a.rows), rowsKey(b.rows));

    T.eq('AC-35: subject of S1 is still v1\'s own release line (untouched by the later tail)',
      a.rows[0].subject, b.rows[0].subject);
    T.contains('AC-35: subject of S2 uses the "(untagged)" placeholder', a.rows[1].subject, '(untagged):');
  }
}

T.finish();
