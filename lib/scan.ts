#!/usr/bin/env node
/* git-leak-scan (docs/SPECIFICATION.md § 2): scan. */
import * as git from './git.ts';
import { UsageError, Refusal, parseFlags, resolveOutsideFile, requireRepo, main, printHelp, readUserFile } from './cli.ts';
import * as leakscan from './leakscan.ts';

/** The categories `scanBuiltins`/`scanTerms` can produce (§ 2.1); `--only`'s closed vocabulary. */
const CATEGORIES = ['email', 'url', 'local-path', 'hostname', 'ip', 'secret', 'term'];

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

/** A `--range` must not start with `-`, nor may either end of `a..b`/
 * `a...b`: git would read it as an option (git-sign check, D20). A usage
 * error, checked before the repo is read; `--end-of-options` on every git
 * call that takes the range is the second line of defence. */
function refuseOptionLikeRange(range: string): void {
  if (range.split(/\.{2,3}/).some((side) => side.startsWith('-'))) {
    throw new UsageError('--range \'' + range + '\': a revision must not start with \'-\'');
  }
}

/** Resolves `--range` to its commits, oldest-first; git's own non-zero exit
 * for an unresolvable range becomes a refusal naming it, never an uncaught
 * crash (git-sign check, D20). */
function resolveRangeCommits(repo: string, env: Env, range: string): string[] {
  const r = git.run(repo, ['rev-list', '--reverse', '--end-of-options', range], { env });
  if (r.status !== 0) throw new Refusal('invalid revision range \'' + range + '\'');
  const out = (r.stdout as string).replace(/\n$/, '');
  return out ? out.split('\n') : [];
}

/** The empty tree, the same well-known sha every git has (used as the
 * "parent" of a root commit, so its whole content diffs as added, not a
 * special case). */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function parentsOf(repo: string, env: Env, commit: string): string[] {
  const line = git.text(repo, ['rev-list', '--parents', '-n', '1', '--end-of-options', commit], { env });
  return line.split(' ').filter(Boolean).slice(1);
}

interface DiffParse { textAdds: Map<string, string>; binaryPaths: Set<string> }

/** A 0- or 1-parent commit's own unified diff, `-M` on: a path git marks
 * binary goes in `binaryPaths` (the existing new-blob rule still applies
 * to it, § 2.1 point 1 as before); a text path's added (`+`) lines, joined,
 * go in `textAdds`, keyed by its path AFTER the diff (so a rename lands at
 * its new path, same as the output's own path column always has). A pure
 * rename -- same content, no `+` line at all -- adds nothing for that
 * path: nothing in the file is actually new. */
function parseUnifiedDiff(raw: string): DiffParse {
  const textAdds = new Map<string, string>();
  const binaryPaths = new Set<string>();
  for (const section of raw ? raw.split(/^diff --git /m).slice(1) : []) {
    const headerLine = section.slice(0, section.indexOf('\n'));
    const m = /^a\/.* b\/(.*)$/.exec(headerLine);
    if (!m) continue;
    const newPath = m[1];
    if (section.indexOf('\nBinary files ') !== -1) { binaryPaths.add(newPath); continue; }
    const added: string[] = [];
    for (const line of section.split('\n')) {
      if (line.startsWith('+++')) continue;
      if (line.startsWith('+')) added.push(line.slice(1));
    }
    if (added.length > 0) textAdds.set(newPath, added.join('\n'));
  }
  return { textAdds, binaryPaths };
}

/** A merge commit's combined diff (`git diff-tree -c`, § 2.1 point 1): a
 * line is genuinely new only when it is new relative to EVERY parent at
 * once -- its leading `numParents` marker characters are all `+`. A line
 * matching even one parent (at least one marker not `+`) is not new. */
function parseCombinedDiff(raw: string, numParents: number): DiffParse {
  const textAdds = new Map<string, string>();
  const binaryPaths = new Set<string>();
  const allPlus = '+'.repeat(numParents);
  for (const section of raw ? raw.split(/^diff --(?:cc|combined) /m).slice(1) : []) {
    const newPath = section.slice(0, section.indexOf('\n')).trim();
    if (!newPath) continue;
    if (section.indexOf('\nBinary files ') !== -1) { binaryPaths.add(newPath); continue; }
    const added: string[] = [];
    for (const line of section.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.slice(0, numParents) === allPlus) added.push(line.slice(numParents));
    }
    if (added.length > 0) textAdds.set(newPath, added.join('\n'));
  }
  return { textAdds, binaryPaths };
}

/** The scan targets one range commit contributes (§ 2.1 point 1): the
 * lines it adds relative to its first parent (root: the empty tree;
 * merge: the combined diff, new against every parent), `-M` rename
 * detection on; a binary path instead keeps the existing new-blob rule
 * (its content is read once and cached exactly as a whole-history blob
 * is, D22) since a line-level diff makes no sense for it. */
function rangeFileTargets(repo: string, env: Env, commit: string): Target[] {
  const parents = parentsOf(repo, env, commit);
  const parsed = parents.length <= 1
    /* `-M` explicit, not relied on as a default: diff.renames is true by
     * default since git 2.9, but a repo or user config can set it false,
     * and this call must detect a rename regardless of that setting. */
    ? parseUnifiedDiff(git.text(repo, ['diff', '-M', '--no-color', '--end-of-options', parents.length === 0 ? EMPTY_TREE : parents[0], commit], { env }))
    : parseCombinedDiff(git.text(repo, ['diff-tree', '-c', '-p', '--no-color', '--end-of-options', commit], { env }), parents.length);
  const targets: Target[] = [];
  for (const [path, text] of parsed.textAdds) targets.push({ commit, path, kind: 'text', text });
  for (const path of parsed.binaryPaths) {
    const sha = git.text(repo, ['rev-parse', '--end-of-options', commit + ':' + path], { env });
    if (sha) targets.push({ commit, path, kind: 'blob', sha });
  }
  return targets;
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

/** Collects every scan target in oldest-first, deterministic order.
 * `range` narrows the whole-history scan to `--range`'s own commits (§ 2.1
 * point 1): the range's own commits (message + identity), only the lines
 * each one adds (`rangeFileTargets`), and only tags whose target commit is
 * itself in the range. `undefined` is the unchanged, unqualified `--all`
 * scan. */
function collectTargets(repo: string, env: Env, range?: { commits: string[] }): Target[] {
  const targets: Target[] = [];
  const commitList = range ? range.commits : (() => {
    const commits = git.text(repo, ['rev-list', '--all', '--reverse'], { env });
    return commits ? commits.split('\n') : [];
  })();
  for (const c of commitList) {
    const message = git.text(repo, ['log', '-1', '--format=%B', c], { env });
    targets.push({ commit: c, path: '(message)', kind: 'text', text: message });
    targets.push({ commit: c, path: '(identity)', kind: 'text', text: identityText(repo, env, c) });
    if (range) {
      targets.push(...rangeFileTargets(repo, env, c));
    } else {
      for (const b of listTreeBlobs(repo, env, c)) targets.push({ commit: c, path: b.path, kind: 'blob', sha: b.sha });
    }
  }
  const inRange = range ? new Set(range.commits) : null;
  const tagsRaw = git.text(repo,
    ['for-each-ref', '--format=%(refname)\t%(objecttype)\t%(*objectname)\t%(objectname)', 'refs/tags'],
    { env });
  for (const l of (tagsRaw ? tagsRaw.split('\n') : [])) {
    const [ref, type, deref, obj] = l.split('\t');
    if (type !== 'tag') continue;
    const target = deref || obj;
    if (inRange && !inRange.has(target)) continue;
    const msg = git.text(repo, ['for-each-ref', '--format=%(contents)', ref], { env });
    const tagger = git.text(repo, ['for-each-ref', '--format=%(taggername) <%(taggeremail)>', ref], { env });
    targets.push({ commit: target, path: '(tag-message)', kind: 'text', text: msg });
    targets.push({ commit: target, path: '(identity)', kind: 'text', text: tagger });
  }
  return targets;
}

function cmdScan(bin: string, args: string[]): void {
  const { positional, flags } = parseFlags(args, { valueFlags: ['--terms', '--allow', '--range', '--only'], boolFlags: [] });
  const repo = positional[0];
  if (!repo) throw new UsageError('missing <repo>');
  if (positional.length > 1) throw new UsageError('unexpected argument: ' + positional[1]);

  /* Usage errors -- checked before the repo is read (§ 2.1 point 3). No
   * trimming: a surrounding space, or an item either side of a leading,
   * trailing or doubled comma, is an empty category, not forgiven. */
  let only: Set<string> | undefined;
  if (flags.only !== undefined) {
    const items = (flags.only as string).split(',');
    for (const item of items) {
      if (item === '') throw new UsageError('--only: empty category in \'' + flags.only + '\'');
      if (!CATEGORIES.includes(item)) throw new UsageError('--only: unknown category \'' + item + '\' (known: ' + CATEGORIES.join(', ') + ')');
      if (item === 'term' && flags.terms === undefined) throw new UsageError('--only: \'term\' needs --terms');
    }
    only = new Set(items);
  }
  if (flags.range !== undefined) refuseOptionLikeRange(flags.range as string);

  requireRepo(repo);
  const env = process.env;

  let termsPath: string | null = null;
  let allowPath: string | null = null;
  if (flags.terms !== undefined) termsPath = resolveOutsideFile(repo, '--terms', flags.terms as string);
  if (flags.allow !== undefined) allowPath = resolveOutsideFile(repo, '--allow', flags.allow as string);
  const terms = termsPath ? leakscan.parseLines(readUserFile('--terms', termsPath).toString('utf8'), true) : [];
  const allow = new Set(allowPath ? leakscan.parseLines(readUserFile('--allow', allowPath).toString('utf8'), false) : []);

  let targets: Target[];
  if (flags.range !== undefined) {
    const range = flags.range as string;
    const rangeCommits = resolveRangeCommits(repo, env, range);
    if (rangeCommits.length === 0) {
      process.stderr.write('git-leak-scan: --range \'' + range + '\' brings in no commits; nothing scanned\n');
      targets = [];
    } else {
      targets = collectTargets(repo, env, { commits: rangeCommits });
    }
  } else {
    targets = collectTargets(repo, env);
  }
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
      if (only && !only.has(h.category)) continue;
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

/** The one synopsis, as docs/SPECIFICATION.md § 2 lists it (`--help`, § 0; AC-100). */
const SYNOPSES: Record<string, string> = {
  scan: 'git-leak-scan scan <repo> [--terms <file>] [--allow <file>] [--range <range>] [--only <a,b,...>]',
};

main('git-leak-scan', (bin) => {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);
  if (printHelp(sub, rest, SYNOPSES, 'Read-only. See docs/SPECIFICATION.md § 2.')) return;
  if (sub === undefined) throw new UsageError('missing subcommand (usage: ' + bin + ' scan <repo> ...)');
  if (sub === 'scan') return cmdScan(bin, rest);
  throw new UsageError('unknown subcommand \'' + sub + '\'');
});
