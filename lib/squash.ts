#!/usr/bin/env node
/* git-release-squash (docs/SPECIFICATION.md § 1): plan / apply / tail. */
import fs from 'node:fs';
import path from 'node:path';
import * as git from './git.ts';
import { UsageError, Refusal, parseFlags, resolveOutsideFile, requireRepo, main, printHelp, readUserFile, decodeUserText } from './cli.ts';
import { refuseNonUtf8 } from './encoding.ts';
import { createSigner, buildSignedTagObject } from './signer.ts';
import type { Signer } from './signer.ts';
import { createBackupBundle } from './bundle.ts';
import * as verify from './verify.ts';

type Env = NodeJS.ProcessEnv;

interface TagEntry {
  name: string;
  type: 'tag' | 'commit';
  commit: string;
  /** What refs/tags/<name> points at now: the tag object, or the commit. */
  obj: string;
}

interface Group {
  tip: string;
  commits: string[];
  tags: TagEntry[];
}

function shortSha(repo: string, env: Env, rev: string): string {
  return git.text(repo, ['rev-parse', '--short', rev], { env });
}

function firstMergeCommit(repo: string, env: Env): string | null {
  const out = git.text(repo, ['rev-list', '--merges', '--topo-order', 'HEAD'], { env });
  return out ? out.split('\n')[0] : null;
}

function refuseOnMerge(repo: string, env: Env): void {
  const merge = firstMergeCommit(repo, env);
  if (merge) throw new Refusal('merge commits are not supported (' + shortSha(repo, env, merge) + ')');
}

function revListReverseHead(repo: string, env: Env): string[] {
  const out = git.text(repo, ['rev-list', '--reverse', 'HEAD'], { env });
  return out ? out.split('\n') : [];
}

function defaultName(repo: string): string {
  let base = path.basename(path.resolve(repo));
  if (base.endsWith('.git')) base = base.slice(0, -4);
  return base;
}

/** Every `refs/heads/*` ref's own name and commit sha, in for-each-ref's
 * own (refname) order -- read once, before any object is written, so the
 * planned final ref map (D24, Q2 follow-up) has a CURRENT value for
 * every branch this run does not touch. */
function allBranchHeads(repo: string, env: Env): { ref: string; sha: string }[] {
  const out = git.text(repo, ['for-each-ref', '--format=%(refname)\t%(objectname)', 'refs/heads'], { env });
  if (!out) return [];
  return out.split('\n').map((l) => {
    const [ref, sha] = l.split('\t');
    return { ref, sha };
  });
}

/** In for-each-ref's own (refname) order. */
function loadTagIndex(repo: string, env: Env): TagEntry[] {
  const out = git.text(repo,
    ['for-each-ref', '--format=%(refname)\t%(objecttype)\t%(*objectname)\t%(objectname)', 'refs/tags'],
    { env });
  if (!out) return [];
  return out.split('\n').map((l): TagEntry => {
    const [ref, type, deref, obj] = l.split('\t');
    return { name: git.refBase(ref, 'refs/tags/'), type: type as 'tag' | 'commit', commit: type === 'tag' ? deref : obj, obj };
  });
}

/** Groups allCommits (oldest-first) by distinct tagged commit. */
function groupsFromTags(allCommits: string[], tags: TagEntry[]): { groups: Group[]; tailCommits: string[] } {
  const byCommit = new Map<string, TagEntry[]>();
  for (const t of tags) {
    if (!byCommit.has(t.commit)) byCommit.set(t.commit, []);
    byCommit.get(t.commit)!.push(t);
  }
  const groups: Group[] = [];
  let prevIdx = -1;
  for (let i = 0; i < allCommits.length; i++) {
    const c = allCommits[i];
    if (byCommit.has(c)) {
      groups.push({ tip: c, commits: allCommits.slice(prevIdx + 1, i + 1), tags: byCommit.get(c)! });
      prevIdx = i;
    }
  }
  return { groups, tailCommits: allCommits.slice(prevIdx + 1) };
}

/** An annotated tag's message as stored, without its signature: never
 * `%(contents:subject)`, which joins the first paragraph into one line
 * (D23, AC-104). By full refname, as everywhere (D20, AC-80). */
function tagMessage(repo: string, env: Env, name: string): string {
  const fmt = (f: string) => git.run(repo, ['for-each-ref', '--format=' + f, 'refs/tags/' + name], { env });
  const all = fmt('%(contents)');
  const sig = fmt('%(contents:signature)');
  if (all.status !== 0) throw new git.GitError(['for-each-ref', 'refs/tags/' + name], all);
  if (sig.status !== 0) throw new git.GitError(['for-each-ref', 'refs/tags/' + name], sig);
  /* for-each-ref ends every record with one newline of its own */
  const contents = (all.stdout as string).replace(/\n$/, '');
  const signature = (sig.stdout as string).replace(/\n$/, '');
  return signature && contents.endsWith(signature) ? contents.slice(0, contents.length - signature.length) : contents;
}

/* § 0: an annotated tag's title is the first line of its message, a
 * lightweight tag's the subject of its commit. */
function titleFor(repo: string, env: Env, tag: TagEntry): string {
  return titleLine(tag.type === 'tag' ? tagMessage(repo, env, tag.name) : git.text(repo, ['log', '-1', '--format=%s', tag.commit], { env }));
}

/** A release subject's title (§ 0, D23): the first line of `text`, every
 * control character (C0 but tab, DEL, C1) a space, so neither the commit
 * subject nor plan's line carries a raw CR or an escape, then trailing
 * spaces and tabs trimmed as git trims a subject (a CRLF message's CR
 * among them, by then a space). Nothing left is `(no title)`. */
function titleLine(text: string): string {
  const t = text.split('\n')[0].replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, ' ').replace(/[ \t]+$/, '');
  return t === '' ? '(no title)' : t;
}

/** The full sha of the commit `apply` would write for one group, unsigned
 * (§ 1.1 `<tag-short>`): the same tree, parent, subject, dates and ident
 * as `commit-tree`, hashed and never written. With no identity configured,
 * where `apply` could not commit at all, the ident is `unknown`. Never an
 * `encoding` header, as `apply` writes none (D23, AC-106). */
function previewCommit(repo: string, env: Env, tree: string, parent: string | null, subject: string, authorDate: string, committerDate: string): { sha: string; object: string } {
  const dated = Object.assign({}, env, { GIT_AUTHOR_DATE: authorDate, GIT_COMMITTER_DATE: committerDate });
  const ident = (v: string, date: string) => {
    const r = git.run(repo, ['var', v], { env: dated });
    return r.status === 0 ? (r.stdout as string).replace(/\n$/, '') : 'unknown <unknown> ' + date.replace(/^@/, '');
  };
  const object = 'tree ' + tree + '\n' + (parent ? 'parent ' + parent + '\n' : '') +
    'author ' + ident('GIT_AUTHOR_IDENT', authorDate) + '\n' +
    'committer ' + ident('GIT_COMMITTER_IDENT', committerDate) + '\n' +
    '\n' + subject + '\n';
  return { sha: git.text(repo, ['hash-object', '-t', 'commit', '--stdin'], { env, input: object }), object };
}

function renderPlanLines(repo: string, env: Env, name: string, dates: string):
  { lines: string[]; groups: Group[]; tailCommits: string[]; allCommits: string[] } {
  const allCommits = revListReverseHead(repo, env);
  const tags = loadTagIndex(repo, env);
  const { groups, tailCommits } = groupsFromTags(allCommits, tags);
  const lines: string[] = [];
  let lastGroupTagName: string | null = null;
  let parent: string | null = null;
  let idx = 0;
  for (const g of groups) {
    const groupOldestShort = shortSha(repo, env, g.commits[0]);
    const tipShort = shortSha(repo, env, g.tip);
    /* The commit apply would write for this group (§ 1.1, § 1.2): one per
     * tagged commit, the first tag's subject, every tag of the group on it. */
    const tree = git.text(repo, ['rev-parse', g.tip + '^{tree}'], { env });
    const subject = name + ' ' + g.tags[0].name + ': ' + titleFor(repo, env, g.tags[0]);
    const authorDate = dates === 'anon' ? anonDateAt(idx) : rawDateOf(repo, env, g.tip, 'a');
    const committerDate = dates === 'anon' ? anonDateAt(idx) : rawDateOf(repo, env, g.tip, 'c');
    const preview = previewCommit(repo, env, tree, parent, subject, authorDate, committerDate);
    const previewShort = preview.sha.slice(0, tipShort.length);
    /* Compared, not assumed: the tree the preview records against each
     * tag's own commit tree (equal by construction for plan, § 1.1).
     * A mutant that always prints OK here (dropping the comparison
     * entirely) is unreachable by any test: `plan` never writes anything
     * to disagree with its own preview, so the FAIL branch is dead code
     * for `plan` by construction, documented as such in SPECIFICATION.md
     * § 1.1 rather than pinned. */
    const previewTree = (/^tree ([0-9a-f]+)$/m.exec(preview.object) || [])[1];
    g.tags.forEach((t, i) => {
      /* Several tags on the same commit: the first (refname order) carries
       * the group's real fold count; every additional co-located tag is
       * "just this commit" (N=1) -- nothing already counted under the first
       * tag is re-counted under the others. */
      const n = i === 0 ? g.commits.length - (g.tags.length - 1) : 1;
      const oldestShort = i === 0 ? groupOldestShort : tipShort;
      const tagTree = git.text(repo, ['rev-parse', t.commit + '^{tree}'], { env });
      lines.push('plan: ' + t.name + ' folds ' + n + ' commit(s) (' +
        oldestShort + '..' + previewShort + ') into "' + subject + '"');
      lines.push('plan: ' + t.name + ' tree equals ' + previewShort + '\'s own tree: ' + (previewTree === tagTree ? 'OK' : 'FAIL'));
    });
    lastGroupTagName = g.tags[0].name;
    parent = preview.sha;
    idx++;
  }
  if (tailCommits.length > 0) {
    if (groups.length === 0) {
      lines.push('plan: ' + tailCommits.length + ' untagged commit(s) from the start of history are not covered by plan');
    } else {
      lines.push('plan: ' + tailCommits.length + ' untagged commit(s) after ' + lastGroupTagName + ' are not covered by plan');
    }
  }
  return { lines, groups, tailCommits, allCommits };
}

/* § 4.3: i is the commit's 0-based ordinal position in the resulting,
 * fully-squashed history; it lands on 1970-01-(i+2) 12:00:00 +0000 (the
 * root, i=0, is 1970-01-02, not -01 -- D1 commit bd16ac2). */
function anonDateAt(i: number): string {
  return '@' + ((i + 1) * 86400 + 43200) + ' +0000';
}

function rawDateOf(repo: string, env: Env, rev: string, which: string): string {
  const raw = git.text(repo, ['log', '-1', '--format=%' + which + 'd', '--date=raw', rev], { env });
  return '@' + raw;
}

/* The message a re-created tag keeps: the stored one, its first lines not
 * joined (D23, AC-104); buildTag's stripspace normalises the rest. */
function tagRawMessage(repo: string, env: Env, name: string): string {
  return tagMessage(repo, env, name).replace(/\s+$/, '') + '\n';
}

/** A new tag's message exactly as `git tag -F` used to store it: its
 * default cleanup (`strip`: trailing whitespace, blank-line runs and
 * comment lines, with the repo's own core.commentChar), now that the tag
 * object is built by hand (D20). */
function cleanTagMessage(repo: string, env: Env, msg: string): string {
  const r = git.run(repo, ['stripspace', '--strip-comments'], { env, input: msg });
  if (r.status !== 0) throw new git.GitError(['stripspace', '--strip-comments'], r);
  return r.stdout as string;
}

/** Builds the signed tag object for `name` -> `commit`, tagged by the
 * committer ident git sees under `env`, without touching any ref. */
function buildTag(repo: string, env: Env, signer: Signer, name: string, commit: string, message: string): string {
  return buildSignedTagObject(repo, env, signer, {
    object: commit, type: 'commit', name, taggerLine: git.committerIdent(repo, env), message: cleanTagMessage(repo, env, message),
  });
}

function moveRefsOrRefuse(repo: string, env: Env, message: string, moves: git.RefMove[], verifies: git.RefVerify[] = []): void {
  const r = git.moveRefs(repo, env, message, moves, verifies);
  if (r.status !== 0) throw new Refusal('ref update transaction failed: ' + (r.stderr as string).trim().split('\n')[0]);
}

/** Every entry of the planned final ref map (`heads`/`tags`, already
 * built against the one read of the backlog's branches/tags this run
 * used for its own `signatures` check) this run's own `moves` does NOT
 * touch, as `git.RefVerify` -- for an untouched ref, "planned" and
 * "current" are the same value by construction, so these are exactly
 * the old values the ref transaction below must still see (Q2
 * hardening). */
function untouchedVerifies(moves: git.RefMove[], heads: verify.PlannedHead[], tags: verify.PlannedTag[]): git.RefVerify[] {
  const touched = new Set(moves.map((m) => m.ref));
  return [
    ...heads.filter((h) => !touched.has(h.ref)).map((h) => ({ ref: h.ref, sha: h.sha })),
    ...tags.filter((t) => !touched.has(t.ref)).map((t) => ({ ref: t.ref, sha: t.tagObj })),
  ];
}

/** HEAD's branch as a FULL refname (`refs/heads/x`), never `--short`,
 * which prints `heads/x` when a tag `x` exists too (D20, AC-72). */
function currentBranch(repo: string, env: Env): string {
  const r = git.run(repo, ['symbolic-ref', 'HEAD'], { env });
  if (r.status !== 0) throw new Refusal('HEAD is detached');
  return (r.stdout as string).replace(/\n$/, '');
}

/** A bare repository has no work tree to be dirty; `git status` there is
 * an error, not an answer (D21, AC-83). */
function isDirty(repo: string, env: Env): boolean {
  if (git.text(repo, ['rev-parse', '--is-bare-repository'], { env }) === 'true') return false;
  return git.text(repo, ['status', '--porcelain', '--untracked-files=no'], { env }) !== '';
}

/* -------------------------------------------------------------- plan --- */

function cmdPlan(bin: string, args: string[]): void {
  const { positional, flags } = parseFlags(args, { valueFlags: ['--name'], boolFlags: [] });
  const repo = positional[0];
  if (!repo) throw new UsageError('missing <repo>');
  if (positional.length > 1) throw new UsageError('unexpected argument: ' + positional[1]);
  requireRepo(repo);
  const env = process.env;
  refuseOnMerge(repo, env);
  const name = (flags.name as string) || defaultName(repo);
  const { lines } = renderPlanLines(repo, env, name, 'anon');
  process.stdout.write(lines.map((l) => l + '\n').join(''));
}

/* ------------------------------------------------------------- apply --- */

function cmdApply(bin: string, args: string[]): void {
  const { positional, flags } = parseFlags(args, {
    valueFlags: ['--map', '--name', '--dates'], boolFlags: ['--apply'],
  });
  const repo = positional[0];
  if (!repo) throw new UsageError('missing <repo>');
  if (positional.length > 1) throw new UsageError('unexpected argument: ' + positional[1]);
  if (!flags.map) throw new UsageError('missing --map');
  /* The map is written after the backup bundle; a path it cannot be written to is a usage error first (D20, AC-77). */
  const mapPath = path.resolve(flags.map as string);
  if (!fs.existsSync(path.dirname(mapPath)) || !fs.statSync(path.dirname(mapPath)).isDirectory()) {
    throw new UsageError('--map: no such directory: ' + path.dirname(mapPath));
  }
  if (fs.existsSync(mapPath) && fs.statSync(mapPath).isDirectory()) throw new UsageError('--map: is a directory: ' + mapPath);
  const dates = (flags.dates as string) || 'anon';
  if (dates !== 'anon' && dates !== 'keep') throw new UsageError('--dates must be \'anon\' or \'keep\'');
  requireRepo(repo);
  const env = process.env;
  refuseOnMerge(repo, env);

  const allCommits = revListReverseHead(repo, env);
  const oldHead = allCommits[allCommits.length - 1];
  const tags = loadTagIndex(repo, env);
  const { groups, tailCommits } = groupsFromTags(allCommits, tags);
  const headTagged = groups.length > 0 && groups[groups.length - 1].tip === oldHead;
  /* Every tag is re-created with its message: UTF-8 only (D21, AC-95). */
  refuseNonUtf8(repo, env, groups.flatMap((g) => g.tags).filter((t) => t.type === 'tag').map((t) => ({ sha: t.obj, label: 'tag ' + t.name })));
  if (!headTagged) throw new Refusal('HEAD is not tagged -- run \'tail\' first');

  const name = (flags.name as string) || defaultName(repo);
  const { lines } = renderPlanLines(repo, env, name, dates);

  if (!flags.apply) {
    process.stdout.write(lines.map((l) => l + '\n').join(''));
    process.stdout.write(bin + ': dry run, no ref changed (use --apply to write)\n');
    return;
  }

  if (isDirty(repo, env)) throw new Refusal('working tree is dirty');
  const branch = currentBranch(repo, env);

  /* The signer's refusals (no key, a key gpg cannot read) before the backup bundle (§ 0, D20, AC-77). */
  const signer = createSigner(repo, env);
  try {
    createBackupBundle(repo, env);
    let parent: string | null = null;
    const commitResults: { g: Group; nc: string; committerDate: string; origTree: string; newTree: string }[] = [];
    const mapLines: string[] = [];
    let idx = 0;
    for (const g of groups) {
      const tree = git.text(repo, ['rev-parse', g.tip + '^{tree}'], { env });
      const title = titleFor(repo, env, g.tags[0]);
      const subject = name + ' ' + g.tags[0].name + ': ' + title;
      const authorDate = dates === 'anon' ? anonDateAt(idx) : rawDateOf(repo, env, g.tip, 'a');
      const committerDate = dates === 'anon' ? anonDateAt(idx) : rawDateOf(repo, env, g.tip, 'c');
      const ctArgs = ['commit-tree', '-S', tree];
      if (parent) ctArgs.push('-p', parent);
      const nc = git.text(repo, ctArgs, {
        env: Object.assign({}, env, { GIT_AUTHOR_DATE: authorDate, GIT_COMMITTER_DATE: committerDate }),
        input: subject + '\n',
        config: signer.gitConfig,
      });
      const newTree = git.text(repo, ['rev-parse', nc + '^{tree}'], { env });
      commitResults.push({ g, nc, committerDate, origTree: tree, newTree });
      for (const c of g.commits) mapLines.push(c + ' ' + g.tags[0].name);
      parent = nc;
      idx++;
    }
    const newHead = commitResults[commitResults.length - 1].nc;

    /* `tree delta` (D24, Reviewer-found): computed against the new commits
     * right above, before any ref moves -- a FAILED one is now a refusal
     * in the usual shape (the backup bundle and the new commits stay,
     * nothing moved), rather than moving every ref first and reporting a
     * verify that failed on an already-moved history. */
    const treeDelta = verify.verifyTreeDelta(commitResults.map((r) => ({ label: r.g.tip, expected: r.origTree, actual: r.newTree })));
    if (!treeDelta.ok) throw new Refusal(treeDelta.line);

    /* Every object first (the commits above, every tag object here), then
     * every ref in ONE transaction against its old value: a failure
     * anywhere moves nothing (D20, AC-74). `git tag -f -s` per tag used to
     * create the object and move its ref in one step. */
    const moves: git.RefMove[] = [];
    const touchedTags = new Map<string, verify.PlannedTag>();
    for (const { g, nc, committerDate } of commitResults) {
      for (const t of g.tags) {
        const newObj = t.type === 'tag'
          ? buildTag(repo, Object.assign({}, env, { GIT_COMMITTER_DATE: committerDate }), signer, t.name, nc, tagRawMessage(repo, env, t.name))
          : nc;
        moves.push({ ref: 'refs/tags/' + t.name, newSha: newObj, oldSha: t.obj });
        touchedTags.set(t.name, { ref: 'refs/tags/' + t.name, type: t.type, commit: nc, tagObj: newObj });
      }
    }
    moves.push({ ref: branch, newSha: newHead, oldSha: oldHead });

    /* `signatures` and `every commit tagged` (D24, Q2 follow-up,
     * Scout-found): checked against the PLANNED final ref map -- this
     * run's own new values above, the CURRENT value (read before
     * anything was written) for every other branch/tag -- before the
     * transaction: a FAILED one here is a refusal (bundle and new
     * objects kept, nothing moved), not a write whose refs already
     * moved. An unrelated branch's own unsigned commit still fails
     * `signatures` exactly as before (it is still checked, same as
     * every branch/tag), just before the move instead of after. */
    const plannedTags: verify.PlannedTag[] = tags.map((t) =>
      touchedTags.get(t.name) || { ref: 'refs/tags/' + t.name, type: t.type, commit: t.commit, tagObj: t.obj });
    const plannedHeads: verify.PlannedHead[] = allBranchHeads(repo, env).map((h) =>
      h.ref === branch ? { ref: h.ref, sha: newHead } : h);
    const signatures = verify.verifySignatures(repo, env, plannedHeads, plannedTags);
    if (!signatures.ok) throw new Refusal(signatures.line);
    const everyCommitTagged = verify.verifyEveryCommitTagged(repo, env, newHead, plannedTags);
    if (!everyCommitTagged.ok) throw new Refusal(everyCommitTagged.line);

    /* Every other branch/tag rides the SAME transaction as a `verify`
     * line (Q2 hardening, Reviewer SHOULD): `signatures` above already
     * read them once for its own planned map; nothing re-checked them
     * between that read and this call until now. */
    moveRefsOrRefuse(repo, env, 'git-release-squash apply', moves, untouchedVerifies(moves, plannedHeads, plannedTags));
    /* Only now: a failed transaction leaves no map of commits no ref
     * points at (D21, AC-85). Its directory was checked up front (AC-77). */
    fs.writeFileSync(mapPath, mapLines.length ? mapLines.join('\n') + '\n' : '');

    const results = [treeDelta, signatures, everyCommitTagged];
    for (const r of results) process.stdout.write(r.line + '\n');
    process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
  } finally {
    signer.cleanup();
  }
}

/* -------------------------------------------------------------- tail --- */

function cmdTail(bin: string, args: string[]): void {
  const { positional, flags } = parseFlags(args, {
    valueFlags: ['--name', '--dates', '--tag', '--message', '--message-file'], boolFlags: ['--apply'],
  });
  const repo = positional[0];
  if (!repo) throw new UsageError('missing <repo>');
  if (positional.length > 1) throw new UsageError('unexpected argument: ' + positional[1]);
  if (flags.map !== undefined) throw new UsageError('tail does not take --map');
  const dates = (flags.dates as string) || 'anon';
  if (dates !== 'anon' && dates !== 'keep') throw new UsageError('--dates must be \'anon\' or \'keep\'');

  const hasMessage = flags.message !== undefined;
  const hasMessageFile = flags['message-file'] !== undefined;
  if (flags.tag !== undefined) {
    if (hasMessage === hasMessageFile) {
      throw new UsageError('--tag requires exactly one of --message or --message-file');
    }
  } else if (hasMessage || hasMessageFile) {
    throw new UsageError('--message/--message-file require --tag');
  }
  if (flags.tag !== undefined && !git.isValidTagName(flags.tag as string)) {
    throw new UsageError('--tag: ' + JSON.stringify(flags.tag) + ' is not a valid tag name');
  }
  const tagMessageText: string | null = hasMessage ? (flags.message as string) :
    (hasMessageFile ? decodeUserText('--message-file', flags['message-file'] as string,
      readUserFile('--message-file', flags['message-file'] as string)) : null);

  requireRepo(repo);
  const env = process.env;
  refuseOnMerge(repo, env);

  if (flags.tag !== undefined) {
    const exists = git.run(repo, ['rev-parse', '--verify', '--quiet', 'refs/tags/' + flags.tag], { env }).status === 0;
    if (exists) throw new Refusal('tag ' + flags.tag + ' already exists');
  }

  const allCommits = revListReverseHead(repo, env);
  const headSha = allCommits[allCommits.length - 1];
  const tags = loadTagIndex(repo, env);
  const { groups, tailCommits } = groupsFromTags(allCommits, tags);
  const headTagged = groups.length > 0 && groups[groups.length - 1].tip === headSha;
  if (headTagged) throw new Refusal('HEAD is already tagged, nothing to squash');
  /* Without --tag the new commit takes HEAD's subject: UTF-8 only (D21, AC-95). */
  if (flags.tag === undefined) refuseNonUtf8(repo, env, [{ sha: headSha, label: 'commit ' + headSha.slice(0, 7) }]);

  /* git cannot take a NUL in a message; it crashed after the bundle (D21, Scout N4, AC-97). */
  if (flags.tag !== undefined && (tagMessageText as string).includes('\u0000')) {
    throw new UsageError('--tag: the tag message contains a NUL byte');
  }
  if (flags.tag !== undefined && cleanTagMessage(repo, env, tagMessageText as string) === '') {
    throw new UsageError('--tag: the tag message is empty');
  }

  const name = (flags.name as string) || defaultName(repo);
  const title = titleLine(flags.tag !== undefined ? tagMessageText as string :
    git.text(repo, ['log', '-1', '--format=%s', headSha], { env }));
  const subject = flags.tag !== undefined ? name + ' ' + flags.tag + ': ' + title : name + ' (untagged): ' + title;
  const oldestShort = shortSha(repo, env, tailCommits[0]);
  const headShort = shortSha(repo, env, headSha);
  const planLine = 'tail: squashes ' + tailCommits.length + ' commit(s) (' + oldestShort + '..' + headShort +
    ') into "' + subject + '"';

  if (!flags.apply) {
    process.stdout.write(planLine + '\n');
    process.stdout.write(bin + ': dry run, no ref changed (use --apply to write)\n');
    return;
  }

  if (isDirty(repo, env)) throw new Refusal('working tree is dirty');
  const branch = currentBranch(repo, env);
  const parentCommit = groups.length > 0 ? groups[groups.length - 1].tip : null;

  /* The signer's refusals (no key, a key gpg cannot read) before the backup bundle (§ 0, D20, AC-77). */
  const signer = createSigner(repo, env);
  try {
    createBackupBundle(repo, env);
    const tree = git.text(repo, ['rev-parse', headSha + '^{tree}'], { env });
    /* § 4.3: the position in the resulting history is the parent's plus
     * one, not the number of tagged commits -- they differ as soon as an
     * untagged commit comes before the last tag (D23, AC-99). */
    const position = parentCommit ? allCommits.indexOf(parentCommit) + 1 : 0;
    const when = dates === 'anon' ? anonDateAt(position) : rawDateOf(repo, env, headSha, 'a');
    const whenC = dates === 'anon' ? anonDateAt(position) : rawDateOf(repo, env, headSha, 'c');
    const ctArgs = ['commit-tree', '-S', tree];
    if (parentCommit) ctArgs.push('-p', parentCommit);
    const nc = git.text(repo, ctArgs, {
      env: Object.assign({}, env, { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: whenC }),
      input: subject + '\n',
      config: signer.gitConfig,
    });
    const newTree = git.text(repo, ['rev-parse', nc + '^{tree}'], { env });

    /* `tree delta` (D24, Reviewer-found): computed against the new commit
     * right above, before any ref moves -- a FAILED one is now a refusal
     * in the usual shape, rather than moving every ref first and
     * reporting a verify that failed on an already-moved history. */
    const treeDelta = verify.verifyTreeDelta([{ label: headSha, expected: tree, actual: newTree }]);
    if (!treeDelta.ok) throw new Refusal(treeDelta.line);

    /* The commit, then the tag object, then both refs in ONE transaction
     * (D20, AC-74): the branch used to move first, so a tag that failed
     * left it moved and no tag. The tag ref must not exist yet. */
    const moves: git.RefMove[] = [{ ref: branch, newSha: nc, oldSha: headSha }];
    const plannedTags: verify.PlannedTag[] = tags.map((t): verify.PlannedTag =>
      ({ ref: 'refs/tags/' + t.name, type: t.type, commit: t.commit, tagObj: t.obj }));
    if (flags.tag !== undefined) {
      const tagEnv = dates === 'anon' ? Object.assign({}, env, { GIT_COMMITTER_DATE: whenC }) : env;
      const tagObj = buildTag(repo, tagEnv, signer, flags.tag as string, nc, tagMessageText as string);
      moves.push({ ref: 'refs/tags/' + flags.tag, newSha: tagObj, oldSha: null });
      plannedTags.push({ ref: 'refs/tags/' + flags.tag, type: 'tag', commit: nc, tagObj });
    }

    /* `signatures` (D24, Q2 follow-up, Scout-found): checked against the
     * PLANNED final ref map -- this run's own new branch tip and new tag
     * (if any) above, the CURRENT value (read before anything was
     * written) for every other branch/tag -- before the transaction: a
     * FAILED one here is a refusal (bundle and new objects kept, nothing
     * moved), not a write whose refs already moved. */
    const plannedHeads: verify.PlannedHead[] = allBranchHeads(repo, env).map((h) =>
      h.ref === branch ? { ref: h.ref, sha: nc } : h);
    const signatures = verify.verifySignatures(repo, env, plannedHeads, plannedTags);
    if (!signatures.ok) throw new Refusal(signatures.line);

    /* Every other branch/tag rides the SAME transaction as a `verify`
     * line (Q2 hardening, Reviewer SHOULD): see the matching comment in
     * cmdApply. */
    moveRefsOrRefuse(repo, env, 'git-release-squash tail', moves, untouchedVerifies(moves, plannedHeads, plannedTags));

    const results = [treeDelta, signatures];
    for (const r of results) process.stdout.write(r.line + '\n');
    process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
  } finally {
    signer.cleanup();
  }
}

/** One synopsis per subcommand, as docs/SPECIFICATION.md § 1 lists them
 * (`--help`, § 0; AC-100). */
const SYNOPSES: Record<string, string> = {
  plan: 'git-release-squash plan <repo> [--name=<name>]',
  apply: 'git-release-squash apply <repo> --map <file> [--name=<name>] [--dates=anon|keep] [--apply]',
  tail: 'git-release-squash tail <repo> [--name=<name>] [--dates=anon|keep] [--tag=<tag> (--message=<text>|--message-file=<path>)] [--apply]',
};

main('git-release-squash', (bin) => {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);
  if (printHelp(sub, rest, SYNOPSES, 'apply and tail are a dry run unless --apply is given. See docs/SPECIFICATION.md § 1.')) return;
  if (sub === undefined) throw new UsageError('missing subcommand (usage: ' + bin + ' plan|apply|tail <repo> ...)');
  if (sub === 'plan') return cmdPlan(bin, rest);
  if (sub === 'apply') return cmdApply(bin, rest);
  if (sub === 'tail') return cmdTail(bin, rest);
  throw new UsageError('unknown subcommand \'' + sub + '\'');
});
