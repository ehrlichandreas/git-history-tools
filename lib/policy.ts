/*
 * git-sign's policy file (docs/SPECIFICATION.md § 5.0): identity, signing key,
 * forbidden time windows and forbidden message patterns. Lives outside the
 * repo (§ 4.4's rule, reused) at --policy=<file>, else
 * $XDG_CONFIG_HOME/git-history-tools/policy.json, else
 * $HOME/.config/git-history-tools/policy.json. A missing or invalid policy
 * is a refusal naming the path, never a usage error -- the default location
 * legitimately may not exist yet, and "the policy file is broken" is a
 * repo-independent precondition failure, not a CLI mistake.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Refusal, isInsideRepo } from './cli.ts';

export interface Identity {
  name: string;
  email: string;
}

export interface ForbiddenWindow {
  days: string[];
  from: string;
  to: string;
}

export interface Policy {
  identity: Identity;
  signingKey: string;
  timezone: string;
  forbiddenWindows: ForbiddenWindow[];
  forbiddenMessagePatterns: string[];
  /** Unix seconds, from the optional `anonymousBefore` ISO date -- an
   * author/committer/tagger date before this is exempt from the forbidden-
   * window rule ONLY (git-release-squash's anonymous placeholder dates,
   * e.g. 1970-01-26 12:00 UTC, are not real working hours; `check` would
   * otherwise flag every single one). Identity, message and the
   * signature's own creation time are never exempt -- an anonymised
   * commit's SIGNATURE is still made in real time. Undefined (the key
   * omitted) exempts nothing. */
  anonymousBefore?: number;
  /** The gpg binary every git-sign command runs, from the optional
   * `gpgProgram` key (an absolute path to an executable file); undefined
   * means `gpg` from PATH. Never git's own `gpg.program` from any config
   * scope -- the policy, not the repo, decides what signs (§ 5.0). */
  gpgProgram?: string;
}

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TOP_REQUIRED = ['identity', 'signingKey', 'timezone', 'forbiddenWindows', 'forbiddenMessagePatterns'];
const TOP_OPTIONAL = ['anonymousBefore', 'gpgProgram'];
const IDENTITY_KEYS = ['name', 'email'];
const WINDOW_KEYS = ['days', 'from', 'to'];

function fail(file: string, reason: string): never {
  throw new Refusal('policy ' + file + ': ' + reason);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `optional` keys are validated when present, never required. Every other
 * key is still either required or rejected as unknown -- `anonymousBefore`
 * and `gpgProgram` are the only keys in the whole schema this applies to. */
function checkKeys(file: string, obj: Record<string, unknown>, required: string[], label: string, optional?: string[]): void {
  const allowed = required.concat(optional || []);
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(file, 'unknown key \'' + label + (label ? '.' : '') + k + '\'');
  }
  for (const k of required) {
    if (!(k in obj)) fail(file, 'missing key \'' + (label ? label + '.' : '') + k + '\'');
  }
}

function validIanaTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function validateIdentity(file: string, v: unknown): Identity {
  if (!isPlainObject(v)) fail(file, '\'identity\' must be an object');
  checkKeys(file, v, IDENTITY_KEYS, 'identity');
  if (typeof v.name !== 'string' || v.name === '') fail(file, '\'identity.name\' must be a non-empty string');
  if (typeof v.email !== 'string' || v.email === '') fail(file, '\'identity.email\' must be a non-empty string');
  return { name: v.name, email: v.email };
}

function validateSigningKey(file: string, v: unknown): string {
  if (typeof v !== 'string' || !/^[0-9A-Fa-f]{16,40}$/.test(v)) {
    fail(file, '\'signingKey\' must be a 16-40 character hex key id/fingerprint');
  }
  return v;
}

function validateTimezone(file: string, v: unknown): string {
  if (typeof v !== 'string' || v === '' || !validIanaTimezone(v)) {
    fail(file, '\'timezone\' must be a valid IANA zone name (got ' + JSON.stringify(v) + ')');
  }
  return v;
}

function validateWindow(file: string, v: unknown, i: number): ForbiddenWindow {
  if (!isPlainObject(v)) fail(file, '\'forbiddenWindows[' + i + ']\' must be an object');
  checkKeys(file, v, WINDOW_KEYS, 'forbiddenWindows[' + i + ']');
  if (!Array.isArray(v.days) || v.days.length === 0 || !v.days.every((d) => typeof d === 'string' && DAYS.includes(d))) {
    fail(file, '\'forbiddenWindows[' + i + '].days\' must be a non-empty array of ' + DAYS.join('/'));
  }
  if (new Set(v.days).size !== v.days.length) fail(file, '\'forbiddenWindows[' + i + '].days\' has a duplicate');
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (typeof v.from !== 'string' || !timeRe.test(v.from)) fail(file, '\'forbiddenWindows[' + i + '].from\' must be HH:MM');
  if (typeof v.to !== 'string' || !timeRe.test(v.to)) fail(file, '\'forbiddenWindows[' + i + '].to\' must be HH:MM');
  if (v.from >= v.to) fail(file, '\'forbiddenWindows[' + i + ']\': from must be earlier than to');
  return { days: v.days.slice(), from: v.from, to: v.to };
}

/* Compiled with the 'i' flag (case-insensitive) everywhere a pattern is
 * used or validated -- GitHub's own trailer is "Co-authored-by:", a
 * different case from a pattern written as "Co-Authored-By:", and a
 * policy author should not have to anticipate every casing variant by
 * hand. Documented in docs/SPECIFICATION.md § 5.0. */
function compilePattern(p: string): RegExp {
  return new RegExp(p, 'i');
}

function validatePatterns(file: string, v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((p) => typeof p === 'string')) {
    fail(file, '\'forbiddenMessagePatterns\' must be an array of strings');
  }
  for (const p of v) {
    try { compilePattern(p); } catch (e) { fail(file, '\'forbiddenMessagePatterns\' has an invalid pattern ' + JSON.stringify(p) + ': ' + (e as Error).message); }
  }
  return v.slice();
}

function validateAnonymousBefore(file: string, v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') fail(file, '\'anonymousBefore\' must be an ISO date string');
  const t = Date.parse(v);
  if (Number.isNaN(t)) fail(file, '\'anonymousBefore\' is not a recognised date: ' + JSON.stringify(v));
  return Math.floor(t / 1000);
}

function validateGpgProgram(file: string, v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !path.isAbsolute(v)) fail(file, '\'gpgProgram\' must be an absolute path (got ' + JSON.stringify(v) + ')');
  let st: fs.Stats;
  try { st = fs.statSync(v); } catch (e) { fail(file, '\'gpgProgram\' does not exist: ' + v); }
  if (!st.isFile()) fail(file, '\'gpgProgram\' is not a file: ' + v);
  try { fs.accessSync(v, fs.constants.X_OK); } catch (e) { fail(file, '\'gpgProgram\' is not executable: ' + v); }
  return v;
}

/** Strict validation: every top-level/nested key must be exactly the
 * expected set, named-key errors so a typo in a policy file is diagnosable
 * from the refusal alone. `anonymousBefore` and `gpgProgram` are the only
 * optional keys. */
export function validatePolicy(parsed: unknown, file: string): Policy {
  if (!isPlainObject(parsed)) fail(file, 'must be a JSON object');
  checkKeys(file, parsed, TOP_REQUIRED, '', TOP_OPTIONAL);
  const identity = validateIdentity(file, parsed.identity);
  const signingKey = validateSigningKey(file, parsed.signingKey);
  const timezone = validateTimezone(file, parsed.timezone);
  if (!Array.isArray(parsed.forbiddenWindows)) fail(file, '\'forbiddenWindows\' must be an array');
  const forbiddenWindows = parsed.forbiddenWindows.map((w, i) => validateWindow(file, w, i));
  const forbiddenMessagePatterns = validatePatterns(file, parsed.forbiddenMessagePatterns);
  const anonymousBefore = validateAnonymousBefore(file, parsed.anonymousBefore);
  const gpgProgram = validateGpgProgram(file, parsed.gpgProgram);
  const policy: Policy = { identity, signingKey, timezone, forbiddenWindows, forbiddenMessagePatterns };
  if (anonymousBefore !== undefined) policy.anonymousBefore = anonymousBefore;
  if (gpgProgram !== undefined) policy.gpgProgram = gpgProgram;
  return policy;
}

function defaultPolicyPath(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  return path.join(base, 'git-history-tools', 'policy.json');
}

/** Resolves --policy=<file> (or the default location), checks it exists and
 * lives outside <repo> (§ 4.4's rule, reused -- same double symlink-resolved
 * containment check as resolveOutsideFile, D3), parses it as JSON and
 * strictly validates its schema. Every failure is a Refusal naming the
 * file, never a UsageError -- unlike --rules/--terms/--allow, a policy
 * file's default location legitimately may not exist yet. */
export function loadPolicy(repo: string, explicitPath: string | undefined, env: NodeJS.ProcessEnv): Policy {
  const file = explicitPath !== undefined ? explicitPath : defaultPolicyPath(env);
  if (!fs.existsSync(file)) throw new Refusal('policy file not found: ' + file);
  const abs = path.resolve(file);
  const realRepo = fs.realpathSync(repo);
  const realDir = fs.realpathSync(path.dirname(abs));
  const realFileShallow = path.join(realDir, path.basename(abs));
  const realFileFull = fs.realpathSync(abs);
  if (isInsideRepo(realRepo, realFileShallow) || isInsideRepo(realRepo, realFileFull)) {
    throw new Refusal('--policy points inside the repo (' + file + ') -- keep it outside');
  }
  let raw: string;
  try { raw = fs.readFileSync(realFileFull, 'utf8'); } catch (e) { throw new Refusal('policy ' + file + ': cannot read (' + (e as Error).message + ')'); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (e) { throw new Refusal('policy ' + file + ': not valid JSON (' + (e as Error).message + ')'); }
  return validatePolicy(parsed, file);
}

/* ------------------------------------------------------- time-zone math --- */

/** weekday (lowercase, 3-letter) and HH:MM, both as observed in `tz` at
 * `epochSeconds` (DST-aware; no fixed-offset assumption anywhere). */
export function zonedParts(epochSeconds: number, tz: string): { weekday: string; hhmm: string } {
  const d = new Date(epochSeconds * 1000);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d).toLowerCase();
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return { weekday, hhmm };
}

/** The zone's UTC offset, in seconds, as observed at `epochSeconds` (DST-aware).
 * Reads `tz`'s wall-clock fields via formatToParts and rebuilds them with
 * Date.UTC -- never re-parses a formatted string with `new Date(string)`,
 * which would read it in the PROCESS's own zone and misplace any instant
 * whose digits fall in that zone's skipped spring-forward hour. */
export function zonedOffsetSeconds(epochSeconds: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(epochSeconds * 1000));
  const field = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  const wallAsUtc = Date.UTC(field('year'), field('month') - 1, field('day'), field('hour'), field('minute'), field('second'));
  return Math.round(wallAsUtc / 1000 - Math.floor(epochSeconds));
}

/** `+HHMM`/`-HHMM`, git's own offset notation, for `tz` at `epochSeconds`. */
export function zonedOffsetString(epochSeconds: number, tz: string): string {
  const off = zonedOffsetSeconds(epochSeconds, tz);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 3600)).padStart(2, '0');
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, '0');
  return sign + hh + mm;
}

/** `@<epoch> <offset>`, the git date form this tool passes via
 * GIT_AUTHOR_DATE/GIT_COMMITTER_DATE/--date, carrying the real local offset
 * for `policy.timezone` at that instant (DST-aware). */
export function gitDateAt(epochSeconds: number, tz: string): string {
  return '@' + epochSeconds + ' ' + zonedOffsetString(epochSeconds, tz);
}

/** A human-readable `YYYY-MM-DD HH:MM:SS +HHMM` rendering in `tz`, for dry-run reports. */
export function formatZoned(epochSeconds: number, tz: string): string {
  const d = new Date(epochSeconds * 1000);
  const datePart = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const timePart = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(d);
  return datePart + ' ' + timePart + ' ' + zonedOffsetString(epochSeconds, tz);
}

export function isForbiddenInstant(epochSeconds: number, policy: Policy): boolean {
  const { weekday, hhmm } = zonedParts(epochSeconds, policy.timezone);
  return policy.forbiddenWindows.some((w) => w.days.includes(weekday) && hhmm >= w.from && hhmm < w.to);
}

/** Whether `epochSeconds` predates `policy.anonymousBefore` -- exempts an
 * author/committer/tagger date from `isForbiddenInstant` ONLY (never the
 * signature's own creation time, never identity/message); false when the
 * policy sets no `anonymousBefore` at all. */
export function isExemptAnonymousDate(epochSeconds: number, policy: Policy): boolean {
  return policy.anonymousBefore !== undefined && epochSeconds < policy.anonymousBefore;
}

/** The forbidden pattern a message matches, or null -- the caller names it
 * in the refusal (never just "a pattern matched"). Case-insensitive (§ 5.0). */
export function matchForbiddenPattern(message: string, policy: Policy): string | null {
  for (const p of policy.forbiddenMessagePatterns) {
    if (compilePattern(p).test(message)) return p;
  }
  return null;
}

/** Converts a zoned wall-clock instant (policy.timezone) to a unix epoch.
 * Every offset the zone uses within a day either side is a candidate; a
 * candidate counts only if the zone really shows that wall clock at the
 * resulting instant. None: the time was skipped (spring-forward gap).
 * Two: it happened twice (fall-back). Both are refusals -- the caller
 * must give an explicit offset, never get a silently shifted or
 * arbitrarily chosen instant (D12). */
export function epochForZonedWallClock(y: number, mo: number, d: number, hh: number, mi: number, ss: number, tz: string): number {
  const wallAsUtc = Math.floor(Date.UTC(y, mo - 1, d, hh, mi, ss) / 1000);
  const offsets = new Set([-86400, 0, 86400].map((delta) => zonedOffsetSeconds(wallAsUtc + delta, tz)));
  const candidates = [...offsets].map((off) => wallAsUtc - off).filter((e) => zonedOffsetSeconds(e, tz) === wallAsUtc - e);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const wall = y + '-' + pad(mo) + '-' + pad(d) + 'T' + pad(hh) + ':' + pad(mi) + ':' + pad(ss);
  if (candidates.length === 0) {
    throw new Refusal('--date ' + wall + ' does not exist in ' + tz + ' (skipped by a DST change) -- give an explicit offset');
  }
  if (candidates.length > 1) {
    const both = candidates.sort((a, b) => a - b).map((e) => zonedOffsetString(e, tz)).join(' and ');
    throw new Refusal('--date ' + wall + ' occurs twice in ' + tz + ' (' + both + ') -- give an explicit offset');
  }
  return candidates[0];
}

/** Latest allowed minute <= `now`, strictly after `after` (exclusive), or
 * null if none exists in that range (the whole gap is one forbidden
 * window). Scans minute by minute -- forbidden windows are at most a day
 * long, so this always terminates quickly in practice; capped at 20160
 * minutes (14 days) as a hard safety bound against a pathological policy. */
export function latestAllowedMinuteAtOrBefore(now: number, after: number, policy: Policy): number | null {
  let t = now - (now % 60);
  const lowerExclusive = after;
  let steps = 0;
  while (t > lowerExclusive && steps < 20160) {
    if (!isForbiddenInstant(t, policy)) return t;
    t -= 60;
    steps++;
  }
  return null;
}

/** The next allowed minute strictly after `from` -- named in the refusal
 * when `latestAllowedMinuteAtOrBefore` finds nothing. `null` (defensive,
 * D14) if the 20160-step (14-day) cap is hit without finding one -- the
 * current schema (HH:MM, `from < to`, max `23:59`) always leaves at least
 * one minute open per day, so this is unreachable via any valid policy
 * today, but the cap must never silently hand back a still-forbidden
 * instant if that ever changes. */
export function nextAllowedMinuteAfter(from: number, policy: Policy): number | null {
  let t = from - (from % 60) + 60;
  let steps = 0;
  while (isForbiddenInstant(t, policy) && steps < 20160) {
    t += 60;
    steps++;
  }
  return isForbiddenInstant(t, policy) ? null : t;
}

/** First allowed minute boundary at or after `from` (inclusive, unlike
 * `nextAllowedMinuteAfter`) -- used by `signTimeFor` to find a floor that
 * is itself never inside a forbidden window. `null` under the same
 * defensive cap as `nextAllowedMinuteAfter` (D14). */
function firstAllowedMinuteAtOrAfter(from: number, policy: Policy): number | null {
  let t = Math.ceil(from / 60) * 60;
  let steps = 0;
  while (isForbiddenInstant(t, policy) && steps < 20160) {
    t += 60;
    steps++;
  }
  return isForbiddenInstant(t, policy) ? null : t;
}

/** The signature time for an object whose own date is `epoch` (a commit's
 * committer date, or a tag's tagger date): never earlier than the signing
 * key's own creation (D1), and never inside a forbidden window -- UNLESS
 * `epoch` itself is exempt via `anonymousBefore` (D9/D10), in which case
 * the signature is pinned to `keyCreated + 60s` EXACTLY, regardless of
 * windows, because that pin is a single constant, already-public value
 * (the key's own creation time) that leaks no real work time, and every
 * anonymised pre-`anonymousBefore` release already depends on this exact
 * pin (unchanged by this rule).
 *
 * For a REAL (non-exempt) date, the floor is NOT `keyCreated + 60s`
 * itself -- that instant can itself land inside a forbidden window (e.g.
 * a key created on a weekday morning) -- but the first minute at or after
 * it that the policy actually allows. Clamping a too-old real commit's
 * signature to the raw `keyCreated + 60s` pin would just trade one leak
 * for a forbidden-window violation; found dogfooding `resign-commits`
 * against real history (D11/D13). This floor is a constant for a given
 * key+policy pair, so -- like the anonymous pin -- it leaks nothing
 * either, and a real `epoch` already past this floor and itself allowed
 * (the ordinary, by-far-most-common case: `commit`/`tag` never let an
 * `epoch` be chosen inside a forbidden window in the first place) is
 * returned unchanged. */
export function signTimeFor(epoch: number, policy: Policy, keyCreated: number): number {
  if (isExemptAnonymousDate(epoch, policy)) return keyCreated + 60;
  const floor = firstAllowedMinuteAtOrAfter(keyCreated + 60, policy);
  if (floor === null) {
    throw new Refusal('no policy-allowed minute found within 14 days of the signing key\'s own creation -- check forbiddenWindows');
  }
  return Math.max(epoch, floor);
}
