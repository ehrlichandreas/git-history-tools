/* AC-94 -- § 2.1 / D22 (Reviewer R3): more secret shapes. camelCase
 * names were missed, because the name had to end in the word after `_`,
 * `.` or `-`: `authToken`, `dbPassword`, `awsSecretAccessKey`. They are
 * found now, case-sensitive, after a lowercase letter or digit, for
 * Token, Secret, Password, ApiKey, AccessKey and PrivateKey; never a bare
 * `Key` (`sortKey`, `cacheKey` are everywhere). `apikey` written flat, in
 * any case, is a name of its own. New prefixes: GitHub fine-grained
 * `github_pat_`, Stripe `sk_live_`/`rk_live_`, Google `AIza`, GitLab
 * `glpat-`. camelCase names keep the digit rule; the prefixes need two
 * of lowercase, uppercase and digit, so placeholders stay quiet but a
 * real token without a digit is found. Each has a near miss that must
 * stay quiet. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-leak-scan');

/* Every fake token is put together at run time, so that no file carries
 * a whole one: GitHub's push protection rejects a push that does. */
const PAT = 'github_pat_' + '11ABCDEFG0'.repeat(2) + 'ab' + '_' + 'Zx9Yw8Vu7T'.repeat(5) + 'abcdefghi';
const STRIPE = 'sk_live_' + '4eC39HqLyjWDarjtT1zdp7dc';
const STRIPE_R = 'rk_live_' + '51H8xYzAbCdEfGh1234567890';
const GOOGLE = 'AIza' + 'SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY';
const GITLAB = 'glpat-' + 'xY9-Ab3_cD5eF7gH1iJk';
const GITLAB_NO_DIGIT = 'glpat-' + 'AbCdEfGhIjKlMnOpQrSt';
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG' + '+bPxRfiCYEXAMPLEKEY';

/* [line in secrets.txt, the exact match it must be reported as] */
const POSITIVE: [string, string][] = [
  ['authToken = "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2"', 'authToken = "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2'],
  ['const dbPassword: "s3cretPassw0rdValue1234"', 'dbPassword: "s3cretPassw0rdValue1234'],
  ['awsSecretAccessKey=' + AWS_SECRET, 'awsSecretAccessKey=' + AWS_SECRET],
  ['clientSecret: Q1w2E3r4T5y6U7i8O9p0Aa', 'clientSecret: Q1w2E3r4T5y6U7i8O9p0Aa'],
  ['slackApiKey=AbCdEfGhIjKlMnOpQrStUvWx', 'slackApiKey=AbCdEfGhIjKlMnOpQrStUvWx'],
  ['sshPrivateKey: "k3yMaterialThatIsLongEnough"', 'sshPrivateKey: "k3yMaterialThatIsLongEnough'],
  ['user2Token=AbCdEfGhIjKlMnOpQrStUv12', 'user2Token=AbCdEfGhIjKlMnOpQrStUv12'],
  ['APIKEY=AbCdEfGhIjKlMnOpQrStUv12', 'APIKEY=AbCdEfGhIjKlMnOpQrStUv12'],
  ['apiKey: "AbCdEfGhIjKlMnOpQrStUv12"', 'apiKey: "AbCdEfGhIjKlMnOpQrStUv12'],
  ['x_apikey = AbCdEfGhIjKlMnOpQrStUv12', 'x_apikey = AbCdEfGhIjKlMnOpQrStUv12'],
  ['gh ' + PAT, PAT],
  ['stripe ' + STRIPE, STRIPE],
  ['stripe ' + STRIPE_R, STRIPE_R],
  ['google ' + GOOGLE, GOOGLE],
  ['gitlab ' + GITLAB, GITLAB],
  /* No digit, but mixed case: a real token, which the digit rule would miss. */
  ['gitlab ' + GITLAB_NO_DIGIT, GITLAB_NO_DIGIT],
];

/* Each line is a near miss of one shape above and must not be reported. */
const NEGATIVE: string[] = [
  'sortKey: "createdAtDescendingOrder"',
  'cacheKey = "user_profile_settings_v2_page"',
  'getToken = fetchTokenFromVaultWithRetries()',
  'authtoken: readFromTheEnvironmentPlease',
  'authtoken=AbCdEfGhIjKlMnOpQrStUv12',
  'AuthToken: readFromTheEnvironmentPlease',
  'dbPassword = loadPasswordFromSecretStore()',
  'TOKEN_NAME: authTokenHeaderFieldName',
  'apikeys = loadAllApiKeysFromConfigFile()',
  'apikey: getFromEnvironmentVariable',
  'github_pat_' + 'X'.repeat(82),
  'github_pat_tooShort123',
  'sk_test_' + '4eC39HqLyjWDarjtT1zdp7dc',
  'sk_live_' + 'x'.repeat(24),
  'sk_live_short123',
  'AIza' + 'X'.repeat(35),
  'AIzaTooShort123',
  'glpat-' + 'x'.repeat(20),
  'glpat-short123',
  'glpat-' + 'your-token-goes-here',
];

const gpg = H.setupGpg('ac94');
if (gpg) {
  const repo = H.initRepo('ac94', gpg);
  const c = H.commit(repo, gpg, 'fixtures', {
    'secrets.txt': POSITIVE.map(([l]) => l + '\n').join(''),
    'clean.txt': NEGATIVE.map((l) => l + '\n').join(''),
  });
  const short = H.shortSha(repo, gpg, c.sha!);
  const allow = path.join(H.freshDir('ac94-allow'), 'allow.txt');
  fs.writeFileSync(allow, H.FIXTURE_EMAIL + '\n');

  const r = H.runBin('git-leak-scan', ['scan', repo, '--allow', allow], { gnupgHome: gpg.gnupgHome });
  T.exit('AC-94: hits found, exit 1', r, 1);
  const lines = r.stdout.split('\n').filter(Boolean);
  for (const [line, match] of POSITIVE) {
    T.check('AC-94 [found]: ' + line, lines.includes('scan: secret ' + match + ' (1) first at ' + short + ':secrets.txt'),
      'want "' + match + '" in:\n' + r.stdout);
  }
  T.eq('AC-94: one line per positive, nothing else', lines.length, POSITIVE.length);
  T.eq('AC-94: nothing on stderr', r.stderr, '');

  /* Every negative on its own, so a hit names the line that caused it. */
  for (const line of NEGATIVE) {
    const one = H.initRepo('ac94-neg', gpg);
    H.commit(one, gpg, 'one line', { 'clean.txt': line + '\n' });
    const n = H.runBin('git-leak-scan', ['scan', one, '--allow', allow], { gnupgHome: gpg.gnupgHome });
    T.check('AC-94 [not found]: ' + line, n.status === 0 && n.stdout === '', n.status + ' ' + n.stdout + n.stderr);
  }
}

T.finish();
