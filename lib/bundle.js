'use strict';
/* § 4.1: the backup bundle, created before any ref is touched. */
const path = require('path');
const git = require('./git.js');

function utcStamp(d) {
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    'T' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
}

/** Creates <parent-of-repo>/<repo-basename>.backup-<UTC>.bundle, --all,
 * capturing every ref as it stands right now. Returns the bundle path. */
function createBackupBundle(repo, env) {
  const base = path.basename(repo);
  const dir = path.dirname(repo);
  const stamp = utcStamp(new Date());
  const bundlePath = path.join(dir, base + '.backup-' + stamp + '.bundle');
  git.text(repo, ['bundle', 'create', bundlePath, '--all'], { env });
  return bundlePath;
}

module.exports = { createBackupBundle };
