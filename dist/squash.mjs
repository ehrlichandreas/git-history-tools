#!/usr/bin/env node

// lib/squash.ts
import fs4 from "node:fs";
import path5 from "node:path";

// lib/git.ts
import { spawnSync } from "node:child_process";
import path from "node:path";
var GitError = class extends Error {
  args;
  result;
  constructor(args, result) {
    super("git " + args.join(" ") + " failed: " + (result.stderr || "").trim());
    this.args = args;
    this.result = result;
  }
};
var CALLER_GIT_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR"
];
function callerGitEnvNames(env) {
  return Object.keys(env).filter((k) => CALLER_GIT_ENV.includes(k) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k));
}
var IDENTITY_KEYS = ["user.name", "user.email", "user.signingkey"];
function callerIdentityConfig(env) {
  const n = parseInt(env.GIT_CONFIG_COUNT || "", 10);
  const out = [];
  for (let i = 0; i < (n > 0 ? n : 0); i++) {
    const k = env["GIT_CONFIG_KEY_" + i];
    const v = env["GIT_CONFIG_VALUE_" + i];
    if (k !== void 0 && v !== void 0 && IDENTITY_KEYS.includes(k.toLowerCase())) out.push([k, v]);
  }
  return out;
}
function configCountEnv(pairs) {
  if (pairs.length === 0) return {};
  return Object.assign(
    { GIT_CONFIG_COUNT: String(pairs.length) },
    ...pairs.map(([k, v], i) => ({ ["GIT_CONFIG_KEY_" + i]: k, ["GIT_CONFIG_VALUE_" + i]: v }))
  );
}
var NO_REPO_CODE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
function run(repo, args, opts) {
  const o = opts || {};
  const env = Object.assign({}, process.env, o.env || {});
  for (const k of CALLER_GIT_ENV) if (k !== "GIT_CONFIG_COUNT") delete env[k];
  env.GIT_NO_REPLACE_OBJECTS = "1";
  const pre = NO_REPO_CODE.concat(o.config || []);
  const r = spawnSync("git", ["-C", repo].concat(pre, args), {
    env,
    input: o.input,
    encoding: o.raw ? null : "utf8",
    maxBuffer: 1 << 30
  });
  return {
    status: r.status,
    stdout: r.stdout == null ? o.raw ? Buffer.alloc(0) : "" : r.stdout,
    stderr: r.stderr == null ? "" : o.raw ? r.stderr.toString("utf8") : r.stderr
  };
}
function text(repo, args, opts) {
  const r = run(repo, args, opts);
  if (r.status !== 0) throw new GitError(args, r);
  return r.stdout.replace(/\n$/, "");
}
function buffer(repo, args, opts) {
  const r = run(repo, args, Object.assign({}, opts, { raw: true }));
  if (r.status !== 0) throw new GitError(args, r);
  return r.stdout;
}
function isRepo(dir) {
  const r = run(dir, ["rev-parse", "--git-dir"]);
  return r.status === 0;
}
function topLevel(dir) {
  const b = run(dir, ["rev-parse", "--is-bare-repository", "--absolute-git-dir", "--is-inside-git-dir"]);
  if (b.status !== 0) return null;
  const [bare, gitDir, insideGitDir] = b.stdout.split("\n");
  if (bare === "true") return gitDir;
  if (insideGitDir === "true") {
    const wt = run(gitDir, ["config", "--get", "core.worktree"]);
    if (wt.status === 0) return path.resolve(gitDir, wt.stdout.replace(/\n$/, ""));
    return path.basename(gitDir) === ".git" ? path.dirname(gitDir) : null;
  }
  const t = run(dir, ["rev-parse", "--show-toplevel"]);
  return t.status === 0 ? t.stdout.replace(/\n$/, "") : null;
}
function moveRefs(repo, env, message, moves) {
  const lines = ["start"];
  for (const m of moves) {
    lines.push(m.oldSha === null ? "create " + m.ref + " " + m.newSha : "update " + m.ref + " " + m.newSha + " " + m.oldSha);
  }
  lines.push("prepare", "commit");
  return run(repo, ["update-ref", "-m", message, "--stdin"], { env, input: lines.join("\n") + "\n" });
}
function committerIdent(repo, env) {
  return text(repo, ["var", "GIT_COMMITTER_IDENT"], { env });
}
function refBase(ref, namespace) {
  if (!ref.startsWith(namespace)) throw new Error("refBase: " + ref + " is not under " + namespace);
  return ref.slice(namespace.length);
}
function isValidTagName(name) {
  if (name === "" || name.startsWith("-")) return false;
  return spawnSync("git", ["check-ref-format", "refs/tags/" + name], { encoding: "utf8" }).status === 0;
}
function configGet(repo, key, opts) {
  const r = run(repo, ["config", "--get", key], opts);
  if (r.status !== 0) return null;
  return r.stdout.replace(/\n$/, "");
}

// lib/cli.ts
import path2 from "node:path";
import fs from "node:fs";
var UsageError = class extends Error {
};
var Refusal = class extends Error {
};
function parseFlags(args, spec) {
  const valueFlags = new Set(spec.valueFlags || []);
  const boolFlags = new Set(spec.boolFlags || []);
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      if (valueFlags.has(name)) {
        let value;
        if (eq !== -1) value = a.slice(eq + 1);
        else {
          i++;
          value = args[i];
          if (value !== void 0 && value.startsWith("--")) value = void 0;
        }
        if (value === void 0) throw new UsageError("missing value for " + name);
        flags[name.slice(2)] = value;
      } else if (boolFlags.has(name)) {
        if (eq !== -1) throw new UsageError("unknown flag '" + a + "'");
        flags[name.slice(2)] = true;
      } else {
        throw new UsageError("unknown flag '" + a + "'");
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}
function requireRepo(repo) {
  if (!isRepo(repo)) throw new Refusal("not a git repository (" + repo + ")");
  const top = topLevel(repo);
  if (top === null || fs.realpathSync(top) !== fs.realpathSync(repo)) {
    throw new Refusal("not the top level of its repository (" + repo + "; the top level is " + (top === null ? "unknown" : fs.realpathSync(top)) + ")");
  }
}
function main(bin, fn) {
  const identity = callerIdentityConfig(process.env);
  for (const k of callerGitEnvNames(process.env)) delete process.env[k];
  Object.assign(process.env, configCountEnv(identity));
  process.env.GIT_NO_REPLACE_OBJECTS = "1";
  try {
    fn(bin);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(bin + ": " + e.message + "\n");
      process.exit(2);
    }
    if (e instanceof Refusal) {
      process.stderr.write(bin + ": " + e.message + "\n");
      process.exit(1);
    }
    throw e;
  }
}

// lib/encoding.ts
var UTF8 = new TextDecoder("utf-8", { fatal: true });
function nonUtf8Reason(raw) {
  const end = raw.indexOf("\n\n");
  const head = (end === -1 ? raw : raw.subarray(0, end)).toString("latin1");
  const m = /^encoding (.*)$/m.exec(head);
  if (m && !/^utf-?8$/i.test(m[1].trim())) return "encoding " + m[1].trim();
  try {
    UTF8.decode(raw);
  } catch {
    return "bytes that are not valid UTF-8 in its message or identity";
  }
  return null;
}
function refuseNonUtf8(repo, env, objects) {
  const seen = /* @__PURE__ */ new Set();
  const list = objects.filter((o) => !seen.has(o.sha) && seen.add(o.sha));
  if (list.length === 0) return;
  const out = buffer(repo, ["cat-file", "--batch"], { env, input: list.map((o) => o.sha).join("\n") + "\n" });
  let pos = 0;
  for (const o of list) {
    const nl = out.indexOf(10, pos);
    const size = Number(out.subarray(pos, nl).toString("latin1").split(" ")[2]);
    const why = nonUtf8Reason(out.subarray(nl + 1, nl + 1 + size));
    if (why) throw new UsageError(o.label + " is not UTF-8 (" + why + "); ght rewrites UTF-8 objects only, nothing written");
    pos = nl + 1 + size + 1;
  }
}

// lib/signer.ts
import fs2 from "node:fs";
import os from "node:os";
import path3 from "node:path";
import { spawnSync as spawnSync2 } from "node:child_process";
var PIN_OTHER_SIGNERS = [
  ["gpg.format", "openpgp"],
  ["gpg.ssh.program", ""],
  ["gpg.x509.program", ""]
];
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
function keyCreationTime(gpgProgram, signingKey, env) {
  const r = spawnSync2(gpgProgram, ["--batch", "--list-keys", "--with-colons", "--", signingKey], { env, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Refusal("could not read the signing key (" + signingKey + ") via " + gpgProgram + " --list-keys: " + (r.stderr || "").trim());
  }
  const line2 = (r.stdout || "").split("\n").find((l) => l.startsWith("pub:"));
  if (!line2) throw new Refusal("no pub record for signing key " + signingKey);
  const fields = line2.split(":");
  const created = parseInt(fields[5], 10);
  if (!Number.isFinite(created)) throw new Refusal("could not parse creation time for signing key " + signingKey);
  return created;
}
function createSigner(repo, env, opts) {
  const gpgProgram = opts && opts.gpgProgram || configGet(repo, "gpg.program", { env }) || "gpg";
  const explicitKey = opts && opts.signingKey;
  const signingKey = explicitKey || configGet(repo, "user.signingkey", { env });
  if (!signingKey) throw new Refusal("no user.signingkey configured for " + repo);
  if (signingKey.startsWith("-")) {
    throw new UsageError('user.signingkey "' + signingKey + '" starts with "-", which gpg would read as an option; nothing written');
  }
  const created = keyCreationTime(gpgProgram, signingKey, env);
  const signTime = opts && opts.signTime !== void 0 ? opts.signTime : created + 60;
  const dir = fs2.mkdtempSync(path3.join(os.tmpdir(), "ght-signer-"));
  let wrapperPath;
  try {
    wrapperPath = path3.join(dir, "gpg-wrapper.sh");
    fs2.writeFileSync(
      wrapperPath,
      "#!/bin/sh\nexec " + shQuote(gpgProgram) + " --faked-system-time " + signTime + '! "$@"\n'
    );
    fs2.chmodSync(wrapperPath, 493);
  } catch (e) {
    try {
      fs2.rmSync(dir, { recursive: true, force: true });
    } catch (e2) {
    }
    throw e;
  }
  const gitConfig = ["-c", "gpg.program=" + wrapperPath].concat(PIN_OTHER_SIGNERS.flatMap(([k, v]) => ["-c", k + "=" + v]));
  if (explicitKey) gitConfig.push("-c", "user.signingkey=" + explicitKey);
  return {
    gitConfig,
    signTime,
    gpgProgram: wrapperPath,
    signingKey,
    cleanup() {
      try {
        fs2.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
      }
    }
  };
}
function signTagTextDetached(signer, env, text2) {
  const r = spawnSync2(signer.gpgProgram, ["--batch", "--status-fd=2", "-bsau", signer.signingKey], {
    env,
    input: text2,
    encoding: "utf8"
  });
  if (r.status !== 0) {
    throw new Refusal("failed to sign tag object: " + (r.stderr || "").trim().split("\n").pop());
  }
  return r.stdout;
}
function signableTagMessage(message) {
  return message !== "" && !message.endsWith("\n") ? message + "\n" : message;
}
function buildSignedTagObject(repo, env, signer, args) {
  const text2 = "object " + args.object + "\ntype " + args.type + "\ntag " + args.name + "\ntagger " + args.taggerLine + "\n\n" + signableTagMessage(args.message);
  const sig = signTagTextDetached(signer, env, text2);
  const full = text2 + sig;
  const r = run(repo, ["hash-object", "-t", "tag", "-w", "--stdin"], { env, input: full });
  if (r.status !== 0) {
    throw new Refusal("failed to write tag object for " + args.name + ": " + r.stderr.trim().split("\n")[0]);
  }
  return r.stdout.trim();
}

// lib/bundle.ts
import fs3 from "node:fs";
import path4 from "node:path";
function utcStamp(d) {
  const p = (n, w) => String(n).padStart(w || 2, "0");
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + "T" + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + "Z";
}
function createBackupBundle(repo, env) {
  const top = topLevel(repo);
  if (top === null || fs3.realpathSync(top) !== fs3.realpathSync(repo)) {
    throw new Error("createBackupBundle: " + repo + " is not the top level of its repository");
  }
  const absRepo = fs3.realpathSync(top);
  const base = path4.basename(absRepo);
  const dir = path4.dirname(absRepo);
  const stamp = utcStamp(/* @__PURE__ */ new Date());
  const bundlePath = path4.join(dir, base + ".backup-" + stamp + ".bundle");
  text(repo, ["bundle", "create", bundlePath, "--all"], { env });
  return bundlePath;
}

// lib/leakscan.ts
import { readFileSync } from "node:fs";

// lib/verify.ts
function line(name, ok, reason) {
  return { ok, line: ok ? "verify: " + name + ": OK" : "verify: " + name + ": FAILED (" + reason + ")" };
}
function verifyTreeDelta(checks) {
  for (const c of checks) {
    if (c.expected !== c.actual) {
      return line("tree delta", false, c.label + ": expected tree " + c.expected + ", got " + c.actual);
    }
  }
  return line("tree delta", true);
}
function verifySignatures(repo, env) {
  const commitsRaw = text(repo, ["rev-list", "--branches", "--tags"], { env });
  const commits = commitsRaw ? commitsRaw.split("\n") : [];
  for (const c of commits) {
    const r = run(repo, ["verify-commit", c], { env });
    if (r.status !== 0) return line("signatures", false, "verify-commit " + c.slice(0, 7) + " failed: " + r.stderr.trim());
  }
  const tagsRaw = text(repo, ["for-each-ref", "--format=%(refname)	%(objecttype)", "refs/tags"], { env });
  const tags = tagsRaw ? tagsRaw.split("\n") : [];
  for (const l of tags) {
    const [ref, type] = l.split("	");
    if (type !== "tag") continue;
    const name = refBase(ref, "refs/tags/");
    const r = run(repo, ["verify-tag", ref], { env });
    if (r.status !== 0) return line("signatures", false, "verify-tag " + name + " failed: " + r.stderr.trim());
  }
  return line("signatures", true);
}
function verifyEveryCommitTagged(repo, env) {
  const commitsRaw = text(repo, ["rev-list", "HEAD"], { env });
  const commits = new Set(commitsRaw ? commitsRaw.split("\n") : []);
  const tagsRaw = text(repo, ["for-each-ref", "--format=%(*objectname)	%(objectname)", "refs/tags"], { env });
  const taggedCommits = /* @__PURE__ */ new Set();
  for (const l of tagsRaw ? tagsRaw.split("\n") : []) {
    const [deref, obj] = l.split("	");
    taggedCommits.add(deref || obj);
  }
  for (const c of commits) {
    if (!taggedCommits.has(c)) return line("squash: every commit tagged", false, c.slice(0, 7) + " is not tagged");
  }
  return line("squash: every commit tagged", true);
}

// lib/squash.ts
function shortSha(repo, env, rev) {
  return text(repo, ["rev-parse", "--short", rev], { env });
}
function firstMergeCommit(repo, env) {
  const out = text(repo, ["rev-list", "--merges", "--topo-order", "HEAD"], { env });
  return out ? out.split("\n")[0] : null;
}
function refuseOnMerge(repo, env) {
  const merge = firstMergeCommit(repo, env);
  if (merge) throw new Refusal("merge commits are not supported (" + shortSha(repo, env, merge) + ")");
}
function revListReverseHead(repo, env) {
  const out = text(repo, ["rev-list", "--reverse", "HEAD"], { env });
  return out ? out.split("\n") : [];
}
function defaultName(repo) {
  let base = path5.basename(path5.resolve(repo));
  if (base.endsWith(".git")) base = base.slice(0, -4);
  return base;
}
function loadTagIndex(repo, env) {
  const out = text(
    repo,
    ["for-each-ref", "--format=%(refname)	%(objecttype)	%(*objectname)	%(objectname)", "refs/tags"],
    { env }
  );
  if (!out) return [];
  return out.split("\n").map((l) => {
    const [ref, type, deref, obj] = l.split("	");
    return { name: refBase(ref, "refs/tags/"), type, commit: type === "tag" ? deref : obj, obj };
  });
}
function groupsFromTags(allCommits, tags) {
  const byCommit = /* @__PURE__ */ new Map();
  for (const t of tags) {
    if (!byCommit.has(t.commit)) byCommit.set(t.commit, []);
    byCommit.get(t.commit).push(t);
  }
  const groups = [];
  let prevIdx = -1;
  for (let i = 0; i < allCommits.length; i++) {
    const c = allCommits[i];
    if (byCommit.has(c)) {
      groups.push({ tip: c, commits: allCommits.slice(prevIdx + 1, i + 1), tags: byCommit.get(c) });
      prevIdx = i;
    }
  }
  return { groups, tailCommits: allCommits.slice(prevIdx + 1) };
}
function titleFor(repo, env, tag) {
  if (tag.type === "tag") {
    const s = text(repo, ["for-each-ref", "--format=%(contents:subject)", "refs/tags/" + tag.name], { env });
    return s === "" ? "(no title)" : s;
  }
  return text(repo, ["log", "-1", "--format=%s", tag.commit], { env });
}
function renderPlanLines(repo, env, name) {
  const allCommits = revListReverseHead(repo, env);
  const tags = loadTagIndex(repo, env);
  const { groups, tailCommits } = groupsFromTags(allCommits, tags);
  const lines = [];
  let lastGroupTagName = null;
  for (const g of groups) {
    const groupOldestShort = shortSha(repo, env, g.commits[0]);
    const tipShort = shortSha(repo, env, g.tip);
    g.tags.forEach((t, i) => {
      const n = i === 0 ? g.commits.length - (g.tags.length - 1) : 1;
      const oldestShort = i === 0 ? groupOldestShort : tipShort;
      const title = titleFor(repo, env, t);
      const tagShort = shortSha(repo, env, "refs/tags/" + t.name);
      lines.push("plan: " + t.name + " folds " + n + " commit(s) (" + oldestShort + ".." + tagShort + ') into "' + title + '"');
      lines.push("plan: " + t.name + " tree equals " + tagShort + "'s own tree: OK");
    });
    lastGroupTagName = g.tags[0].name;
  }
  if (tailCommits.length > 0) {
    if (groups.length === 0) {
      lines.push("plan: " + tailCommits.length + " untagged commit(s) from the start of history are not covered by plan");
    } else {
      lines.push("plan: " + tailCommits.length + " untagged commit(s) after " + lastGroupTagName + " are not covered by plan");
    }
  }
  return { lines, groups, tailCommits, allCommits };
}
function anonDateAt(i) {
  return "@" + ((i + 1) * 86400 + 43200) + " +0000";
}
function rawDateOf(repo, env, rev, which) {
  const raw = text(repo, ["log", "-1", "--format=%" + which + "d", "--date=raw", rev], { env });
  return "@" + raw;
}
function tagRawMessage(repo, env, name) {
  const s = text(repo, ["for-each-ref", "--format=%(contents:subject)", "refs/tags/" + name], { env });
  const b = text(repo, ["for-each-ref", "--format=%(contents:body)", "refs/tags/" + name], { env }).replace(/\s+$/, "");
  return s + (b ? "\n\n" + b : "") + "\n";
}
function cleanTagMessage(repo, env, msg) {
  const r = run(repo, ["stripspace", "--strip-comments"], { env, input: msg });
  if (r.status !== 0) throw new GitError(["stripspace", "--strip-comments"], r);
  return r.stdout;
}
function buildTag(repo, env, signer, name, commit, message) {
  return buildSignedTagObject(repo, env, signer, {
    object: commit,
    type: "commit",
    name,
    taggerLine: committerIdent(repo, env),
    message: cleanTagMessage(repo, env, message)
  });
}
function moveRefsOrRefuse(repo, env, message, moves) {
  const r = moveRefs(repo, env, message, moves);
  if (r.status !== 0) throw new Refusal("ref update transaction failed: " + r.stderr.trim().split("\n")[0]);
}
function currentBranch(repo, env) {
  const r = run(repo, ["symbolic-ref", "HEAD"], { env });
  if (r.status !== 0) throw new Refusal("HEAD is detached");
  return r.stdout.replace(/\n$/, "");
}
function isDirty(repo, env) {
  if (text(repo, ["rev-parse", "--is-bare-repository"], { env }) === "true") return false;
  return text(repo, ["status", "--porcelain", "--untracked-files=no"], { env }) !== "";
}
function cmdPlan(bin, args) {
  const { positional, flags } = parseFlags(args, { valueFlags: ["--name"], boolFlags: [] });
  const repo = positional[0];
  if (!repo) throw new UsageError("missing <repo>");
  requireRepo(repo);
  const env = process.env;
  refuseOnMerge(repo, env);
  const name = flags.name || defaultName(repo);
  const { lines } = renderPlanLines(repo, env, name);
  process.stdout.write(lines.map((l) => l + "\n").join(""));
}
function cmdApply(bin, args) {
  const { positional, flags } = parseFlags(args, {
    valueFlags: ["--map", "--name", "--dates"],
    boolFlags: ["--apply"]
  });
  const repo = positional[0];
  if (!repo) throw new UsageError("missing <repo>");
  if (!flags.map) throw new UsageError("missing --map");
  const mapPath = path5.resolve(flags.map);
  if (!fs4.existsSync(path5.dirname(mapPath)) || !fs4.statSync(path5.dirname(mapPath)).isDirectory()) {
    throw new UsageError("--map: no such directory: " + path5.dirname(mapPath));
  }
  if (fs4.existsSync(mapPath) && fs4.statSync(mapPath).isDirectory()) throw new UsageError("--map: is a directory: " + mapPath);
  const dates = flags.dates || "anon";
  if (dates !== "anon" && dates !== "keep") throw new UsageError("--dates must be 'anon' or 'keep'");
  requireRepo(repo);
  const env = process.env;
  refuseOnMerge(repo, env);
  const allCommits = revListReverseHead(repo, env);
  const oldHead = allCommits[allCommits.length - 1];
  const tags = loadTagIndex(repo, env);
  const { groups, tailCommits } = groupsFromTags(allCommits, tags);
  const headTagged = groups.length > 0 && groups[groups.length - 1].tip === oldHead;
  refuseNonUtf8(repo, env, groups.flatMap((g) => g.tags).filter((t) => t.type === "tag").map((t) => ({ sha: t.obj, label: "tag " + t.name })));
  if (!headTagged) throw new Refusal("HEAD is not tagged -- run 'tail' first");
  const name = flags.name || defaultName(repo);
  const { lines } = renderPlanLines(repo, env, name);
  if (!flags.apply) {
    process.stdout.write(lines.map((l) => l + "\n").join(""));
    process.stdout.write(bin + ": dry run, no ref changed (use --apply to write)\n");
    return;
  }
  if (isDirty(repo, env)) throw new Refusal("working tree is dirty");
  const branch = currentBranch(repo, env);
  const signer = createSigner(repo, env);
  try {
    createBackupBundle(repo, env);
    let parent = null;
    const commitResults = [];
    const mapLines = [];
    let idx = 0;
    for (const g of groups) {
      const tree = text(repo, ["rev-parse", g.tip + "^{tree}"], { env });
      const title = titleFor(repo, env, g.tags[0]);
      const subject = name + " " + g.tags[0].name + ": " + title;
      const authorDate = dates === "anon" ? anonDateAt(idx) : rawDateOf(repo, env, g.tip, "a");
      const committerDate = dates === "anon" ? anonDateAt(idx) : rawDateOf(repo, env, g.tip, "c");
      const ctArgs = ["commit-tree", "-S", tree];
      if (parent) ctArgs.push("-p", parent);
      const nc = text(repo, ctArgs, {
        env: Object.assign({}, env, { GIT_AUTHOR_DATE: authorDate, GIT_COMMITTER_DATE: committerDate }),
        input: subject + "\n",
        config: signer.gitConfig
      });
      const newTree = text(repo, ["rev-parse", nc + "^{tree}"], { env });
      commitResults.push({ g, nc, committerDate, origTree: tree, newTree });
      for (const c of g.commits) mapLines.push(c + " " + g.tags[0].name);
      parent = nc;
      idx++;
    }
    const newHead = commitResults[commitResults.length - 1].nc;
    const moves = [];
    for (const { g, nc, committerDate } of commitResults) {
      for (const t of g.tags) {
        const newObj = t.type === "tag" ? buildTag(repo, Object.assign({}, env, { GIT_COMMITTER_DATE: committerDate }), signer, t.name, nc, tagRawMessage(repo, env, t.name)) : nc;
        moves.push({ ref: "refs/tags/" + t.name, newSha: newObj, oldSha: t.obj });
      }
    }
    moves.push({ ref: branch, newSha: newHead, oldSha: oldHead });
    moveRefsOrRefuse(repo, env, "git-release-squash apply", moves);
    fs4.writeFileSync(mapPath, mapLines.length ? mapLines.join("\n") + "\n" : "");
    const results = [
      verifyTreeDelta(commitResults.map((r) => ({ label: r.g.tip, expected: r.origTree, actual: r.newTree }))),
      verifySignatures(repo, env),
      verifyEveryCommitTagged(repo, env)
    ];
    for (const r of results) process.stdout.write(r.line + "\n");
    process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
  } finally {
    signer.cleanup();
  }
}
function cmdTail(bin, args) {
  const { positional, flags } = parseFlags(args, {
    valueFlags: ["--name", "--dates", "--tag", "--message", "--message-file"],
    boolFlags: ["--apply"]
  });
  const repo = positional[0];
  if (!repo) throw new UsageError("missing <repo>");
  if (flags.map !== void 0) throw new UsageError("tail does not take --map");
  const dates = flags.dates || "anon";
  if (dates !== "anon" && dates !== "keep") throw new UsageError("--dates must be 'anon' or 'keep'");
  const hasMessage = flags.message !== void 0;
  const hasMessageFile = flags["message-file"] !== void 0;
  if (flags.tag !== void 0) {
    if (hasMessage === hasMessageFile) {
      throw new UsageError("--tag requires exactly one of --message or --message-file");
    }
  } else if (hasMessage || hasMessageFile) {
    throw new UsageError("--message/--message-file require --tag");
  }
  if (flags.tag !== void 0 && !isValidTagName(flags.tag)) {
    throw new UsageError("--tag: " + JSON.stringify(flags.tag) + " is not a valid tag name");
  }
  const tagMessageText = hasMessage ? flags.message : hasMessageFile ? fs4.readFileSync(flags["message-file"], "utf8") : null;
  requireRepo(repo);
  const env = process.env;
  refuseOnMerge(repo, env);
  if (flags.tag !== void 0) {
    const exists = run(repo, ["rev-parse", "--verify", "--quiet", "refs/tags/" + flags.tag], { env }).status === 0;
    if (exists) throw new Refusal("tag " + flags.tag + " already exists");
  }
  const allCommits = revListReverseHead(repo, env);
  const headSha = allCommits[allCommits.length - 1];
  const tags = loadTagIndex(repo, env);
  const { groups, tailCommits } = groupsFromTags(allCommits, tags);
  const headTagged = groups.length > 0 && groups[groups.length - 1].tip === headSha;
  if (headTagged) throw new Refusal("HEAD is already tagged, nothing to squash");
  if (flags.tag === void 0) refuseNonUtf8(repo, env, [{ sha: headSha, label: "commit " + headSha.slice(0, 7) }]);
  if (flags.tag !== void 0 && tagMessageText.includes("\0")) {
    throw new UsageError("--tag: the tag message contains a NUL byte");
  }
  if (flags.tag !== void 0 && cleanTagMessage(repo, env, tagMessageText) === "") {
    throw new UsageError("--tag: the tag message is empty");
  }
  const name = flags.name || defaultName(repo);
  const title = flags.tag !== void 0 ? tagMessageText.split("\n")[0] : text(repo, ["log", "-1", "--format=%s", headSha], { env });
  const subject = flags.tag !== void 0 ? name + " " + flags.tag + ": " + title : name + " (untagged): " + title;
  const oldestShort = shortSha(repo, env, tailCommits[0]);
  const headShort = shortSha(repo, env, headSha);
  const planLine = "tail: squashes " + tailCommits.length + " commit(s) (" + oldestShort + ".." + headShort + ') into "' + subject + '"';
  if (!flags.apply) {
    process.stdout.write(planLine + "\n");
    process.stdout.write(bin + ": dry run, no ref changed (use --apply to write)\n");
    return;
  }
  if (isDirty(repo, env)) throw new Refusal("working tree is dirty");
  const branch = currentBranch(repo, env);
  const parentCommit = groups.length > 0 ? groups[groups.length - 1].tip : null;
  const signer = createSigner(repo, env);
  try {
    createBackupBundle(repo, env);
    const tree = text(repo, ["rev-parse", headSha + "^{tree}"], { env });
    const position = groups.length;
    const when = dates === "anon" ? anonDateAt(position) : rawDateOf(repo, env, headSha, "a");
    const whenC = dates === "anon" ? anonDateAt(position) : rawDateOf(repo, env, headSha, "c");
    const ctArgs = ["commit-tree", "-S", tree];
    if (parentCommit) ctArgs.push("-p", parentCommit);
    const nc = text(repo, ctArgs, {
      env: Object.assign({}, env, { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: whenC }),
      input: subject + "\n",
      config: signer.gitConfig
    });
    const newTree = text(repo, ["rev-parse", nc + "^{tree}"], { env });
    const moves = [{ ref: branch, newSha: nc, oldSha: headSha }];
    if (flags.tag !== void 0) {
      const tagEnv = dates === "anon" ? Object.assign({}, env, { GIT_COMMITTER_DATE: whenC }) : env;
      const tagObj = buildTag(repo, tagEnv, signer, flags.tag, nc, tagMessageText);
      moves.push({ ref: "refs/tags/" + flags.tag, newSha: tagObj, oldSha: null });
    }
    moveRefsOrRefuse(repo, env, "git-release-squash tail", moves);
    const results = [
      verifyTreeDelta([{ label: headSha, expected: tree, actual: newTree }]),
      verifySignatures(repo, env)
    ];
    for (const r of results) process.stdout.write(r.line + "\n");
    process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
  } finally {
    signer.cleanup();
  }
}
main("git-release-squash", (bin) => {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);
  if (sub === void 0) throw new UsageError("missing subcommand (usage: " + bin + " plan|apply|tail <repo> ...)");
  if (sub === "plan") return cmdPlan(bin, rest);
  if (sub === "apply") return cmdApply(bin, rest);
  if (sub === "tail") return cmdTail(bin, rest);
  throw new UsageError("unknown subcommand '" + sub + "'");
});
