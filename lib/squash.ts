#!/usr/bin/env node
/* git-release-squash (docs/SPECIFICATION.md § 1): plan / apply / tail. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as git from './git.ts';
import { UsageError, Refusal, parseFlags, resolveOutsideFile, main } from './cli.ts';
import { createSigner } from './signer.ts';
import { createBackupBundle } from './bundle.ts';
import * as verify from './verify.ts';

type Env = NodeJS.ProcessEnv;

interface TagEntry {
  name: string;
  type: 'tag' | 'commit';
  commit: string;
}

interface Group {
  tip: string;
  commits: string[];
  tags: TagEntry[];
}

interface TmpMsg {
  path: string;
  cleanup(): void;
}

function requireRepo(repo: string): void {
  if (!git.isRepo(repo)) throw new Refusal('not a git repository (' + repo + ')');
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
    ['for-each-ref', '--format=%(refname:short)\t%(objecttype)\t%(*objectname)\t%(objectname)', 'refs/tags'],
    { env });
  if (!out) return [];
  return out.split('\n').map((l): TagEntry => {
    const [name, type, deref, obj] = l.split('\t');
    return { name, type: type as 'tag' | 'commit', commit: type === 'tag' ? deref : obj };
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
      const tagShort = shortSha(repo, env, t.name);
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

function tagRawMessage(repo: string, env: Env, name: string): string {
  const s = git.text(repo, ['tag', '-l', '--format=%(contents:subject)', name], { env });
  const b = git.text(repo, ['tag', '-l', '--format=%(contents:body)', name], { env }).replace(/\s+$/, '');
  return s + (b ? '\n\n' + b : '') + '\n';
}

function writeTmpMsg(msg: string): TmpMsg {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ght-tagmsg-'));
  const p = path.join(dir, 'msg.txt');
  fs.writeFileSync(p, msg);
  return { path: p, cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } } };
}

function currentBranch(repo: string, env: Env): string {
  const r = git.run(repo, ['symbolic-ref', '--short', 'HEAD'], { env });
  if (r.status !== 0) throw new Refusal('HEAD is detached');
  return (r.stdout as string).replace(/\n$/, '');
}

function isDirty(repo: string, env: Env): boolean {
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

  createBackupBundle(repo, env);
  const signer = createSigner(repo, env);
  const tmpFiles: TmpMsg[] = [];
  try {
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

    fs.writeFileSync(flags.map as string, mapLines.length ? mapLines.join('\n') + '\n' : '');

    for (const { g, nc, committerDate } of commitResults) {
      for (const t of g.tags) {
        if (t.type === 'tag') {
          const msg = tagRawMessage(repo, env, t.name);
          const tmp = writeTmpMsg(msg);
          tmpFiles.push(tmp);
          git.text(repo, ['tag', '-f', '-s', '-F', tmp.path, t.name, nc], {
            env: Object.assign({}, env, { GIT_COMMITTER_DATE: committerDate }),
            config: signer.gitConfig,
          });
        } else {
          git.text(repo, ['update-ref', 'refs/tags/' + t.name, nc], { env });
        }
      }
    }
    git.text(repo, ['update-ref', '-m', 'git-release-squash apply', 'refs/heads/' + branch, newHead, oldHead], { env });

    const results = [
      verify.verifyTreeDelta(commitResults.map((r) => ({ label: r.g.tip, expected: r.origTree, actual: r.newTree }))),
      verify.verifySignatures(repo, env),
      verify.verifyEveryCommitTagged(repo, env),
    ];
    for (const r of results) process.stdout.write(r.line + '\n');
    process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
  } finally {
    signer.cleanup();
    for (const t of tmpFiles) t.cleanup();
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

  createBackupBundle(repo, env);
  const signer = createSigner(repo, env);
  const tmpFiles: TmpMsg[] = [];
  try {
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

    git.text(repo, ['update-ref', '-m', 'git-release-squash tail', 'refs/heads/' + branch, nc, headSha], { env });

    if (flags.tag !== undefined) {
      const tmp = writeTmpMsg(tagMessageText as string);
      tmpFiles.push(tmp);
      const tagEnv = dates === 'anon' ? Object.assign({}, env, { GIT_COMMITTER_DATE: whenC }) : env;
      git.text(repo, ['tag', '-s', '-F', tmp.path, flags.tag as string, nc], { env: tagEnv, config: signer.gitConfig });
    }

    const results = [
      verify.verifyTreeDelta([{ label: headSha, expected: tree, actual: newTree }]),
      verify.verifySignatures(repo, env),
    ];
    for (const r of results) process.stdout.write(r.line + '\n');
    process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
  } finally {
    signer.cleanup();
    for (const t of tmpFiles) t.cleanup();
  }
}

main('git-release-squash', (bin) => {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);
  if (sub === 'plan') return cmdPlan(bin, rest);
  if (sub === 'apply') return cmdApply(bin, rest);
  if (sub === 'tail') return cmdTail(bin, rest);
  throw new UsageError('unknown subcommand \'' + sub + '\'');
});
