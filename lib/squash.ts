#!/usr/bin/env node
/* git-release-squash (docs/SPECIFICATION.md § 1): plan / apply / tail. */
import fs from 'node:fs';
import path from 'node:path';
import * as git from './git.ts';
import { UsageError, Refusal, parseFlags, resolveOutsideFile, requireRepo, main } from './cli.ts';
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

function titleFor(repo: string, env: Env, tag: TagEntry): string {
  if (tag.type === 'tag') {
    const s = git.text(repo, ['for-each-ref', '--format=%(contents:subject)', 'refs/tags/' + tag.name], { env });
    return s === '' ? '(no title)' : s;
  }
  return git.text(repo, ['log', '-1', '--format=%s', tag.commit], { env });
}

function renderPlanLines(repo: string, env: Env, name: string):
  { lines: string[]; groups: Group[]; tailCommits: string[]; allCommits: string[] } {
  const allCommits = revListReverseHead(repo, env);
  const tags = loadTagIndex(repo, env);
  const { groups, tailCommits } = groupsFromTags(allCommits, tags);
  const lines: string[] = [];
  let lastGroupTagName: string | null = null;
  for (const g of groups) {
    const groupOldestShort = shortSha(repo, env, g.commits[0]);
    const tipShort = shortSha(repo, env, g.tip);
    g.tags.forEach((t, i) => {
      /* Several tags on the same commit: the first (refname order) carries
       * the group's real fold count; every additional co-located tag is
       * "just this commit" (N=1) -- nothing already counted under the first
       * tag is re-counted under the others. */
      const n = i === 0 ? g.commits.length - (g.tags.length - 1) : 1;
      const oldestShort = i === 0 ? groupOldestShort : tipShort;
      const title = titleFor(repo, env, t);
      const tagShort = shortSha(repo, env, 'refs/tags/' + t.name);
      lines.push('plan: ' + t.name + ' folds ' + n + ' commit(s) (' +
        oldestShort + '..' + tagShort + ') into "' + title + '"');
      lines.push('plan: ' + t.name + ' tree equals ' + tagShort + '\'s own tree: OK');
    });
    lastGroupTagName = g.tags[0].name;
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

/* By full refname, never the bare name: `git tag -l <name>` reads a valid
 * tag `-x` as an option (D20, AC-80). */
function tagRawMessage(repo: string, env: Env, name: string): string {
  const s = git.text(repo, ['for-each-ref', '--format=%(contents:subject)', 'refs/tags/' + name], { env });
  const b = git.text(repo, ['for-each-ref', '--format=%(contents:body)', 'refs/tags/' + name], { env }).replace(/\s+$/, '');
  return s + (b ? '\n\n' + b : '') + '\n';
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

function moveRefsOrRefuse(repo: string, env: Env, message: string, moves: git.RefMove[]): void {
  const r = git.moveRefs(repo, env, message, moves);
  if (r.status !== 0) throw new Refusal('ref update transaction failed: ' + (r.stderr as string).trim().split('\n')[0]);
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
  requireRepo(repo);
  const env = process.env;
  refuseOnMerge(repo, env);
  const name = (flags.name as string) || defaultName(repo);
  const { lines } = renderPlanLines(repo, env, name);
  process.stdout.write(lines.map((l) => l + '\n').join(''));
}

/* ------------------------------------------------------------- apply --- */

function cmdApply(bin: string, args: string[]): void {
  const { positional, flags } = parseFlags(args, {
    valueFlags: ['--map', '--name', '--dates'], boolFlags: ['--apply'],
  });
  const repo = positional[0];
  if (!repo) throw new UsageError('missing <repo>');
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
  const { lines } = renderPlanLines(repo, env, name);

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

    /* Every object first (the commits above, every tag object here), then
     * every ref in ONE transaction against its old value: a failure
     * anywhere moves nothing (D20, AC-74). `git tag -f -s` per tag used to
     * create the object and move its ref in one step. */
    const moves: git.RefMove[] = [];
    for (const { g, nc, committerDate } of commitResults) {
      for (const t of g.tags) {
        const newObj = t.type === 'tag'
          ? buildTag(repo, Object.assign({}, env, { GIT_COMMITTER_DATE: committerDate }), signer, t.name, nc, tagRawMessage(repo, env, t.name))
          : nc;
        moves.push({ ref: 'refs/tags/' + t.name, newSha: newObj, oldSha: t.obj });
      }
    }
    moves.push({ ref: branch, newSha: newHead, oldSha: oldHead });
    moveRefsOrRefuse(repo, env, 'git-release-squash apply', moves);
    /* Only now: a failed transaction leaves no map of commits no ref
     * points at (D21, AC-85). Its directory was checked up front (AC-77). */
    fs.writeFileSync(mapPath, mapLines.length ? mapLines.join('\n') + '\n' : '');

    const results = [
      verify.verifyTreeDelta(commitResults.map((r) => ({ label: r.g.tip, expected: r.origTree, actual: r.newTree }))),
      verify.verifySignatures(repo, env),
      verify.verifyEveryCommitTagged(repo, env),
    ];
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
    (hasMessageFile ? fs.readFileSync(flags['message-file'] as string, 'utf8') : null);

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
  const title = flags.tag !== undefined ? (tagMessageText as string).split('\n')[0] :
    git.text(repo, ['log', '-1', '--format=%s', headSha], { env });
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
    const position = groups.length;
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

    /* The commit, then the tag object, then both refs in ONE transaction
     * (D20, AC-74): the branch used to move first, so a tag that failed
     * left it moved and no tag. The tag ref must not exist yet. */
    const moves: git.RefMove[] = [{ ref: branch, newSha: nc, oldSha: headSha }];
    if (flags.tag !== undefined) {
      const tagEnv = dates === 'anon' ? Object.assign({}, env, { GIT_COMMITTER_DATE: whenC }) : env;
      const tagObj = buildTag(repo, tagEnv, signer, flags.tag as string, nc, tagMessageText as string);
      moves.push({ ref: 'refs/tags/' + flags.tag, newSha: tagObj, oldSha: null });
    }
    moveRefsOrRefuse(repo, env, 'git-release-squash tail', moves);

    const results = [
      verify.verifyTreeDelta([{ label: headSha, expected: tree, actual: newTree }]),
      verify.verifySignatures(repo, env),
    ];
    for (const r of results) process.stdout.write(r.line + '\n');
    process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
  } finally {
    signer.cleanup();
  }
}

main('git-release-squash', (bin) => {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);
  if (sub === undefined) throw new UsageError('missing subcommand (usage: ' + bin + ' plan|apply|tail <repo> ...)');
  if (sub === 'plan') return cmdPlan(bin, rest);
  if (sub === 'apply') return cmdApply(bin, rest);
  if (sub === 'tail') return cmdTail(bin, rest);
  throw new UsageError('unknown subcommand \'' + sub + '\'');
});
