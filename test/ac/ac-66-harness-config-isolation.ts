/* AC-66 -- test hygiene: nothing a test runs reads the machine's own
 * configuration. The harness gives every process it starts (and, through
 * process.env, every child those start) GIT_CONFIG_GLOBAL=/dev/null,
 * GIT_CONFIG_NOSYSTEM=1 and an empty XDG_CONFIG_HOME of its own under the
 * tmp root -- so neither ~/.gitconfig / /etc/gitconfig nor git-sign's
 * default policy ($XDG_CONFIG_HOME, else $HOME/.config,
 * /git-history-tools/policy.json) can leak in. A test that forgets
 * --policy= is refused for a missing policy at the isolated location,
 * never handed the owner's policy.
 * HOME itself is left alone. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as H from '../lib/harness.ts';
const T = H.T;

H.requireBin('git-sign');

const xdg = process.env.XDG_CONFIG_HOME || '';
T.check('AC-66: XDG_CONFIG_HOME is set, to a directory of its own under the tmp root',
  xdg !== '' && path.dirname(xdg) === H.TMP_ROOT && fs.existsSync(xdg), xdg);
T.eq('AC-66: GIT_CONFIG_GLOBAL is /dev/null', process.env.GIT_CONFIG_GLOBAL, '/dev/null');
T.eq('AC-66: GIT_CONFIG_NOSYSTEM is 1', process.env.GIT_CONFIG_NOSYSTEM, '1');

const repo = H.freshDir('ac66-repo');
spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
const defaultPolicy = path.join(xdg, 'git-history-tools', 'policy.json');

/* The scenario itself: git-sign without --policy. HOME is an empty dir, so
 * a regressed isolation fails here without ever reading the owner's real
 * policy. */
{
  const emptyHome = H.freshDir('ac66-emptyhome');
  const r = H.runBin('git-sign', ['check', repo], { env: { HOME: emptyHome } });
  T.exit('AC-66: git-sign check without --policy (empty HOME): exit 1', r, 1);
  T.check('AC-66: (empty HOME) it names the isolated default policy path',
    xdg !== '' && r.stderr.includes(defaultPolicy), r.stderr);
  T.check('AC-66: (empty HOME) not a path under HOME', !r.stderr.includes(emptyHome), r.stderr);
}

/* Machine-independent: a decoy HOME that HAS a policy and a .gitconfig, and
 * a decoy system config. With the isolation none of them is read. */
const home = H.freshDir('ac66-home');
fs.mkdirSync(path.join(home, '.config', 'git-history-tools'), { recursive: true });
fs.writeFileSync(path.join(home, '.config', 'git-history-tools', 'policy.json'), '{"decoy": true}\n');
fs.writeFileSync(path.join(home, '.gitconfig'), '[ac66]\n\tmarker = global\n');
const sysConfig = path.join(home, 'system-gitconfig');
fs.writeFileSync(sysConfig, '[ac66]\n\tmarker = system\n');
{
  const r = H.runBin('git-sign', ['check', repo], { env: { HOME: home } });
  T.exit('AC-66: with a decoy HOME holding a policy, git-sign check without --policy: exit 1', r, 1);
  T.check('AC-66: (decoy HOME) it names the isolated default policy path',
    xdg !== '' && r.stderr.includes(defaultPolicy), r.stderr);
  T.check('AC-66: (decoy HOME) never the decoy HOME\'s policy', !r.stderr.includes(home), r.stderr);
  const g = spawnSync('git', ['config', '--get-all', 'ac66.marker'],
    { cwd: repo, env: Object.assign({}, process.env, { HOME: home, GIT_CONFIG_SYSTEM: sysConfig }), encoding: 'utf8' });
  T.eq('AC-66: git reads neither the decoy ~/.gitconfig nor the decoy system config', g.stdout, '');
}

T.finish();
