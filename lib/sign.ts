#!/usr/bin/env node
/* git-sign (docs/SPECIFICATION.md § 5): commit / tag / resign-tags / check /
 * resign-commits. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as git from './git.ts';
import { UsageError, Refusal, parseFlags, isInsideRepo, main } from './cli.ts';
import { createSigner, keyCreationTime } from './signer.ts';
import type { Signer } from './signer.ts';
import { createBackupBundle } from './bundle.ts';
import * as verify from './verify.ts';
import {
  loadPolicy, isForbiddenInstant, isExemptAnonymousDate, matchForbiddenPattern, formatZoned, gitDateAt,
  epochForZonedWallClock, latestAllowedMinuteAtOrBefore, nextAllowedMinuteAfter, signTimeFor,
} from './policy.ts';
import type { Policy } from './policy.ts';
import { extractSignature, signatureCreationTime, signatureStatus, verifiedKeyFingerprint, keyMatches, signatureBlockCount, tagSignatureBoundary } from './siginfo.ts';

type Env = NodeJS.ProcessEnv;
type Flags = Record<string, string | boolean>;

interface TmpMsg {
  path: string;
  cleanup(): void;
}

interface AnnotatedRef {
  name: string;
  type: string;
  obj: string;
  commit: string;
}

function requireRepo(repo: string): void {
  if (!git.isRepo(repo)) throw new Refusal('not a git repository (' + repo + ')');
}

/** Resolves a user-supplied revision/range (`check`'s and `resign-commits`'
 * `<range>`) via `git rev-list`, converting git's own non-zero exit for an
 * unresolvable range (e.g. a root commit's `~1`) into a refusal naming it --
 * never an uncaught `GitError`/stack trace for a range the user mistyped
 * (§ 0: a bad argument is a refusal, never a crash). `args` is the full
 * rev-list argument list (flags and the range/exclusion expression alike);
 * `label` is what the refusal names on failure -- the user-facing range
 * text, which is not always `args`' own last element (`resign-commits`
 * resolves via `--branches --tags ^<lower>`, not a plain `<range>` arg). */
function resolveRevList(repo: string, env: Env, args: string[], label: string): string[] {
  const r = git.run(repo, ['rev-list'].concat(args), { env });
  if (r.status !== 0) throw new Refusal('invalid revision range \'' + label + '\'');
  const out = (r.stdout as string).replace(/\n$/, '');
  return out ? out.split('\n') : [];
}

function splitIdent(s: string): { name: string; email: string } {
  const m = /^(.*) <([^>]*)>$/.exec(s);
  return m ? { name: m[1], email: m[2] } : { name: s, email: '' };
}

function writeTmpMsg(msg: string): TmpMsg {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ght-signmsg-'));
  try {
    const p = path.join(dir, 'msg.txt');
    fs.writeFileSync(p, msg);
    return { path: p, cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ } } };
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e2) { /* best effort */ }
    throw e;
  }
}

/** The policy, the gpg binary it names (`gpgProgram`, else `gpg` from
 * PATH), and the environment every git/gpg call of this command runs
 * under. git-sign never takes `gpg.program` from any git config scope
 * (§ 5.0): `git verify-commit`/`verify-tag`/`tag -v` read it themselves, so
 * the environment carries a `GIT_CONFIG_COUNT` entry overriding it for
 * every git invocation (it beats every config file; a signing call's own
 * `-c gpg.program=<wrapper>` still beats it in turn). */
function policyContext(repo: string, flags: Flags): { policy: Policy; gpgProgram: string; env: Env } {
  const policy = loadPolicy(repo, flags.policy as string | undefined, process.env);
  const gpgProgram = policy.gpgProgram || 'gpg';
  return { policy, gpgProgram, env: withGitConfig(process.env, 'gpg.program', gpgProgram) };
}

/** `env` plus one more `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` pair,
 * appended after any the caller's own environment already carries. */
function withGitConfig(env: Env, key: string, value: string): Env {
  const n = parseInt(env.GIT_CONFIG_COUNT || '0', 10) || 0;
  return Object.assign({}, env, {
    GIT_CONFIG_COUNT: String(n + 1), ['GIT_CONFIG_KEY_' + n]: key, ['GIT_CONFIG_VALUE_' + n]: value,
  });
}

/* Test-only "now" override (GHT_NOW, unix seconds) -- the only way to make
 * --date=auto deterministic; mirrors nanojira's own NJ_NOW. */
function nowSeconds(env: Env): number {
  if (env.GHT_NOW !== undefined) {
    const n = parseInt(env.GHT_NOW, 10);
    if (Number.isFinite(n)) return n;
  }
  return Math.floor(Date.now() / 1000);
}

function resolveMessage(flags: Flags): string {
  const hasMessage = flags.message !== undefined;
  const hasMessageFile = flags['message-file'] !== undefined;
  if (hasMessage === hasMessageFile) throw new UsageError('exactly one of --message or --message-file is required');
  if (hasMessage) return flags.message as string;
  const file = flags['message-file'] as string;
  return file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/;

function normaliseOffset(off: string): string {
  if (off === 'Z' || off.includes(':')) return off;
  return off.slice(0, 3) + ':' + off.slice(3);
}

function parseExplicitDate(value: string, tz: string): number {
  const m = DATE_RE.exec(value);
  if (!m) throw new UsageError('--date: not a recognised date (expected YYYY-MM-DDTHH:MM[:SS][Z|+HH:MM], or \'auto\')');
  const [, Y, Mo, D, H, Mi, S, Off] = m;
  const ss = S ? parseInt(S, 10) : 0;
  if (Off) {
    const iso = Y + '-' + Mo + '-' + D + 'T' + H + ':' + Mi + ':' + String(ss).padStart(2, '0') + normaliseOffset(Off);
    const t = Date.parse(iso);
    if (Number.isNaN(t)) throw new UsageError('--date: not a recognised date: ' + value);
    return Math.floor(t / 1000);
  }
  return epochForZonedWallClock(parseInt(Y, 10), parseInt(Mo, 10), parseInt(D, 10), parseInt(H, 10), parseInt(Mi, 10), ss, tz);
}

/** Resolves --date (required: an explicit timestamp or 'auto') against the
 * policy's forbidden windows and, when `lowerExclusive` is not null, the
 * requirement that the chosen instant comes strictly after it (the
 * parent's/target's own committer date). 'auto': the latest allowed minute
 * <= now; refuses, naming the next allowed start, if none exists in range. */
function resolveDate(flags: Flags, policy: Policy, env: Env, lowerExclusive: number | null, lowerLabel: string): number {
  const raw = flags.date as string | undefined;
  if (raw === undefined) throw new UsageError('missing --date (an explicit date, or \'auto\')');
  if (raw === 'auto') {
    const now = nowSeconds(env);
    const lower = lowerExclusive === null ? -Infinity : lowerExclusive;
    const found = latestAllowedMinuteAtOrBefore(now, lower, policy);
    if (found === null) {
      const next = nextAllowedMinuteAfter(Math.max(now, lower), policy);
      if (next === null) {
        throw new Refusal('no allowed minute between ' + lowerLabel + ' committer date and now, and none found ' +
          'within 14 days afterward either -- check forbiddenWindows');
      }
      throw new Refusal('no allowed minute between ' + lowerLabel + ' committer date and now -- next allowed minute is ' +
        formatZoned(next, policy.timezone));
    }
    return found;
  }
  const epoch = parseExplicitDate(raw, policy.timezone);
  if (isForbiddenInstant(epoch, policy)) {
    throw new Refusal('--date ' + formatZoned(epoch, policy.timezone) + ' falls in a forbidden window');
  }
  if (lowerExclusive !== null && epoch <= lowerExclusive) {
    throw new Refusal('--date ' + formatZoned(epoch, policy.timezone) +
      ' is not after ' + lowerLabel + ' committer date (' + formatZoned(lowerExclusive, policy.timezone) + ')');
  }
  return epoch;
}

function committerDateEpoch(repo: string, env: Env, rev: string): number {
  const raw = git.text(repo, ['log', '-1', '--format=%cd', '--date=raw', rev], { env });
  return parseInt(raw.split(' ')[0], 10);
}

function dryRunReport(policy: Policy, chosenEpoch: number, signTime: number): string[] {
  return [
    'sign: identity ' + policy.identity.name + ' <' + policy.identity.email + '>',
    'sign: date ' + formatZoned(chosenEpoch, policy.timezone),
    'sign: key ' + policy.signingKey,
    'sign: signature time ' + formatZoned(signTime, policy.timezone),
  ];
}

/* ------------------------------------------------------------- commit --- */

function parentForMode(repo: string, env: Env, amend: boolean): string | null {
  const headExists = git.run(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'], { env }).status === 0;
  if (amend) {
    if (!headExists) throw new Refusal('--amend: no HEAD commit to amend');
    const r = git.run(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^'], { env });
    return r.status === 0 ? (r.stdout as string).replace(/\n$/, '') : null;
  }
  return headExists ? git.text(repo, ['rev-parse', 'HEAD'], { env }) : null;
}

function cmdCommit(bin: string, args: string[]): void {
  const { positional, flags } = parseFlags(args, {
    valueFlags: ['--message', '--message-file', '--date', '--policy'], boolFlags: ['--amend', '--apply'],
  });
  const repo = positional[0];
  if (!repo) throw new UsageError('missing <repo>');
  if (positional.length > 1) throw new UsageError('unexpected argument: ' + positional[1]);
  requireRepo(repo);
  const { policy, gpgProgram, env } = policyContext(repo, flags);
  const message = resolveMessage(flags);
  const matched = matchForbiddenPattern(message, policy);
  if (matched) throw new Refusal('message matches forbidden pattern: ' + matched);

  const amend = !!flags.amend;
  const parent = parentForMode(repo, env, amend);
  const lowerExclusive = parent === null ? null : committerDateEpoch(repo, env, parent);
  const chosenEpoch = resolveDate(flags, policy, env, lowerExclusive, 'the parent\'s');

  const created = keyCreationTime(gpgProgram, policy.signingKey, env);
  const signTime = signTimeFor(chosenEpoch, policy, created);
  const report = dryRunReport(policy, chosenEpoch, signTime);

  if (!flags.apply) {
    process.stdout.write(report.map((l) => l + '\n').join(''));
    process.stdout.write(bin + ': dry run, nothing committed (use --apply to write)\n');
    return;
  }

  const signer = createSigner(repo, env, { signingKey: policy.signingKey, signTime, gpgProgram });
  let tmp: TmpMsg | undefined;
  try {
    tmp = writeTmpMsg(message);
    const dateStr = gitDateAt(chosenEpoch, policy.timezone);
    /* --amend otherwise silently keeps the ORIGINAL commit's author name/
     * email/date, ignoring GIT_AUTHOR_* env vars entirely for that one
     * purpose (committer identity/date has no such special case, env vars
     * alone are enough) -- --author/--date passed explicitly on the
     * command line are what actually override it. Harmless, redundant
     * with the env vars below, for a plain (non-amend) commit. */
    const commitArgs = ['commit', '-S', '--date=' + dateStr,
      '--author=' + policy.identity.name + ' <' + policy.identity.email + '>', '-F', tmp.path];
    if (amend) commitArgs.push('--amend');
    const r = git.run(repo, commitArgs, {
      env: Object.assign({}, env, {
        GIT_AUTHOR_NAME: policy.identity.name, GIT_AUTHOR_EMAIL: policy.identity.email, GIT_AUTHOR_DATE: dateStr,
        GIT_COMMITTER_NAME: policy.identity.name, GIT_COMMITTER_EMAIL: policy.identity.email, GIT_COMMITTER_DATE: dateStr,
      }),
      config: signer.gitConfig,
    });
    if (r.status !== 0) throw new Refusal('git commit failed: ' + (r.stderr as string).trim().split('\n')[0]);
    const sha = git.text(repo, ['rev-parse', '--short', 'HEAD'], { env });
    process.stdout.write(report.map((l) => l + '\n').join(''));
    process.stdout.write('sign: commit ' + sha + '\n');
  } finally {
    signer.cleanup();
    if (tmp) tmp.cleanup();
  }
}

/* ---------------------------------------------------------------- tag --- */

function cmdTag(bin: string, args: string[]): void {
  const { positional, flags } = parseFlags(args, {
    valueFlags: ['--message', '--message-file', '--date', '--policy'], boolFlags: ['--apply'],
  });
  const repo = positional[0];
  const tagName = positional[1];
  if (!repo) throw new UsageError('missing <repo>');
  if (!tagName) throw new UsageError('missing <tag>');
  if (positional.length > 2) throw new UsageError('unexpected argument: ' + positional[2]);
  requireRepo(repo);
  const { policy, gpgProgram, env } = policyContext(repo, flags);
  const message = resolveMessage(flags);
  const matched = matchForbiddenPattern(message, policy);
  if (matched) throw new Refusal('message matches forbidden pattern: ' + matched);

  const exists = git.run(repo, ['rev-parse', '--verify', '--quiet', 'refs/tags/' + tagName], { env }).status === 0;
  if (exists) throw new Refusal('tag ' + tagName + ' already exists -- use resign-tags to re-sign it');

  const headExists = git.run(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'], { env }).status === 0;
  if (!headExists) throw new Refusal('no HEAD commit to tag');
  const target = git.text(repo, ['rev-parse', 'HEAD'], { env });
  const lowerExclusive = committerDateEpoch(repo, env, target);
  const chosenEpoch = resolveDate(flags, policy, env, lowerExclusive, 'the target\'s');

  const created = keyCreationTime(gpgProgram, policy.signingKey, env);
  const signTime = signTimeFor(chosenEpoch, policy, created);
  const report = dryRunReport(policy, chosenEpoch, signTime);

  if (!flags.apply) {
    process.stdout.write(report.map((l) => l + '\n').join(''));
    process.stdout.write(bin + ': dry run, no ref changed (use --apply to write)\n');
    return;
  }

  const signer = createSigner(repo, env, { signingKey: policy.signingKey, signTime, gpgProgram });
  let tmp: TmpMsg | undefined;
  try {
    tmp = writeTmpMsg(message);
    const dateStr = gitDateAt(chosenEpoch, policy.timezone);
    const r = git.run(repo, ['tag', '-s', '-F', tmp.path, tagName, target], {
      env: Object.assign({}, env, {
        GIT_COMMITTER_NAME: policy.identity.name, GIT_COMMITTER_EMAIL: policy.identity.email, GIT_COMMITTER_DATE: dateStr,
      }),
      config: signer.gitConfig,
    });
    if (r.status !== 0) throw new Refusal('git tag failed: ' + (r.stderr as string).trim().split('\n')[0]);
    process.stdout.write(report.map((l) => l + '\n').join(''));
    process.stdout.write('sign: tag ' + tagName + '\n');
  } finally {
    signer.cleanup();
    if (tmp) tmp.cleanup();
  }
}

/* --------------------------------------------------------- resign-tags --- */

function annotatedTags(repo: string, env: Env): AnnotatedRef[] {
  const out = git.text(repo,
    ['for-each-ref', '--format=%(refname:short)\t%(objecttype)\t%(objectname)\t%(*objectname)', 'refs/tags'], { env });
  if (!out) return [];
  return out.split('\n').map((l): AnnotatedRef => {
    const [name, type, obj, deref] = l.split('\t');
    return { name, type, obj, commit: type === 'tag' ? deref : obj };
  });
}

/* git.text() trims exactly one trailing newline off whatever it reads,
 * which would silently differ here depending on whether that trim lands
 * on the message's own last byte (an unsigned tag, nothing after it) or
 * well before the signature block (a signed one) -- cat-file's raw bytes,
 * via git.buffer(), sidestep that asymmetry entirely. */
function stripSignature(raw: Buffer): Buffer {
  /* latin1: a 1-byte-per-char decoding (0-255 only), so the offset
   * `tagSignatureBoundary` finds in the decoded string is exactly the
   * same byte offset in `raw` -- unlike utf8, which would shift offsets
   * for any multi-byte character in the tag's own message. */
  const { index } = tagSignatureBoundary(raw.toString('latin1'));
  return index === -1 ? raw : raw.subarray(0, index);
}

/** A tag's own message -- the raw object's bytes after the header's
 * blank-line separator, with any trailing signature block stripped --
 * NEVER `for-each-ref --format=%(contents)`, which for an ALREADY-SIGNED
 * tag includes the existing signature block as part of its own output
 * (git's own documented behavior, not a bug in git). Feeding that
 * straight back in as a NEW tag's message via `-F` embedded the OLD
 * signature as literal text inside the new message, which then received
 * a second, genuinely new signature appended right after it: a tag
 * object with two concatenated signature blocks (CRITICAL, found
 * resigning an already-signed tag -- D14 follow-up).
 *
 * Truncating at `tagSignatureBoundary`'s own boundary -- the backward
 * walk from EOF, never a bare "last marker anywhere" scan -- is what
 * makes this correct for a message that quotes an old signature block as
 * literal text (e.g. pasting a security advisory into a release tag's
 * own message) AND has further real text after the quote: the walk sees
 * nothing recognizable at EOF and reports no boundary at all, so none of
 * the message is lost. A bare `lastIndexOf` has no notion of "at EOF" and
 * happily returned the quote's own position as a false boundary,
 * silently dropping everything after it on every resign (HIGH,
 * Lead-found, D16 follow-up) -- and separately, the previous FIRST-marker
 * rule this itself had already replaced once cut the message short right
 * at the quote too, for the same underlying reason: neither of two
 * independent algorithms agreed with the one, true backward walk. The
 * REAL, currently-valid signature is always the end of that walk's
 * trailing stack, since `buildSignedTagObject`/`git tag -s` always
 * appends it last. */
function tagMessageFromRaw(raw: string): string {
  const idx = raw.indexOf('\n\n');
  const rest = idx === -1 ? '' : raw.slice(idx + 2);
  const { index: sigIdx } = tagSignatureBoundary(rest);
  return sigIdx === -1 ? rest : rest.slice(0, sigIdx);
}

/** The SAME question `tagMessageFromRaw` answers -- the message minus its
 * trailing signature, if any -- but via a regex anchored at the very end
 * of the string, never the line-by-line backward walk `tagSignatureBoundary`
 * uses, so that a bug in that ONE shared walk can't also hide inside the
 * check meant to catch it (D16/D18 follow-up, Lead-found: `cmdResignTags`'
 * own verify step used to compare two bodies BOTH produced by the same
 * function, so a boundary bug there truncated both sides identically and
 * still reported `OK`). `oldSigCount` is the caller's own, separately
 * computed `signatureBlockCount(raw, 'tag')` -- 1 means a real trailing
 * signature is almost certainly there (strip it, independently, with the
 * regex below); 0 (unsigned) or 2+ (corrupted) means there is nothing
 * safe to strip, so the independent answer is the whole message,
 * untouched, same as `tagSignatureBoundary` itself would say. */
function independentOldTagMessage(message: string, oldSigCount: number): string {
  if (oldSigCount !== 1) return message;
  /* The `(?:(?!-----END ...)[\s\S])*` middle refuses to cross ANY `END`
   * marker -- without it, a greedy (or lazy) `[\s\S]*` anchored at `$`
   * still matches starting from the EARLIEST `BEGIN` in the string
   * whenever a quoted block precedes the real one (regex search tries
   * the leftmost start position first, and either quantifier can still
   * reach `$` from there by crossing straight through the quote's own
   * `END`) -- exactly the "first marker" bug D16 fixed elsewhere,
   * silently reintroduced here if this constraint is dropped. Forcing
   * each candidate span to stay within a single, non-nested block means
   * the leftmost-start attempt fails whenever a quote precedes the real
   * signature (it can't reach $ without crossing the quote's own END),
   * so the engine advances to the true last BEGIN instead. */
  const m = /\n?(-----BEGIN (?:PGP|SSH) SIGNATURE-----\n(?:(?!-----END (?:PGP|SSH) SIGNATURE-----)[\s\S])*\n-----END (?:PGP|SSH) SIGNATURE-----\n?)$/
    .exec(message);
  return m ? message.slice(0, m.index) : message;
}

/** Signs `text` (a tag's own bytes, everything before the signature)
 * detached+armored, via the SAME gpg invocation `git tag -s` uses
 * internally (`-bsau <key>`) -- but through `signer.gpgProgram` directly
 * (the `--faked-system-time` wrapper `createSigner` already built), not
 * through any `git` command at all, so nothing here ever creates or
 * moves a ref. Refuses, naming gpg's own first stderr line, on failure. */
function signTagTextDetached(signer: Signer, env: Env, text: string): string {
  const r = spawnSync(signer.gpgProgram, ['--batch', '--status-fd=2', '-bsau', signer.signingKey], {
    env, input: text, encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Refusal('failed to sign tag object: ' + (r.stderr || '').trim().split('\n').pop());
  }
  return r.stdout;
}

/** Builds a brand new, fully signed tag object and writes it as a loose
 * object -- WITHOUT ever creating or moving any ref, unlike `git tag
 * -s`, which always does both in one step. (An earlier version of this
 * fix let `git tag -s`/`-f` create the object under its real name, which
 * incidentally moves the real ref too, then immediately reverted that
 * ref -- not actually atomic: a crash between the two steps leaves that
 * one ref moved, reviewer/Lead-found.) The tag's own text (object/type/
 * tag/tagger/blank line/message) is constructed directly from already-
 * parsed fields -- never from `git tag -s`'s own machinery, and never
 * from a previous signature's bytes (item 0: this is also what keeps a
 * resigned tag at exactly 1 signature block, the message here can never
 * contain stray signature material to begin with). Signed via
 * `signTagTextDetached` above, then written via `git hash-object -t tag
 * -w --stdin`, which -- like `commit-tree` for commits -- never touches
 * any ref either. Returns the new object's sha. */
function buildSignedTagObject(repo: string, env: Env, signer: Signer,
  args: { object: string; type: string; name: string; taggerLine: string; message: string }): string {
  const text = 'object ' + args.object + '\ntype ' + args.type + '\ntag ' + args.name +
    '\ntagger ' + args.taggerLine + '\n\n' + args.message;
  const sig = signTagTextDetached(signer, env, text);
  const full = text + sig;
  const r = git.run(repo, ['hash-object', '-t', 'tag', '-w', '--stdin'], { env, input: full });
  if (r.status !== 0) {
    throw new Refusal('resign: failed to write tag object for ' + args.name + ': ' + (r.stderr as string).trim().split('\n')[0]);
  }
  return (r.stdout as string).trim();
}

function cmdResignTags(bin: string, args: string[]): void {
  const { positional, flags } = parseFlags(args, { valueFlags: ['--policy'], boolFlags: ['--apply'] });
  const repo = positional[0];
  if (!repo) throw new UsageError('missing <repo>');
  requireRepo(repo);
  const { policy, gpgProgram, env } = policyContext(repo, flags);
  const explicitNames = positional.slice(1);
  const all = annotatedTags(repo, env);
  const byName = new Map(all.map((t) => [t.name, t] as const));

  const candidates: AnnotatedRef[] = [];
  const skippedLightweight: string[] = [];
  if (explicitNames.length > 0) {
    for (const n of explicitNames) {
      const t = byName.get(n);
      if (!t) throw new UsageError('no such tag: ' + n);
      if (t.type !== 'tag') { skippedLightweight.push(n); continue; }
      candidates.push(t);
    }
  } else {
    for (const t of all) {
      if (t.type !== 'tag') { skippedLightweight.push(t.name); continue; }
      const fp = verifiedKeyFingerprint(repo, env, 'tag', t.name);
      if (!keyMatches(policy.signingKey, fp)) candidates.push(t);
    }
  }

  const lines: string[] = [];
  for (const n of skippedLightweight) lines.push('resign-tags: ' + n + ' is lightweight, skipped');

  if (candidates.length === 0) {
    process.stdout.write(lines.map((l) => l + '\n').join(''));
    process.stdout.write(bin + ': nothing to resign\n');
    return;
  }

  if (!flags.apply) {
    for (const t of candidates) {
      lines.push('resign-tags: ' + t.name + ' would be re-signed');
      const hasSig = extractSignature(repo, env, 'tag', t.name) !== null;
      const status = signatureStatus(repo, env, 'tag', t.name, hasSig, policy.signingKey);
      const key = unverifiableKeyLabel(status);
      if (key) lines.push('resign-tags: ' + t.name + ' would replace unverifiable signature (key ' + key + ')');
    }
    process.stdout.write(lines.map((l) => l + '\n').join(''));
    process.stdout.write(bin + ': dry run, no ref changed (use --apply to write)\n');
    return;
  }

  createBackupBundle(repo, env);
  const results: { name: string; oldSha: string; newSha: string; independentOldMsg: string }[] = [];
  {
    /* Every new tag object is built via `buildSignedTagObject` --
     * signed directly, written via `git hash-object -w`, which (like
     * `commit-tree` for commits) never creates or moves ANY ref -- then
     * every real tag move happens together in ONE `update-ref --stdin`
     * transaction below, each old value checked. A failure building any
     * object means the transaction is never reached: nothing moves, not
     * even a tag processed earlier in this same loop (HIGH fix,
     * reviewer-found, same pattern as resign-commits).
     *
     * An earlier version of this fix let `git tag -f -s` create the
     * object under its REAL name (which also moves the real ref as a
     * side effect, `git tag -s` having no "write the object, don't
     * touch the ref" mode of its own), then immediately reverted that
     * ref -- not actually atomic: a crash between the two steps leaves
     * that one ref moved (Lead-found). `buildSignedTagObject` sidesteps
     * this: the ref is never touched at all until the transaction. */
    for (const t of candidates) {
      const oldSha = t.obj;
      /* git.buffer(), never git.text() -- the latter trims exactly one
       * trailing newline, which lands harmlessly in the (discarded)
       * signature tail for an already-signed tag but eats the
       * MESSAGE's own final newline for a never-signed one, corrupting
       * exactly the bytes `tagMessageFromRaw` is supposed to preserve. */
      const raw = git.buffer(repo, ['cat-file', '-p', oldSha], { env }).toString('utf8');
      const tm = /^tagger (.*) (\d+ [+-]\d{4})$/m.exec(raw)!;
      const taggerEpoch = parseInt(tm[2].split(' ')[0], 10);
      const msg = tagMessageFromRaw(raw);
      const oldSigCount = signatureBlockCount(raw, 'tag');
      const hasSig = oldSigCount === 1;
      const oldStatus = signatureStatus(repo, env, 'tag', t.name, hasSig, policy.signingKey);
      /* A tag whose text ends with a complete, well-formed signature
       * block but which gpg can neither verify NOR attribute to any key
       * at all (`bad` -- not `unknown-key`, which at least names a real
       * key id) is genuinely ambiguous from the object's bytes alone: it
       * is indistinguishable from an UNSIGNED tag whose MESSAGE simply
       * ends with a quoted block, nothing real after it (SPEC § 5.5, "if
       * one follows"). Guessing either way is wrong half the time, so
       * this refuses instead -- naming the tag -- rather than silently
       * stripping what might be the user's own real trailing message
       * text as if it were a signature to replace (Lead-found,
       * D16/D18 follow-up). */
      if (hasSig && oldStatus.state === 'bad') {
        throw new Refusal(t.name + ' ends with a signature-shaped block gpg cannot verify or ' +
          'attribute to any key -- indistinguishable from an unsigned tag whose message merely ends with a ' +
          'quoted block; refusing to guess, resolve manually');
      }
      const oldKey = unverifiableKeyLabel(oldStatus);
      if (oldKey) lines.push('resign-tags: ' + t.name + ' replaced unverifiable signature (key ' + oldKey + ')');
      const headerEnd = raw.indexOf('\n\n');
      const rawMessagePart = headerEnd === -1 ? '' : raw.slice(headerEnd + 2);
      const independentOldMsg = independentOldTagMessage(rawMessagePart, oldSigCount);
      const created = keyCreationTime(gpgProgram, policy.signingKey, env);
      const signTime = signTimeFor(taggerEpoch, policy, created);
      const signer = createSigner(repo, env, { signingKey: policy.signingKey, signTime, gpgProgram });
      let newSha: string;
      try {
        newSha = buildSignedTagObject(repo, env, signer, {
          object: t.commit, type: 'commit', name: t.name, taggerLine: tm[1] + ' ' + tm[2], message: msg,
        });
      } finally {
        signer.cleanup();
      }
      results.push({ name: t.name, oldSha, newSha, independentOldMsg });
    }

    const stdinLines: string[] = ['start'];
    for (const r of results) stdinLines.push('update refs/tags/' + r.name + ' ' + r.newSha + ' ' + r.oldSha);
    stdinLines.push('prepare', 'commit');
    const txn = git.run(repo, ['update-ref', '--stdin'], { env, input: stdinLines.join('\n') + '\n' });
    if (txn.status !== 0) {
      throw new Refusal('ref update transaction failed: ' + (txn.stderr as string).trim().split('\n')[0]);
    }

    let allOk = true;
    for (const r of results) {
      const newTarget = git.text(repo, ['rev-parse', r.newSha + '^{commit}'], { env });
      const oldTarget = git.text(repo, ['rev-parse', r.oldSha + '^{commit}'], { env });
      const sameTarget = newTarget === oldTarget;
      const oldBody = stripSignature(git.buffer(repo, ['cat-file', '-p', r.oldSha], { env }));
      const newRawBuf = git.buffer(repo, ['cat-file', '-p', r.newSha], { env });
      const newBody = stripSignature(newRawBuf);
      const bodyOk = oldBody.equals(newBody);
      const newRaw = newRawBuf.toString('utf8');
      /* Exactly 1 signature block, never 0 or 2+ -- the defensive guard
       * that would have caught the %(contents) bug above on its own:
       * `bodyOk` (truncates at the FIRST marker on both sides) and
       * `git tag -v` (happily verifies the first of several blocks) both
       * missed a tag object corrupted with two concatenated signatures. */
      const sigBlocksOk = signatureBlockCount(newRaw, 'tag') === 1;
      /* `bodyOk` above and this both ultimately reach the message via
       * `tagMessageFromRaw`/`stripSignature` -- the SAME backward walk --
       * so a bug in that one walk would truncate both the old and the
       * new side identically and still pass `bodyOk`. This instead
       * compares the NEW message (extracted the normal way; the new
       * object has exactly one real trailing signature by construction,
       * nothing ambiguous about it) against `independentOldMsg`, computed
       * back when `r` was built via a completely different, regex-based
       * method (`independentOldTagMessage`) that cannot share the same
       * bug (D16/D18 follow-up, Lead-found). */
      /* Trailing-newline COUNT right at the message/signature boundary is
       * not meaningful content -- both extractions agree on every actual
       * character of the message, but can legitimately attribute a
       * different number of the blank line's own newlines to "message"
       * vs "separator" (the walk includes them in the message, up to the
       * boundary LINE; the regex's own `\n?` can consume one of them as
       * part of the separator it skips). Trimming trailing newlines
       * before comparing catches real content loss (the repro: whole
       * sentences gone) without false-failing on that harmless wrinkle. */
      const messageIndependentOk =
        tagMessageFromRaw(newRaw).replace(/\n*$/, '') === r.independentOldMsg.replace(/\n*$/, '');
      const verifyOk = git.run(repo, ['tag', '-v', r.name], { env }).status === 0;
      const ok = sameTarget && bodyOk && sigBlocksOk && messageIndependentOk && verifyOk;
      if (!ok) allOk = false;
      lines.push('verify: ' + r.name + ': ' + (ok ? 'OK' :
        'FAILED (' + (!sameTarget ? 'target changed' : !bodyOk || !messageIndependentOk ? 'tagger/message changed' :
          !sigBlocksOk ? 'multiple-signatures' : 'signature not accepted') + ')'));
    }
    /* An unchanged sha (a deterministic signature scheme such as EdDSA,
     * re-signing at the same signing time, yields the identical object)
     * moved nothing, so it gets no push hint. */
    for (const r of results) {
      lines.push('resign-tags: ' + r.name + ' ' + r.oldSha + ' -> ' + r.newSha + (r.oldSha === r.newSha ? ' (unchanged)' : ''));
    }
    for (const r of results) {
      if (r.oldSha === r.newSha) continue;
      lines.push('# git push --force-with-lease=refs/tags/' + r.name + ':' + r.oldSha + ' <remote> refs/tags/' + r.name);
    }
    process.stdout.write(lines.map((l) => l + '\n').join(''));
    process.exitCode = allOk ? 0 : 1;
  }
}

/* --------------------------------------------------------------- check --- */

/** `missing`/`bad`/`unknown-key`/`wrong-key` -> the exact wording `check`
 * prints for the `signature` rule (§ 5.4) -- distinct enough that the
 * several old nanojira tags hitting each case are individually
 * diagnosable from `check`'s own output, not lumped into one generic
 * "missing or invalid". */
function signatureDetail(status: { state: string; keyid?: string; fingerprint?: string }): string {
  if (status.state === 'missing') return 'missing';
  if (status.state === 'unknown-key') return 'signed by unknown key ' + status.keyid + ' (not in keyring)';
  if (status.state === 'wrong-key') return 'good signature but by ' + status.fingerprint + ', not the policy key';
  return 'bad signature';
}

/** `resign-tags`/`resign-commits` unconditionally overwrite any existing
 * signature regardless of its own validity, but a signature that cannot
 * be verified at all because the key that made it is not in this keyring
 * (NO_PUBKEY) is worth calling out explicitly when it is replaced -- the
 * old key id it was signed with would otherwise be silently lost with no
 * record anywhere that it used to be signed by something else entirely
 * (Lead-found, dogfooding against nanojira's own pre-326fc528 history,
 * signed by a since-discarded key). Not 'wrong-key' (a different, already
 * cryptographically GOOD signature -- not "unverifiable", just not the
 * policy key) and not 'bad' (no key id to name at all) -- only the one
 * case Lead named: "an existing signature it cannot verify (no public
 * key)". */
function unverifiableKeyLabel(status: { state: string; keyid?: string }): string | null {
  return status.state === 'unknown-key' ? status.keyid! : null;
}

/** The sig-time rule for a signature `signatureStatus` already reports as
 * `ok`: a present signature whose creation time cannot be parsed is a
 * violation in its own right ("unreadable"), never silently treated as a
 * pass -- the exact gap that let a real leaked signature time (nanojira
 * c8d5657) through `check` silently (D9: the original regex matched a
 * human-readable date and truncated it to a wrong-but-present epoch; a
 * later, more careful regex could just as easily find nothing at all for
 * some other malformed signature, and null must still fail closed).
 *
 * `anonymous` (the object's own date -- committer for a commit, tagger for
 * a tag -- is exempt per `isExemptAnonymousDate`, § 5.0/D9/D10): the
 * forbidden-window rule does NOT apply, because by construction the
 * signature on an anonymised object is always pinned to `key creation +
 * 60s` (D1), never to a real time -- that pin itself reveals nothing a
 * public key doesn't already reveal. Instead the signature time must equal
 * that pin EXACTLY; anything else (including a real workday instant) is a
 * violation in its own right, named separately from "falls in a forbidden
 * window" since the failure mode is different (not a leaked work time, but
 * a signature that was never pinned the way D1 requires at all). */
function sigTimeViolation(label: string, sig: string, policy: Policy, gpgProgram: string, env: Env, anonymous: boolean): string | null {
  const st = signatureCreationTime(gpgProgram, env, sig);
  if (st === null) return label + ' sig-time signature creation time could not be read';
  if (anonymous) {
    const expected = keyCreationTime(gpgProgram, policy.signingKey, env) + 60;
    if (st !== expected) {
      return label + ' sig-time anonymous object not signed at the pinned time (expected ' +
        formatZoned(expected, policy.timezone) + ', got ' + formatZoned(st, policy.timezone) + ')';
    }
    return null;
  }
  if (isForbiddenInstant(st, policy)) return label + ' sig-time signature created ' + formatZoned(st, policy.timezone) + ' falls in a forbidden window';
  return null;
}

function checkOneCommit(repo: string, env: Env, sha: string, policy: Policy, gpgProgram: string): string[] {
  const out: string[] = [];
  const short = git.text(repo, ['rev-parse', '--short', sha], { env });
  const raw = git.text(repo, ['cat-file', 'commit', sha], { env });
  const am = /^author (.*) (\d+) [+-]\d{4}$/m.exec(raw);
  const cm = /^committer (.*) (\d+) [+-]\d{4}$/m.exec(raw);
  if (am) {
    const a = splitIdent(am[1]);
    if (a.name !== policy.identity.name || a.email !== policy.identity.email) {
      out.push(short + ' identity author is ' + am[1] + ', not the policy identity');
    }
    const t = parseInt(am[2], 10);
    if (!isExemptAnonymousDate(t, policy) && isForbiddenInstant(t, policy)) {
      out.push(short + ' date author date ' + formatZoned(t, policy.timezone) + ' falls in a forbidden window');
    }
  }
  let committerEpoch: number | null = null;
  if (cm) {
    const c = splitIdent(cm[1]);
    if (c.name !== policy.identity.name || c.email !== policy.identity.email) {
      out.push(short + ' identity committer is ' + cm[1] + ', not the policy identity');
    }
    committerEpoch = parseInt(cm[2], 10);
    if (!isExemptAnonymousDate(committerEpoch, policy) && isForbiddenInstant(committerEpoch, policy)) {
      out.push(short + ' date committer date ' + formatZoned(committerEpoch, policy.timezone) + ' falls in a forbidden window');
    }
  }
  const sigBlocks = signatureBlockCount(raw, 'commit');
  if (sigBlocks > 1) {
    out.push(short + ' signature multiple-signatures (' + sigBlocks + ' signature blocks found)');
  } else {
    const sig = extractSignature(repo, env, 'commit', sha);
    const status = signatureStatus(repo, env, 'commit', sha, sig !== null, policy.signingKey);
    if (status.state !== 'ok') {
      out.push(short + ' signature ' + signatureDetail(status));
    } else if (sig) {
      const anonymous = committerEpoch !== null && isExemptAnonymousDate(committerEpoch, policy);
      const v = sigTimeViolation(short, sig, policy, gpgProgram, env, anonymous);
      if (v) out.push(v);
    }
  }
  const msg = git.text(repo, ['log', '-1', '--format=%B', sha], { env });
  const matched = matchForbiddenPattern(msg, policy);
  if (matched) out.push(short + ' message matches forbidden pattern: ' + matched);
  return out;
}

function checkOneTag(repo: string, env: Env, t: AnnotatedRef, policy: Policy, gpgProgram: string): string[] {
  const out: string[] = [];
  /* git.buffer(), never git.text() -- see the identical comment in
   * cmdResignTags; `tagMessageFromRaw` below needs the message's own
   * exact trailing newline for a never-signed tag. */
  const raw = git.buffer(repo, ['cat-file', 'tag', t.obj], { env }).toString('utf8');
  const tm = /^tagger (.*) (\d+) [+-]\d{4}$/m.exec(raw);
  if (tm) {
    const ident = splitIdent(tm[1]);
    if (ident.name !== policy.identity.name || ident.email !== policy.identity.email) {
      out.push(t.name + ' identity tagger is ' + tm[1] + ', not the policy identity');
    }
    const when = parseInt(tm[2], 10);
    if (!isExemptAnonymousDate(when, policy) && isForbiddenInstant(when, policy)) {
      out.push(t.name + ' date tagger date ' + formatZoned(when, policy.timezone) + ' falls in a forbidden window');
    }
  }
  const sigBlocks = signatureBlockCount(raw, 'tag');
  if (sigBlocks > 1) {
    out.push(t.name + ' signature multiple-signatures (' + sigBlocks + ' signature blocks found)');
  } else {
    const sig = extractSignature(repo, env, 'tag', t.obj);
    const status = signatureStatus(repo, env, 'tag', t.name, sig !== null, policy.signingKey);
    if (status.state !== 'ok') {
      out.push(t.name + ' signature ' + signatureDetail(status));
    } else if (sig) {
      const taggerEpoch = tm ? parseInt(tm[2], 10) : null;
      const anonymous = taggerEpoch !== null && isExemptAnonymousDate(taggerEpoch, policy);
      const v = sigTimeViolation(t.name, sig, policy, gpgProgram, env, anonymous);
      if (v) out.push(v);
    }
  }
  const msg = tagMessageFromRaw(raw);
  const matched = matchForbiddenPattern(msg, policy);
  if (matched) out.push(t.name + ' message matches forbidden pattern: ' + matched);
  return out;
}

/** exit 0 clean / 1 violations found -- a deliberate exception to "nothing
 * on stdout on exit 1" (§ 0): the violation lines ARE the point of `check`,
 * this is the pre-push gate every agent runs, and a silent exit 1 would be
 * useless here. **(decision)** */
function cmdCheck(bin: string, args: string[]): void {
  const { positional, flags } = parseFlags(args, { valueFlags: ['--range', '--policy'], boolFlags: ['--tags'] });
  const repo = positional[0];
  if (!repo) throw new UsageError('missing <repo>');
  if (positional.length > 2) throw new UsageError('unexpected argument: ' + positional[2]);
  const positionalRange = positional[1];
  if (positionalRange !== undefined && flags.range !== undefined) {
    throw new UsageError('give the revision range either positionally or as --range, not both');
  }
  requireRepo(repo);
  const { policy, gpgProgram, env } = policyContext(repo, flags);

  let range = positionalRange !== undefined ? positionalRange : (flags.range as string | undefined);
  if (range === undefined) {
    const up = git.run(repo, ['rev-parse', '--verify', '--quiet', '@{upstream}'], { env });
    if (up.status !== 0) throw new Refusal('no upstream configured for HEAD -- pass --range explicitly (or as a positional argument)');
    range = '@{upstream}..HEAD';
  }

  const commits = resolveRevList(repo, env, ['--reverse', range], range);

  const lines: string[] = [];
  for (const c of commits) lines.push(...checkOneCommit(repo, env, c, policy, gpgProgram));

  let tagCount = 0;
  if (flags.tags) {
    for (const t of annotatedTags(repo, env)) {
      if (t.type !== 'tag') continue;
      tagCount++;
      lines.push(...checkOneTag(repo, env, t, policy, gpgProgram));
    }
  }

  for (const l of lines) process.stdout.write(l + '\n');
  process.stdout.write('check: ' + lines.length + ' violation(s) across ' + commits.length + ' commit(s)' +
    (flags.tags ? ' and ' + tagCount + ' tag(s)' : '') + '\n');
  process.exitCode = lines.length > 0 ? 1 : 0;
}

/* -------------------------------------------------------- resign-commits --- */

interface ParsedCommit {
  sha: string;
  tree: string;
  parents: string[];
  authorIdent: { name: string; email: string };
  authorDate: string;
  committerIdent: { name: string; email: string };
  committerDate: string;
  committerEpoch: number;
}

/** Parses the one commit `sha` needs re-signed: tree, parent(s), and the
 * author/committer identity+date exactly as recorded (as a git date string,
 * `@<epoch> <offset>`, carrying the ORIGINAL recorded offset byte-for-byte
 * -- never recomputed from `policy.timezone`, which need not match the
 * offset the commit itself was made under). Refuses (not an uncaught
 * exception) on a merge commit (more than one parent) or a structurally
 * unparseable commit, naming the sha either way. */
function parseCommitForResign(repo: string, env: Env, sha: string): ParsedCommit {
  const raw = git.text(repo, ['cat-file', 'commit', sha], { env });
  const treeM = /^tree ([0-9a-f]{40})$/m.exec(raw);
  if (!treeM) throw new Refusal(sha.slice(0, 7) + ': malformed commit, no tree line');
  const parents: string[] = [];
  const parentRe = /^parent ([0-9a-f]{40})$/mg;
  let pm: RegExpExecArray | null;
  while ((pm = parentRe.exec(raw))) parents.push(pm[1]);
  if (parents.length > 1) throw new Refusal('merge commits are not supported (' + sha.slice(0, 7) + ')');
  const am = /^author (.*) (\d+) ([+-]\d{4})$/m.exec(raw);
  const cm = /^committer (.*) (\d+) ([+-]\d{4})$/m.exec(raw);
  if (!am || !cm) throw new Refusal(sha.slice(0, 7) + ': malformed commit, missing author/committer line');
  return {
    sha, tree: treeM[1], parents,
    authorIdent: splitIdent(am[1]), authorDate: '@' + am[2] + ' ' + am[3],
    committerIdent: splitIdent(cm[1]), committerDate: '@' + cm[2] + ' ' + cm[3],
    committerEpoch: parseInt(cm[2], 10),
  };
}

/** The exact message bytes following a commit's headers -- read as a raw
 * Buffer (not `git.text`, which trims a trailing newline) so the new
 * commit's message, fed back verbatim via `commit-tree`'s stdin, is
 * byte-identical to the original's, not merely equal modulo one newline. */
function commitMessageBytes(repo: string, env: Env, sha: string): Buffer {
  const raw = git.buffer(repo, ['cat-file', 'commit', sha], { env });
  const idx = raw.indexOf('\n\n');
  return idx === -1 ? Buffer.alloc(0) : raw.subarray(idx + 2);
}

/** A raw commit object's headers with every `parent `/`gpgsig ` (+ its
 * folded continuation lines) line removed, plus its message -- what two
 * commits across a re-sign must be byte-identical on, since only the
 * parent(s) and the signature are allowed to differ (§ 5.5). */
function headersMinusParentsAndSig(raw: Buffer): Buffer {
  const text = raw.toString('utf8');
  const messageIdx = text.indexOf('\n\n');
  const headerText = messageIdx === -1 ? text : text.slice(0, messageIdx);
  const message = messageIdx === -1 ? '' : text.slice(messageIdx);
  const lines = headerText.split('\n');
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('parent ')) { i++; continue; }
    if (l.startsWith('gpgsig ') || l.startsWith('gpgsig-sha256 ')) {
      i++;
      while (i < lines.length && lines[i].startsWith(' ')) i++;
      continue;
    }
    kept.push(l);
    i++;
  }
  return Buffer.from(kept.join('\n') + message, 'utf8');
}

function verifyHeadersPreserved(repo: string, env: Env, pairs: { old: string; nw: string }[]): verify.VerifyResult {
  for (const p of pairs) {
    const oldRaw = git.buffer(repo, ['cat-file', 'commit', p.old], { env });
    const newRaw = git.buffer(repo, ['cat-file', 'commit', p.nw], { env });
    if (!headersMinusParentsAndSig(oldRaw).equals(headersMinusParentsAndSig(newRaw))) {
      return { ok: false, line: 'verify: resign-commits: headers preserved: FAILED (' +
        p.old.slice(0, 7) + ' -> ' + p.nw.slice(0, 7) + ' differs beyond parent/signature)' };
    }
  }
  return { ok: true, line: 'verify: resign-commits: headers preserved: OK' };
}

function verifyParentsMapped(repo: string, env: Env, pairs: { old: string; nw: string }[], parsed: ParsedCommit[]): verify.VerifyResult {
  const parentsByOld = new Map(parsed.map((p) => [p.sha, p.parents] as const));
  const oldToNew = new Map(pairs.map((p) => [p.old, p.nw] as const));
  for (const p of pairs) {
    const oldParents = parentsByOld.get(p.old) || [];
    const expected = oldParents.length === 0 ? null : (oldToNew.get(oldParents[0]) || oldParents[0]);
    const newRaw = git.text(repo, ['cat-file', 'commit', p.nw], { env });
    const pm = /^parent ([0-9a-f]{40})$/m.exec(newRaw);
    const actual = pm ? pm[1] : null;
    if (actual !== expected) {
      return { ok: false, line: 'verify: resign-commits: parents mapped: FAILED (' + p.old.slice(0, 7) + ' -> ' +
        p.nw.slice(0, 7) + ': expected parent ' + expected + ', got ' + actual + ')' };
    }
  }
  return { ok: true, line: 'verify: resign-commits: parents mapped: OK' };
}

/** 0 `signature`/`sig-time` violations on the rewritten commits and tags --
 * reuses `check`'s own `checkOneCommit`/`checkOneTag` against the NEW shas,
 * already written to the repo by this point in `--apply`, filtering for
 * just the two rules a re-sign could possibly get wrong (identity/date/
 * message are untouched by a re-sign, so re-checking them here would only
 * re-verify something this command never had the power to break). */
function verifyNewSignatures(repo: string, env: Env, gpgProgram: string, policy: Policy,
  pairs: { nw: string }[], movedTagNames: Set<string>): verify.VerifyResult {
  const bad: string[] = [];
  for (const p of pairs) {
    for (const l of checkOneCommit(repo, env, p.nw, policy, gpgProgram)) {
      if (/ (signature|sig-time) /.test(l)) bad.push(l);
    }
  }
  for (const t of annotatedTags(repo, env)) {
    if (t.type !== 'tag' || !movedTagNames.has(t.name)) continue;
    for (const l of checkOneTag(repo, env, t, policy, gpgProgram)) {
      if (/ (signature|sig-time) /.test(l)) bad.push(l);
    }
  }
  if (bad.length > 0) {
    return { ok: false, line: 'verify: resign-commits: check (signature/sig-time): FAILED (' +
      bad[0] + (bad.length > 1 ? '; +' + (bad.length - 1) + ' more' : '') + ')' };
  }
  return { ok: true, line: 'verify: resign-commits: check (signature/sig-time): OK' };
}

function checkMapOutOutsideRepo(repo: string, filePath: string): void {
  const abs = path.resolve(filePath);
  const realRepo = fs.realpathSync(repo);
  const parentDir = path.dirname(abs);
  let realParent: string;
  try { realParent = fs.realpathSync(parentDir); } catch (e) { throw new UsageError('--map-out: directory does not exist: ' + parentDir); }
  const realFileShallow = path.join(realParent, path.basename(abs));
  if (isInsideRepo(realRepo, realFileShallow)) throw new Refusal('--map-out points inside the repo (' + filePath + ') -- keep it outside');
}

function cmdResignCommits(bin: string, args: string[]): void {
  const { positional, flags } = parseFlags(args, { valueFlags: ['--policy', '--map-out'], boolFlags: ['--apply', '--from-root'] });
  const repo = positional[0];
  const range = positional[1];
  if (!repo) throw new UsageError('missing <repo>');
  if (!range) throw new UsageError('missing <range>');
  if (positional.length > 2) throw new UsageError('unexpected argument: ' + positional[2]);

  /* The range's shape is a CLI question (usage error, exit 2), answered
   * before the repo or the policy is even looked at. */
  if (range.includes('...')) throw new UsageError('<range> must be \'<lower>..<upper>\' (two dots, not three)');
  const dotdot = range.indexOf('..');
  /* No `..` at all: <range> is a bare `<upper>`, meaning "every ancestor
   * of <upper>, root commit included" -- there is no earlier commit to
   * name as a lower bound for the very first commit in a history, so
   * `<lower>..<upper>` has no way to express "from the root". `lowerSha`
   * stays null throughout; R0 and the candidate walk below both already
   * degrade correctly to "no exclusion" when it is. Because `main` or
   * `HEAD~3` reads like "that commit" or "the last few", the bare form
   * re-signs the whole history only with an explicit `--from-root`. */
  const lower = dotdot === -1 ? null : range.slice(0, dotdot);
  const upper = dotdot === -1 ? range : range.slice(dotdot + 2);
  if (dotdot !== -1 && (!lower || !upper)) throw new UsageError('<range> must be \'<lower>..<upper>\'');
  if (!upper) throw new UsageError('<range> must be \'<lower>..<upper>\' or \'<rev> --from-root\'');
  const fromRoot = !!flags['from-root'];
  if (dotdot === -1 && !fromRoot) {
    throw new UsageError('\'' + range + '\' has no \'..\' -- that re-signs the whole history down to the root; ' +
      'pass --from-root if you mean that, or use <lower>..<upper>');
  }
  if (dotdot !== -1 && fromRoot) {
    throw new UsageError('--from-root takes a bare <rev>, not a range (\'' + range + '\')');
  }

  requireRepo(repo);
  const { policy, gpgProgram, env } = policyContext(repo, flags);

  if (flags['map-out'] !== undefined) checkMapOutOutsideRepo(repo, flags['map-out'] as string);

  let lowerSha: string | null = null;
  if (lower) {
    const lowerR = git.run(repo, ['rev-parse', '--verify', '--quiet', lower + '^{commit}'], { env });
    if (lowerR.status !== 0) throw new Refusal('invalid revision range \'' + range + '\'');
    lowerSha = (lowerR.stdout as string).replace(/\n$/, '');
  }
  const upperR = git.run(repo, ['rev-parse', '--verify', '--quiet', upper + '^{commit}'], { env });
  if (upperR.status !== 0) throw new Refusal('invalid revision range \'' + range + '\'');
  const upperSha = (upperR.stdout as string).replace(/\n$/, '');
  if (lowerSha) {
    const isAncestor = git.run(repo, ['merge-base', '--is-ancestor', lowerSha, upperSha], { env });
    if (isAncestor.status !== 0) {
      throw new Refusal('invalid revision range \'' + range + '\': ' + upper + ' is not a descendant of ' + lower);
    }
  }

  /* Every commit literally IN <range> (R0: `lower..upper`), AND every
   * descendant of one of those on any local branch/tag (not just
   * <upper>'s own branch) -- any such descendant also gets a new parent
   * hash and so must be rewritten too, exactly like git-release-squash's
   * "merge commits are not supported" scope.
   *
   * CRITICAL fix (reviewer-found): `--branches --tags ^lower` ALONE is
   * NOT "every descendant of lower" -- it is "everything NOT an ancestor
   * of lower", which also matches a branch with no relation to <range>
   * at all (an orphan branch, or a side branch forked at or before
   * <lower> that never merges back), silently re-signing and moving
   * commits/refs that have nothing to do with the requested range. The
   * fix: walk the candidate set (still `--branches --tags ^lower`, a
   * safe SUPERSET) in topological order, and mark a candidate for
   * rewrite only if it is actually in R0, or at least one of its real
   * parents has already been marked -- true transitive descendance from
   * R0, not mere non-ancestry of <lower>. An affected ref is then only
   * one whose tip actually ended up marked. */
  const inRange = new Set(resolveRevList(repo, env, [range], range));
  const candidateArgs = ['--topo-order', '--reverse', '--parents', '--branches', '--tags'];
  if (lowerSha) candidateArgs.push('^' + lowerSha);
  const candidateLines = resolveRevList(repo, env, candidateArgs, range);
  const rewriteSet = new Set<string>();
  const toRewrite: string[] = [];
  for (const line of candidateLines) {
    const [sha, ...parents] = line.split(' ');
    if (inRange.has(sha) || parents.some((p) => rewriteSet.has(p))) {
      rewriteSet.add(sha);
      toRewrite.push(sha);
    }
  }
  if (toRewrite.length === 0) throw new Refusal('nothing to resign in range \'' + range + '\'');

  const parsed = toRewrite.map((sha) => parseCommitForResign(repo, env, sha));
  for (const p of parsed) {
    if (p.authorIdent.name !== policy.identity.name || p.authorIdent.email !== policy.identity.email ||
      p.committerIdent.name !== policy.identity.name || p.committerIdent.email !== policy.identity.email) {
      throw new Refusal(p.sha.slice(0, 7) +
        ' author/committer is not the policy identity -- identities are never changed here');
    }
  }
  const branchesRaw = git.text(repo, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'], { env });
  const branches = branchesRaw ? branchesRaw.split('\n').map((l) => {
    const sp = l.indexOf(' ');
    return { name: l.slice(0, sp), sha: l.slice(sp + 1) };
  }) : [];
  const affectedBranches = branches.filter((b) => rewriteSet.has(b.sha));
  const affectedTags = annotatedTags(repo, env).filter((t) => rewriteSet.has(t.commit));

  if (!flags.apply) {
    if (fromRoot) process.stdout.write('resign-commits: root-inclusive: ' + toRewrite.length + ' commits\n');
    for (const sha of toRewrite) {
      process.stdout.write('resign-commits: ' + sha.slice(0, 7) + ' would be re-signed\n');
      const hasSig = extractSignature(repo, env, 'commit', sha) !== null;
      const status = signatureStatus(repo, env, 'commit', sha, hasSig, policy.signingKey);
      const key = unverifiableKeyLabel(status);
      if (key) process.stdout.write('resign-commits: ' + sha.slice(0, 7) + ' would replace unverifiable signature (key ' + key + ')\n');
    }
    for (const b of affectedBranches) process.stdout.write('resign-commits: branch ' + b.name + ' would move\n');
    for (const t of affectedTags) {
      process.stdout.write('resign-commits: tag ' + t.name + (t.type === 'tag' ? ' would be re-signed and moved' : ' would be moved') + '\n');
      if (t.type === 'tag') {
        const hasSig = extractSignature(repo, env, 'tag', t.name) !== null;
        const status = signatureStatus(repo, env, 'tag', t.name, hasSig, policy.signingKey);
        const key = unverifiableKeyLabel(status);
        if (key) process.stdout.write('resign-commits: tag ' + t.name + ' would replace unverifiable signature (key ' + key + ')\n');
      }
    }
    /* Unlike squash/tail's plan, the new shas are not shown -- there is no
     * no-write form of commit-tree -S (§ 5.1's rule, same reason): a dry
     * run here honestly cannot know a re-signed commit's own hash before
     * actually invoking gpg and writing the object. */
    process.stdout.write(bin + ': dry run, no ref changed, no objects written (use --apply to write)\n');
    return;
  }

  createBackupBundle(repo, env);
  const signers: { cleanup(): void }[] = [];
  const tmpFiles: TmpMsg[] = [];
  try {
    const oldToNew = new Map<string, string>();
    const pairs: { old: string; nw: string; origTree: string; newTree: string }[] = [];
    for (const p of parsed) {
      const hasSig = extractSignature(repo, env, 'commit', p.sha) !== null;
      const oldStatus = signatureStatus(repo, env, 'commit', p.sha, hasSig, policy.signingKey);
      const oldKey = unverifiableKeyLabel(oldStatus);
      if (oldKey) process.stdout.write('resign-commits: ' + p.sha.slice(0, 7) + ' replaced unverifiable signature (key ' + oldKey + ')\n');
      const created = keyCreationTime(gpgProgram, policy.signingKey, env);
      /* D1/D11/D13: a signature can never predate its own key -- an
       * anonymous commit is pinned to created+60s exactly (§ 5.0/D10); a
       * REAL commit older than the signing key (re-signing with a newer
       * key than the one the history was originally signed with) is
       * clamped up to the first policy-allowed minute at or after
       * created+60s, same rule `commit`/`tag`/`resign-tags` already apply
       * -- never its own (older) committer date verbatim, which gpg
       * refuses outright as a "time warp", and never the raw created+60s
       * instant either, which can itself fall inside a forbidden window.
       * Found dogfooding against nanojira's own real history: a real
       * commit from 2026-09-05 re-signed with a key created 2026-10-12. */
      const signTime = signTimeFor(p.committerEpoch, policy, created);
      const signer = createSigner(repo, env, { signingKey: policy.signingKey, signTime, gpgProgram });
      signers.push(signer);
      const newParent = p.parents.length === 0 ? null : (oldToNew.get(p.parents[0]) || p.parents[0]);
      const ctArgs = ['commit-tree', '-S', p.tree];
      if (newParent) ctArgs.push('-p', newParent);
      const nc = git.text(repo, ctArgs, {
        env: Object.assign({}, env, {
          GIT_AUTHOR_NAME: p.authorIdent.name, GIT_AUTHOR_EMAIL: p.authorIdent.email, GIT_AUTHOR_DATE: p.authorDate,
          GIT_COMMITTER_NAME: p.committerIdent.name, GIT_COMMITTER_EMAIL: p.committerIdent.email, GIT_COMMITTER_DATE: p.committerDate,
        }),
        input: commitMessageBytes(repo, env, p.sha),
        config: signer.gitConfig,
      });
      const newTree = git.text(repo, ['rev-parse', nc + '^{tree}'], { env });
      oldToNew.set(p.sha, nc);
      pairs.push({ old: p.sha, nw: nc, origTree: p.tree, newTree });
    }
    const newHeadOf = (oldSha: string) => oldToNew.get(oldSha)!;

    /* Every new object -- commits above, and now every tag object below
     * -- is created BEFORE any real ref is touched (HIGH fix, reviewer-
     * found: a sequential update-ref/`tag -f -s` per ref left a partial,
     * inconsistent state on any failure partway through). A signed tag
     * object is built by `buildSignedTagObject` -- signed directly and
     * written via `git hash-object -w`, which never creates or moves
     * any ref at all (an earlier version of this fix let `git tag -f -s`
     * create the object under its real name, incidentally moving the
     * real ref, then reverted that move -- not actually atomic: a crash
     * between the two steps leaves that one ref moved, Lead-found) --
     * then every branch AND tag move happens together in ONE
     * `update-ref --stdin` transaction at the very end (below), each old
     * value checked, so a failure anywhere aborts with NOTHING moved.
     *
     * Tag-on-tag (MEDIUM fix, reviewer-found): an outer tag whose
     * IMMEDIATE target is another tag, not a commit, is resigned only
     * once that inner tag's own new object exists, and is re-created
     * pointing AT the new inner tag object -- never flattened straight
     * onto the commit. `t.commit` (the fully-dereferenced target used to
     * decide which tags are affected at all, above) already sees through
     * any such chain regardless of depth; only the recreation order
     * needs to respect it. */
    const signedTags = affectedTags.filter((t) => t.type === 'tag');
    const tagRaw = new Map<string, string>();
    const tagImmediate = new Map<string, { type: string; obj: string }>();
    for (const t of signedTags) {
      /* git.buffer(), never git.text() -- see the identical comment in
       * cmdResignTags; `tagMessageFromRaw` below needs the message's
       * own exact trailing newline for a never-signed annotated tag. */
      const raw = git.buffer(repo, ['cat-file', '-p', t.obj], { env }).toString('utf8');
      tagRaw.set(t.name, raw);
      const om = /^object ([0-9a-f]{40})$/m.exec(raw);
      const tym = /^type (\S+)$/m.exec(raw);
      if (!om || !tym) throw new Refusal('tag ' + t.name + ': malformed tag object');
      tagImmediate.set(t.name, { type: tym[1], obj: om[1] });
    }

    const tagResults: { name: string; type: string; oldSha: string; newSha: string }[] = [];
    for (const t of affectedTags) {
      if (t.type !== 'tag') tagResults.push({ name: t.name, type: t.type, oldSha: t.obj, newSha: newHeadOf(t.commit) });
    }
    const tagOldObjToNewObj = new Map<string, string>();
    const pending = new Set(signedTags.map((t) => t.name));
    while (pending.size > 0) {
      let progressed = false;
      for (const t of signedTags) {
        if (!pending.has(t.name)) continue;
        const info = tagImmediate.get(t.name)!;
        let newTarget: string;
        if (info.type === 'commit') {
          newTarget = newHeadOf(info.obj);
        } else if (info.type === 'tag') {
          const inner = tagOldObjToNewObj.get(info.obj);
          if (inner === undefined) continue;
          newTarget = inner;
        } else {
          throw new Refusal('tag ' + t.name + ' points at a ' + info.type + ', not a commit or tag -- not supported');
        }
        const raw = tagRaw.get(t.name)!;
        const tm = /^tagger (.*) (\d+) ([+-]\d{4})$/m.exec(raw)!;
        const taggerEpoch = parseInt(tm[2], 10);
        const msg = tagMessageFromRaw(raw);
        const hasSig = signatureBlockCount(raw, 'tag') === 1;
        const oldStatus = signatureStatus(repo, env, 'tag', t.name, hasSig, policy.signingKey);
        /* Same refusal as `cmdResignTags` (D16/D18 follow-up, Lead-found):
         * a tag ending in a complete, well-formed signature block gpg
         * can neither verify nor attribute to any key is indistinguishable
         * from an unsigned tag whose message merely ends with a quoted
         * block -- refuse rather than guess which one it is. */
        if (hasSig && oldStatus.state === 'bad') {
          throw new Refusal('tag ' + t.name + ' ends with a signature-shaped block gpg cannot ' +
            'verify or attribute to any key -- indistinguishable from an unsigned tag whose message merely ' +
            'ends with a quoted block; refusing to guess, resolve manually');
        }
        const oldKey = unverifiableKeyLabel(oldStatus);
        if (oldKey) process.stdout.write('resign-commits: tag ' + t.name + ' replaced unverifiable signature (key ' + oldKey + ')\n');
        const taggerCreated = keyCreationTime(gpgProgram, policy.signingKey, env);
        const signTime = signTimeFor(taggerEpoch, policy, taggerCreated);
        const signer = createSigner(repo, env, { signingKey: policy.signingKey, signTime, gpgProgram });
        signers.push(signer);
        const newTagSha = buildSignedTagObject(repo, env, signer, {
          object: newTarget, type: info.type, name: t.name, taggerLine: tm[1] + ' ' + tm[2] + ' ' + tm[3], message: msg,
        });
        tagOldObjToNewObj.set(t.obj, newTagSha);
        tagResults.push({ name: t.name, type: t.type, oldSha: t.obj, newSha: newTagSha });
        pending.delete(t.name);
        progressed = true;
      }
      if (!progressed) {
        throw new Refusal('could not resolve tag dependency order for: ' + Array.from(pending).join(', '));
      }
    }

    /* ONE atomic transaction for every branch and tag move (HIGH fix):
     * every new object already exists above, this only moves refs, each
     * checked against its current (old) value, all-or-nothing. */
    const stdinLines: string[] = ['start'];
    for (const b of affectedBranches) {
      stdinLines.push('update refs/heads/' + b.name + ' ' + newHeadOf(b.sha) + ' ' + b.sha);
    }
    for (const r of tagResults) {
      stdinLines.push('update refs/tags/' + r.name + ' ' + r.newSha + ' ' + r.oldSha);
    }
    stdinLines.push('prepare', 'commit');
    const txn = git.run(repo, ['update-ref', '--stdin'], { env, input: stdinLines.join('\n') + '\n' });
    if (txn.status !== 0) {
      throw new Refusal('ref update transaction failed: ' + (txn.stderr as string).trim().split('\n')[0]);
    }

    if (flags['map-out']) {
      const mapLines = pairs.map((p) => p.old + ' ' + p.nw).concat(tagResults.map((r) => r.oldSha + ' ' + r.newSha));
      fs.writeFileSync(flags['map-out'] as string, mapLines.length ? mapLines.join('\n') + '\n' : '');
    }

    const movedTagNames = new Set(affectedTags.map((t) => t.name));
    const results = [
      verify.verifyTreeDelta(pairs.map((p) => ({ label: p.old, expected: p.origTree, actual: p.newTree }))),
      verifyHeadersPreserved(repo, env, pairs),
      verifyParentsMapped(repo, env, pairs, parsed),
      verifyNewSignatures(repo, env, gpgProgram, policy, pairs, movedTagNames),
    ];
    for (const r of results) process.stdout.write(r.line + '\n');
    for (const p of pairs) {
      process.stdout.write('resign-commits: ' + p.old.slice(0, 7) + ' -> ' + p.nw.slice(0, 7) + (p.old === p.nw ? ' (unchanged)' : '') + '\n');
    }
    /* `<remote>` is a literal placeholder, as in resign-tags: this tool never
     * inspects or assumes a remote. A ref whose sha did not change (a
     * deterministic signature at the same signing time) gets no hint. */
    for (const b of affectedBranches) {
      if (newHeadOf(b.sha) === b.sha) continue;
      process.stdout.write('# git push --force-with-lease=' + b.name + ':' + b.sha + ' <remote> ' + b.name + '\n');
    }
    for (const r of tagResults) {
      if (r.newSha === r.oldSha) continue;
      process.stdout.write('# git push --force-with-lease=refs/tags/' + r.name + ':' + r.oldSha + ' <remote> refs/tags/' + r.name + '\n');
    }
    process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
  } finally {
    for (const s of signers) s.cleanup();
    for (const t of tmpFiles) t.cleanup();
  }
}

/* --------------------------------------------------------------- help --- */

/** One synopsis per subcommand, exactly as docs/SPECIFICATION.md § 5.1-5.5
 * head them -- what `--help`/`-h`/`help` print (exit 0), and what a missing
 * subcommand prints after its error line (exit 2). */
const SYNOPSES: Record<string, string> = {
  commit: 'git-sign commit <repo> (--message=<text>|--message-file=<path>) --date=(auto|<date>) [--amend] [--policy=<file>] [--apply]',
  tag: 'git-sign tag <repo> <tag> (--message=<text>|--message-file=<path>) --date=(auto|<date>) [--policy=<file>] [--apply]',
  'resign-tags': 'git-sign resign-tags <repo> [<tag> ...] [--policy=<file>] [--apply]',
  'resign-commits': 'git-sign resign-commits <repo> (<lower>..<upper> | <rev> --from-root) [--map-out=<file>] [--policy=<file>] [--apply]',
  check: 'git-sign check <repo> [<range> | --range=<range>] [--tags] [--policy=<file>]',
};

function usage(): string {
  return 'usage:\n' + Object.values(SYNOPSES).map((l) => '  ' + l + '\n').join('') +
    'Every writing subcommand is a dry run unless --apply is given. See docs/SPECIFICATION.md § 5.\n';
}

const HELP_WORDS = ['--help', '-h', 'help'];
const COMMANDS: Record<string, (bin: string, args: string[]) => void> = {
  commit: cmdCommit, tag: cmdTag, 'resign-tags': cmdResignTags, check: cmdCheck, 'resign-commits': cmdResignCommits,
};

main('git-sign', (bin) => {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);
  if (sub === undefined) {
    process.stderr.write(bin + ': missing subcommand\n' + usage());
    process.exit(2);
  }
  if (HELP_WORDS.includes(sub)) {
    process.stdout.write(usage());
    return;
  }
  if (!Object.hasOwn(COMMANDS, sub)) throw new UsageError('unknown subcommand \'' + sub + '\'');
  /* `git-sign <sub> --help`: that subcommand's synopsis only, before any
   * flag parsing (so it never fails on the other arguments around it). */
  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write('usage: ' + SYNOPSES[sub] + '\n');
    return;
  }
  return COMMANDS[sub](bin, rest);
});
