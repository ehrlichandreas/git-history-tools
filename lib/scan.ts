#!/usr/bin/env node
/* git-leak-scan (docs/SPECIFICATION.md § 2): scan. */
import * as git from './git.ts';
import { UsageError, Refusal, parseFlags, resolveOutsideFile, requireRepo, main } from './cli.ts';
import * as leakscan from './leakscan.ts';

type Env = NodeJS.ProcessEnv;

interface TreeBlob {
  sha: string;
  path: string;
}

interface Target {
  commit: string;
  path: string;
  kind: 'text' | 'blob';
  text?: string;
  /** For a blob: its sha, read when scanned (once per sha, D22). */
  sha?: string;
}

interface AggEntry {
  category: string;
  match: string;
  count: number;
  firstCommit: string;
  firstPath: string;
}

function shortSha(repo: string, env: Env, rev: string): string {
  return git.text(repo, ['rev-parse', '--short', rev], { env });
}

function listTreeBlobs(repo: string, env: Env, commit: string): TreeBlob[] {
  const out = git.text(repo, ['ls-tree', '-r', '--full-tree', commit], { env });
  if (!out) return [];
  const entries: TreeBlob[] = [];
  for (const line of out.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const meta = line.slice(0, tab).split(/\s+/);
    const filePath = line.slice(tab + 1);
    if (meta[1] !== 'blob') continue;
    entries.push({ sha: meta[2], path: filePath });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

function identityText(repo: string, env: Env, commit: string): string {
  const out = git.text(repo, ['log', '-1', '--format=%an <%ae>%n%cn <%ce>', commit], { env });
  return out;
}

/** Collects every scan target in oldest-first, deterministic order. */
function collectTargets(repo: string, env: Env): Target[] {
  const targets: Target[] = [];
  const commits = git.text(repo, ['rev-list', '--all', '--reverse'], { env });
  const commitList = commits ? commits.split('\n') : [];
  for (const c of commitList) {
    const message = git.text(repo, ['log', '-1', '--format=%B', c], { env });
    targets.push({ commit: c, path: '(message)', kind: 'text', text: message });
    targets.push({ commit: c, path: '(identity)', kind: 'text', text: identityText(repo, env, c) });
    for (const b of listTreeBlobs(repo, env, c)) targets.push({ commit: c, path: b.path, kind: 'blob', sha: b.sha });
  }
  const tagsRaw = git.text(repo,
    ['for-each-ref', '--format=%(refname)\t%(objecttype)\t%(*objectname)\t%(objectname)', 'refs/tags'],
    { env });
  for (const l of (tagsRaw ? tagsRaw.split('\n') : [])) {
    const [ref, type, deref, obj] = l.split('\t');
    if (type !== 'tag') continue;
    const msg = git.text(repo, ['for-each-ref', '--format=%(contents)', ref], { env });
    const tagger = git.text(repo, ['for-each-ref', '--format=%(taggername) <%(taggeremail)>', ref], { env });
    targets.push({ commit: deref || obj, path: '(tag-message)', kind: 'text', text: msg });
    targets.push({ commit: deref || obj, path: '(identity)', kind: 'text', text: tagger });
  }
  return targets;
}

function cmdScan(bin: string, args: string[]): void {
  const { positional, flags } = parseFlags(args, { valueFlags: ['--terms', '--allow'], boolFlags: [] });
  const repo = positional[0];
  if (!repo) throw new UsageError('missing <repo>');
  requireRepo(repo);
  const env = process.env;

  let termsPath: string | null = null;
  let allowPath: string | null = null;
  if (flags.terms !== undefined) termsPath = resolveOutsideFile(repo, '--terms', flags.terms as string);
  if (flags.allow !== undefined) allowPath = resolveOutsideFile(repo, '--allow', flags.allow as string);
  const terms = termsPath ? leakscan.readLines(termsPath, true) : [];
  const allow = new Set(allowPath ? leakscan.readLines(allowPath, false) : []);

  const targets = collectTargets(repo, env);
  const seenPairs = new Set<string>();
  const agg = new Map<string, AggEntry>();
  const order: string[] = [];

  /* A blob's hits depend on its content alone, so each distinct blob is
   * read and scanned once, however many commits and paths it sits at
   * (D22, AC-89); the counts below still go per (commit, path). */
  const blobHits = new Map<string, leakscan.Hit[]>();
  for (const t of targets) {
    let hits: leakscan.Hit[];
    if (t.kind === 'blob') {
      const cached = blobHits.get(t.sha!);
      if (cached) {
        hits = cached;
      } else {
        const buf = git.buffer(repo, ['cat-file', '-p', t.sha!], { env });
        if (leakscan.isBinary(buf)) {
          hits = leakscan.scanPemInBuffer(buf);
        } else {
          const text = buf.toString('utf8');
          hits = leakscan.scanBuiltins(text).concat(leakscan.scanTerms(text, terms));
        }
        blobHits.set(t.sha!, hits);
      }
    } else {
      hits = leakscan.scanBuiltins(t.text!).concat(leakscan.scanTerms(t.text!, terms));
    }
    for (const h of hits) {
      const pairKey = h.category + '\u0000' + h.match + '\u0000' + t.commit + '\u0000' + t.path;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const key = h.category + '\u0000' + h.match;
      let e = agg.get(key);
      if (!e) {
        e = { category: h.category, match: h.match, count: 0, firstCommit: t.commit, firstPath: t.path };
        agg.set(key, e);
        order.push(key);
      }
      e.count++;
    }
  }

  /* One `rev-parse --short` per commit, not per line: 40000 hits from one
   * commit were 40000 git processes (AC-93). */
  const shorts = new Map<string, string>();
  const lines: string[] = [];
  for (const key of order) {
    const e = agg.get(key)!;
    if (allow.has(e.match)) continue;
    let short = shorts.get(e.firstCommit);
    if (short === undefined) { short = shortSha(repo, env, e.firstCommit); shorts.set(e.firstCommit, short); }
    lines.push('scan: ' + e.category + ' ' + e.match + ' (' + e.count + ') first at ' + short + ':' + e.firstPath);
  }
  process.stdout.write(lines.map((l) => l + '\n').join(''));
  process.exitCode = lines.length > 0 ? 1 : 0;
}

main('git-leak-scan', (bin) => {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);
  if (sub === undefined) throw new UsageError('missing subcommand (usage: ' + bin + ' scan <repo> ...)');
  if (sub === 'scan') return cmdScan(bin, rest);
  throw new UsageError('unknown subcommand \'' + sub + '\'');
});
