/* AC-100 -- § 0 (D23): every tool has git-sign's help form (AC-64). Only
 * git-sign had one; `git-release-squash --help` was "unknown subcommand
 * '--help'" and `<sub> --help` "unknown flag '--help'", both exit 2. Now
 * `<bin> --help`/`-h`/`help` prints `usage:` and every synopsis, exactly
 * the lines of the tool's "Synopses" block in docs/SPECIFICATION.md, and
 * `<bin> <sub> --help` (or `-h`, among other arguments that would be a
 * usage error) prints `usage: <its synopsis>`; both exit 0 with nothing on
 * stderr. Reading the synopses from the spec keeps the two from drifting. */
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../lib/harness.ts';
const T = H.T;

const BINS = ['git-release-squash', 'git-leak-scan', 'git-history-rewrite', 'git-sign'];
for (const b of BINS) H.requireBin(b);

const spec = fs.readFileSync(path.join(H.ROOT, 'docs', 'SPECIFICATION.md'), 'utf8');
function specSynopses(bin: string): string[] {
  const m = new RegExp('^Synops[ie]s \\(`' + bin + ' --help`, § 0\\):\\n\\n```\\n([^`]*)```$', 'm').exec(spec);
  return m ? m[1].split('\n').filter(Boolean) : [];
}

for (const bin of BINS) {
  const synopses = specSynopses(bin);
  T.check(bin + ': the spec has a synopses block', synopses.length > 0, '');
  for (const word of ['--help', '-h', 'help']) {
    const r = H.runBin(bin, [word]);
    const l = 'AC-100 ' + bin + ' ' + word;
    T.exit(l + ': exit 0', r, 0);
    T.eq(l + ': nothing on stderr', r.stderr, '');
    const lines = r.stdout.split('\n');
    T.eq(l + ': first line usage:', lines[0], 'usage:');
    T.eq(l + ': exactly the spec synopses, in order', lines.filter((x) => x.startsWith('  ')).map((x) => x.slice(2)).join('\n'), synopses.join('\n'));
    T.check(l + ': one closing line naming the spec', lines.length === synopses.length + 3 && /docs\/SPECIFICATION\.md § \d\.$/.test(lines[lines.length - 2]), r.stdout);
  }
  for (const s of synopses) {
    const sub = s.split(' ')[1];
    for (const args of [[sub, '--help'], [sub, '/nonexistent', '--bogus', '-h', 'extra']]) {
      const r = H.runBin(bin, args);
      const l = 'AC-100 ' + bin + ' ' + args.join(' ');
      T.exit(l + ': exit 0', r, 0);
      T.eq(l + ': exactly its own synopsis', r.stdout, 'usage: ' + s + '\n');
      T.eq(l + ': nothing on stderr', r.stderr, '');
    }
  }
  const unknown = H.runBin(bin, ['nosuch', '--help']);
  T.exit('AC-100 ' + bin + ' nosuch --help: still the unknown subcommand, exit 2', unknown, 2);
  T.eq('AC-100 ' + bin + ' nosuch --help: one stderr line', unknown.stderr, bin + ': unknown subcommand \'nosuch\'\n');
}

T.finish();
