/* AC-87 -- § 2.1 / D22: the `secret` category finds the common shapes.
 * The old key=value pattern started with `\b`, which cannot match after
 * `_` (so `API_KEY=…` and `GITHUB_TOKEN=…` were missed), took only `=`
 * with nothing around it, and no `+` or `/` in the value; the PEM check
 * missed `-----BEGIN PGP PRIVATE KEY BLOCK-----`; and well-known token
 * prefixes were not recognised at all. Every new shape has a positive
 * line in secrets.txt and a near miss in clean.txt that must stay quiet:
 * a spaced or `:` form needs a digit in the value, so ordinary code and
 * config (`token = generate_authentication_token()`) is not a secret. A
 * token inside a longer secret hit (`GITHUB_TOKEN=ghp_…`, `Bearer eyJ…`)
 * is reported once, as the longer hit. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-leak-scan');

/* Every fake token is put together at run time, so that no file carries
 * a whole one: GitHub's push protection rejects a push that does. */
const GHP = 'ghp_' + 'aB3'.repeat(12);
const GHO = 'gho_' + 'Zy9'.repeat(12);
const GHS = 'ghs_' + 'q7W'.repeat(12);
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'].join('.');
const SLACK = ['xoxb', '123456789012', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-');
const SLACKP = ['xoxp', '210987654321', '3210987654321', 'ZyXwVuTsRqPoNmLkJiHgFeDc'].join('-');
const AKIA = 'AKIA' + 'IOSFODNN7EXAMPLE';
const ASIA = 'ASIA' + 'Y34FZKBOKMUTVV7A';
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG' + '+bPxRfiCYEXAMPLEKEY';

/* [line in secrets.txt, the exact match it must be reported as] */
const POSITIVE: [string, string][] = [
  ['API_KEY=AbCdEfGhIjKlMnOpQrStUv12', 'API_KEY=AbCdEfGhIjKlMnOpQrStUv12'],
  ['export GITHUB_TOKEN=Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2', 'GITHUB_TOKEN=Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2'],
  ['password: s3cretPassw0rdValue1234', 'password: s3cretPassw0rdValue1234'],
  ['{"client_secret": "Q1w2E3r4T5y6U7i8O9p0Aa"}', 'client_secret": "Q1w2E3r4T5y6U7i8O9p0Aa'],
  ['db_password = Pa55w0rdWithSpaces12345', 'db_password = Pa55w0rdWithSpaces12345'],
  ['aws_secret_access_key=' + AWS_SECRET, 'aws_secret_access_key=' + AWS_SECRET],
  ["x-api-key: 'k3y.W1th.D0ts.And.Padding=='", "x-api-key: 'k3y.W1th.D0ts.And.Padding=="],
  ['-----BEGIN PGP PRIVATE KEY BLOCK-----', '-----BEGIN PGP PRIVATE KEY BLOCK-----'],
  ['aws id ' + AKIA + ' here', AKIA],
  ['session ' + ASIA + ' here', ASIA],
  ['gh ' + GHP, GHP],
  ['gh ' + GHO, GHO],
  ['gh ' + GHS, GHS],
  ['slack ' + SLACK, SLACK],
  ['slack ' + SLACKP, SLACKP],
  ['jwt ' + JWT + ' end', JWT],
  ['Authorization: Bearer 4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c', 'Bearer 4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c'],
  /* A token inside a longer secret: one hit, the longer one. */
  ['GITHUB_PAT_TOKEN=' + GHO.replace('gho_', 'ghp_'), 'GITHUB_PAT_TOKEN=' + GHO.replace('gho_', 'ghp_')],
  ['Authorization: Bearer ' + JWT, 'Bearer ' + JWT],
];

/* Each line is a near miss of one shape above and must not be reported. */
const NEGATIVE: string[] = [
  'cache_key = build_cache_key_for_request(x)',
  'token = generate_authentication_token()',
  'primary_key: user_account_identifier_column',
  'monkey=abcdefghijklmnopqrstuvwx12',
  'secret_value=abcdefghijklmnopqrstuvwx1',
  'password: ${{ secrets.DB_PASSWORD }}',
  'api_key = os.environ["API_KEY"]',
  '-----BEGIN PGP PUBLIC KEY BLOCK-----',
  '-----BEGIN PGP SIGNATURE-----',
  'AKIA1234 is too short',
  'akiaiosfodnn7example is lowercase',
  'X' + AKIA + ' is inside a word',
  'ghp_shortplaceholder',
  'ghp_' + 'X'.repeat(36),
  'xoxb-your-token-here',
  'eyJhbGciOiJIUzI1NiJ9 is a header alone',
  'use a Bearer token in the Authorization header',
  'Authorization: Bearer ${TOKEN}',
  'Bearer authentication-scheme-described-here',
];

const gpg = H.setupGpg('ac87');
if (gpg) {
  const repo = H.initRepo('ac87', gpg);
  const c = H.commit(repo, gpg, 'fixtures', {
    'secrets.txt': POSITIVE.map(([l]) => l + '\n').join(''),
    'clean.txt': NEGATIVE.map((l) => l + '\n').join(''),
  });
  H.commit(repo, gpg, 'second', { 'other.txt': 'x\n' });
  const short = H.shortSha(repo, gpg, c.sha!);
  const allow = path.join(H.freshDir('ac87-allow'), 'allow.txt');
  fs.writeFileSync(allow, H.FIXTURE_EMAIL + '\n');

  const r = H.runBin('git-leak-scan', ['scan', repo, '--allow', allow], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-87: hits found, exit 1', r, 1);
  const lines = r.stdout.split('\n').filter(Boolean);
  for (const [line, match] of POSITIVE) {
    T.check('AC-87 [found]: ' + line, lines.includes('scan: secret ' + match + ' (2) first at ' + short + ':secrets.txt'),
      'want "' + match + '" in:\n' + r.stdout);
  }
  T.eq('AC-87: one line per positive, nothing else', lines.length, POSITIVE.length);
  T.eq('AC-87 [not found]: nothing from clean.txt', lines.filter((l) => l.endsWith(':clean.txt')).join('\n'), '');
  T.eq('AC-87: nothing on stderr', r.stderr, '');

  /* A binary blob gets the private-key header check only, and that check knows the PGP form too. */
  const bin = H.initRepo('ac87-bin', gpg);
  const cb = H.commit(bin, gpg, 'binary key', { 'key.gpg': Buffer.concat([Buffer.from([0x99, 0x00, 0x01]),
    Buffer.from('\n-----BEGIN PGP PRIVATE KEY BLOCK-----\n'), Buffer.from([0x00, 0xff])]) });
  const b = H.runBin('git-leak-scan', ['scan', bin, '--allow', allow], { gnupgHome: gpg.gnupgHome });
  T.eq('AC-87 [found]: a PGP private key block inside a binary blob', b.stdout,
    'scan: secret -----BEGIN PGP PRIVATE KEY BLOCK----- (1) first at ' + H.shortSha(bin, gpg, cb.sha!) + ':key.gpg\n');

  /* Every negative on its own, so a hit names the line that caused it. */
  for (const line of NEGATIVE) {
    const one = H.initRepo('ac87-neg', gpg);
    H.commit(one, gpg, 'one line', { 'clean.txt': line + '\n' });
    const n = H.runBin('git-leak-scan', ['scan', one, '--allow', allow], { gnupgHome: gpg.gnupgHome });
    T.check('AC-87 [not found]: ' + line, n.status === 0 && n.stdout === '', n.status + ' ' + n.stdout + n.stderr);
  }
}

T.finish();
