#!/usr/bin/env node

// lib/rewrite.ts
import fs4 from "node:fs";
import path5 from "node:path";
import { spawnSync as spawnSync4 } from "node:child_process";

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
function refBase(ref, namespace) {
  if (!ref.startsWith(namespace)) throw new Error("refBase: " + ref + " is not under " + namespace);
  return ref.slice(namespace.length);
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
function isBinary(buf) {
  const n = Math.min(buf.length, 8e3);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

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
function verifyRuleSourcesClean(replacementValues) {
  const found = [];
  for (const v of replacementValues) {
    for (const hit of scanBuiltins(v)) found.push(hit.match);
  }
  if (found.length === 0) return line("replace: rule sources clean", true);
  return line("replace: rule sources clean", false, "replacement value(s) leak: " + found.join(", "));
}

// lib/siginfo.ts
import { spawnSync as spawnSync3 } from "node:child_process";
var TAG_SIGNATURE_MARKERS = [
  { begin: "-----BEGIN PGP SIGNATURE-----", end: "-----END PGP SIGNATURE-----" },
  { begin: "-----BEGIN SSH SIGNATURE-----", end: "-----END SSH SIGNATURE-----" }
];
function tagSignatureBoundary(raw) {
  const lines = raw.split("\n");
  const lineStart = new Array(lines.length + 1);
  lineStart[0] = 0;
  for (let k = 0; k < lines.length; k++) lineStart[k + 1] = lineStart[k] + lines[k].length + 1;
  let i = lines.length;
  let count = 0;
  let index = -1;
  for (; ; ) {
    while (i > 0 && lines[i - 1].trim() === "") i--;
    if (i === 0) break;
    const marker = TAG_SIGNATURE_MARKERS.find((m) => lines[i - 1] === m.end);
    if (!marker) break;
    let j = i - 2;
    while (j >= 0 && lines[j] !== marker.begin) j--;
    if (j < 0) break;
    count++;
    index = lineStart[j];
    i = j;
  }
  return { index, count };
}
function tagMessageFromRaw(raw) {
  const idx = raw.indexOf("\n\n");
  const rest = idx === -1 ? "" : raw.slice(idx + 2);
  const { index: sigIdx } = tagSignatureBoundary(rest);
  return sigIdx === -1 ? rest : rest.slice(0, sigIdx);
}
function signatureBlockCount(raw, kind) {
  if (kind === "tag") return tagSignatureBoundary(raw).count;
  const headerEnd = raw.indexOf("\n\n");
  const header = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  return (header.match(/^gpgsig(-sha256)? /mg) || []).length;
}
function signatureStatus(repo, env, kind, rev, hasSignature, policyKey) {
  if (!hasSignature) return { state: "missing" };
  const args = kind === "commit" ? ["verify-commit", "--raw", rev] : ["verify-tag", "--raw", rev];
  const r = run(repo, args, { env });
  const stderr = r.stderr || "";
  const noPubkey = /^\[GNUPG:\] NO_PUBKEY ([0-9A-Fa-f]+)/m.exec(stderr);
  if (noPubkey) return { state: "unknown-key", keyid: noPubkey[1].toUpperCase() };
  const validsig = /^\[GNUPG:\] VALIDSIG ([0-9A-Fa-f]+) /m.exec(stderr);
  if (validsig) {
    const fingerprint = validsig[1].toUpperCase();
    return keyMatches(policyKey, fingerprint) ? { state: "ok", fingerprint } : { state: "wrong-key", fingerprint };
  }
  return { state: "bad" };
}
function keyMatches(full, reported) {
  if (!reported) return false;
  const a = full.toUpperCase();
  const b = reported.toUpperCase();
  return a === b || b.length < a.length && a.endsWith(b);
}

// lib/rewrite.ts
function shortSha(repo, env, rev) {
  return text(repo, ["rev-parse", "--short", rev], { env });
}
function refuseOnMerge(repo, env) {
  const out = text(repo, ["rev-list", "--merges", "--topo-order", "HEAD"], { env });
  const merge = out ? out.split("\n")[0] : null;
  if (merge) throw new Refusal("merge commits are not supported (" + shortSha(repo, env, merge) + ")");
}
function splitIdent(s) {
  const m = /^(.*) <([^>]*)>$/.exec(s);
  return m ? { name: m[1], email: m[2] } : { name: s, email: "" };
}
function rawIdentity(repo, env, sha) {
  const raw = text(repo, ["cat-file", "-p", sha], { env });
  const am = /^author (.*) (\d+ [+-]\d{4})$/m.exec(raw);
  const cm = /^committer (.*) (\d+ [+-]\d{4})$/m.exec(raw);
  const a = splitIdent(am[1]);
  const c = splitIdent(cm[1]);
  return {
    authorName: a.name,
    authorEmail: a.email,
    authorWhen: "@" + am[2],
    committerName: c.name,
    committerEmail: c.email,
    committerWhen: "@" + cm[2]
  };
}
function lsTreeOneLevel(repo, env, treeSha) {
  const out = text(repo, ["ls-tree", treeSha], { env });
  if (!out) return [];
  return out.split("\n").map((line2) => {
    const tab = line2.indexOf("	");
    const meta = line2.slice(0, tab).split(/\s+/);
    return { mode: meta[0], type: meta[1], sha: meta[2], name: line2.slice(tab + 1) };
  });
}
function treeSortKey(e) {
  return e.name + (e.type === "tree" ? "/" : "");
}
function mktree(repo, env, entries, write) {
  if (write) {
    const input = entries.map((e) => e.mode + " " + e.type + " " + e.sha + "	" + e.name).join("\n") + "\n";
    return text(repo, ["mktree"], { env, input });
  }
  const sorted = entries.slice().sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const raw = Buffer.concat(sorted.map((e) => Buffer.concat([
    Buffer.from(e.mode.replace(/^0+(?=\d)/, "") + " " + e.name + "\0"),
    Buffer.from(e.sha, "hex")
  ])));
  return text(repo, ["hash-object", "-t", "tree", "--stdin"], { env, input: raw });
}
function hashObjectBlob(repo, env, buf, write) {
  const args = write ? ["hash-object", "-w", "--stdin"] : ["hash-object", "--stdin"];
  return text(repo, args, { env, input: buf });
}
function rewriteBlob(repo, env, sha, rules, cache, write) {
  if (cache.has(sha)) return cache.get(sha);
  const buf = buffer(repo, ["cat-file", "-p", sha], { env });
  let resultSha;
  if (isBinary(buf)) {
    resultSha = sha;
  } else {
    const hadTrailingNewline = buf.length > 0 && buf[buf.length - 1] === 10;
    let text2 = buf.toString("utf8");
    for (const r of rules) text2 = text2.split(r.from).join(r.to);
    if (hadTrailingNewline) {
      if (!text2.endsWith("\n")) text2 += "\n";
    } else {
      while (text2.endsWith("\n")) text2 = text2.slice(0, -1);
    }
    const newBuf = Buffer.from(text2, "utf8");
    resultSha = newBuf.equals(buf) ? sha : hashObjectBlob(repo, env, newBuf, write);
  }
  cache.set(sha, resultSha);
  return resultSha;
}
function rewriteTreeWithRules(repo, env, treeSha, rules, treeCache, blobCache, write) {
  if (treeCache.has(treeSha)) return treeCache.get(treeSha);
  const entries = lsTreeOneLevel(repo, env, treeSha);
  const newEntries = entries.map((e) => {
    if (e.type === "tree") {
      return Object.assign({}, e, { sha: rewriteTreeWithRules(repo, env, e.sha, rules, treeCache, blobCache, write) });
    }
    if (e.type === "blob") {
      return Object.assign({}, e, { sha: rewriteBlob(repo, env, e.sha, rules, blobCache, write) });
    }
    return e;
  });
  const changed = newEntries.some((e, i) => e.sha !== entries[i].sha);
  const newTreeSha = changed ? mktree(repo, env, newEntries, write) : treeSha;
  treeCache.set(treeSha, newTreeSha);
  return newTreeSha;
}
function refuseDirectoryAt(repo, env, treeSha, segments, repoPath) {
  let tree = treeSha;
  for (let i = 0; i < segments.length; i++) {
    const e = lsTreeOneLevel(repo, env, tree).find((x) => x.name === segments[i]);
    if (!e || e.type !== "tree") return;
    if (i === segments.length - 1) throw new Refusal("a directory already exists at " + repoPath);
    tree = e.sha;
  }
}
function setPathInTree(repo, env, treeSha, segments, mode, blobSha, repoPath, write) {
  const [head, ...rest] = segments;
  const entries = lsTreeOneLevel(repo, env, treeSha);
  const idx = entries.findIndex((e) => e.name === head);
  let newEntry;
  if (rest.length === 0) {
    if (idx !== -1 && entries[idx].type === "tree") {
      throw new Refusal("a directory already exists at " + repoPath);
    }
    newEntry = { mode, type: "blob", sha: blobSha, name: head };
  } else {
    const subTree = idx !== -1 && entries[idx].type === "tree" ? entries[idx].sha : mktree(repo, env, [], write);
    const newSub = setPathInTree(repo, env, subTree, rest, mode, blobSha, repoPath, write);
    newEntry = { mode: "040000", type: "tree", sha: newSub, name: head };
  }
  if (idx === -1) entries.push(newEntry);
  else entries[idx] = newEntry;
  return mktree(repo, env, entries, write);
}
function runHook(hookPath, repo, ruleTreeSha, hookCache) {
  if (hookCache.has(ruleTreeSha)) return hookCache.get(ruleTreeSha);
  const r = spawnSync4(hookPath, [ruleTreeSha], {
    env: Object.assign({}, process.env, { GHT_REPO: repo }),
    encoding: "utf8"
  });
  if (r.error) throw new Refusal("hook " + hookPath + " could not be run: " + r.error.message);
  const out = r.stdout || "";
  const trimmed = out.replace(/\n$/, "");
  if (r.status !== 0 || trimmed !== "" && !/^[0-9a-f]{40}$/.test(trimmed)) {
    throw new Refusal("hook " + hookPath + " failed (exit " + r.status + "): " + JSON.stringify(out));
  }
  const finalSha = trimmed === "" ? ruleTreeSha : trimmed;
  hookCache.set(ruleTreeSha, finalSha);
  return finalSha;
}
function allRefCommitsTopoReverse(repo, env) {
  const out = text(repo, ["rev-list", "--branches", "--tags", "--topo-order", "--reverse"], { env });
  return out ? out.split("\n") : [];
}
function refTips(repo, env) {
  const headsRaw = text(repo, ["for-each-ref", "--format=%(refname)	%(objectname)", "refs/heads"], { env });
  const heads = (headsRaw ? headsRaw.split("\n") : []).map((l) => {
    const [ref, sha] = l.split("	");
    return { ref, name: refBase(ref, "refs/heads/"), sha };
  });
  const tagsRaw = text(
    repo,
    ["for-each-ref", "--format=%(refname)	%(objecttype)	%(*objectname)	%(objectname)", "refs/tags"],
    { env }
  );
  const tags = (tagsRaw ? tagsRaw.split("\n") : []).map((l) => {
    const [ref, type, deref, obj] = l.split("	");
    return { ref, name: refBase(ref, "refs/tags/"), type, commit: type === "tag" ? deref : obj, tagObj: obj };
  });
  return { heads, tags };
}
function tagMessages(repo, env, tags) {
  const out = /* @__PURE__ */ new Map();
  for (const t of tags) {
    if (t.type !== "tag") continue;
    const raw = buffer(repo, ["cat-file", "tag", t.tagObj], { env }).toString("utf8");
    if (signatureBlockCount(raw, "tag") === 1 && signatureStatus(repo, env, "tag", t.tagObj, true, "").state === "bad") {
      throw new Refusal("tag " + t.name + " ends with a signature-shaped block gpg cannot verify or attribute to any key -- indistinguishable from an unsigned tag whose message merely ends with a quoted block; refusing to guess, resolve manually");
    }
    out.set(t.name, tagMessageFromRaw(raw));
  }
  return out;
}
function refDrift(snapshot, now) {
  const shaOf = (t) => new Map([...t.heads.map((h) => [h.ref, h.sha]), ...t.tags.map((g) => [g.ref, g.tagObj])]);
  const before = shaOf(snapshot);
  const after = shaOf(now);
  const out = [];
  for (const [ref, sha] of before) {
    if (!after.has(ref)) out.push(ref + " deleted");
    else if (after.get(ref) !== sha) out.push(ref + " moved");
  }
  for (const ref of after.keys()) if (!before.has(ref)) out.push(ref + " created");
  return out;
}
function runRewrite(bin, sub, repo, env, opts) {
  refuseOnMerge(repo, env);
  const snapshot = refTips(repo, env);
  const commits = allRefCommitsTopoReverse(repo, env);
  refuseNonUtf8(repo, env, [
    ...commits.map((c) => ({ sha: c, label: "commit " + c.slice(0, 7) })),
    ...snapshot.tags.filter((t) => t.type === "tag").map((t) => ({ sha: t.tagObj, label: "tag " + t.name }))
  ]);
  const parentsOf = {};
  for (const c of commits) {
    const p = text(repo, ["log", "-1", "--format=%P", c], { env });
    parentsOf[c] = p ? p.split(" ") : [];
  }
  const messages = tagMessages(repo, env, snapshot.tags);
  if (opts.refuseMessageChange) {
    for (const c of commits) {
      const msg = text(repo, ["log", "-1", "--format=%B", c], { env });
      if (opts.applyToText(msg) !== msg) {
        throw new Refusal("commit " + shortSha(repo, env, c) + " message would change -- replace only rewrites file contents");
      }
    }
    for (const [name, msg] of messages) {
      if (opts.applyToText(msg) !== msg) {
        throw new Refusal("tag " + name + " message would change -- replace only rewrites file contents");
      }
    }
  }
  const computeRecords = (write) => commits.map((c) => {
    const oldTree = text(repo, ["rev-parse", c + "^{tree}"], { env });
    const finalTree = opts.transformTree(oldTree, write);
    return { oldSha: c, oldTree, finalTree, changed: finalTree !== oldTree };
  });
  if (!opts.apply) {
    const records = computeRecords(false);
    const changedCount = records.filter((r) => r.changed).length;
    const lines = [];
    for (const r of records) {
      if (r.changed) lines.push("replace: " + shortSha(repo, env, r.oldSha) + " " + opts.changeLabel);
    }
    lines.push("replace: " + changedCount + " of " + records.length + " commits " + opts.changeLabel);
    process.stdout.write(lines.map((l) => l + "\n").join(""));
    process.stdout.write(bin + ": dry run, no ref changed (use --apply to write)\n");
    return;
  }
  if (opts.precheck) {
    const seen = /* @__PURE__ */ new Set();
    for (const c of commits) {
      const tree = text(repo, ["rev-parse", c + "^{tree}"], { env });
      if (!seen.has(tree)) {
        seen.add(tree);
        opts.precheck(tree);
      }
    }
  }
  const signer = createSigner(repo, env);
  try {
    createBackupBundle(repo, env);
    const records = computeRecords(true);
    const remap = /* @__PURE__ */ new Map();
    for (const r of records) {
      const ident = rawIdentity(repo, env, r.oldSha);
      const message = text(repo, ["log", "-1", "--format=%B", r.oldSha], { env });
      const newParents = parentsOf[r.oldSha].filter(Boolean).map((p) => remap.get(p));
      const ctArgs = ["commit-tree", "-S", r.finalTree];
      for (const p of newParents) ctArgs.push("-p", p);
      const nc = text(repo, ctArgs, {
        env: Object.assign({}, env, {
          GIT_AUTHOR_NAME: ident.authorName,
          GIT_AUTHOR_EMAIL: ident.authorEmail,
          GIT_AUTHOR_DATE: ident.authorWhen,
          GIT_COMMITTER_NAME: ident.committerName,
          GIT_COMMITTER_EMAIL: ident.committerEmail,
          GIT_COMMITTER_DATE: ident.committerWhen
        }),
        input: message,
        config: signer.gitConfig
      });
      remap.set(r.oldSha, nc);
    }
    const { heads, tags } = snapshot;
    const moves = [];
    for (const h of heads) {
      const newSha = remap.get(h.sha);
      if (newSha) moves.push({ ref: h.ref, newSha, oldSha: h.sha });
    }
    for (const t of tags) {
      const newCommit = remap.get(t.commit);
      if (!newCommit) continue;
      let newObj = newCommit;
      if (t.type === "tag") {
        const raw = text(repo, ["cat-file", "-p", t.tagObj], { env });
        const tm = /^tagger (.*) (\d+ [+-]\d{4})$/m.exec(raw);
        newObj = buildSignedTagObject(repo, env, signer, {
          object: newCommit,
          type: "commit",
          name: t.name,
          taggerLine: tm[1] + " " + tm[2],
          message: messages.get(t.name)
        });
      }
      moves.push({ ref: t.ref, newSha: newObj, oldSha: t.tagObj });
    }
    const drift = refDrift(snapshot, refTips(repo, env));
    if (drift.length > 0) throw new Refusal("refs changed during the run (" + drift.join(", ") + "); nothing moved, run it again");
    const txn = moveRefs(repo, env, bin + " " + sub, moves);
    if (txn.status !== 0) throw new Refusal("ref update transaction failed: " + txn.stderr.trim().split("\n")[0]);
    const known = /* @__PURE__ */ new Set([...heads.map((h) => h.ref), ...tags.map((t) => t.ref)]);
    const after = refTips(repo, env);
    const late = [...after.heads.map((h) => ({ ref: h.ref, target: h.sha })), ...after.tags.map((t) => ({ ref: t.ref, target: t.commit }))].filter((x) => !known.has(x.ref));
    for (const x of late) {
      process.stderr.write(bin + ": " + x.ref + " created during the run" + (remap.has(x.target) ? ", still on the old history" : "") + "\n");
    }
    const treeChecks = records.map((r) => ({
      label: r.oldSha,
      expected: r.finalTree,
      actual: text(repo, ["rev-parse", remap.get(r.oldSha) + "^{tree}"], { env })
    }));
    const results = [verifyTreeDelta(treeChecks), verifySignatures(repo, env)];
    if (opts.ruleSourcesCheck) results.push(verifyRuleSourcesClean(opts.ruleSourcesCheck));
    for (const r of results) process.stdout.write(r.line + "\n");
    process.exitCode = results.some((r) => !r.ok) || late.length > 0 ? 1 : 0;
  } finally {
    signer.cleanup();
  }
}
function parseRulesFile(rulesPath) {
  const raw = fs4.readFileSync(rulesPath, "utf8");
  const lines = raw.split("\n");
  const rules = [];
  lines.forEach((line2, i) => {
    if (line2 === "" || line2.startsWith("#")) return;
    const parts = line2.split("	");
    if (parts.length !== 2) throw new UsageError("--rules line " + (i + 1) + ": expected one tab-separated from/to pair");
    rules.push({ from: parts[0], to: parts[1] });
  });
  return rules;
}
function applyRulesToText(text2, rules) {
  let out = text2;
  for (const r of rules) out = out.split(r.from).join(r.to);
  return out;
}
function cmdReplace(bin, args) {
  const { positional, flags } = parseFlags(args, { valueFlags: ["--rules", "--hook"], boolFlags: ["--apply"] });
  const repo = positional[0];
  if (!repo) throw new UsageError("missing <repo>");
  if (!flags.rules) throw new UsageError("missing --rules");
  requireRepo(repo);
  const env = process.env;
  const rulesPath = resolveOutsideFile(repo, "--rules", flags.rules);
  const rules = parseRulesFile(rulesPath);
  const treeCache = /* @__PURE__ */ new Map();
  const blobCache = /* @__PURE__ */ new Map();
  const hookCache = /* @__PURE__ */ new Map();
  const transformTree = (oldTree, write) => {
    const ruleTree = rewriteTreeWithRules(repo, env, oldTree, rules, treeCache, blobCache, write);
    return flags.hook ? runHook(flags.hook, repo, ruleTree, hookCache) : ruleTree;
  };
  runRewrite(bin, "replace", repo, env, {
    apply: !!flags.apply,
    refuseMessageChange: true,
    applyToText: (t) => applyRulesToText(t, rules),
    transformTree,
    changeLabel: "would change",
    ruleSourcesCheck: rules.map((r) => r.to)
  });
}
function cmdAddFile(bin, args) {
  const { positional, flags } = parseFlags(args, { valueFlags: ["--as"], boolFlags: ["--apply"] });
  const repo = positional[0];
  const srcPath = positional[1];
  if (!repo) throw new UsageError("missing <repo>");
  if (!srcPath) throw new UsageError("missing <path>");
  if (!fs4.existsSync(srcPath)) throw new UsageError("<path> does not exist: " + srcPath);
  requireRepo(repo);
  const env = process.env;
  const content = fs4.readFileSync(srcPath);
  const st = fs4.statSync(srcPath);
  const mode = (st.mode & 73) !== 0 ? "100755" : "100644";
  const asPath = flags.as || path5.basename(srcPath);
  const segments = asPath.split("/").filter(Boolean);
  const blobShaByWrite = {};
  const getBlobSha = (write) => {
    if (!(String(write) in blobShaByWrite)) blobShaByWrite[String(write)] = hashObjectBlob(repo, env, content, write);
    return blobShaByWrite[String(write)];
  };
  const transformTree = (oldTree, write) => setPathInTree(repo, env, oldTree, segments, mode, getBlobSha(write), asPath, write);
  runRewrite(bin, "add-file", repo, env, {
    apply: !!flags.apply,
    refuseMessageChange: false,
    transformTree,
    changeLabel: "would add/replace " + asPath,
    ruleSourcesCheck: null,
    precheck: (oldTree) => refuseDirectoryAt(repo, env, oldTree, segments, asPath)
  });
}
main("git-history-rewrite", (bin) => {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);
  if (sub === void 0) throw new UsageError("missing subcommand (usage: " + bin + " replace|add-file <repo> ...)");
  if (sub === "replace") return cmdReplace(bin, rest);
  if (sub === "add-file") return cmdAddFile(bin, rest);
  throw new UsageError("unknown subcommand '" + sub + "'");
});
