/* AC-48 -- § 6's policy file: missing, malformed JSON, inside the repo, an
 * unknown or missing top-level key, a bad timezone, a bad signingKey shape,
 * a backwards forbidden window, and an invalid forbidden-message regex are
 * all a refusal (exit 1) naming the specific problem -- never a usage
 * error, and never silently accepted. --policy=<file> overrides the
 * default $XDG_CONFIG_HOME/git-history-tools/policy.json location. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

function basicCommitArgs(repo: string, policyPath: string): string[] {
  return ['commit', repo, '--message=x', '--date=2001-09-10T01:46:40Z', '--policy=' + policyPath];
}

{
  const gpg = H.setupGpg('ac48-missing');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac48-missing', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const missingPath = path.join(H.freshDir('ac48-missing-dir'), 'no-such-policy.json');

    const r = H.runBin('git-sign', basicCommitArgs(repo, missingPath), { gnupgHome: gpg.gnupgHome });
    T.exit('AC-48 missing policy: refusal, exit 1', r, 1);
    T.contains('AC-48 missing policy: names the path', r.stderr, missingPath);
  }
}

{
  const gpg = H.setupGpg('ac48-inside');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac48-inside', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const insidePath = path.join(repo, 'policy.json');
    fs.writeFileSync(insidePath, JSON.stringify({
      identity: { name: 'X', email: 'x@example.invalid' }, signingKey: gpg.fingerprint,
      timezone: 'UTC', forbiddenWindows: [], forbiddenMessagePatterns: [],
    }));

    const r = H.runBin('git-sign', basicCommitArgs(repo, insidePath), { gnupgHome: gpg.gnupgHome });
    T.exit('AC-48 policy inside repo: refusal, exit 1', r, 1);
    T.contains('AC-48 policy inside repo: names --policy and "outside"', r.stderr, 'keep it outside');
  }
}

function writeRaw(label: string, content: string): string {
  const dir = H.freshDir(label);
  const file = path.join(dir, 'policy.json');
  fs.writeFileSync(file, content);
  return file;
}

{
  const gpg = H.setupGpg('ac48-malformed');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac48-malformed', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });
    const p = writeRaw('ac48-malformed-policy', '{ not json');

    const r = H.runBin('git-sign', basicCommitArgs(repo, p), { gnupgHome: gpg.gnupgHome });
    T.exit('AC-48 malformed JSON: refusal, exit 1', r, 1);
    T.contains('AC-48 malformed JSON: mentions JSON', r.stderr, 'JSON');
  }
}

const VALID = {
  identity: { name: 'X', email: 'x@example.invalid' },
  signingKey: 'DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF',
  timezone: 'UTC',
  forbiddenWindows: [] as unknown[],
  forbiddenMessagePatterns: [] as string[],
};

function expectRefusal(desc: string, repo: string, gpg: H.Gpg, overrides: Record<string, unknown>, mustContain: string): void {
  const policy = Object.assign({}, VALID, overrides);
  const p = writeRaw('ac48-' + desc.replace(/[^a-z0-9]+/gi, '-'), JSON.stringify(policy));
  const r = H.runBin('git-sign', basicCommitArgs(repo, p), { gnupgHome: gpg.gnupgHome });
  T.exit('AC-48 ' + desc + ': refusal, exit 1', r, 1);
  T.contains('AC-48 ' + desc + ': names the problem', r.stderr, mustContain);
}

{
  const gpg = H.setupGpg('ac48-schema');
  if (gpg) {
    const repo = H.initRepoNoSignConfig('ac48-schema', gpg);
    H.commit(repo, gpg, 'root', { 'a.txt': 'one\n' }, { date: '@1000000000 +0000' });

    expectRefusal('unknown top-level key', repo, gpg, { bogus: 1 }, 'unknown key');
    expectRefusal('missing signingKey', repo, gpg, { signingKey: undefined }, 'missing key');
    expectRefusal('bad timezone', repo, gpg, { timezone: 'Mars/Phobos' }, 'timezone');
    expectRefusal('signingKey too short', repo, gpg, { signingKey: 'AB' }, 'signingKey');
    expectRefusal('window missing to', repo, gpg, { forbiddenWindows: [{ days: ['mon'], from: '07:00' }] }, 'forbiddenWindows');
    expectRefusal('window from after to', repo, gpg, { forbiddenWindows: [{ days: ['mon'], from: '20:00', to: '07:00' }] }, 'forbiddenWindows');
    expectRefusal('window bad day name', repo, gpg, { forbiddenWindows: [{ days: ['someday'], from: '07:00', to: '19:00' }] }, 'forbiddenWindows');
    expectRefusal('invalid regex pattern', repo, gpg, { forbiddenMessagePatterns: ['(unclosed'] }, 'forbiddenMessagePatterns');
    expectRefusal('identity not an object', repo, gpg, { identity: 'nope' }, 'identity');
    expectRefusal('identity unknown key', repo, gpg, { identity: { name: 'X', email: 'x@example.invalid', extra: 1 } }, 'identity');
    expectRefusal('anonymousBefore not a string', repo, gpg, { anonymousBefore: 12345 }, 'anonymousBefore');
    expectRefusal('anonymousBefore unparseable date', repo, gpg, { anonymousBefore: 'not-a-date' }, 'anonymousBefore');

    const validWithAnon = Object.assign({}, VALID, { signingKey: gpg.fingerprint, anonymousBefore: '1971-01-01T00:00:00Z' });
    const p = writeRaw('ac48-anonymousBefore-valid', JSON.stringify(validWithAnon));
    const r = H.runBin('git-sign', basicCommitArgs(repo, p), { gnupgHome: gpg.gnupgHome });
    T.exit('AC-48 anonymousBefore valid ISO string: accepted (dry run), exit 0', r, 0);
  }
}

T.finish();
