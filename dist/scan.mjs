#!/usr/bin/env node

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
function buffer(repo, args, opts) {
  const r = run(repo, args, Object.assign({}, opts, { raw: true }));
  if (r.status !== 0) throw new GitError(args, r);
  return r.stdout;
}
function isRepo(dir) {
  const r = run(dir, ["rev-parse", "--git-dir"]);
  return r.status === 0;
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
function isInsideRepo(realRepo, candidate) {
  const rel = path.relative(realRepo, candidate);
  return rel === "" || !rel.startsWith("..") && !path.isAbsolute(rel);
}
function resolveOutsideFile(repo, flagName, filePath) {
  if (!fs.existsSync(filePath)) {
    throw new UsageError(flagName + " file does not exist: " + filePath);
  }
  const abs = path.resolve(filePath);
  const realRepo = fs.realpathSync(repo);
  const realDir = fs.realpathSync(path.dirname(abs));
  const realFileShallow = path.join(realDir, path.basename(abs));
  const realFileFull = fs.realpathSync(abs);
  if (isInsideRepo(realRepo, realFileShallow) || isInsideRepo(realRepo, realFileFull)) {
    throw new Refusal(flagName + " points inside the repo (" + filePath + ") -- keep it outside");
  }
  return realFileFull;
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

// lib/leakscan.ts
import { readFileSync } from "node:fs";
var RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
var RE_URL = /https?:\/\/[^\s)"'`>\]]+/g;
var RE_LOCAL_PATH = /(?:\/Users\/[^\s"'`<>]+|\/home\/[^\s"'`<>]+|C:\\Users\\[^\s"'`<>]+)/g;
var RE_HOSTNAME = /\b(?:[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+(?:local|internal|corp|lan)(?:\.[A-Za-z0-9-]+)*\b/gi;
var RE_IP = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
var RE_SECRET_KV = /\b(?:token|secret|key|password)=[A-Za-z0-9_-]{20,}/gi;
var RE_SECRET_PEM = /-----BEGIN [A-Za-z0-9 ]*PRIVATE KEY-----/g;
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
  add("secret", RE_SECRET_KV);
  add("secret", RE_SECRET_PEM);
  return hits;
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
function requireRepo(repo) {
  if (!isRepo(repo)) throw new Refusal("not a git repository (" + repo + ")");
}
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
    for (const b of listTreeBlobs(repo, env, c)) {
      const buf = buffer(repo, ["cat-file", "-p", b.sha], { env });
      targets.push({ commit: c, path: b.path, kind: "blob", buf });
    }
  }
  const tagsRaw = text(
    repo,
    ["for-each-ref", "--format=%(refname:short)	%(objecttype)	%(*objectname)	%(objectname)", "refs/tags"],
    { env }
  );
  for (const l of tagsRaw ? tagsRaw.split("\n") : []) {
    const [name, type, deref, obj] = l.split("	");
    if (type !== "tag") continue;
    const msg = text(repo, ["for-each-ref", "--format=%(contents)", "refs/tags/" + name], { env });
    const tagger = text(repo, ["for-each-ref", "--format=%(taggername) <%(taggeremail)>", "refs/tags/" + name], { env });
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
  for (const t of targets) {
    let hits;
    if (t.kind === "blob") {
      const buf = t.buf;
      if (isBinary(buf)) {
        hits = scanPemInBuffer(buf);
      } else {
        const text2 = buf.toString("utf8");
        hits = scanBuiltins(text2).concat(scanTerms(text2, terms));
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
  const lines = [];
  for (const key of order) {
    const e = agg.get(key);
    if (allow.has(e.match)) continue;
    const short = shortSha(repo, env, e.firstCommit);
    lines.push("scan: " + e.category + " " + e.match + " (" + e.count + ") first at " + short + ":" + e.firstPath);
  }
  process.stdout.write(lines.map((l) => l + "\n").join(""));
  process.exitCode = lines.length > 0 ? 1 : 0;
}
main("git-leak-scan", (bin) => {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);
  if (sub === "scan") return cmdScan(bin, rest);
  throw new UsageError("unknown subcommand '" + sub + "'");
});
