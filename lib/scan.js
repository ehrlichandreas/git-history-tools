#!/usr/bin/env node
'use strict';
/* leak-scan (docs/SPECIFICATION.md § 2): scan. */
const git = require('./git.js');
const { UsageError, Refusal, parseFlags, resolveOutsideFile, main } = require('./cli.js');
const leakscan = require('./leakscan.js');

function requireRepo(repo) {
  if (!git.isRepo(repo)) throw new Refusal('not a git repository (' + repo + ')');
}

function shortSha(repo, env, rev) {
  return git.text(repo, ['rev-parse', '--short', rev], { env });
}

function listTreeBlobs(repo, env, commit) {
  const out = git.text(repo, ['ls-tree', '-r', '--full-tree', commit], { env });
  if (!out) return [];
  const entries = [];
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

function identityText(repo, env, commit) {
  const out = git.text(repo, ['log', '-1', '--format=%an <%ae>%n%cn <%ce>', commit], { env });
  return out;
}

/** Collects every scan target in oldest-first, deterministic order:
 * [{ commit, path, kind: 'text'|'blob', text?, buf? }]. */
function collectTargets(repo, env) {
  const targets = [];
  const commits = git.text(repo, ['rev-list', '--all', '--reverse'], { env });
  const commitList = commits ? commits.split('\n') : [];
  for (const c of commitList) {
    const message = git.text(repo, ['log', '-1', '--format=%B', c], { env });
    targets.push({ commit: c, path: '(message)', kind: 'text', text: message });
    targets.push({ commit: c, path: '(identity)', kind: 'text', text: identityText(repo, env, c) });
    for (const b of listTreeBlobs(repo, env, c)) {
      const buf = git.buffer(repo, ['cat-file', '-p', b.sha], { env });
      targets.push({ commit: c, path: b.path, kind: 'blob', buf });
    }
  }
  const tagsRaw = git.text(repo,
    ['for-each-ref', '--format=%(refname:short)\t%(objecttype)\t%(*objectname)\t%(objectname)', 'refs/tags'],
    { env });
  for (const l of (tagsRaw ? tagsRaw.split('\n') : [])) {
    const [name, type, deref, obj] = l.split('\t');
    if (type !== 'tag') continue;
    const msg = git.text(repo, ['for-each-ref', '--format=%(contents)', 'refs/tags/' + name], { env });
    const tagger = git.text(repo, ['for-each-ref', '--format=%(taggername) <%(taggeremail)>', 'refs/tags/' + name], { env });
    targets.push({ commit: deref || obj, path: '(tag-message)', kind: 'text', text: msg });
    targets.push({ commit: deref || obj, path: '(identity)', kind: 'text', text: tagger });
  }
  return targets;
}

function cmdScan(bin, args) {
  const { positional, flags } = parseFlags(args, { valueFlags: ['--terms', '--allow'], boolFlags: [] });
  const repo = positional[0];
  if (!repo) throw new UsageError('missing <repo>');
  requireRepo(repo);
  const env = process.env;

  let termsPath = null;
  let allowPath = null;
  if (flags.terms !== undefined) termsPath = resolveOutsideFile(repo, '--terms', flags.terms);
  if (flags.allow !== undefined) allowPath = resolveOutsideFile(repo, '--allow', flags.allow);
  const terms = termsPath ? leakscan.readLines(termsPath, true) : [];
  const allow = new Set(allowPath ? leakscan.readLines(allowPath, false) : []);

  const targets = collectTargets(repo, env);
  const seenPairs = new Set();
  const agg = new Map();
  const order = [];

  for (const t of targets) {
    let hits;
    if (t.kind === 'blob') {
      if (leakscan.isBinary(t.buf)) {
        hits = leakscan.scanPemInBuffer(t.buf);
      } else {
        const text = t.buf.toString('utf8');
        hits = leakscan.scanBuiltins(text).concat(leakscan.scanTerms(text, terms));
      }
    } else {
      hits = leakscan.scanBuiltins(t.text).concat(leakscan.scanTerms(t.text, terms));
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

  const lines = [];
  for (const key of order) {
    const e = agg.get(key);
    if (allow.has(e.match)) continue;
    const short = shortSha(repo, env, e.firstCommit);
    lines.push('scan: ' + e.category + ' ' + e.match + ' (' + e.count + ') first at ' + short + ':' + e.firstPath);
  }
  process.stdout.write(lines.map((l) => l + '\n').join(''));
  process.exitCode = lines.length > 0 ? 1 : 0;
}

main('ght-scan', (bin) => {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);
  if (sub === 'scan') return cmdScan(bin, rest);
  throw new UsageError('unknown subcommand \'' + sub + '\'');
});
