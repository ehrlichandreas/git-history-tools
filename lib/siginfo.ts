/*
 * git-sign `check` (docs/SPECIFICATION.md § 5.4): reading facts about an
 * existing signature -- which key validated it, and when the signature
 * itself was created -- as opposed to lib/signer.ts, which only ever
 * creates new signatures.
 */
import { spawnSync } from 'node:child_process';
import * as git from './git.ts';

type Env = NodeJS.ProcessEnv;

/** The armor markers `git`'s own `parse_signed_buffer` recognises as the
 * start of a tag's detached signature -- PGP (the only scheme nanojira's
 * real history or any AC fixture actually uses) and SSH (`gpg.format=
 * ssh`), kept as a pair list so the one boundary walk below
 * (`tagSignatureBoundary`) recognises exactly the same set for both its
 * "count" and "where does it start" answers -- there is only the one
 * walk now, so there is nothing left to drift (D1/D15/D16 follow-up,
 * Lead-found). */
const TAG_SIGNATURE_MARKERS: { begin: string; end: string }[] = [
  { begin: '-----BEGIN PGP SIGNATURE-----', end: '-----END PGP SIGNATURE-----' },
  { begin: '-----BEGIN SSH SIGNATURE-----', end: '-----END SSH SIGNATURE-----' },
];

/** The boundary between a tag's own message and its trailing, genuinely
 * stacked signature block(s) -- and, incidentally, how many of those
 * stacked blocks there are -- computed by ONE backward walk from EOF,
 * never two independent algorithms that can disagree (HIGH, Lead-found,
 * D16 follow-up). The walk: each complete `BEGIN...END` block immediately
 * preceded (modulo blank lines) by another complete block counts as one
 * more stacked layer; `index` is the offset of the EARLIEST such block's
 * `BEGIN` line. `index === -1` ("no boundary") whenever nothing at the
 * very end of the object is a complete block -- an unsigned tag whose
 * MESSAGE merely quotes a complete signature block in the MIDDLE, with
 * real text still after it, has no boundary at all: the quote is just
 * message text, wherever in the object it happens to sit.
 *
 * This replaces the previous pair, `lastTagSignatureBeginIndex`
 * (`text.lastIndexOf` on the begin marker, string or Buffer, taking
 * whichever marker's last occurrence came latest) and
 * `stackedTagBlockCount` (this same backward walk, but only ever asked
 * for the count). They agreed on the common cases but NOT on a tag
 * message that quotes a complete block in the middle and then has real
 * text after it: the walk correctly stops immediately (nothing recognizable
 * at EOF, `count` 0, no boundary), but a bare `lastIndexOf` has no notion
 * of "at EOF" at all and happily returned the quote's own position as if
 * it were real -- `tagMessageFromRaw`/`stripSignature` then truncated the
 * message right at the quote, silently dropping everything after it, on
 * every resign. Both sides of `cmdResignTags`' own verify step used that
 * same truncation, so they agreed with each other and reported `OK`
 * while the loss happened (Lead-found live against exactly this
 * fixture). One function, one answer, used by every caller below. */
export function tagSignatureBoundary(raw: string): { index: number; count: number } {
  const lines = raw.split('\n');
  const lineStart: number[] = new Array(lines.length + 1);
  lineStart[0] = 0;
  for (let k = 0; k < lines.length; k++) lineStart[k + 1] = lineStart[k] + lines[k].length + 1;
  let i = lines.length;
  let count = 0;
  let index = -1;
  for (;;) {
    while (i > 0 && lines[i - 1].trim() === '') i--;
    if (i === 0) break;
    const marker = TAG_SIGNATURE_MARKERS.find((m) => lines[i - 1] === m.end);
    if (!marker) break;
    let j = i - 2;
    while (j >= 0 && lines[j] !== marker.begin) j--;
    if (j < 0) break;
    count++;
    index = lineStart[j];
    i = j;
  }
  return { index, count };
}

/** How many distinct signature blocks `rev`'s raw object text actually
 * contains: for a tag, `tagSignatureBoundary(raw).count` above (NOT every
 * `BEGIN` marker anywhere in the text -- see its own comment for why); for a
 * commit, the number of top-level `gpgsig `/`gpgsig-sha256 ` header lines
 * in the HEADER REGION ONLY (up to the first blank line) -- never the
 * whole object, which also includes the commit MESSAGE: a commit whose
 * message happens to contain a line starting with "gpgsig " as literal
 * text must not be miscounted as a second signature (D2, Lead-found). A
 * folded continuation line always starts with a space, so restricting to
 * the header region still only ever counts real header starts, never
 * their own wrapped lines. A normal object has 0 (unsigned) or 1
 * (signed) -- more than that means the object itself is malformed, most
 * likely a tag whose MESSAGE was built from a previous signature's own
 * text (e.g. `for-each-ref --format=%(contents)` on an already-signed
 * tag, which includes the trailing signature block as part of its own
 * output) and then signed again on top, concatenating two blocks back to
 * back (CRITICAL, found resigning an already-signed tag -- D14 follow-up).
 * `extractSignature` below refuses to silently hand either gpg or a
 * pattern-matcher a multi-block blob as if it were one signature; `check`
 * (lib/sign.ts) uses this directly to report `multiple-signatures` as its
 * own violation, distinct from and checked before `missing`/`bad`/etc. */
export function signatureBlockCount(raw: string, kind: 'commit' | 'tag'): number {
  if (kind === 'tag') return tagSignatureBoundary(raw).count;
  const headerEnd = raw.indexOf('\n\n');
  const header = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  return (header.match(/^gpgsig(-sha256)? /mg) || []).length;
}

/** The gpgsig packet's own raw bytes (the signature, exactly as embedded),
 * extracted straight from the commit/tag object's own text -- never from
 * `git log --format=...`, which has no placeholder for it. A commit's
 * `gpgsig` header folds continuation lines with one leading space (RFC
 * 822-style); a tag's signature is not a header at all, just the literal
 * signature block appended straight after the message -- found via
 * `tagSignatureBoundary`, which is also where its own `count` comes from,
 * so there is no second, independent scan to disagree with it (same D16
 * reasoning). Null when there is no signature at all, OR when there is
 * more than one -- never silently takes just the first/last of several
 * and hands it to gpg as if the object were normal; the caller (`check`'s
 * `checkOneCommit`/`checkOneTag`) detects the multiple case itself, via
 * `signatureBlockCount`, and reports it as its own violation before ever
 * reaching this function. */
export function extractSignature(repo: string, env: Env, kind: 'commit' | 'tag', rev: string): string | null {
  const raw = git.text(repo, ['cat-file', kind, rev], { env });
  if (kind === 'tag') {
    const { index, count } = tagSignatureBoundary(raw);
    return count === 1 ? raw.slice(index) + '\n' : null;
  }
  if (signatureBlockCount(raw, kind) > 1) return null;
  const headerEnd = raw.indexOf('\n\n');
  const header = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  const lines = header.split('\n');
  const start = lines.findIndex((l) => l.startsWith('gpgsig ') || l.startsWith('gpgsig-sha256 '));
  if (start === -1) return null;
  const prefixLen = lines[start].startsWith('gpgsig-sha256 ') ? 'gpgsig-sha256 '.length : 'gpgsig '.length;
  const sigLines = [lines[start].slice(prefixLen)];
  let i = start + 1;
  while (i < lines.length && lines[i].startsWith(' ')) { sigLines.push(lines[i].slice(1)); i++; }
  return sigLines.join('\n') + '\n';
}

/** The signature's own creation time (unix seconds), parsed from gpg's
 * packet dump -- independent of trust/verification state, so it can be
 * read even for a signature `check` separately reports as invalid.
 * `gpg --list-packets` needs no keyring access for this, only the armored
 * signature on stdin. Null if the packet dump has no readable creation
 * time at all (malformed/corrupt signature -- `check`'s own signature-
 * validity check flags that case separately; a *present-but-unreadable*
 * time is a `check` violation in its own right, never silently treated as
 * clean -- see `check`'s caller in lib/sign.ts).
 *
 * The epoch lives on the packet line itself (`version 4, created
 * <epoch>, ...`), not on the "(sig created <ISO-date>)" hashed-subpacket
 * annotation a few lines down -- that one is a human-readable *date*
 * (`2026-10-17`), not an epoch, and the original `/\(sig created
 * (\d+)\)/` regex matched its leading digits and silently produced a
 * truncated, WRONG epoch (`2026`) instead of failing to match at all: a
 * present signature's time was then read as 1970-01-01, which happened to
 * never fall inside any realistic forbidden window, so `check` silently
 * passed real leaks straight through. Found live against nanojira commit
 * c8d5657 (D9) -- fixed by reading the packet line's own epoch instead. */
export function signatureCreationTime(gpgProgram: string, env: Env, armored: string): number | null {
  const r = spawnSync(gpgProgram, ['--list-packets'], { env, input: armored, encoding: 'utf8' });
  const m = /version \d+, created (\d+),/.exec(r.stdout || '');
  return m ? parseInt(m[1], 10) : null;
}

export type SigState = 'missing' | 'bad' | 'unknown-key' | 'wrong-key' | 'ok';

export interface SigStatus {
  state: SigState;
  /** The key id gpg reported it couldn't find, for 'unknown-key'. */
  keyid?: string;
  /** The fingerprint that actually produced a cryptographically good
   * signature, for 'wrong-key' and 'ok'. */
  fingerprint?: string;
}

/**
 * Classifies `rev`'s signature against `policyKey`, via `git verify-commit/
 * verify-tag --raw`'s GnuPG status-fd lines on stderr -- distinguishing the
 * cases `check` must report separately (§ 5.4): no signature at all; a
 * present signature nothing can verify (`NO_PUBKEY`, the signing key isn't
 * in this keyring); a present, cryptographically good signature by some
 * OTHER key (`VALIDSIG` with a fingerprint that isn't `policyKey`); and
 * anything else gpg itself calls invalid (corrupt/forged, no NO_PUBKEY, no
 * VALIDSIG). `hasSignature` is `extractSignature(...) !== null` -- passed
 * in rather than re-derived, since the caller already has it. */
export function signatureStatus(repo: string, env: Env, kind: 'commit' | 'tag', rev: string,
  hasSignature: boolean, policyKey: string): SigStatus {
  if (!hasSignature) return { state: 'missing' };
  const args = kind === 'commit' ? ['verify-commit', '--raw', rev] : ['verify-tag', '--raw', rev];
  const r = git.run(repo, args, { env });
  const stderr = (r.stderr as string) || '';
  const noPubkey = /^\[GNUPG:\] NO_PUBKEY ([0-9A-Fa-f]+)/m.exec(stderr);
  if (noPubkey) return { state: 'unknown-key', keyid: noPubkey[1].toUpperCase() };
  const validsig = /^\[GNUPG:\] VALIDSIG ([0-9A-Fa-f]+) /m.exec(stderr);
  if (validsig) {
    const fingerprint = validsig[1].toUpperCase();
    return keyMatches(policyKey, fingerprint) ? { state: 'ok', fingerprint } : { state: 'wrong-key', fingerprint };
  }
  return { state: 'bad' };
}

/** The fingerprint of the key that produced a good signature on `rev`, via
 * `git verify-commit/verify-tag --raw`'s GnuPG status-fd lines on stderr
 * (`VALIDSIG <fingerprint> ...`) -- present whenever the signature is
 * cryptographically good, regardless of trust level (so both git's `G` and
 * `U` validity states still yield a fingerprint here). Null if the
 * signature is missing, bad, or by an unknown key. Used only by
 * `resign-tags`'s default-selection pass, which only ever needs the
 * yes/no "already validly signed by the policy key?" question -- `check`
 * uses the richer `signatureStatus` above instead, to name which of the
 * several distinct failure shapes it actually found. */
export function verifiedKeyFingerprint(repo: string, env: Env, kind: 'commit' | 'tag', rev: string): string | null {
  const args = kind === 'commit' ? ['verify-commit', '--raw', rev] : ['verify-tag', '--raw', rev];
  const r = git.run(repo, args, { env });
  const m = /^\[GNUPG:\] VALIDSIG ([0-9A-Fa-f]+) /m.exec(r.stderr || '');
  return m ? m[1].toUpperCase() : null;
}

/** Whether `reported` (a key id or fingerprint of unknown length -- gpg's
 * own output is not consistent across versions) names the same key as
 * `full` (the policy's own full fingerprint): equal, or a suffix of it. */
export function keyMatches(full: string, reported: string | null): boolean {
  if (!reported) return false;
  const a = full.toUpperCase();
  const b = reported.toUpperCase();
  return a === b || (b.length < a.length && a.endsWith(b));
}
