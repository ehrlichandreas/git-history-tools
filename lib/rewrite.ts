#!/usr/bin/env node
/* git-history-rewrite (docs/SPECIFICATION.md § 3): replace / add-file. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as git from './git.ts';
import { UsageError, Refusal, parseFlags, resolveOutsideFile, requireRepo, main, printHelp, readUserFile } from './cli.ts';
import { refuseNonUtf8 } from './encoding.ts';
import { createSigner, buildSignedTagObject } from './signer.ts';
import { createBackupBundle } from './bundle.ts';
import * as leakscan from './leakscan.ts';
import * as verify from './verify.ts';
import { tagMessageFromRaw, signatureBlockCount, signatureStatus } from './siginfo.ts';

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

interface RefTag {
  ref: string;
  name: string;
  type: string;
  commit: string;
  tagObj: string;
}

interface RefHead {
  ref: string;
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
  /** A refusal `transformTree` would raise, checked over every commit's
   * tree before the backup bundle (§ 0, D20, AC-77). Writes nothing. */
  precheck?: (oldTree: string) => void;
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
  const r = git.run(repo, ['symbolic-ref', 'HEAD'], { env });
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

/** `setPathInTree`'s refusal on its own, read-only: a directory sits at
 * exactly `segments` inside `treeSha`. */
function refuseDirectoryAt(repo: string, env: Env, treeSha: string, segments: string[], repoPath: string): void {
  let tree = treeSha;
  for (let i = 0; i < segments.length; i++) {
    const e = lsTreeOneLevel(repo, env, tree).find((x) => x.name === segments[i]);
    if (!e || e.type !== 'tree') return;
    if (i === segments.length - 1) throw new Refusal('a directory already exists at ' + repoPath);
    tree = e.sha;
  }
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
  const headsRaw = git.text(repo, ['for-each-ref', '--format=%(refname)\t%(objectname)', 'refs/heads'], { env });
  const heads = (headsRaw ? headsRaw.split('\n') : []).map((l): RefHead => {
    const [ref, sha] = l.split('\t');
    return { ref, name: git.refBase(ref, 'refs/heads/'), sha };
  });
  const tagsRaw = git.text(repo,
    ['for-each-ref', '--format=%(refname)\t%(objecttype)\t%(*objectname)\t%(objectname)', 'refs/tags'],
    { env });
  const tags = (tagsRaw ? tagsRaw.split('\n') : []).map((l): RefTag => {
    const [ref, type, deref, obj] = l.split('\t');
    return { ref, name: git.refBase(ref, 'refs/tags/'), type, commit: type === 'tag' ? deref : obj, tagObj: obj };
  });
  return { heads, tags };
}

/** Every annotated tag's own message (D20, AC-71): the raw object minus
 * its trailing signature, by the same boundary walk git-sign uses (its
 * D14/D16) -- never `%(contents)`, which for a signed tag includes the old
 * signature, so a re-created tag carried two blocks. A tag whose message
 * ends in a signature-shaped block gpg can neither verify nor attribute to
 * any key is refused, as git-sign refuses it (D18): it may be an unsigned
 * tag quoting a block, and stripping that would drop the user's text. */
function tagMessages(repo: string, env: Env, tags: RefTag[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of tags) {
    if (t.type !== 'tag') continue;
    const raw = git.buffer(repo, ['cat-file', 'tag', t.tagObj], { env }).toString('utf8');
    if (signatureBlockCount(raw, 'tag') === 1 && signatureStatus(repo, env, 'tag', t.tagObj, true, '').state === 'bad') {
      throw new Refusal('tag ' + t.name + ' ends with a signature-shaped block gpg cannot verify or attribute to any key ' +
        '-- indistinguishable from an unsigned tag whose message merely ends with a quoted block; refusing to guess, resolve manually');
    }
    out.set(t.name, tagMessageFromRaw(raw));
  }
  return out;
}

/**
 * Shared replace/add-file engine: builds the full remapped commit graph by
 * applying `transformTree(oldTreeSha) -> newTreeSha` to each reachable
 * commit's tree, keeping parents/identities/messages byte-for-byte.
 */
/** How `now` differs from `snapshot`, one `<ref> <created|moved|deleted>`
 * per ref; empty when they agree. */
function refDrift(snapshot: { heads: RefHead[]; tags: RefTag[] }, now: { heads: RefHead[]; tags: RefTag[] }): string[] {
  const shaOf = (t: { heads: RefHead[]; tags: RefTag[] }) =>
    new Map<string, string>([...t.heads.map((h): [string, string] => [h.ref, h.sha]), ...t.tags.map((g): [string, string] => [g.ref, g.tagObj])]);
  const before = shaOf(snapshot);
  const after = shaOf(now);
  const out: string[] = [];
  for (const [ref, sha] of before) {
    if (!after.has(ref)) out.push(ref + ' deleted');
    else if (after.get(ref) !== sha) out.push(ref + ' moved');
  }
  for (const ref of after.keys()) if (!before.has(ref)) out.push(ref + ' created');
  return out;
}

function runRewrite(bin: string, sub: string, repo: string, env: Env, opts: RewriteOpts): void {
  refuseOnMerge(repo, env);
  /* ONE read of the refs (D20, Reviewer R1): the tag messages, the refs to
   * move and their old values all come from this snapshot, taken before
   * anything else is read. A ref that differs from it once the work is
   * done is a refusal, and the transaction's old values cover the rest. */
  const snapshot = refTips(repo, env);
  const commits = allRefCommitsTopoReverse(repo, env);
  /* Every commit and annotated tag is re-created: UTF-8 only (D21, AC-95). */
  refuseNonUtf8(repo, env, [
    ...commits.map((c) => ({ sha: c, label: 'commit ' + c.slice(0, 7) })),
    ...snapshot.tags.filter((t) => t.type === 'tag').map((t) => ({ sha: t.tagObj, label: 'tag ' + t.name })),
  ]);
  const parentsOf: Record<string, string[]> = {};
  for (const c of commits) {
    const p = git.text(repo, ['log', '-1', '--format=%P', c], { env });
    parentsOf[c] = p ? p.split(' ') : [];
  }
  const messages = tagMessages(repo, env, snapshot.tags);

  if (opts.refuseMessageChange) {
    for (const c of commits) {
      const msg = git.text(repo, ['log', '-1', '--format=%B', c], { env });
      if (opts.applyToText!(msg) !== msg) {
        throw new Refusal('commit ' + shortSha(repo, env, c) + ' message would change -- replace only rewrites file contents');
      }
    }
    for (const [name, msg] of messages) {
      if (opts.applyToText!(msg) !== msg) {
        throw new Refusal('tag ' + name + ' message would change -- replace only rewrites file contents');
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

  /* Every refusal before the backup bundle (§ 0, D20, AC-77): the
   * signing key, and the transform's own refusal over every tree. */
  if (opts.precheck) {
    const seen = new Set<string>();
    for (const c of commits) {
      const tree = git.text(repo, ['rev-parse', c + '^{tree}'], { env });
      if (!seen.has(tree)) { seen.add(tree); opts.precheck(tree); }
    }
  }
  const signer = createSigner(repo, env);
  try {
    createBackupBundle(repo, env);
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

    /* `tree delta` (D24, Reviewer-found): computed against the new
     * commits right above, before any ref moves (and before the tag
     * objects below, which need not be built at all on a doomed run) --
     * a FAILED one is now a refusal in the usual shape (the backup
     * bundle and the new commits stay, nothing moved), rather than
     * moving every ref first and reporting a verify that failed on an
     * already-moved history. */
    const treeChecks = records.map((r) => ({
      label: r.oldSha,
      expected: r.finalTree,
      actual: git.text(repo, ['rev-parse', remap.get(r.oldSha) + '^{tree}'], { env }),
    }));
    const treeDelta = verify.verifyTreeDelta(treeChecks);
    if (!treeDelta.ok) throw new Refusal(treeDelta.line);

    /* Every object first (the commits above, every tag object here), then
     * every ref in ONE transaction against its old value: a failure
     * anywhere moves nothing (D20, AC-74). `git tag -f -s` per tag used to
     * create the object and move its ref in one step, after the branches
     * had already moved. A tag keeps its tagger line and its message byte
     * for byte (AC-71). */
    const { heads, tags } = snapshot;
    const moves: git.RefMove[] = [];
    const plannedHeads: verify.PlannedHead[] = [];
    const plannedTags: verify.PlannedTag[] = [];
    /* A head/tag whose own commit never turns up in `remap` -- in
     * practice none, since `commits` already walked this same
     * `--branches --tags` universe, but the guard below exists for an
     * edge case `remap` would not cover (e.g. a tag on a tree/blob) --
     * is left untouched; it rides the transaction below as a `verify`
     * line instead of a move (Q2 hardening, Reviewer SHOULD). */
    const verifies: git.RefVerify[] = [];
    for (const h of heads) {
      const newSha = remap.get(h.sha);
      if (newSha) { moves.push({ ref: h.ref, newSha, oldSha: h.sha }); plannedHeads.push({ ref: h.ref, sha: newSha }); }
      else verifies.push({ ref: h.ref, sha: h.sha });
    }
    for (const t of tags) {
      const newCommit = remap.get(t.commit);
      if (!newCommit) { verifies.push({ ref: t.ref, sha: t.tagObj }); continue; }
      let newObj = newCommit;
      if (t.type === 'tag') {
        const raw = git.text(repo, ['cat-file', '-p', t.tagObj], { env });
        const tm = /^tagger (.*) (\d+ [+-]\d{4})$/m.exec(raw)!;
        newObj = buildSignedTagObject(repo, env, signer, {
          object: newCommit, type: 'commit', name: t.name, taggerLine: tm[1] + ' ' + tm[2], message: messages.get(t.name)!,
        });
      }
      moves.push({ ref: t.ref, newSha: newObj, oldSha: t.tagObj });
      plannedTags.push({ ref: t.ref, type: t.type, commit: newCommit, tagObj: newObj });
    }
    /* `signatures` (D24, Q2 follow-up, Scout-found): every reachable
     * commit and annotated tag is now checked against the PLANNED final
     * ref map -- every `remap`ped head/tag above, by construction every
     * head and tag there is since `commits` already walked the same
     * `--branches --tags` universe -- before the transaction: a FAILED
     * one here is a refusal (bundle and new objects kept, nothing
     * moved), not a write whose refs already moved. */
    const signatures = verify.verifySignatures(repo, env, plannedHeads, plannedTags);
    if (!signatures.ok) throw new Refusal(signatures.line);
    /* The drift check comes after the last tag is signed, right before the
     * transaction (D20, Reviewer R1b): signing can take seconds (pinentry,
     * a smartcard), and a ref created meanwhile is in neither the snapshot
     * nor the transaction, so it would stay on the old history (AC-91). */
    const drift = refDrift(snapshot, refTips(repo, env));
    if (drift.length > 0) throw new Refusal('refs changed during the run (' + drift.join(', ') + '); nothing moved, run it again');
    const txn = git.moveRefs(repo, env, bin + ' ' + sub, moves, verifies);
    if (txn.status !== 0) throw new Refusal('ref update transaction failed: ' + (txn.stderr as string).trim().split('\n')[0]);
    /* A ref created between that check and the transaction is not covered
     * by either: name it, exit 1. A moved or deleted one fails the
     * transaction's old values instead. */
    const known = new Set([...heads.map((h) => h.ref), ...tags.map((t) => t.ref)]);
    const after = refTips(repo, env);
    const late = [...after.heads.map((h) => ({ ref: h.ref, target: h.sha })), ...after.tags.map((t) => ({ ref: t.ref, target: t.commit }))]
      .filter((x) => !known.has(x.ref));
    /* "still on the old history" only when it points at a commit this run
     * rewrote (Reviewer's R1b nit N2). */
    for (const x of late) {
      process.stderr.write(bin + ': ' + x.ref + ' created during the run' + (remap.has(x.target) ? ', still on the old history' : '') + '\n');
    }

    const results = [treeDelta, signatures];
    if (opts.ruleSourcesCheck) results.push(verify.verifyRuleSourcesClean(opts.ruleSourcesCheck));
    for (const r of results) process.stdout.write(r.line + '\n');
    process.exitCode = results.some((r) => !r.ok) || late.length > 0 ? 1 : 0;
  } finally {
    signer.cleanup();
  }
}

/* ------------------------------------------------------------- replace --- */

function parseRulesFile(rulesPath: string): Rule[] {
  const raw = readUserFile('--rules', rulesPath).toString('utf8');
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
  if (positional.length > 1) throw new UsageError('unexpected argument: ' + positional[1]);
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
  if (positional.length > 2) throw new UsageError('unexpected argument: ' + positional[2]);
  if (!fs.existsSync(srcPath)) throw new UsageError('<path> does not exist: ' + srcPath);
  requireRepo(repo);
  const env = process.env;

  const content = readUserFile('<path>', srcPath);
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
    precheck: (oldTree) => refuseDirectoryAt(repo, env, oldTree, segments, asPath),
  });
}

/** One synopsis per subcommand, as docs/SPECIFICATION.md § 3 lists them
 * (`--help`, § 0; AC-100). */
const SYNOPSES: Record<string, string> = {
  replace: 'git-history-rewrite replace <repo> --rules <file> [--hook <script>] [--apply]',
  'add-file': 'git-history-rewrite add-file <repo> <path> [--as <repo-path>] [--apply]',
};

main('git-history-rewrite', (bin) => {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);
  if (printHelp(sub, rest, SYNOPSES, 'Every subcommand is a dry run unless --apply is given. See docs/SPECIFICATION.md § 3.')) return;
  if (sub === undefined) throw new UsageError('missing subcommand (usage: ' + bin + ' replace|add-file <repo> ...)');
  if (sub === 'replace') return cmdReplace(bin, rest);
  if (sub === 'add-file') return cmdAddFile(bin, rest);
  throw new UsageError('unknown subcommand \'' + sub + '\'');
});
