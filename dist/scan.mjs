#!/usr/bin/env node

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
function isInsideRepo(realRepo, candidate) {
  const rel = path2.relative(realRepo, candidate);
  return rel === "" || !rel.startsWith("..") && !path2.isAbsolute(rel);
}
function resolveOutsideFile(repo, flagName, filePath) {
  if (!fs.existsSync(filePath)) {
    throw new UsageError(flagName + " file does not exist: " + filePath);
  }
  const abs = path2.resolve(filePath);
  const realRepo = fs.realpathSync(repo);
  const realDir = fs.realpathSync(path2.dirname(abs));
  const realFileShallow = path2.join(realDir, path2.basename(abs));
  const realFileFull = fs.realpathSync(abs);
  if (isInsideRepo(realRepo, realFileShallow) || isInsideRepo(realRepo, realFileFull)) {
    throw new Refusal(flagName + " points inside the repo (" + filePath + ") -- keep it outside");
  }
  return realFileFull;
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

// lib/leakscan.ts
import { readFileSync } from "node:fs";
var RE_EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}/g;
var RE_URL = /https?:\/\/[^\s)"'`>\]]+/g;
var RE_LOCAL_PATH = /\/Users\/[^\s"'`<>]+|\/home\/[^\s"'`<>]+|[Cc]:\\[Uu][Ss][Ee][Rr][Ss]\\[^\s"'`<>]+|(?<![A-Za-z0-9._~-])\/root\/[^\s"'`<>]+|(?<![A-Za-z0-9._\/~-])~[A-Za-z_][A-Za-z0-9_.-]*\/[^\s"'`<>]+/g;
var RE_HOSTNAME = /\b(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,16}(?:local|internal|corp|lan)(?:\.[A-Za-z0-9-]{1,63}){0,16}\b/gi;
var RE_IP = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
var RE_SECRET_KV = /(?<![A-Za-z0-9])(?:[A-Za-z0-9]{1,64}[_.-]){0,8}(?:token|secret|key|password|apikey)(["']?)(\s*)([:=])(\s*)(["']?)([A-Za-z0-9_+\/-]+(?:\.[A-Za-z0-9_+\/-]+)*={0,2})/gi;
var RE_SECRET_CAMEL = /(?<![A-Za-z0-9])(?:[A-Za-z0-9]{1,64}[_.-]){0,8}[A-Za-z0-9]{0,63}[a-z0-9](?:Token|Secret|Password|ApiKey|AccessKey|PrivateKey)(["']?)(\s*)([:=])(\s*)(["']?)([A-Za-z0-9_+\/-]+(?:\.[A-Za-z0-9_+\/-]+)*={0,2})/g;
var RE_SECRET_PEM = /-----BEGIN [A-Za-z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;
var SECRET_PREFIXES = [
  { re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g, rule: "none" },
  { re: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g, rule: "digit" },
  { re: /(?<![A-Za-z0-9])xox[bp]-[0-9]{6,}-[0-9A-Za-z-]{10,}/g, rule: "none" },
  { re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, rule: "none" },
  { re: /\bBearer [A-Za-z0-9._~+\/-]{20,}=*/g, rule: "digit" },
  /* GitHub fine-grained, Stripe live secret/restricted, Google API, GitLab personal (Reviewer R3). */
  { re: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}(?![A-Za-z0-9_])/g, rule: "mixed" },
  { re: /(?<![A-Za-z0-9_])[sr]k_live_[0-9A-Za-z]{24,99}(?![A-Za-z0-9])/g, rule: "mixed" },
  { re: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g, rule: "mixed" },
  { re: /(?<![A-Za-z0-9_-])glpat-[0-9A-Za-z_-]{20}(?![A-Za-z0-9_-])/g, rule: "mixed" }
];
function keepKeyValue(m) {
  const value = m[6];
  if (value.replace(/=+$/, "").length < 20) return false;
  const compact = m[1] === "" && m[2] === "" && m[3] === "=" && m[4] === "" && m[5] === "";
  return compact || /[0-9]/.test(value);
}
function prefixRuleHolds(rule, match) {
  if (rule === "digit") return /[0-9]/.test(match);
  if (rule === "none") return true;
  const body = match.replace(/^(?:github_pat_|[sr]k_live_|AIza|glpat-)/, "");
  return [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(body)).length >= 2;
}
function scanSecrets(text2) {
  const spans = [];
  const add = (re, keep) => {
    let m;
    re.lastIndex = 0;
    while (m = re.exec(text2)) {
      if (keep(m)) spans.push({ start: m.index, end: m.index + m[0].length, match: m[0] });
    }
  };
  add(RE_SECRET_KV, keepKeyValue);
  add(RE_SECRET_CAMEL, keepKeyValue);
  add(RE_SECRET_PEM, () => true);
  for (const p of SECRET_PREFIXES) add(p.re, (m) => prefixRuleHolds(p.rule, m[0]));
  const inside = containedSpans(spans);
  return spans.filter((_, i) => !inside.has(i)).map((s) => ({ category: "secret", match: s.match }));
}
function containedSpans(spans) {
  const order = spans.map((_, i) => i).sort((a, b) => spans[a].start - spans[b].start || spans[b].end - spans[a].end);
  const inside = /* @__PURE__ */ new Set();
  let reach = -1;
  for (let i = 0; i < order.length; ) {
    const start = spans[order[i]].start;
    const groupEnd = spans[order[i]].end;
    let j = i;
    for (; j < order.length && spans[order[j]].start === start; j++) {
      const end = spans[order[j]].end;
      if (reach >= end || groupEnd > end) inside.add(order[j]);
    }
    reach = Math.max(reach, groupEnd);
    i = j;
  }
  return inside;
}
var IGNORED_IPS = /* @__PURE__ */ new Set(["127.0.0.1", "0.0.0.0"]);
function scanBuiltins(text2) {
  const hits = [];
  const add = (category, re) => {
    let m;
    re.lastIndex = 0;
    while (m = re.exec(text2)) {
      if (category === "ip" && IGNORED_IPS.has(m[0])) continue;
      hits.push({ category, match: m[0] });
      if (m[0].length === 0) re.lastIndex++;
    }
  };
  add("email", RE_EMAIL);
  add("url", RE_URL);
  add("local-path", RE_LOCAL_PATH);
  add("hostname", RE_HOSTNAME);
  add("ip", RE_IP);
  return hits.concat(scanSecrets(text2));
}
function scanPemInBuffer(buf) {
  const hits = [];
  const text2 = buf.toString("latin1");
  let m;
  RE_SECRET_PEM.lastIndex = 0;
  while (m = RE_SECRET_PEM.exec(text2)) hits.push({ category: "secret", match: m[0] });
  return hits;
}
function scanTerms(text2, terms) {
  const hits = [];
  const lower = text2.toLowerCase();
  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    for (; ; ) {
      const i = lower.indexOf(term, from);
      if (i === -1) break;
      hits.push({ category: "term", match: text2.slice(i, i + term.length) });
      from = i + term.length;
    }
  }
  return hits;
}
function readLines(filePath, lowercase) {
  const raw = readFileSync(filePath, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    const l = line.replace(/\r$/, "");
    if (l === "" || l.startsWith("#")) continue;
    out.push(lowercase ? l.toLowerCase() : l);
  }
  return out;
}
function isBinary(buf) {
  const n = Math.min(buf.length, 8e3);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// lib/scan.ts
function shortSha(repo, env, rev) {
  return text(repo, ["rev-parse", "--short", rev], { env });
}
function listTreeBlobs(repo, env, commit) {
  const out = text(repo, ["ls-tree", "-r", "--full-tree", commit], { env });
  if (!out) return [];
  const entries = [];
  for (const line of out.split("\n")) {
    const tab = line.indexOf("	");
    if (tab === -1) continue;
    const meta = line.slice(0, tab).split(/\s+/);
    const filePath = line.slice(tab + 1);
    if (meta[1] !== "blob") continue;
    entries.push({ sha: meta[2], path: filePath });
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return entries;
}
function identityText(repo, env, commit) {
  const out = text(repo, ["log", "-1", "--format=%an <%ae>%n%cn <%ce>", commit], { env });
  return out;
}
function collectTargets(repo, env) {
  const targets = [];
  const commits = text(repo, ["rev-list", "--all", "--reverse"], { env });
  const commitList = commits ? commits.split("\n") : [];
  for (const c of commitList) {
    const message = text(repo, ["log", "-1", "--format=%B", c], { env });
    targets.push({ commit: c, path: "(message)", kind: "text", text: message });
    targets.push({ commit: c, path: "(identity)", kind: "text", text: identityText(repo, env, c) });
    for (const b of listTreeBlobs(repo, env, c)) targets.push({ commit: c, path: b.path, kind: "blob", sha: b.sha });
  }
  const tagsRaw = text(
    repo,
    ["for-each-ref", "--format=%(refname)	%(objecttype)	%(*objectname)	%(objectname)", "refs/tags"],
    { env }
  );
  for (const l of tagsRaw ? tagsRaw.split("\n") : []) {
    const [ref, type, deref, obj] = l.split("	");
    if (type !== "tag") continue;
    const msg = text(repo, ["for-each-ref", "--format=%(contents)", ref], { env });
    const tagger = text(repo, ["for-each-ref", "--format=%(taggername) <%(taggeremail)>", ref], { env });
    targets.push({ commit: deref || obj, path: "(tag-message)", kind: "text", text: msg });
    targets.push({ commit: deref || obj, path: "(identity)", kind: "text", text: tagger });
  }
  return targets;
}
function cmdScan(bin, args) {
  const { positional, flags } = parseFlags(args, { valueFlags: ["--terms", "--allow"], boolFlags: [] });
  const repo = positional[0];
  if (!repo) throw new UsageError("missing <repo>");
  requireRepo(repo);
  const env = process.env;
  let termsPath = null;
  let allowPath = null;
  if (flags.terms !== void 0) termsPath = resolveOutsideFile(repo, "--terms", flags.terms);
  if (flags.allow !== void 0) allowPath = resolveOutsideFile(repo, "--allow", flags.allow);
  const terms = termsPath ? readLines(termsPath, true) : [];
  const allow = new Set(allowPath ? readLines(allowPath, false) : []);
  const targets = collectTargets(repo, env);
  const seenPairs = /* @__PURE__ */ new Set();
  const agg = /* @__PURE__ */ new Map();
  const order = [];
  const blobHits = /* @__PURE__ */ new Map();
  for (const t of targets) {
    let hits;
    if (t.kind === "blob") {
      const cached = blobHits.get(t.sha);
      if (cached) {
        hits = cached;
      } else {
        const buf = buffer(repo, ["cat-file", "-p", t.sha], { env });
        if (isBinary(buf)) {
          hits = scanPemInBuffer(buf);
        } else {
          const text2 = buf.toString("utf8");
          hits = scanBuiltins(text2).concat(scanTerms(text2, terms));
        }
        blobHits.set(t.sha, hits);
      }
    } else {
      hits = scanBuiltins(t.text).concat(scanTerms(t.text, terms));
    }
    for (const h of hits) {
      const pairKey = h.category + "\0" + h.match + "\0" + t.commit + "\0" + t.path;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const key = h.category + "\0" + h.match;
      let e = agg.get(key);
      if (!e) {
        e = { category: h.category, match: h.match, count: 0, firstCommit: t.commit, firstPath: t.path };
        agg.set(key, e);
        order.push(key);
      }
      e.count++;
    }
  }
  const shorts = /* @__PURE__ */ new Map();
  const lines = [];
  for (const key of order) {
    const e = agg.get(key);
    if (allow.has(e.match)) continue;
    let short = shorts.get(e.firstCommit);
    if (short === void 0) {
      short = shortSha(repo, env, e.firstCommit);
      shorts.set(e.firstCommit, short);
    }
    lines.push("scan: " + e.category + " " + e.match + " (" + e.count + ") first at " + short + ":" + e.firstPath);
  }
  process.stdout.write(lines.map((l) => l + "\n").join(""));
  process.exitCode = lines.length > 0 ? 1 : 0;
}
main("git-leak-scan", (bin) => {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);
  if (sub === void 0) throw new UsageError("missing subcommand (usage: " + bin + " scan <repo> ...)");
  if (sub === "scan") return cmdScan(bin, rest);
  throw new UsageError("unknown subcommand '" + sub + "'");
});
