#!/usr/bin/env node

// lib/squash.ts
import fs3 from "node:fs";
import os2 from "node:os";
import path4 from "node:path";

// lib/git.ts
import { spawnSync } from "node:child_process";
var GitError = class extends Error {
  args;
  result;
  constructor(args, result) {
    super("git " + args.join(" ") + " failed: " + (result.stderr || "").trim());
    this.args = args;
    this.result = result;
  }
};
function run(repo, args, opts) {
  const o = opts || {};
  const env = Object.assign({}, process.env, o.env || {});
  const pre = o.config || [];
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
function isRepo(dir) {
  const r = run(dir, ["rev-parse", "--git-dir"]);
  return r.status === 0;
}
function configGet(repo, key, opts) {
  const r = run(repo, ["config", "--get", key], opts);
  if (r.status !== 0) return null;
  return r.stdout.replace(/\n$/, "");
}

// lib/cli.ts
import path from "node:path";
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
function main(bin, fn) {
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

// lib/signer.ts
import fs2 from "node:fs";
import os from "node:os";
import path2 from "node:path";
import { spawnSync as spawnSync2 } from "node:child_process";
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
function keyCreationTime(gpgProgram, signingKey, env) {
  const r = spawnSync2(gpgProgram, ["--batch", "--list-keys", "--with-colons", signingKey], { env, encoding: "utf8" });
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
  const created = keyCreationTime(gpgProgram, signingKey, env);
  const signTime = opts && opts.signTime !== void 0 ? opts.signTime : created + 60;
  const dir = fs2.mkdtempSync(path2.join(os.tmpdir(), "ght-signer-"));
  const wrapperPath = path2.join(dir, "gpg-wrapper.sh");
  fs2.writeFileSync(
    wrapperPath,
    "#!/bin/sh\nexec " + shQuote(gpgProgram) + " --faked-system-time " + signTime + '! "$@"\n'
  );
  fs2.chmodSync(wrapperPath, 493);
  const gitConfig = ["-c", "gpg.program=" + wrapperPath];
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

// lib/bundle.ts
import path3 from "node:path";
function utcStamp(d) {
  const p = (n, w) => String(n).padStart(w || 2, "0");
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + "T" + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + "Z";
}
function createBackupBundle(repo, env) {
  const absRepo = path3.resolve(repo);
  const base = path3.basename(absRepo);
  const dir = path3.dirname(absRepo);
  const stamp = utcStamp(/* @__PURE__ */ new Date());
  const bundlePath = path3.join(dir, base + ".backup-" + stamp + ".bundle");
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
  const tagsRaw = text(repo, ["for-each-ref", "--format=%(refname:short)	%(objecttype)", "refs/tags"], { env });
  const tags = tagsRaw ? tagsRaw.split("\n") : [];
  for (const l of tags) {
    const [name, type] = l.split("	");
    if (type !== "tag") continue;
    const r = run(repo, ["verify-tag", name], { env });
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
function requireRepo(repo) {
  if (!isRepo(repo)) throw new Refusal("not a git repository (" + repo + ")");
}
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
  let base = path4.basename(path4.resolve(repo));
  if (base.endsWith(".git")) base = base.slice(0, -4);
  return base;
}
function loadTagIndex(repo, env) {
  const out = text(
    repo,
    ["for-each-ref", "--format=%(refname:short)	%(objecttype)	%(*objectname)	%(objectname)", "refs/tags"],
    { env }
  );
  if (!out) return [];
  return out.split("\n").map((l) => {
    const [name, type, deref, obj] = l.split("	");
    return { name, type, commit: type === "tag" ? deref : obj };
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
      const tagShort = shortSha(repo, env, t.name);
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
  const s = text(repo, ["tag", "-l", "--format=%(contents:subject)", name], { env });
  const b = text(repo, ["tag", "-l", "--format=%(contents:body)", name], { env }).replace(/\s+$/, "");
  return s + (b ? "\n\n" + b : "") + "\n";
}
function writeTmpMsg(msg) {
  const dir = fs3.mkdtempSync(path4.join(os2.tmpdir(), "ght-tagmsg-"));
  const p = path4.join(dir, "msg.txt");
  fs3.writeFileSync(p, msg);
  return { path: p, cleanup() {
    try {
      fs3.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
    }
  } };
}
function currentBranch(repo, env) {
  const r = run(repo, ["symbolic-ref", "--short", "HEAD"], { env });
  if (r.status !== 0) throw new Refusal("HEAD is detached");
  return r.stdout.replace(/\n$/, "");
}
function isDirty(repo, env) {
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
  createBackupBundle(repo, env);
  const signer = createSigner(repo, env);
  const tmpFiles = [];
  try {
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
    fs3.writeFileSync(flags.map, mapLines.length ? mapLines.join("\n") + "\n" : "");
    for (const { g, nc, committerDate } of commitResults) {
      for (const t of g.tags) {
        if (t.type === "tag") {
          const msg = tagRawMessage(repo, env, t.name);
          const tmp = writeTmpMsg(msg);
          tmpFiles.push(tmp);
          text(repo, ["tag", "-f", "-s", "-F", tmp.path, t.name, nc], {
            env: Object.assign({}, env, { GIT_COMMITTER_DATE: committerDate }),
            config: signer.gitConfig
          });
        } else {
          text(repo, ["update-ref", "refs/tags/" + t.name, nc], { env });
        }
      }
    }
    text(repo, ["update-ref", "-m", "git-release-squash apply", "refs/heads/" + branch, newHead, oldHead], { env });
    const results = [
      verifyTreeDelta(commitResults.map((r) => ({ label: r.g.tip, expected: r.origTree, actual: r.newTree }))),
      verifySignatures(repo, env),
      verifyEveryCommitTagged(repo, env)
    ];
    for (const r of results) process.stdout.write(r.line + "\n");
    process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
  } finally {
    signer.cleanup();
    for (const t of tmpFiles) t.cleanup();
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
  const tagMessageText = hasMessage ? flags.message : hasMessageFile ? fs3.readFileSync(flags["message-file"], "utf8") : null;
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
  createBackupBundle(repo, env);
  const signer = createSigner(repo, env);
  const tmpFiles = [];
  try {
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
    text(repo, ["update-ref", "-m", "git-release-squash tail", "refs/heads/" + branch, nc, headSha], { env });
    if (flags.tag !== void 0) {
      const tmp = writeTmpMsg(tagMessageText);
      tmpFiles.push(tmp);
      const tagEnv = dates === "anon" ? Object.assign({}, env, { GIT_COMMITTER_DATE: whenC }) : env;
      text(repo, ["tag", "-s", "-F", tmp.path, flags.tag, nc], { env: tagEnv, config: signer.gitConfig });
    }
    const results = [
      verifyTreeDelta([{ label: headSha, expected: tree, actual: newTree }]),
      verifySignatures(repo, env)
    ];
    for (const r of results) process.stdout.write(r.line + "\n");
    process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
  } finally {
    signer.cleanup();
    for (const t of tmpFiles) t.cleanup();
  }
}
main("git-release-squash", (bin) => {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);
  if (sub === "plan") return cmdPlan(bin, rest);
  if (sub === "apply") return cmdApply(bin, rest);
  if (sub === "tail") return cmdTail(bin, rest);
  throw new UsageError("unknown subcommand '" + sub + "'");
});
