/* AC-86 -- § 0 / D21: a tool run with no subcommand. git-release-squash,
 * git-history-rewrite and git-leak-scan said "unknown subcommand
 * 'undefined'". Now it is the usage error `<bin>: missing subcommand
 * (usage: <bin> <subcommands> <repo> ...)`, one stderr line, exit 2,
 * nothing on stdout. git-sign already printed its full usage (§ 5). */
import * as H from '../lib/harness.ts';
const T = H.T;

for (const [bin, subs] of [
  ['git-release-squash', 'plan|apply|tail'],
  ['git-history-rewrite', 'replace|add-file'],
  ['git-leak-scan', 'scan'],
] as [string, string][]) {
  H.requireBin(bin);
  const r = H.runBin(bin, []);
  T.exit('AC-86 [' + bin + ']: a usage error, exit 2', r, 2);
  T.eq('AC-86 [' + bin + ']: one stderr line with the usage', r.stderr, bin + ': missing subcommand (usage: ' + bin + ' ' + subs + ' <repo> ...)\n');
  T.eq('AC-86 [' + bin + ']: nothing on stdout', r.stdout, '');
}

T.finish();
