#!/usr/bin/env node
/* git-history-rewrite (docs/SPECIFICATION.md § 3): replace / add-file. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as git from './git.ts';
import { UsageError, Refusal, parseFlags, resolveOutsideFile, main } from './cli.ts';
import { createSigner } from './signer.ts';
import { createBackupBundle } from './bundle.ts';
import * as leakscan from './leakscan.ts';
import * as verify from './verify.ts';

type Env = NodeJS.ProcessEnv;

interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  name: string;
}

interface Identity {
  authorName: string;
  authorEmail: string;
  authorWhen: string;
  committerName: string;
  committerEmail: string;
  committerWhen: string;
}

interface Rule {
  from: string;
  to: string;
}

interface TmpMsg {
  path: string;
  cleanup(): void;
}

interface RefTag {
  name: string;
  type: string;
  commit: string;
  tagObj: string;
}

interface RefHead {
  name: string;
  sha: string;
}

interface RewriteRecord {
  oldSha: string;
  oldTree: string;
  finalTree: string;
  changed: boolean;
}

interface RewriteOpts {
  apply: boolean;
  refuseMessageChange: boolean;
  applyToText?: (t: string) => string;
  transformTree: (oldTree: string, write: boolean) => string;
  changeLabel: string;
  ruleSourcesCheck: string[] | null;
}

function requireRepo(repo: string): void {
  if (!git.isRepo(repo)) throw new Refusal('not a git repository (' + repo + ')');
}

function shortSha(repo: string, env: Env, rev: string): string {
  return git.text(repo, ['rev-parse', '--short', rev], { env });
}

function refuseOnMerge(repo: string, env: Env): void {
  const out = git.text(repo, ['rev-list', '--merges', '--topo-order', 'HEAD'], { env });
  const merge = out ? out.split('\n')[0] : null;
  if (merge) throw new Refusal('merge commits are not supported (' + shortSha(repo, env, merge) + ')');
}

function currentBranch(repo: string, env: Env): string {
  const r = git.run(repo, ['symbolic-ref', '--short', 'HEAD'], { env });
  if (r.status !== 0) throw new Refusal('HEAD is detached');
  return (r.stdout as string).replace(/\n$/, '');
}

function splitIdent(s: string): { name: string; email: string } {
  const m = /^(.*) <([^>]*)>$/.exec(s);
  return m ? { name: m[1], email: m[2] } : { name: s, email: '' };
}

function rawIdentity(repo: string, env: Env, sha: string): Identity {
  const raw = git.text(repo, ['cat-file', '-p', sha], { env });
  const am = /^author (.*) (\d+ [+-]\d{4})$/m.exec(raw)!;
  const cm = /^committer (.*) (\d+ [+-]\d{4})$/m.exec(raw)!;
  const a = splitIdent(am[1]);
  const c = splitIdent(cm[1]);
  return {
    authorName: a.name, authorEmail: a.email, authorWhen: '@' + am[2],
    committerName: c.name, committerEmail: c.email, committerWhen: '@' + cm[2],
  };
}

function writeTmpMsg(msg: string): TmpMsg {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ght-tagmsg-'));
  try {
    const p = path.join(dir, 'msg.txt');
    fs.writeFileSync(p, msg);
    return { path: p, cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } } };
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e2) { /* best effort */ }
    throw e;
  }
}

/* -------------------------------------------------------- tree rewriting --- */

function lsTreeOneLevel(repo: string, env: Env, treeSha: string): TreeEntry[] {
  const out = git.text(repo, ['ls-tree', treeSha], { env });
  if (!out) return [];
  return out.split('\n').map((line): TreeEntry => {
    const tab = line.indexOf('\t');
    const meta = line.slice(0, tab).split(/\s+/);
    return { mode: meta[0], type: meta[1], sha: meta[2], name: line.slice(tab + 1) };
  });
}

/** D2: a dry run must leave .git/objects byte-identical. `git mktree`
 * itself always writes the tree object it builds (even with --missing),
 * so a no-write preview can't go through it -- instead the tree's raw
 * object content is built by hand (mode-without-leading-zeros, name, NUL,
 * 20 raw sha bytes, entries sorted the way git sorts tree entries) and
 * hashed via `git hash-object -t tree --stdin` without `-w`, which only
 * computes the sha. Writing mode still uses plain `mktree` (simplest and
 * means the object genuinely exists for commit-tree to reference). */
function treeSortKey(e: TreeEntry): string {
  return e.name + (e.type === 'tree' ? '/' : '');
}

function mktree(repo: string, env: Env, entries: TreeEntry[], write: boolean): string {
  if (write) {
    const input = entries.map((e) => e.mode + ' ' + e.type + ' ' + e.sha + '\t' + e.name).join('\n') + '\n';
    return git.text(repo, ['mktree'], { env, input });
  }
  const sorted = entries.slice().sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const raw = Buffer.concat(sorted.map((e) =>
    Buffer.concat([
      Buffer.from(e.mode.replace(/^0+(?=\d)/, '') + ' ' + e.name + '\0'),
      Buffer.from(e.sha, 'hex'),
    ])));
  return git.text(repo, ['hash-object', '-t', 'tree', '--stdin'], { env, input: raw });
}

function hashObjectBlob(repo: string, env: Env, buf: Buffer, write: boolean): string {
  const args = write ? ['hash-object', '-w', '--stdin'] : ['hash-object', '--stdin'];
  return git.text(repo, args, { env, input: buf });
}

/** Applies ordered replace rules to a blob, honouring the binary/trailing-
 * newline rules of § 3.1. Returns the (possibly unchanged) blob sha. */
function rewriteBlob(repo: string, env: Env, sha: string, rules: Rule[], cache: Map<string, string>, write: boolean): string {
  if (cache.has(sha)) return cache.get(sha)!;
  const buf = git.buffer(repo, ['cat-file', '-p', sha], { env });
  let resultSha: string;
  if (leakscan.isBinary(buf)) {
    resultSha = sha;
  } else {
    const hadTrailingNewline = buf.length > 0 && buf[buf.length - 1] === 10;
    let text = buf.toString('utf8');
    for (const r of rules) text = text.split(r.from).join(r.to);
    if (hadTrailingNewline) {
      if (!text.endsWith('\n')) text += '\n';
    } else {
      while (text.endsWith('\n')) text = text.slice(0, -1);
    }
    const newBuf = Buffer.from(text, 'utf8');
    resultSha = newBuf.equals(buf) ? sha : hashObjectBlob(repo, env, newBuf, write);
  }
  cache.set(sha, resultSha);
  return resultSha;
}

function rewriteTreeWithRules(repo: string, env: Env, treeSha: string, rules: Rule[],
  treeCache: Map<string, string>, blobCache: Map<string, string>, write: boolean): string {
  if (treeCache.has(treeSha)) return treeCache.get(treeSha)!;
  const entries = lsTreeOneLevel(repo, env, treeSha);
  const newEntries = entries.map((e) => {
    if (e.type === 'tree') {
      return Object.assign({}, e, { sha: rewriteTreeWithRules(repo, env, e.sha, rules, treeCache, blobCache, write) });
    }
    if (e.type === 'blob') {
      return Object.assign({}, e, { sha: rewriteBlob(repo, env, e.sha, rules, blobCache, write) });
    }
    return e;
  });
  const changed = newEntries.some((e, i) => e.sha !== entries[i].sha);
  const newTreeSha = changed ? mktree(repo, env, newEntries, write) : treeSha;
  treeCache.set(treeSha, newTreeSha);
  return newTreeSha;
}

/** Sets (or replaces) a blob at `asPath` inside `treeSha`. Refuses if a
 * directory already sits at that exact path. Returns the new tree sha. */
function setPathInTree(repo: string, env: Env, treeSha: string, segments: string[], mode: string,
  blobSha: string, repoPath: string, write: boolean): string {
  const [head, ...rest] = segments;
  const entries = lsTreeOneLevel(repo, env, treeSha);
  const idx = entries.findIndex((e) => e.name === head);
  let newEntry: TreeEntry;
  if (rest.length === 0) {
    if (idx !== -1 && entries[idx].type === 'tree') {
      throw new Refusal('a directory already exists at ' + repoPath);
    }
    newEntry = { mode, type: 'blob', sha: blobSha, name: head };
  } else {
    const subTree = idx !== -1 && entries[idx].type === 'tree' ? entries[idx].sha : mktree(repo, env, [], write);
    const newSub = setPathInTree(repo, env, subTree, rest, mode, blobSha, repoPath, write);
    newEntry = { mode: '040000', type: 'tree', sha: newSub, name: head };
  }
  if (idx === -1) entries.push(newEntry); else entries[idx] = newEntry;
  return mktree(repo, env, entries, write);
}

/* -------------------------------------------------------------- hook --- */

function runHook(hookPath: string, repo: string, ruleTreeSha: string, hookCache: Map<string, string>): string {
  if (hookCache.has(ruleTreeSha)) return hookCache.get(ruleTreeSha)!;
  const r = spawnSync(hookPath, [ruleTreeSha], {
    env: Object.assign({}, process.env, { GHT_REPO: repo }),
    encoding: 'utf8',
  });
  if (r.error) throw new Refusal('hook ' + hookPath + ' could not be run: ' + r.error.message);
  const out = (r.stdout || '');
  const trimmed = out.replace(/\n$/, '');
  if (r.status !== 0 || (trimmed !== '' && !/^[0-9a-f]{40}$/.test(trimmed))) {
    throw new Refusal('hook ' + hookPath + ' failed (exit ' + r.status + '): ' + JSON.stringify(out));
  }
  const finalSha = trimmed === '' ? ruleTreeSha : trimmed;
  hookCache.set(ruleTreeSha, finalSha);
  return finalSha;
}

/* --------------------------------------------------------- shared core --- */

/* --branches --tags, not --all: --all also walks refs/remotes/* (and
 * refs/stash, refs/notes), and refTips() below -- what actually gets
 * re-pointed afterward -- only ever touches refs/heads/refs/tags. Any
 * commit only reachable via a stale remote-tracking ref would otherwise
 * still enter this list and get refuseMessageChange-checked (a false
 * positive refusal for a commit that's never actually touched) and run
 * through --hook (unwanted side effects), same root cause as D4's
 * verifySignatures() fix in verify.ts. */
function allRefCommitsTopoReverse(repo: string, env: Env): string[] {
  const out = git.text(repo, ['rev-list', '--branches', '--tags', '--topo-order', '--reverse'], { env });
  return out ? out.split('\n') : [];
}

function refTips(repo: string, env: Env): { heads: RefHead[]; tags: RefTag[] } {
  const headsRaw = git.text(repo, ['for-each-ref', '--format=%(refname:short)\t%(objectname)', 'refs/heads'], { env });
  const heads = (headsRaw ? headsRaw.split('\n') : []).map((l): RefHead => {
    const [name, sha] = l.split('\t');
    return { name, sha };
  });
  const tagsRaw = git.text(repo,
    ['for-each-ref', '--format=%(refname:short)\t%(objecttype)\t%(*objectname)\t%(objectname)', 'refs/tags'],
    { env });
  const tags = (tagsRaw ? tagsRaw.split('\n') : []).map((l): RefTag => {
    const [name, type, deref, obj] = l.split('\t');
    return { name, type, commit: type === 'tag' ? deref : obj, tagObj: obj };
  });
  return { heads, tags };
}

/**
 * Shared replace/add-file engine: builds the full remapped commit graph by
 * applying `transformTree(oldTreeSha) -> newTreeSha` to each reachable
 * commit's tree, keeping parents/identities/messages byte-for-byte.
 */
function runRewrite(bin: string, sub: string, repo: string, env: Env, opts: RewriteOpts): void {
  refuseOnMerge(repo, env);
  const commits = allRefCommitsTopoReverse(repo, env);
  const parentsOf: Record<string, string[]> = {};
  for (const c of commits) {
    const p = git.text(repo, ['log', '-1', '--format=%P', c], { env });
    parentsOf[c] = p ? p.split(' ') : [];
  }

  if (opts.refuseMessageChange) {
    for (const c of commits) {
      const msg = git.text(repo, ['log', '-1', '--format=%B', c], { env });
      if (opts.applyToText!(msg) !== msg) {
        throw new Refusal('commit ' + shortSha(repo, env, c) + ' message would change -- replace only rewrites file contents');
      }
    }
    const { tags } = refTips(repo, env);
    for (const t of tags) {
      if (t.type !== 'tag') continue;
      const msg = git.text(repo, ['for-each-ref', '--format=%(contents)', 'refs/tags/' + t.name], { env });
      if (opts.applyToText!(msg) !== msg) {
        throw new Refusal('tag ' + t.name + ' message would change -- replace only rewrites file contents');
      }
    }
  }

  const computeRecords = (write: boolean): RewriteRecord[] => commits.map((c): RewriteRecord => {
    const oldTree = git.text(repo, ['rev-parse', c + '^{tree}'], { env });
    const finalTree = opts.transformTree(oldTree, write);
    return { oldSha: c, oldTree, finalTree, changed: finalTree !== oldTree };
  });

  if (!opts.apply) {
    /* D2: a dry run writes no git objects either -- every hash computed
     * for this report uses `write: false` throughout (hash-object/mktree
     * without -w). */
    const records = computeRecords(false);
    const changedCount = records.filter((r) => r.changed).length;
    const lines: string[] = [];
    for (const r of records) {
      if (r.changed) lines.push('replace: ' + shortSha(repo, env, r.oldSha) + ' ' + opts.changeLabel);
    }
    lines.push('replace: ' + changedCount + ' of ' + records.length + ' commits ' + opts.changeLabel);
    process.stdout.write(lines.map((l) => l + '\n').join(''));
    process.stdout.write(bin + ': dry run, no ref changed (use --apply to write)\n');
    return;
  }

  createBackupBundle(repo, env);
  const signer = createSigner(repo, env);
  const tmpFiles: TmpMsg[] = [];
  try {
    /* Only now, after the backup bundle exists, do the actual (writing)
     * tree/blob computation -- § 4.1's "before changing anything" covers
     * objects, not just refs. */
    const records = computeRecords(true);
    const remap = new Map<string, string>();
    for (const r of records) {
      const ident = rawIdentity(repo, env, r.oldSha);
      const message = git.text(repo, ['log', '-1', '--format=%B', r.oldSha], { env });
      const newParents = parentsOf[r.oldSha].filter(Boolean).map((p) => remap.get(p)!);
      const ctArgs = ['commit-tree', '-S', r.finalTree];
      for (const p of newParents) ctArgs.push('-p', p);
      const nc = git.text(repo, ctArgs, {
        env: Object.assign({}, env, {
          GIT_AUTHOR_NAME: ident.authorName, GIT_AUTHOR_EMAIL: ident.authorEmail, GIT_AUTHOR_DATE: ident.authorWhen,
          GIT_COMMITTER_NAME: ident.committerName, GIT_COMMITTER_EMAIL: ident.committerEmail, GIT_COMMITTER_DATE: ident.committerWhen,
        }),
        input: message,
        config: signer.gitConfig,
      });
      remap.set(r.oldSha, nc);
    }

    const { heads, tags } = refTips(repo, env);
    for (const h of heads) {
      const newSha = remap.get(h.sha);
      if (newSha) git.text(repo, ['update-ref', 'refs/heads/' + h.name, newSha], { env });
    }
    for (const t of tags) {
      const newCommit = remap.get(t.commit);
      if (!newCommit) continue;
      if (t.type === 'tag') {
        const raw = git.text(repo, ['cat-file', '-p', t.tagObj], { env });
        const tm = /^tagger (.*) (\d+ [+-]\d{4})$/m.exec(raw)!;
        const taggerIdent = splitIdent(tm[1]);
        const msg = git.text(repo, ['for-each-ref', '--format=%(contents)', 'refs/tags/' + t.name], { env });
        const tmp = writeTmpMsg(msg);
        tmpFiles.push(tmp);
        git.text(repo, ['tag', '-f', '-s', '-F', tmp.path, t.name, newCommit], {
          env: Object.assign({}, env, {
            GIT_COMMITTER_NAME: taggerIdent.name, GIT_COMMITTER_EMAIL: taggerIdent.email,
            GIT_COMMITTER_DATE: '@' + tm[2],
          }),
          config: signer.gitConfig,
        });
      } else {
        git.text(repo, ['update-ref', 'refs/tags/' + t.name, newCommit], { env });
      }
    }

    const treeChecks = records.map((r) => ({
      label: r.oldSha,
      expected: r.finalTree,
      actual: git.text(repo, ['rev-parse', remap.get(r.oldSha) + '^{tree}'], { env }),
    }));
    const results = [verify.verifyTreeDelta(treeChecks), verify.verifySignatures(repo, env)];
    if (opts.ruleSourcesCheck) results.push(verify.verifyRuleSourcesClean(opts.ruleSourcesCheck));
    for (const r of results) process.stdout.write(r.line + '\n');
    process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
  } finally {
    signer.cleanup();
    for (const t of tmpFiles) t.cleanup();
  }
}

/* ------------------------------------------------------------- replace --- */

function parseRulesFile(rulesPath: string): Rule[] {
  const raw = fs.readFileSync(rulesPath, 'utf8');
  const lines = raw.split('\n');
  const rules: Rule[] = [];
  lines.forEach((line, i) => {
    if (line === '' || line.startsWith('#')) return;
    const parts = line.split('\t');
    if (parts.length !== 2) throw new UsageError('--rules line ' + (i + 1) + ': expected one tab-separated from/to pair');
    rules.push({ from: parts[0], to: parts[1] });
  });
  return rules;
}

function applyRulesToText(text: string, rules: Rule[]): string {
  let out = text;
  for (const r of rules) out = out.split(r.from).join(r.to);
  return out;
}

function cmdReplace(bin: string, args: string[]): void {
  const { positional, flags } = parseFlags(args, { valueFlags: ['--rules', '--hook'], boolFlags: ['--apply'] });
  const repo = positional[0];
  if (!repo) throw new UsageError('missing <repo>');
  if (!flags.rules) throw new UsageError('missing --rules');
  requireRepo(repo);
  const env = process.env;
  const rulesPath = resolveOutsideFile(repo, '--rules', flags.rules as string);
  const rules = parseRulesFile(rulesPath);

  const treeCache = new Map<string, string>();
  const blobCache = new Map<string, string>();
  const hookCache = new Map<string, string>();
  const transformTree = (oldTree: string, write: boolean): string => {
    const ruleTree = rewriteTreeWithRules(repo, env, oldTree, rules, treeCache, blobCache, write);
    return flags.hook ? runHook(flags.hook as string, repo, ruleTree, hookCache) : ruleTree;
  };

  runRewrite(bin, 'replace', repo, env, {
    apply: !!flags.apply,
    refuseMessageChange: true,
    applyToText: (t) => applyRulesToText(t, rules),
    transformTree,
    changeLabel: 'would change',
    ruleSourcesCheck: rules.map((r) => r.to),
  });
}

/* ------------------------------------------------------------- add-file --- */

function cmdAddFile(bin: string, args: string[]): void {
  const { positional, flags } = parseFlags(args, { valueFlags: ['--as'], boolFlags: ['--apply'] });
  const repo = positional[0];
  const srcPath = positional[1];
  if (!repo) throw new UsageError('missing <repo>');
  if (!srcPath) throw new UsageError('missing <path>');
  if (!fs.existsSync(srcPath)) throw new UsageError('<path> does not exist: ' + srcPath);
  requireRepo(repo);
  const env = process.env;

  const content = fs.readFileSync(srcPath);
  const st = fs.statSync(srcPath);
  const mode = (st.mode & 0o111) !== 0 ? '100755' : '100644';
  const asPath = (flags.as as string) || path.basename(srcPath);
  const segments = asPath.split('/').filter(Boolean);
  const blobShaByWrite: Record<string, string> = {};
  const getBlobSha = (write: boolean): string => {
    if (!(String(write) in blobShaByWrite)) blobShaByWrite[String(write)] = hashObjectBlob(repo, env, content, write);
    return blobShaByWrite[String(write)];
  };

  const transformTree = (oldTree: string, write: boolean): string =>
    setPathInTree(repo, env, oldTree, segments, mode, getBlobSha(write), asPath, write);

  runRewrite(bin, 'add-file', repo, env, {
    apply: !!flags.apply,
    refuseMessageChange: false,
    transformTree,
    changeLabel: 'would add/replace ' + asPath,
    ruleSourcesCheck: null,
  });
}

main('git-history-rewrite', (bin) => {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);
  if (sub === 'replace') return cmdReplace(bin, rest);
  if (sub === 'add-file') return cmdAddFile(bin, rest);
  throw new UsageError('unknown subcommand \'' + sub + '\'');
});
