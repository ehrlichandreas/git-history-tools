/* AC-109 -- § 2.1 points 1-3: `--range` scans only what the range brings
 * in (old, unchanged content is not rescanned; a tag counts only when its
 * target is itself in the range), and `--only` restricts which categories
 * are reported and counted. Usage-error hardening mirrors git-sign check
 * (D20): a leading '-' anywhere in the range, an unknown/empty --only
 * category, and 'term' without --terms are all exit 2 before the repo is
 * read; an unresolvable range is a refusal (exit 1); a valid range with
 * no commits scans nothing (exit 0) with a stderr note. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-leak-scan');

/** The fixture committer identity is itself email-shaped (`H.FIXTURE_EMAIL`,
 * flagged in every commit); an --allow file naming it keeps these fixtures'
 * assertions about the test's OWN leaks, not an artifact of the fixture. */
function allowFixtureEmail(label: string): string {
  const f = path.join(H.freshDir(label), label + '.txt');
  fs.writeFileSync(f, H.FIXTURE_EMAIL + '\n');
  return f;
}

/* Built at runtime, not a literal, so this test's own fixture secret is
 * never itself a hit when this repo's history is scanned (ac-87/ac-94's
 * own pattern). */
const SECRET_LINE = 'API_' + 'KEY=' + 'abcdefghijklmnopqrstuvwx';

/* ---- A: --range excludes old, unchanged content; includes new content - */
{
  const gpg = H.setupGpg('ac109a');
  if (gpg) {
    const repo = H.initRepo('ac109a', gpg);
    const c1 = H.commit(repo, gpg, 'base', { 'old.txt': 'contact old@old.example for history\n' });
    const c2 = H.commit(repo, gpg, 'new work', { 'new.txt': 'contact new@new.example for this change\n' });
    const short2 = H.shortSha(repo, gpg, c2.sha!);

    const r = H.runBin('git-leak-scan', ['scan', repo, '--range', c1.sha! + '..' + c2.sha!, '--allow', allowFixtureEmail('ac109allow-' + repo.slice(-6))],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-109A: new content in range: exit 1', r, 1);
    if (!r.missing) {
      T.contains('AC-109A: the new leak is reported', r.stdout, 'scan: email new@new.example (1) first at ' + short2 + ':new.txt');
      T.check('AC-109A: the old, unchanged leak is NOT reported', r.stdout.indexOf('old@old.example') === -1, r.stdout);
    }
  }
}

/* ---- A2: a changed file keeps its old secret line (not re-reported) --- */
/* and gains a clean line (also not reported, obviously) -- --range scans */
/* lines ADDED per commit vs its first parent, not the whole changed blob */
{
  const gpg = H.setupGpg('ac109a2');
  if (gpg) {
    const repo = H.initRepo('ac109a2', gpg);
    const c1 = H.commit(repo, gpg, 'base', { 'a.txt': SECRET_LINE + '\n' });
    const c2 = H.commit(repo, gpg, 'append a clean line', { 'a.txt': SECRET_LINE + '\nnothing sensitive here\n' });

    const r = H.runBin('git-leak-scan', ['scan', repo, '--range', c1.sha! + '..' + c2.sha!, '--allow', allowFixtureEmail('ac109a2allow-' + repo.slice(-6))],
      { gnupgHome: gpg.gnupgHome });
    T.exit('AC-109A2: a changed file with only an old secret line and a new clean one: exit 0', r, 0);
    if (!r.missing) T.eq('AC-109A2: nothing on stdout (the old secret line is not re-reported)', r.stdout, '');
  }
}

/* ---- A3: a genuinely NEW secret line in an already-tracked file ------- */
{
  const gpg = H.setupGpg('ac109a3');
  if (gpg) {
    const repo = H.initRepo('ac109a3', gpg);
    const c1 = H.commit(repo, gpg, 'base', { 'a.txt': 'nothing sensitive here\n' });
    const c2 = H.commit(repo, gpg, 'add a secret line', { 'a.txt': 'nothing sensitive here\n' + SECRET_LINE + '\n' });
    const short2 = H.shortSha(repo, gpg, c2.sha!);

    const r = H.runBin('git-leak-scan', ['scan', repo, '--range', c1.sha! + '..' + c2.sha!], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-109A3: a new secret line added to an existing file: exit 1', r, 1);
    if (!r.missing) {
      T.contains('AC-109A3: the new secret line is reported, at the file it landed in',
        r.stdout, 'scan: secret ' + SECRET_LINE + ' (1) first at ' + short2 + ':a.txt');
    }
  }
}

/* ---- A4: renaming a file that holds a secret, content unchanged ------- */
/* -M rename detection means a pure rename has no '+' line at all, so     */
/* nothing is reported -- the content is not new, only its path moved.    */
/* diff.renames=false here (repo-local) proves `-M` is passed explicitly, */
/* not relied on as a default this fixture's own config could turn off.  */
{
  const gpg = H.setupGpg('ac109a4');
  if (gpg) {
    const repo = H.initRepo('ac109a4', gpg);
    const c1 = H.commit(repo, gpg, 'base', { 'secret.txt': SECRET_LINE + '\n' });
    const git = H.gitIn(repo, gpg);
    git(['config', 'diff.renames', 'false']);
    fs.renameSync(path.join(repo, 'secret.txt'), path.join(repo, 'moved.txt'));
    git(['add', '-A']);
    const commitR = git(['commit', '-q', '-m', 'rename secret.txt to moved.txt']);
    if (commitR.status !== 0) { T.check('AC-109A4: rename commit succeeded', false, commitR.stderr); } else {
      const c2sha = H.revParse(repo, gpg, 'HEAD');
      const r = H.runBin('git-leak-scan', ['scan', repo, '--range', c1.sha! + '..' + c2sha, '--allow', allowFixtureEmail('ac109a4allow-' + repo.slice(-6))],
        { gnupgHome: gpg.gnupgHome });
      T.exit('AC-109A4: a pure rename of a file holding a secret: exit 0', r, 0);
      if (!r.missing) T.eq('AC-109A4: nothing on stdout (content is not new, only moved)', r.stdout, '');
    }
  }
}

/* ---- B: a tag counts only when its own target is in the range --------- */
{
  const gpg = H.setupGpg('ac109b');
  if (gpg) {
    const repo = H.initRepo('ac109b', gpg);
    const c1 = H.commit(repo, gpg, 'base', { 'a.txt': 'nothing sensitive\n' });
    H.tagAnnotatedUnsigned(repo, gpg, 'at-c1', 'leak jdoe@internal.example at c1');
    const c2 = H.commit(repo, gpg, 'next', { 'b.txt': 'still nothing\n' });
    H.tagAnnotatedUnsigned(repo, gpg, 'at-c2', 'leak jdoe@internal.example at c2');

    const r = H.runBin('git-leak-scan', ['scan', repo, '--range', c1.sha! + '..' + c2.sha!, '--allow', allowFixtureEmail('ac109allow-' + repo.slice(-6))],
      { gnupgHome: gpg.gnupgHome });
    if (!r.missing) {
      T.exit('AC-109B: the in-range tag is found, exit 1', r, 1);
      T.contains('AC-109B: tag-message hit counted once (the out-of-range tag at c1 does not add to it)',
        r.stdout, 'scan: email jdoe@internal.example (1) first at ');
    }
  }
}

/* ---- C: --only restricts reported AND counted categories -------------- */
{
  const gpg = H.setupGpg('ac109c');
  if (gpg) {
    const repo = H.initRepo('ac109c', gpg);
    H.commit(repo, gpg, 'multi-category leak', {
      'leak.txt': 'contact jdoe@internal.example for help\nip 203.0.113.7 observed\n',
    });

    const r = H.runBin('git-leak-scan', ['scan', repo, '--only', 'email', '--allow', allowFixtureEmail('ac109allow-' + repo.slice(-6))], { gnupgHome: gpg.gnupgHome });
    if (!r.missing) {
      T.exit('AC-109C: --only email still finds a hit, exit 1', r, 1);
      T.contains('AC-109C: the email hit is reported', r.stdout, 'scan: email jdoe@internal.example');
      T.check('AC-109C: the ip hit is NOT reported (not in --only)', r.stdout.indexOf('ip 203.0.113.7') === -1, r.stdout);
    }
  }
}

/* ---- D: usage errors (exit 2), before the repo is read ----------------- */
{
  const gpg = H.setupGpg('ac109d');
  if (gpg) {
    const repo = H.initRepo('ac109d', gpg);
    H.commit(repo, gpg, 'clean', { 'a.txt': 'nothing sensitive\n' });

    const dashRange = H.runBin('git-leak-scan', ['scan', repo, '--range=-x'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-109D: a --range starting with \'-\' is a usage error, exit 2', dashRange, 2);
    T.contains('AC-109D: the message names the range and the rule',
      dashRange.stderr, 'git-leak-scan: --range \'-x\': a revision must not start with \'-\'');

    const dashUpper = H.runBin('git-leak-scan', ['scan', repo, '--range=HEAD..-x'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-109D: the upper side of a..b starting with \'-\' is a usage error, exit 2', dashUpper, 2);
    T.contains('AC-109D: the message names the whole range, not just the bad side',
      dashUpper.stderr, 'git-leak-scan: --range \'HEAD..-x\': a revision must not start with \'-\'');

    const emptyCategory = H.runBin('git-leak-scan', ['scan', repo, '--only', 'email,,url'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-109D: an empty --only category (doubled comma) is a usage error, exit 2', emptyCategory, 2);
    T.contains('AC-109D: the message names the whole --only list the empty item came from',
      emptyCategory.stderr, 'git-leak-scan: --only: empty category in \'email,,url\'');

    const unknownCategory = H.runBin('git-leak-scan', ['scan', repo, '--only', 'bogus'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-109D: an unknown --only category is a usage error, exit 2', unknownCategory, 2);
    T.contains('AC-109D: the message names the unknown category and the known ones',
      unknownCategory.stderr, 'git-leak-scan: --only: unknown category \'bogus\' (known: email, url, local-path, hostname, ip, secret, term)');

    const termWithoutTerms = H.runBin('git-leak-scan', ['scan', repo, '--only', 'term'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-109D: --only term without --terms is a usage error, exit 2', termWithoutTerms, 2);
    T.contains('AC-109D: the message says term needs --terms',
      termWithoutTerms.stderr, 'git-leak-scan: --only: \'term\' needs --terms');

    const spacedCategory = H.runBin('git-leak-scan', ['scan', repo, '--only', ' email'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-109D: --only is not trimmed -- a leading space makes it an unknown category, exit 2', spacedCategory, 2);
    T.contains('AC-109D: the message shows the untrimmed category, leading space included',
      spacedCategory.stderr, 'git-leak-scan: --only: unknown category \' email\' (known: email, url, local-path, hostname, ip, secret, term)');
  }
}

/* ---- E: an unresolvable range is a refusal (exit 1), not a usage error - */
{
  const gpg = H.setupGpg('ac109e');
  if (gpg) {
    const repo = H.initRepo('ac109e', gpg);
    H.commit(repo, gpg, 'clean', { 'a.txt': 'nothing sensitive\n' });

    const r = H.runBin('git-leak-scan', ['scan', repo, '--range', 'does-not-exist..HEAD'], { gnupgHome: gpg.gnupgHome });
    T.exit('AC-109E: an unresolvable range is a refusal, exit 1', r, 1);
  }
}

/* ---- F: a valid range with no commits scans nothing, exit 0, with a ---- */
/* stderr note naming the empty range                                     */
{
  const gpg = H.setupGpg('ac109f');
  if (gpg) {
    const repo = H.initRepo('ac109f', gpg);
    const c1 = H.commit(repo, gpg, 'only commit', { 'a.txt': 'contact jdoe@internal.example\n' });

    const r = H.runBin('git-leak-scan', ['scan', repo, '--range', c1.sha! + '..' + c1.sha!], { gnupgHome: gpg.gnupgHome });
    if (!r.missing) {
      T.exit('AC-109F: an empty range scans nothing, exit 0', r, 0);
      T.eq('AC-109F: nothing on stdout', r.stdout, '');
      T.contains('AC-109F: a stderr note names the empty range', r.stderr, c1.sha! + '..' + c1.sha!);
    }
  }
}

T.finish();
