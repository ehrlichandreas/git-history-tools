#!/usr/bin/env node

// lib/sign.ts
import fs5 from "node:fs";
import os3 from "node:os";
import path6 from "node:path";

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
var UTF8_ONLY = ["-c", "i18n.commitEncoding=UTF-8", "-c", "i18n.logOutputEncoding=UTF-8"];
function run(repo, args, opts) {
  const o = opts || {};
  const env = Object.assign({}, process.env, o.env || {});
  for (const k of CALLER_GIT_ENV) if (k !== "GIT_CONFIG_COUNT") delete env[k];
  env.GIT_NO_REPLACE_OBJECTS = "1";
  const pre = NO_REPO_CODE.concat(UTF8_ONLY, o.config || []);
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
function isInsideRepo(realRepo, candidate) {
  const rel = path2.relative(realRepo, candidate);
  return rel === "" || !rel.startsWith("..") && !path2.isAbsolute(rel);
}
function readUserFile(label, file) {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    const code = e.code;
    const why = code === "ENOENT" ? "no such file" : code === "EISDIR" ? "is a directory" : code === "EACCES" ? "permission denied" : "cannot read (" + (code || e.message) + ")";
    throw new UsageError(label + ": " + why + ": " + file);
  }
}
var UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decodeUserText(label, file, bytes) {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new UsageError(label + ": not valid UTF-8: " + file);
  }
}
var HELP_WORDS = ["--help", "-h", "help"];
function printHelp(sub, rest, synopses, footer) {
  if (sub === void 0) return false;
  if (HELP_WORDS.includes(sub)) {
    process.stdout.write("usage:\n" + Object.values(synopses).map((l) => "  " + l + "\n").join("") + footer + "\n");
    return true;
  }
  if (Object.hasOwn(synopses, sub) && (rest.includes("--help") || rest.includes("-h"))) {
    process.stdout.write("usage: " + synopses[sub] + "\n");
    return true;
  }
  return false;
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
var UTF82 = new TextDecoder("utf-8", { fatal: true });
function nonUtf8Reason(raw) {
  const end = raw.indexOf("\n\n");
  const head = (end === -1 ? raw : raw.subarray(0, end)).toString("latin1");
  const m = /^encoding (.*)$/m.exec(head);
  if (m && !/^utf-?8$/i.test(m[1].trim())) return "encoding " + m[1].trim();
  try {
    UTF82.decode(raw);
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
  process.stdout.write("backup: " + bundlePath + "\n");
  return bundlePath;
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

// lib/policy.ts
import fs4 from "node:fs";
import os2 from "node:os";
import path5 from "node:path";
var DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
var TOP_REQUIRED = ["identity", "signingKey", "timezone", "forbiddenWindows", "forbiddenMessagePatterns"];
var TOP_OPTIONAL = ["anonymousBefore", "gpgProgram"];
var IDENTITY_KEYS2 = ["name", "email"];
var WINDOW_KEYS = ["days", "from", "to"];
function fail(file, reason) {
  throw new Refusal("policy " + file + ": " + reason);
}
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function checkKeys(file, obj, required, label, optional) {
  const allowed = required.concat(optional || []);
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(file, "unknown key '" + label + (label ? "." : "") + k + "'");
  }
  for (const k of required) {
    if (!(k in obj)) fail(file, "missing key '" + (label ? label + "." : "") + k + "'");
  }
}
function validIanaTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
function validateIdentity(file, v) {
  if (!isPlainObject(v)) fail(file, "'identity' must be an object");
  checkKeys(file, v, IDENTITY_KEYS2, "identity");
  if (typeof v.name !== "string" || v.name === "") fail(file, "'identity.name' must be a non-empty string");
  if (typeof v.email !== "string" || v.email === "") fail(file, "'identity.email' must be a non-empty string");
  return { name: v.name, email: v.email };
}
function validateSigningKey(file, v) {
  if (typeof v !== "string" || !/^[0-9A-Fa-f]{16,40}$/.test(v)) {
    fail(file, "'signingKey' must be a 16-40 character hex key id/fingerprint");
  }
  return v;
}
function validateTimezone(file, v) {
  if (typeof v !== "string" || v === "" || !validIanaTimezone(v)) {
    fail(file, "'timezone' must be a valid IANA zone name (got " + JSON.stringify(v) + ")");
  }
  return v;
}
function validateWindow(file, v, i) {
  if (!isPlainObject(v)) fail(file, "'forbiddenWindows[" + i + "]' must be an object");
  checkKeys(file, v, WINDOW_KEYS, "forbiddenWindows[" + i + "]");
  if (!Array.isArray(v.days) || v.days.length === 0 || !v.days.every((d) => typeof d === "string" && DAYS.includes(d))) {
    fail(file, "'forbiddenWindows[" + i + "].days' must be a non-empty array of " + DAYS.join("/"));
  }
  if (new Set(v.days).size !== v.days.length) fail(file, "'forbiddenWindows[" + i + "].days' has a duplicate");
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (typeof v.from !== "string" || !timeRe.test(v.from)) fail(file, "'forbiddenWindows[" + i + "].from' must be HH:MM");
  if (typeof v.to !== "string" || !timeRe.test(v.to)) fail(file, "'forbiddenWindows[" + i + "].to' must be HH:MM");
  if (v.from >= v.to) fail(file, "'forbiddenWindows[" + i + "]': from must be earlier than to");
  return { days: v.days.slice(), from: v.from, to: v.to };
}
function compilePattern(p) {
  return new RegExp(p, "i");
}
function validatePatterns(file, v) {
  if (!Array.isArray(v) || !v.every((p) => typeof p === "string")) {
    fail(file, "'forbiddenMessagePatterns' must be an array of strings");
  }
  for (const p of v) {
    try {
      compilePattern(p);
    } catch (e) {
      fail(file, "'forbiddenMessagePatterns' has an invalid pattern " + JSON.stringify(p) + ": " + e.message);
    }
  }
  return v.slice();
}
function validateAnonymousBefore(file, v) {
  if (v === void 0) return void 0;
  if (typeof v !== "string") fail(file, "'anonymousBefore' must be an ISO date string");
  const t = Date.parse(v);
  if (Number.isNaN(t)) fail(file, "'anonymousBefore' is not a recognised date: " + JSON.stringify(v));
  return Math.floor(t / 1e3);
}
function validateGpgProgram(file, v) {
  if (v === void 0) return void 0;
  if (typeof v !== "string" || !path5.isAbsolute(v)) fail(file, "'gpgProgram' must be an absolute path (got " + JSON.stringify(v) + ")");
  let st;
  try {
    st = fs4.statSync(v);
  } catch (e) {
    fail(file, "'gpgProgram' does not exist: " + v);
  }
  if (!st.isFile()) fail(file, "'gpgProgram' is not a file: " + v);
  try {
    fs4.accessSync(v, fs4.constants.X_OK);
  } catch (e) {
    fail(file, "'gpgProgram' is not executable: " + v);
  }
  return v;
}
function validatePolicy(parsed, file) {
  if (!isPlainObject(parsed)) fail(file, "must be a JSON object");
  checkKeys(file, parsed, TOP_REQUIRED, "", TOP_OPTIONAL);
  const identity = validateIdentity(file, parsed.identity);
  const signingKey = validateSigningKey(file, parsed.signingKey);
  const timezone = validateTimezone(file, parsed.timezone);
  if (!Array.isArray(parsed.forbiddenWindows)) fail(file, "'forbiddenWindows' must be an array");
  const forbiddenWindows = parsed.forbiddenWindows.map((w, i) => validateWindow(file, w, i));
  const forbiddenMessagePatterns = validatePatterns(file, parsed.forbiddenMessagePatterns);
  const anonymousBefore = validateAnonymousBefore(file, parsed.anonymousBefore);
  const gpgProgram = validateGpgProgram(file, parsed.gpgProgram);
  const policy = { identity, signingKey, timezone, forbiddenWindows, forbiddenMessagePatterns };
  if (anonymousBefore !== void 0) policy.anonymousBefore = anonymousBefore;
  if (gpgProgram !== void 0) policy.gpgProgram = gpgProgram;
  return policy;
}
function defaultPolicyPath(env) {
  const base = env.XDG_CONFIG_HOME || path5.join(env.HOME || os2.homedir(), ".config");
  return path5.join(base, "git-history-tools", "policy.json");
}
function loadPolicy(repo, explicitPath, env) {
  const file = explicitPath !== void 0 ? explicitPath : defaultPolicyPath(env);
  if (!fs4.existsSync(file)) throw new Refusal("policy file not found: " + file);
  const abs = path5.resolve(file);
  const realRepo = fs4.realpathSync(repo);
  const realDir = fs4.realpathSync(path5.dirname(abs));
  const realFileShallow = path5.join(realDir, path5.basename(abs));
  const realFileFull = fs4.realpathSync(abs);
  if (isInsideRepo(realRepo, realFileShallow) || isInsideRepo(realRepo, realFileFull)) {
    throw new Refusal("--policy points inside the repo (" + file + ") -- keep it outside");
  }
  let raw;
  try {
    raw = fs4.readFileSync(realFileFull, "utf8");
  } catch (e) {
    throw new Refusal("policy " + file + ": cannot read (" + e.message + ")");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Refusal("policy " + file + ": not valid JSON (" + e.message + ")");
  }
  return validatePolicy(parsed, file);
}
function zonedParts(epochSeconds, tz) {
  const d = new Date(epochSeconds * 1e3);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d).toLowerCase();
  const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return { weekday, hhmm };
}
function zonedOffsetSeconds(epochSeconds, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric"
  }).formatToParts(new Date(epochSeconds * 1e3));
  const field = (type) => Number(parts.find((p) => p.type === type)?.value);
  const wallAsUtc = Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second"));
  return Math.round(wallAsUtc / 1e3 - Math.floor(epochSeconds));
}
function zonedOffsetString(epochSeconds, tz) {
  const off = zonedOffsetSeconds(epochSeconds, tz);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 3600)).padStart(2, "0");
  const mm = String(Math.floor(abs % 3600 / 60)).padStart(2, "0");
  return sign + hh + mm;
}
function gitDateAt(epochSeconds, tz) {
  return "@" + epochSeconds + " " + zonedOffsetString(epochSeconds, tz);
}
function formatZoned(epochSeconds, tz) {
  const d = new Date(epochSeconds * 1e3);
  const datePart = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const timePart = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).format(d);
  return datePart + " " + timePart + " " + zonedOffsetString(epochSeconds, tz);
}
function isForbiddenInstant(epochSeconds, policy) {
  const { weekday, hhmm } = zonedParts(epochSeconds, policy.timezone);
  return policy.forbiddenWindows.some((w) => w.days.includes(weekday) && hhmm >= w.from && hhmm < w.to);
}
function isExemptAnonymousDate(epochSeconds, policy) {
  return policy.anonymousBefore !== void 0 && epochSeconds < policy.anonymousBefore;
}
function matchForbiddenPattern(message, policy) {
  for (const p of policy.forbiddenMessagePatterns) {
    if (compilePattern(p).test(message)) return p;
  }
  return null;
}
function epochForZonedWallClock(y, mo, d, hh, mi, ss, tz) {
  const wallAsUtc = Math.floor(Date.UTC(y, mo - 1, d, hh, mi, ss) / 1e3);
  const offsets = new Set([-86400, 0, 86400].map((delta) => zonedOffsetSeconds(wallAsUtc + delta, tz)));
  const candidates = [...offsets].map((off) => wallAsUtc - off).filter((e) => zonedOffsetSeconds(e, tz) === wallAsUtc - e);
  const pad = (n) => String(n).padStart(2, "0");
  const wall = y + "-" + pad(mo) + "-" + pad(d) + "T" + pad(hh) + ":" + pad(mi) + ":" + pad(ss);
  if (candidates.length === 0) {
    throw new Refusal("--date " + wall + " does not exist in " + tz + " (skipped by a DST change) -- give an explicit offset");
  }
  if (candidates.length > 1) {
    const both = candidates.sort((a, b) => a - b).map((e) => zonedOffsetString(e, tz)).join(" and ");
    throw new Refusal("--date " + wall + " occurs twice in " + tz + " (" + both + ") -- give an explicit offset");
  }
  return candidates[0];
}
function latestAllowedMinuteAtOrBefore(now, after, policy) {
  let t = now - now % 60;
  const lowerExclusive = after;
  let steps = 0;
  while (t > lowerExclusive && steps < 20160) {
    if (!isForbiddenInstant(t, policy)) return t;
    t -= 60;
    steps++;
  }
  return null;
}
function nextAllowedMinuteAfter(from, policy) {
  let t = from - from % 60 + 60;
  let steps = 0;
  while (isForbiddenInstant(t, policy) && steps < 20160) {
    t += 60;
    steps++;
  }
  return isForbiddenInstant(t, policy) ? null : t;
}
function firstAllowedMinuteAtOrAfter(from, policy) {
  let t = Math.ceil(from / 60) * 60;
  let steps = 0;
  while (isForbiddenInstant(t, policy) && steps < 20160) {
    t += 60;
    steps++;
  }
  return isForbiddenInstant(t, policy) ? null : t;
}
function signTimeFor(epoch, policy, keyCreated) {
  if (isExemptAnonymousDate(epoch, policy)) return keyCreated + 60;
  const floor = firstAllowedMinuteAtOrAfter(keyCreated + 60, policy);
  if (floor === null) {
    throw new Refusal("no policy-allowed minute found within 14 days of the signing key's own creation -- check forbiddenWindows");
  }
  return Math.max(epoch, floor);
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
function extractSignature(repo, env, kind, rev) {
  const raw = text(repo, ["cat-file", kind, rev], { env });
  if (kind === "tag") {
    const { index, count } = tagSignatureBoundary(raw);
    return count === 1 ? raw.slice(index) + "\n" : null;
  }
  if (signatureBlockCount(raw, kind) > 1) return null;
  const headerEnd = raw.indexOf("\n\n");
  const header = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  const lines = header.split("\n");
  const start = lines.findIndex((l) => l.startsWith("gpgsig ") || l.startsWith("gpgsig-sha256 "));
  if (start === -1) return null;
  const prefixLen = lines[start].startsWith("gpgsig-sha256 ") ? "gpgsig-sha256 ".length : "gpgsig ".length;
  const sigLines = [lines[start].slice(prefixLen)];
  let i = start + 1;
  while (i < lines.length && lines[i].startsWith(" ")) {
    sigLines.push(lines[i].slice(1));
    i++;
  }
  return sigLines.join("\n") + "\n";
}
function signatureCreationTime(gpgProgram, env, armored) {
  const r = spawnSync3(gpgProgram, ["--list-packets"], { env, input: armored, encoding: "utf8" });
  const m = /version \d+, created (\d+),/.exec(r.stdout || "");
  return m ? parseInt(m[1], 10) : null;
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
function verifiedKeyFingerprint(repo, env, kind, rev) {
  const args = kind === "commit" ? ["verify-commit", "--raw", rev] : ["verify-tag", "--raw", rev];
  const r = run(repo, args, { env });
  const m = /^\[GNUPG:\] VALIDSIG ([0-9A-Fa-f]+) /m.exec(r.stderr || "");
  return m ? m[1].toUpperCase() : null;
}
function keyMatches(full, reported) {
  if (!reported) return false;
  const a = full.toUpperCase();
  const b = reported.toUpperCase();
  return a === b || b.length < a.length && a.endsWith(b);
}

// lib/sign.ts
function resolveRevList(repo, env, opts, revs, label) {
  const r = run(repo, ["rev-list"].concat(opts, ["--end-of-options"], revs), { env });
  if (r.status !== 0) throw new Refusal("invalid revision range '" + label + "'");
  const out = r.stdout.replace(/\n$/, "");
  return out ? out.split("\n") : [];
}
function refuseOptionLikeRange(range) {
  if (range.split(/\.{2,3}/).some((side) => side.startsWith("-"))) {
    throw new UsageError("<range> '" + range + "': a revision must not start with '-'");
  }
}
function splitIdent(s) {
  const m = /^(.*) <([^>]*)>$/.exec(s);
  return m ? { name: m[1], email: m[2] } : { name: s, email: "" };
}
function writeTmpMsg(msg) {
  const dir = fs5.mkdtempSync(path6.join(os3.tmpdir(), "ght-signmsg-"));
  try {
    const p = path6.join(dir, "msg.txt");
    fs5.writeFileSync(p, msg);
    return { path: p, cleanup() {
      try {
        fs5.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
      }
    } };
  } catch (e) {
    try {
      fs5.rmSync(dir, { recursive: true, force: true });
    } catch (e2) {
    }
    throw e;
  }
}
function policyContext(repo, flags) {
  const policy = loadPolicy(repo, flags.policy, process.env);
  const gpgProgram = policy.gpgProgram || "gpg";
  let env = withGitConfig(process.env, "gpg.program", gpgProgram);
  for (const [k, v] of PIN_OTHER_SIGNERS) env = withGitConfig(env, k, v);
  return { policy, gpgProgram, env };
}
function withGitConfig(env, key, value) {
  const n = parseInt(env.GIT_CONFIG_COUNT || "0", 10) || 0;
  return Object.assign({}, env, {
    GIT_CONFIG_COUNT: String(n + 1),
    ["GIT_CONFIG_KEY_" + n]: key,
    ["GIT_CONFIG_VALUE_" + n]: value
  });
}
function nowSeconds(env) {
  if (env.GHT_NOW !== void 0) {
    const n = parseInt(env.GHT_NOW, 10);
    if (Number.isFinite(n)) return n;
  }
  return Math.floor(Date.now() / 1e3);
}
function resolveMessage(flags) {
  const hasMessage = flags.message !== void 0;
  const hasMessageFile = flags["message-file"] !== void 0;
  if (hasMessage === hasMessageFile) throw new UsageError("exactly one of --message or --message-file is required");
  if (hasMessage) return flags.message;
  const file = flags["message-file"];
  return decodeUserText("--message-file", file, file === "-" ? fs5.readFileSync(0) : readUserFile("--message-file", file));
}
var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/;
function normaliseOffset(off) {
  if (off === "Z" || off.includes(":")) return off;
  return off.slice(0, 3) + ":" + off.slice(3);
}
function parseExplicitDate(value, tz) {
  const m = DATE_RE.exec(value);
  if (!m) throw new UsageError("--date: not a recognised date (expected YYYY-MM-DDTHH:MM[:SS][Z|+HH:MM], or 'auto')");
  const [, Y, Mo, D, H, Mi, S, Off] = m;
  const ss = S ? parseInt(S, 10) : 0;
  if (Off) {
    const iso = Y + "-" + Mo + "-" + D + "T" + H + ":" + Mi + ":" + String(ss).padStart(2, "0") + normaliseOffset(Off);
    const t = Date.parse(iso);
    if (Number.isNaN(t)) throw new UsageError("--date: not a recognised date: " + value);
    return Math.floor(t / 1e3);
  }
  return epochForZonedWallClock(parseInt(Y, 10), parseInt(Mo, 10), parseInt(D, 10), parseInt(H, 10), parseInt(Mi, 10), ss, tz);
}
function resolveDate(flags, policy, env, lowerExclusive, lowerLabel) {
  const raw = flags.date;
  if (raw === void 0) throw new UsageError("missing --date (an explicit date, or 'auto')");
  if (raw === "auto") {
    const now = nowSeconds(env);
    const lower = lowerExclusive === null ? -Infinity : lowerExclusive;
    const found = latestAllowedMinuteAtOrBefore(now, lower, policy);
    if (found === null) {
      const next = nextAllowedMinuteAfter(Math.max(now, lower), policy);
      if (next === null) {
        throw new Refusal("no allowed minute between " + lowerLabel + " committer date and now, and none found within 14 days afterward either -- check forbiddenWindows");
      }
      throw new Refusal("no allowed minute between " + lowerLabel + " committer date and now -- next allowed minute is " + formatZoned(next, policy.timezone));
    }
    return found;
  }
  const epoch = parseExplicitDate(raw, policy.timezone);
  if (isForbiddenInstant(epoch, policy)) {
    throw new Refusal("--date " + formatZoned(epoch, policy.timezone) + " falls in a forbidden window");
  }
  if (lowerExclusive !== null && epoch <= lowerExclusive) {
    throw new Refusal("--date " + formatZoned(epoch, policy.timezone) + " is not after " + lowerLabel + " committer date (" + formatZoned(lowerExclusive, policy.timezone) + ")");
  }
  return epoch;
}
function committerDateEpoch(repo, env, rev) {
  const raw = text(repo, ["log", "-1", "--format=%cd", "--date=raw", rev], { env });
  return parseInt(raw.split(" ")[0], 10);
}
function dryRunReport(policy, chosenEpoch, signTime) {
  return [
    "sign: identity " + policy.identity.name + " <" + policy.identity.email + ">",
    "sign: date " + formatZoned(chosenEpoch, policy.timezone),
    "sign: key " + policy.signingKey,
    "sign: signature time " + formatZoned(signTime, policy.timezone)
  ];
}
function parentForMode(repo, env, amend) {
  const headExists = run(repo, ["rev-parse", "--verify", "--quiet", "HEAD"], { env }).status === 0;
  if (amend) {
    if (!headExists) throw new Refusal("--amend: no HEAD commit to amend");
    const r = run(repo, ["rev-parse", "--verify", "--quiet", "HEAD^"], { env });
    return r.status === 0 ? r.stdout.replace(/\n$/, "") : null;
  }
  return headExists ? text(repo, ["rev-parse", "HEAD"], { env }) : null;
}
function cmdCommit(bin, args) {
  const { positional, flags } = parseFlags(args, {
    valueFlags: ["--message", "--message-file", "--date", "--policy"],
    boolFlags: ["--amend", "--apply"]
  });
  const repo = positional[0];
  if (!repo) throw new UsageError("missing <repo>");
  if (positional.length > 1) throw new UsageError("unexpected argument: " + positional[1]);
  requireRepo(repo);
  const { policy, gpgProgram, env } = policyContext(repo, flags);
  const message = resolveMessage(flags);
  const matched = matchForbiddenPattern(message, policy);
  if (matched) throw new Refusal("message matches forbidden pattern: " + matched);
  const amend = !!flags.amend;
  const parent = parentForMode(repo, env, amend);
  const lowerExclusive = parent === null ? null : committerDateEpoch(repo, env, parent);
  const chosenEpoch = resolveDate(flags, policy, env, lowerExclusive, "the parent's");
  const created = keyCreationTime(gpgProgram, policy.signingKey, env);
  const signTime = signTimeFor(chosenEpoch, policy, created);
  const report = dryRunReport(policy, chosenEpoch, signTime);
  if (!flags.apply) {
    process.stdout.write(report.map((l) => l + "\n").join(""));
    process.stdout.write(bin + ": dry run, nothing committed (use --apply to write)\n");
    return;
  }
  const signer = createSigner(repo, env, { signingKey: policy.signingKey, signTime, gpgProgram });
  let tmp;
  try {
    tmp = writeTmpMsg(message);
    const dateStr = gitDateAt(chosenEpoch, policy.timezone);
    const commitArgs = [
      "commit",
      "-S",
      "--date=" + dateStr,
      "--author=" + policy.identity.name + " <" + policy.identity.email + ">",
      "-F",
      tmp.path
    ];
    if (amend) commitArgs.push("--amend");
    const r = run(repo, commitArgs, {
      env: Object.assign({}, env, {
        GIT_AUTHOR_NAME: policy.identity.name,
        GIT_AUTHOR_EMAIL: policy.identity.email,
        GIT_AUTHOR_DATE: dateStr,
        GIT_COMMITTER_NAME: policy.identity.name,
        GIT_COMMITTER_EMAIL: policy.identity.email,
        GIT_COMMITTER_DATE: dateStr
      }),
      config: signer.gitConfig
    });
    if (r.status !== 0) throw new Refusal("git commit failed: " + r.stderr.trim().split("\n")[0]);
    const sha = text(repo, ["rev-parse", "--short", "HEAD"], { env });
    process.stdout.write(report.map((l) => l + "\n").join(""));
    process.stdout.write("sign: commit " + sha + "\n");
  } finally {
    signer.cleanup();
    if (tmp) tmp.cleanup();
  }
}
function cmdTag(bin, args) {
  const { positional, flags } = parseFlags(args, {
    valueFlags: ["--message", "--message-file", "--date", "--policy"],
    boolFlags: ["--apply"]
  });
  const repo = positional[0];
  const tagName = positional[1];
  if (!repo) throw new UsageError("missing <repo>");
  if (!tagName) throw new UsageError("missing <tag>");
  if (positional.length > 2) throw new UsageError("unexpected argument: " + positional[2]);
  if (!isValidTagName(tagName)) throw new UsageError("<tag>: " + JSON.stringify(tagName) + " is not a valid tag name");
  requireRepo(repo);
  const { policy, gpgProgram, env } = policyContext(repo, flags);
  const message = resolveMessage(flags);
  const matched = matchForbiddenPattern(message, policy);
  if (matched) throw new Refusal("message matches forbidden pattern: " + matched);
  const exists = run(repo, ["rev-parse", "--verify", "--quiet", "refs/tags/" + tagName], { env }).status === 0;
  if (exists) throw new Refusal("tag " + tagName + " already exists -- use resign-tags to re-sign it");
  const headExists = run(repo, ["rev-parse", "--verify", "--quiet", "HEAD"], { env }).status === 0;
  if (!headExists) throw new Refusal("no HEAD commit to tag");
  const target = text(repo, ["rev-parse", "HEAD"], { env });
  const lowerExclusive = committerDateEpoch(repo, env, target);
  const chosenEpoch = resolveDate(flags, policy, env, lowerExclusive, "the target's");
  const created = keyCreationTime(gpgProgram, policy.signingKey, env);
  const signTime = signTimeFor(chosenEpoch, policy, created);
  const report = dryRunReport(policy, chosenEpoch, signTime);
  if (!flags.apply) {
    process.stdout.write(report.map((l) => l + "\n").join(""));
    process.stdout.write(bin + ": dry run, no ref changed (use --apply to write)\n");
    return;
  }
  const signer = createSigner(repo, env, { signingKey: policy.signingKey, signTime, gpgProgram });
  let tmp;
  try {
    tmp = writeTmpMsg(message);
    const dateStr = gitDateAt(chosenEpoch, policy.timezone);
    const r = run(repo, ["tag", "-s", "-F", tmp.path, tagName, target], {
      env: Object.assign({}, env, {
        GIT_COMMITTER_NAME: policy.identity.name,
        GIT_COMMITTER_EMAIL: policy.identity.email,
        GIT_COMMITTER_DATE: dateStr
      }),
      config: signer.gitConfig
    });
    if (r.status !== 0) throw new Refusal("git tag failed: " + r.stderr.trim().split("\n")[0]);
    process.stdout.write(report.map((l) => l + "\n").join(""));
    process.stdout.write("sign: tag " + tagName + "\n");
  } finally {
    signer.cleanup();
    if (tmp) tmp.cleanup();
  }
}
function annotatedTags(repo, env) {
  const out = text(
    repo,
    ["for-each-ref", "--format=%(refname)	%(objecttype)	%(objectname)	%(*objectname)", "refs/tags"],
    { env }
  );
  if (!out) return [];
  return out.split("\n").map((l) => {
    const [ref, type, obj, deref] = l.split("	");
    return { name: refBase(ref, "refs/tags/"), type, obj, commit: type === "tag" ? deref : obj };
  });
}
function stripSignature(raw) {
  const { index } = tagSignatureBoundary(raw.toString("latin1"));
  return index === -1 ? raw : raw.subarray(0, index);
}
function independentOldTagMessage(message, oldSigCount) {
  if (oldSigCount !== 1) return message;
  const m = /\n?(-----BEGIN (?:PGP|SSH) SIGNATURE-----\n(?:(?!-----END (?:PGP|SSH) SIGNATURE-----)[\s\S])*\n-----END (?:PGP|SSH) SIGNATURE-----\n?)$/.exec(message);
  return m ? message.slice(0, m.index) : message;
}
function refuseAmbiguousTag(repo, env, policy, t, label) {
  const raw = buffer(repo, ["cat-file", "-p", t.obj], { env }).toString("utf8");
  if (signatureBlockCount(raw, "tag") !== 1) return;
  if (signatureStatus(repo, env, "tag", "refs/tags/" + t.name, true, policy.signingKey).state !== "bad") return;
  throw new Refusal(label + " ends with a signature-shaped block gpg cannot verify or attribute to any key -- indistinguishable from an unsigned tag whose message merely ends with a quoted block; refusing to guess, resolve manually");
}
function cmdResignTags(bin, args) {
  const { positional, flags } = parseFlags(args, { valueFlags: ["--policy"], boolFlags: ["--apply"] });
  const repo = positional[0];
  if (!repo) throw new UsageError("missing <repo>");
  requireRepo(repo);
  const { policy, gpgProgram, env } = policyContext(repo, flags);
  const explicitNames = positional.slice(1);
  const all = annotatedTags(repo, env);
  const byName = new Map(all.map((t) => [t.name, t]));
  const candidates = [];
  const skippedLightweight = [];
  if (explicitNames.length > 0) {
    for (const n of explicitNames) {
      const t = byName.get(n);
      if (!t) throw new UsageError("no such tag: " + n);
      if (t.type !== "tag") {
        skippedLightweight.push(n);
        continue;
      }
      candidates.push(t);
    }
  } else {
    for (const t of all) {
      if (t.type !== "tag") {
        skippedLightweight.push(t.name);
        continue;
      }
      const fp = verifiedKeyFingerprint(repo, env, "tag", "refs/tags/" + t.name);
      if (!keyMatches(policy.signingKey, fp)) candidates.push(t);
    }
  }
  refuseNonUtf8(repo, env, candidates.map((t) => ({ sha: t.obj, label: "tag " + t.name })));
  const lines = [];
  for (const n of skippedLightweight) lines.push("resign-tags: " + n + " is lightweight, skipped");
  if (candidates.length === 0) {
    process.stdout.write(lines.map((l) => l + "\n").join(""));
    process.stdout.write(bin + ": nothing to resign\n");
    return;
  }
  if (!flags.apply) {
    for (const t of candidates) {
      lines.push("resign-tags: " + t.name + " would be re-signed");
      const hasSig = extractSignature(repo, env, "tag", "refs/tags/" + t.name) !== null;
      const status = signatureStatus(repo, env, "tag", "refs/tags/" + t.name, hasSig, policy.signingKey);
      const key = unverifiableKeyLabel(status);
      if (key) lines.push("resign-tags: " + t.name + " would replace unverifiable signature (key " + key + ")");
    }
    process.stdout.write(lines.map((l) => l + "\n").join(""));
    process.stdout.write(bin + ": dry run, no ref changed (use --apply to write)\n");
    return;
  }
  keyCreationTime(gpgProgram, policy.signingKey, env);
  for (const t of candidates) refuseAmbiguousTag(repo, env, policy, t, t.name);
  createBackupBundle(repo, env);
  const results = [];
  {
    for (const t of candidates) {
      const oldSha = t.obj;
      const raw = buffer(repo, ["cat-file", "-p", oldSha], { env }).toString("utf8");
      const tm = /^tagger (.*) (\d+ [+-]\d{4})$/m.exec(raw);
      const taggerEpoch = parseInt(tm[2].split(" ")[0], 10);
      const msg = tagMessageFromRaw(raw);
      const oldSigCount = signatureBlockCount(raw, "tag");
      const hasSig = oldSigCount === 1;
      const oldStatus = signatureStatus(repo, env, "tag", "refs/tags/" + t.name, hasSig, policy.signingKey);
      if (hasSig && oldStatus.state === "bad") {
        throw new Refusal(t.name + " ends with a signature-shaped block gpg cannot verify or attribute to any key -- indistinguishable from an unsigned tag whose message merely ends with a quoted block; refusing to guess, resolve manually");
      }
      const oldKey = unverifiableKeyLabel(oldStatus);
      if (oldKey) lines.push("resign-tags: " + t.name + " replaced unverifiable signature (key " + oldKey + ")");
      const headerEnd = raw.indexOf("\n\n");
      const rawMessagePart = headerEnd === -1 ? "" : raw.slice(headerEnd + 2);
      const independentOldMsg = independentOldTagMessage(rawMessagePart, oldSigCount);
      const created = keyCreationTime(gpgProgram, policy.signingKey, env);
      const signTime = signTimeFor(taggerEpoch, policy, created);
      const signer = createSigner(repo, env, { signingKey: policy.signingKey, signTime, gpgProgram });
      let newSha;
      try {
        newSha = buildSignedTagObject(repo, env, signer, {
          object: t.commit,
          type: "commit",
          name: t.name,
          taggerLine: tm[1] + " " + tm[2],
          message: msg
        });
      } finally {
        signer.cleanup();
      }
      results.push({ name: t.name, oldSha, newSha, independentOldMsg });
    }
    const stdinLines = ["start"];
    for (const r of results) stdinLines.push("update refs/tags/" + r.name + " " + r.newSha + " " + r.oldSha);
    stdinLines.push("prepare", "commit");
    const txn = run(repo, ["update-ref", "--stdin"], { env, input: stdinLines.join("\n") + "\n" });
    if (txn.status !== 0) {
      throw new Refusal("ref update transaction failed: " + txn.stderr.trim().split("\n")[0]);
    }
    let allOk = true;
    for (const r of results) {
      const newTarget = text(repo, ["rev-parse", r.newSha + "^{commit}"], { env });
      const oldTarget = text(repo, ["rev-parse", r.oldSha + "^{commit}"], { env });
      const sameTarget = newTarget === oldTarget;
      const oldBody = stripSignature(buffer(repo, ["cat-file", "-p", r.oldSha], { env }));
      const newRawBuf = buffer(repo, ["cat-file", "-p", r.newSha], { env });
      const newBody = stripSignature(newRawBuf);
      const oldText = oldBody.toString("latin1");
      const sep = oldText.indexOf("\n\n");
      const expectedBody = sep === -1 ? oldText : oldText.slice(0, sep + 2) + signableTagMessage(oldText.slice(sep + 2));
      const bodyOk = expectedBody === newBody.toString("latin1");
      const newRaw = newRawBuf.toString("utf8");
      const sigBlocksOk = signatureBlockCount(newRaw, "tag") === 1;
      const messageIndependentOk = tagMessageFromRaw(newRaw).replace(/\n*$/, "") === r.independentOldMsg.replace(/\n*$/, "");
      const verifyOk = run(repo, ["verify-tag", "refs/tags/" + r.name], { env }).status === 0;
      const ok = sameTarget && bodyOk && sigBlocksOk && messageIndependentOk && verifyOk;
      if (!ok) allOk = false;
      lines.push("verify: " + r.name + ": " + (ok ? "OK" : "FAILED (" + (!sameTarget ? "target changed" : !bodyOk || !messageIndependentOk ? "tagger/message changed" : !sigBlocksOk ? "multiple-signatures" : "signature not accepted") + ")"));
    }
    for (const r of results) {
      lines.push("resign-tags: " + r.name + " " + r.oldSha + " -> " + r.newSha + (r.oldSha === r.newSha ? " (unchanged)" : ""));
    }
    for (const r of results) {
      if (r.oldSha === r.newSha) continue;
      lines.push("# git push --force-with-lease=refs/tags/" + r.name + ":" + r.oldSha + " <remote> refs/tags/" + r.name);
    }
    process.stdout.write(lines.map((l) => l + "\n").join(""));
    process.exitCode = allOk ? 0 : 1;
  }
}
function signatureDetail(status) {
  if (status.state === "missing") return "missing";
  if (status.state === "unknown-key") return "signed by unknown key " + status.keyid + " (not in keyring)";
  if (status.state === "wrong-key") return "good signature but by " + status.fingerprint + ", not the policy key";
  return "bad signature";
}
function unverifiableKeyLabel(status) {
  return status.state === "unknown-key" ? status.keyid : null;
}
function sigTimeViolation(label, sig, policy, gpgProgram, env, anonymous) {
  const st = signatureCreationTime(gpgProgram, env, sig);
  if (st === null) return label + " sig-time signature creation time could not be read";
  if (anonymous) {
    const expected = keyCreationTime(gpgProgram, policy.signingKey, env) + 60;
    if (st !== expected) {
      return label + " sig-time anonymous object not signed at the pinned time (expected " + formatZoned(expected, policy.timezone) + ", got " + formatZoned(st, policy.timezone) + ")";
    }
    return null;
  }
  if (isForbiddenInstant(st, policy)) return label + " sig-time signature created " + formatZoned(st, policy.timezone) + " falls in a forbidden window";
  return null;
}
function checkOneCommit(repo, env, sha, policy, gpgProgram) {
  const out = [];
  const short = text(repo, ["rev-parse", "--short", sha], { env });
  const raw = text(repo, ["cat-file", "commit", sha], { env });
  const am = /^author (.*) (\d+) [+-]\d{4}$/m.exec(raw);
  const cm = /^committer (.*) (\d+) [+-]\d{4}$/m.exec(raw);
  if (am) {
    const a = splitIdent(am[1]);
    if (a.name !== policy.identity.name || a.email !== policy.identity.email) {
      out.push(short + " identity author is " + am[1] + ", not the policy identity");
    }
    const t = parseInt(am[2], 10);
    if (!isExemptAnonymousDate(t, policy) && isForbiddenInstant(t, policy)) {
      out.push(short + " date author date " + formatZoned(t, policy.timezone) + " falls in a forbidden window");
    }
  }
  let committerEpoch = null;
  if (cm) {
    const c = splitIdent(cm[1]);
    if (c.name !== policy.identity.name || c.email !== policy.identity.email) {
      out.push(short + " identity committer is " + cm[1] + ", not the policy identity");
    }
    committerEpoch = parseInt(cm[2], 10);
    if (!isExemptAnonymousDate(committerEpoch, policy) && isForbiddenInstant(committerEpoch, policy)) {
      out.push(short + " date committer date " + formatZoned(committerEpoch, policy.timezone) + " falls in a forbidden window");
    }
  }
  const sigBlocks = signatureBlockCount(raw, "commit");
  if (sigBlocks > 1) {
    out.push(short + " signature multiple-signatures (" + sigBlocks + " signature blocks found)");
  } else {
    const sig = extractSignature(repo, env, "commit", sha);
    const status = signatureStatus(repo, env, "commit", sha, sig !== null, policy.signingKey);
    if (status.state !== "ok") {
      out.push(short + " signature " + signatureDetail(status));
    } else if (sig) {
      const anonymous = committerEpoch !== null && isExemptAnonymousDate(committerEpoch, policy);
      const v = sigTimeViolation(short, sig, policy, gpgProgram, env, anonymous);
      if (v) out.push(v);
    }
  }
  const msg = text(repo, ["log", "-1", "--format=%B", sha], { env });
  const matched = matchForbiddenPattern(msg, policy);
  if (matched) out.push(short + " message matches forbidden pattern: " + matched);
  return out;
}
function checkOneTag(repo, env, t, policy, gpgProgram) {
  const out = [];
  const raw = buffer(repo, ["cat-file", "tag", t.obj], { env }).toString("utf8");
  const tm = /^tagger (.*) (\d+) [+-]\d{4}$/m.exec(raw);
  if (tm) {
    const ident = splitIdent(tm[1]);
    if (ident.name !== policy.identity.name || ident.email !== policy.identity.email) {
      out.push(t.name + " identity tagger is " + tm[1] + ", not the policy identity");
    }
    const when = parseInt(tm[2], 10);
    if (!isExemptAnonymousDate(when, policy) && isForbiddenInstant(when, policy)) {
      out.push(t.name + " date tagger date " + formatZoned(when, policy.timezone) + " falls in a forbidden window");
    }
  }
  const sigBlocks = signatureBlockCount(raw, "tag");
  if (sigBlocks > 1) {
    out.push(t.name + " signature multiple-signatures (" + sigBlocks + " signature blocks found)");
  } else {
    const sig = extractSignature(repo, env, "tag", t.obj);
    const status = signatureStatus(repo, env, "tag", "refs/tags/" + t.name, sig !== null, policy.signingKey);
    if (status.state !== "ok") {
      out.push(t.name + " signature " + signatureDetail(status));
    } else if (sig) {
      const taggerEpoch = tm ? parseInt(tm[2], 10) : null;
      const anonymous = taggerEpoch !== null && isExemptAnonymousDate(taggerEpoch, policy);
      const v = sigTimeViolation(t.name, sig, policy, gpgProgram, env, anonymous);
      if (v) out.push(v);
    }
  }
  const msg = tagMessageFromRaw(raw);
  const matched = matchForbiddenPattern(msg, policy);
  if (matched) out.push(t.name + " message matches forbidden pattern: " + matched);
  return out;
}
function cmdCheck(bin, args) {
  const { positional, flags } = parseFlags(args, { valueFlags: ["--range", "--policy"], boolFlags: ["--tags"] });
  const repo = positional[0];
  if (!repo) throw new UsageError("missing <repo>");
  if (positional.length > 2) throw new UsageError("unexpected argument: " + positional[2]);
  const positionalRange = positional[1];
  if (positionalRange !== void 0 && flags.range !== void 0) {
    throw new UsageError("give the revision range either positionally or as --range, not both");
  }
  const givenRange = positionalRange !== void 0 ? positionalRange : flags.range;
  if (givenRange !== void 0) refuseOptionLikeRange(givenRange);
  requireRepo(repo);
  const { policy, gpgProgram, env } = policyContext(repo, flags);
  let range = positionalRange !== void 0 ? positionalRange : flags.range;
  if (range === void 0) {
    const up = run(repo, ["rev-parse", "--verify", "--quiet", "@{upstream}"], { env });
    if (up.status !== 0) throw new Refusal("no upstream configured for HEAD -- pass --range explicitly (or as a positional argument)");
    range = "@{upstream}..HEAD";
  }
  const commits = resolveRevList(repo, env, ["--reverse"], [range], range);
  const lines = [];
  for (const c of commits) lines.push(...checkOneCommit(repo, env, c, policy, gpgProgram));
  let tagCount = 0;
  if (flags.tags) {
    for (const t of annotatedTags(repo, env)) {
      if (t.type !== "tag") continue;
      tagCount++;
      lines.push(...checkOneTag(repo, env, t, policy, gpgProgram));
    }
  }
  for (const l of lines) process.stdout.write(l + "\n");
  process.stdout.write("check: " + lines.length + " violation(s) across " + commits.length + " commit(s)" + (flags.tags ? " and " + tagCount + " tag(s)" : "") + "\n");
  process.exitCode = lines.length > 0 ? 1 : 0;
}
function parseCommitForResign(repo, env, sha) {
  const raw = text(repo, ["cat-file", "commit", sha], { env });
  const treeM = /^tree ([0-9a-f]{40})$/m.exec(raw);
  if (!treeM) throw new Refusal(sha.slice(0, 7) + ": malformed commit, no tree line");
  const parents = [];
  const parentRe = /^parent ([0-9a-f]{40})$/mg;
  let pm;
  while (pm = parentRe.exec(raw)) parents.push(pm[1]);
  if (parents.length > 1) throw new Refusal("merge commits are not supported (" + sha.slice(0, 7) + ")");
  const am = /^author (.*) (\d+) ([+-]\d{4})$/m.exec(raw);
  const cm = /^committer (.*) (\d+) ([+-]\d{4})$/m.exec(raw);
  if (!am || !cm) throw new Refusal(sha.slice(0, 7) + ": malformed commit, missing author/committer line");
  const end = raw.indexOf("\n\n");
  const em = /^encoding (.*)$/m.exec(end < 0 ? raw : raw.slice(0, end));
  return {
    sha,
    tree: treeM[1],
    parents,
    authorIdent: splitIdent(am[1]),
    authorDate: "@" + am[2] + " " + am[3],
    committerIdent: splitIdent(cm[1]),
    committerDate: "@" + cm[2] + " " + cm[3],
    committerEpoch: parseInt(cm[2], 10),
    encoding: em ? em[1] : null
  };
}
function commitMessageBytes(repo, env, sha) {
  const raw = buffer(repo, ["cat-file", "commit", sha], { env });
  const idx = raw.indexOf("\n\n");
  return idx === -1 ? Buffer.alloc(0) : raw.subarray(idx + 2);
}
function headersMinusParentsAndSig(raw) {
  const text2 = raw.toString("utf8");
  const messageIdx = text2.indexOf("\n\n");
  const headerText = messageIdx === -1 ? text2 : text2.slice(0, messageIdx);
  const message = messageIdx === -1 ? "" : text2.slice(messageIdx);
  const lines = headerText.split("\n");
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith("parent ")) {
      i++;
      continue;
    }
    if (l.startsWith("gpgsig ") || l.startsWith("gpgsig-sha256 ")) {
      i++;
      while (i < lines.length && lines[i].startsWith(" ")) i++;
      continue;
    }
    kept.push(l);
    i++;
  }
  return Buffer.from(kept.join("\n") + message, "utf8");
}
function verifyHeadersPreserved(repo, env, pairs) {
  for (const p of pairs) {
    const oldRaw = buffer(repo, ["cat-file", "commit", p.old], { env });
    const newRaw = buffer(repo, ["cat-file", "commit", p.nw], { env });
    if (!headersMinusParentsAndSig(oldRaw).equals(headersMinusParentsAndSig(newRaw))) {
      return { ok: false, line: "verify: resign-commits: headers preserved: FAILED (" + p.old.slice(0, 7) + " -> " + p.nw.slice(0, 7) + " differs beyond parent/signature)" };
    }
  }
  return { ok: true, line: "verify: resign-commits: headers preserved: OK" };
}
function verifyParentsMapped(repo, env, pairs, parsed) {
  const parentsByOld = new Map(parsed.map((p) => [p.sha, p.parents]));
  const oldToNew = new Map(pairs.map((p) => [p.old, p.nw]));
  for (const p of pairs) {
    const oldParents = parentsByOld.get(p.old) || [];
    const expected = oldParents.length === 0 ? null : oldToNew.get(oldParents[0]) || oldParents[0];
    const newRaw = text(repo, ["cat-file", "commit", p.nw], { env });
    const pm = /^parent ([0-9a-f]{40})$/m.exec(newRaw);
    const actual = pm ? pm[1] : null;
    if (actual !== expected) {
      return { ok: false, line: "verify: resign-commits: parents mapped: FAILED (" + p.old.slice(0, 7) + " -> " + p.nw.slice(0, 7) + ": expected parent " + expected + ", got " + actual + ")" };
    }
  }
  return { ok: true, line: "verify: resign-commits: parents mapped: OK" };
}
function verifyNewSignatures(repo, env, gpgProgram, policy, pairs, movedTagNames) {
  const bad = [];
  for (const p of pairs) {
    for (const l of checkOneCommit(repo, env, p.nw, policy, gpgProgram)) {
      if (/ (signature|sig-time) /.test(l)) bad.push(l);
    }
  }
  for (const t of annotatedTags(repo, env)) {
    if (t.type !== "tag" || !movedTagNames.has(t.name)) continue;
    for (const l of checkOneTag(repo, env, t, policy, gpgProgram)) {
      if (/ (signature|sig-time) /.test(l)) bad.push(l);
    }
  }
  if (bad.length > 0) {
    return { ok: false, line: "verify: resign-commits: check (signature/sig-time): FAILED (" + bad[0] + (bad.length > 1 ? "; +" + (bad.length - 1) + " more" : "") + ")" };
  }
  return { ok: true, line: "verify: resign-commits: check (signature/sig-time): OK" };
}
function checkMapOutOutsideRepo(repo, filePath) {
  const abs = path6.resolve(filePath);
  const realRepo = fs5.realpathSync(repo);
  const parentDir = path6.dirname(abs);
  let realParent;
  try {
    realParent = fs5.realpathSync(parentDir);
  } catch (e) {
    throw new UsageError("--map-out: directory does not exist: " + parentDir);
  }
  const realFileShallow = path6.join(realParent, path6.basename(abs));
  if (isInsideRepo(realRepo, realFileShallow)) throw new Refusal("--map-out points inside the repo (" + filePath + ") -- keep it outside");
}
function cmdResignCommits(bin, args) {
  const { positional, flags } = parseFlags(args, { valueFlags: ["--policy", "--map-out"], boolFlags: ["--apply", "--from-root"] });
  const repo = positional[0];
  const range = positional[1];
  if (!repo) throw new UsageError("missing <repo>");
  if (!range) throw new UsageError("missing <range>");
  if (positional.length > 2) throw new UsageError("unexpected argument: " + positional[2]);
  if (range.includes("...")) throw new UsageError("<range> must be '<lower>..<upper>' (two dots, not three)");
  const dotdot = range.indexOf("..");
  const lower = dotdot === -1 ? null : range.slice(0, dotdot);
  const upper = dotdot === -1 ? range : range.slice(dotdot + 2);
  if (dotdot !== -1 && (!lower || !upper)) throw new UsageError("<range> must be '<lower>..<upper>'");
  if (!upper) throw new UsageError("<range> must be '<lower>..<upper>' or '<rev> --from-root'");
  const fromRoot = !!flags["from-root"];
  if (dotdot === -1 && !fromRoot) {
    throw new UsageError("'" + range + "' has no '..' -- that re-signs the whole history down to the root; pass --from-root if you mean that, or use <lower>..<upper>");
  }
  if (dotdot !== -1 && fromRoot) {
    throw new UsageError("--from-root takes a bare <rev>, not a range ('" + range + "')");
  }
  refuseOptionLikeRange(range);
  requireRepo(repo);
  const { policy, gpgProgram, env } = policyContext(repo, flags);
  if (flags["map-out"] !== void 0) checkMapOutOutsideRepo(repo, flags["map-out"]);
  let lowerSha = null;
  if (lower) {
    const lowerR = run(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", lower + "^{commit}"], { env });
    if (lowerR.status !== 0) throw new Refusal("invalid revision range '" + range + "'");
    lowerSha = lowerR.stdout.replace(/\n$/, "");
  }
  const upperR = run(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", upper + "^{commit}"], { env });
  if (upperR.status !== 0) throw new Refusal("invalid revision range '" + range + "'");
  const upperSha = upperR.stdout.replace(/\n$/, "");
  if (lowerSha) {
    const isAncestor = run(repo, ["merge-base", "--is-ancestor", lowerSha, upperSha], { env });
    if (isAncestor.status !== 0) {
      throw new Refusal("invalid revision range '" + range + "': " + upper + " is not a descendant of " + lower);
    }
  }
  const inRange = new Set(resolveRevList(repo, env, [], [range], range));
  const candidateLines = resolveRevList(
    repo,
    env,
    ["--topo-order", "--reverse", "--parents", "--branches", "--tags"],
    lowerSha ? ["^" + lowerSha] : [],
    range
  );
  const rewriteSet = /* @__PURE__ */ new Set();
  const toRewrite = [];
  for (const line2 of candidateLines) {
    const [sha, ...parents] = line2.split(" ");
    if (inRange.has(sha) || parents.some((p) => rewriteSet.has(p))) {
      rewriteSet.add(sha);
      toRewrite.push(sha);
    }
  }
  if (toRewrite.length === 0) throw new Refusal("nothing to resign in range '" + range + "'");
  const parsed = toRewrite.map((sha) => parseCommitForResign(repo, env, sha));
  for (const p of parsed) {
    if (p.authorIdent.name !== policy.identity.name || p.authorIdent.email !== policy.identity.email || p.committerIdent.name !== policy.identity.name || p.committerIdent.email !== policy.identity.email) {
      throw new Refusal(p.sha.slice(0, 7) + " author/committer is not the policy identity -- identities are never changed here");
    }
  }
  const branchesRaw = text(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], { env });
  const branches = branchesRaw ? branchesRaw.split("\n").map((l) => {
    const sp = l.indexOf(" ");
    return { name: refBase(l.slice(0, sp), "refs/heads/"), sha: l.slice(sp + 1) };
  }) : [];
  const affectedBranches = branches.filter((b) => rewriteSet.has(b.sha));
  const affectedTags = annotatedTags(repo, env).filter((t) => rewriteSet.has(t.commit));
  refuseNonUtf8(repo, env, [
    ...toRewrite.map((c) => ({ sha: c, label: "commit " + c.slice(0, 7) })),
    ...affectedTags.filter((t) => t.type === "tag").map((t) => ({ sha: t.obj, label: "tag " + t.name }))
  ]);
  const withHeader = parsed.find((p) => p.encoding !== null);
  if (withHeader) {
    throw new Refusal("commit " + withHeader.sha.slice(0, 7) + " has an encoding header (" + withHeader.encoding + ") -- a re-signed commit would lose it; not supported");
  }
  if (!flags.apply) {
    if (fromRoot) process.stdout.write("resign-commits: root-inclusive: " + toRewrite.length + " commits\n");
    for (const sha of toRewrite) {
      process.stdout.write("resign-commits: " + sha.slice(0, 7) + " would be re-signed\n");
      const hasSig = extractSignature(repo, env, "commit", sha) !== null;
      const status = signatureStatus(repo, env, "commit", sha, hasSig, policy.signingKey);
      const key = unverifiableKeyLabel(status);
      if (key) process.stdout.write("resign-commits: " + sha.slice(0, 7) + " would replace unverifiable signature (key " + key + ")\n");
    }
    for (const b of affectedBranches) process.stdout.write("resign-commits: branch " + b.name + " would move\n");
    for (const t of affectedTags) {
      process.stdout.write("resign-commits: tag " + t.name + (t.type === "tag" ? " would be re-signed and moved" : " would be moved") + "\n");
      if (t.type === "tag") {
        const hasSig = extractSignature(repo, env, "tag", "refs/tags/" + t.name) !== null;
        const status = signatureStatus(repo, env, "tag", "refs/tags/" + t.name, hasSig, policy.signingKey);
        const key = unverifiableKeyLabel(status);
        if (key) process.stdout.write("resign-commits: tag " + t.name + " would replace unverifiable signature (key " + key + ")\n");
      }
    }
    process.stdout.write(bin + ": dry run, no ref changed, no objects written (use --apply to write)\n");
    return;
  }
  keyCreationTime(gpgProgram, policy.signingKey, env);
  {
    const targets = /* @__PURE__ */ new Map();
    for (const t of affectedTags) {
      if (t.type !== "tag") continue;
      const raw = buffer(repo, ["cat-file", "-p", t.obj], { env }).toString("utf8");
      const om = /^object ([0-9a-f]{40})$/m.exec(raw);
      const tym = /^type (\S+)$/m.exec(raw);
      if (!om || !tym) throw new Refusal("tag " + t.name + ": malformed tag object");
      if (tym[1] !== "commit" && tym[1] !== "tag") {
        throw new Refusal("tag " + t.name + " points at a " + tym[1] + ", not a commit or tag -- not supported");
      }
      refuseAmbiguousTag(repo, env, policy, t, "tag " + t.name);
      targets.set(t.name, { type: tym[1], obj: om[1] });
    }
    const done = /* @__PURE__ */ new Set();
    const pending = new Set(targets.keys());
    let progressed = true;
    while (pending.size > 0 && progressed) {
      progressed = false;
      for (const t of affectedTags) {
        const target = targets.get(t.name);
        if (!target || !pending.has(t.name) || target.type === "tag" && !done.has(target.obj)) continue;
        done.add(t.obj);
        pending.delete(t.name);
        progressed = true;
      }
    }
    if (pending.size > 0) throw new Refusal("could not resolve tag dependency order for: " + Array.from(pending).join(", "));
  }
  createBackupBundle(repo, env);
  const signers = [];
  const tmpFiles = [];
  try {
    const oldToNew = /* @__PURE__ */ new Map();
    const pairs = [];
    for (const p of parsed) {
      const hasSig = extractSignature(repo, env, "commit", p.sha) !== null;
      const oldStatus = signatureStatus(repo, env, "commit", p.sha, hasSig, policy.signingKey);
      const oldKey = unverifiableKeyLabel(oldStatus);
      if (oldKey) process.stdout.write("resign-commits: " + p.sha.slice(0, 7) + " replaced unverifiable signature (key " + oldKey + ")\n");
      const created = keyCreationTime(gpgProgram, policy.signingKey, env);
      const signTime = signTimeFor(p.committerEpoch, policy, created);
      const signer = createSigner(repo, env, { signingKey: policy.signingKey, signTime, gpgProgram });
      signers.push(signer);
      const newParent = p.parents.length === 0 ? null : oldToNew.get(p.parents[0]) || p.parents[0];
      const ctArgs = ["commit-tree", "-S", p.tree];
      if (newParent) ctArgs.push("-p", newParent);
      const nc = text(repo, ctArgs, {
        env: Object.assign({}, env, {
          GIT_AUTHOR_NAME: p.authorIdent.name,
          GIT_AUTHOR_EMAIL: p.authorIdent.email,
          GIT_AUTHOR_DATE: p.authorDate,
          GIT_COMMITTER_NAME: p.committerIdent.name,
          GIT_COMMITTER_EMAIL: p.committerIdent.email,
          GIT_COMMITTER_DATE: p.committerDate
        }),
        input: commitMessageBytes(repo, env, p.sha),
        config: signer.gitConfig
      });
      const newTree = text(repo, ["rev-parse", nc + "^{tree}"], { env });
      oldToNew.set(p.sha, nc);
      pairs.push({ old: p.sha, nw: nc, origTree: p.tree, newTree });
    }
    const newHeadOf = (oldSha) => oldToNew.get(oldSha);
    const signedTags = affectedTags.filter((t) => t.type === "tag");
    const tagRaw = /* @__PURE__ */ new Map();
    const tagImmediate = /* @__PURE__ */ new Map();
    for (const t of signedTags) {
      const raw = buffer(repo, ["cat-file", "-p", t.obj], { env }).toString("utf8");
      tagRaw.set(t.name, raw);
      const om = /^object ([0-9a-f]{40})$/m.exec(raw);
      const tym = /^type (\S+)$/m.exec(raw);
      if (!om || !tym) throw new Refusal("tag " + t.name + ": malformed tag object");
      tagImmediate.set(t.name, { type: tym[1], obj: om[1] });
    }
    const tagResults = [];
    for (const t of affectedTags) {
      if (t.type !== "tag") tagResults.push({ name: t.name, type: t.type, oldSha: t.obj, newSha: newHeadOf(t.commit) });
    }
    const tagOldObjToNewObj = /* @__PURE__ */ new Map();
    const pending = new Set(signedTags.map((t) => t.name));
    while (pending.size > 0) {
      let progressed = false;
      for (const t of signedTags) {
        if (!pending.has(t.name)) continue;
        const info = tagImmediate.get(t.name);
        let newTarget;
        if (info.type === "commit") {
          newTarget = newHeadOf(info.obj);
        } else if (info.type === "tag") {
          const inner = tagOldObjToNewObj.get(info.obj);
          if (inner === void 0) continue;
          newTarget = inner;
        } else {
          throw new Refusal("tag " + t.name + " points at a " + info.type + ", not a commit or tag -- not supported");
        }
        const raw = tagRaw.get(t.name);
        const tm = /^tagger (.*) (\d+) ([+-]\d{4})$/m.exec(raw);
        const taggerEpoch = parseInt(tm[2], 10);
        const msg = tagMessageFromRaw(raw);
        const hasSig = signatureBlockCount(raw, "tag") === 1;
        const oldStatus = signatureStatus(repo, env, "tag", "refs/tags/" + t.name, hasSig, policy.signingKey);
        if (hasSig && oldStatus.state === "bad") {
          throw new Refusal("tag " + t.name + " ends with a signature-shaped block gpg cannot verify or attribute to any key -- indistinguishable from an unsigned tag whose message merely ends with a quoted block; refusing to guess, resolve manually");
        }
        const oldKey = unverifiableKeyLabel(oldStatus);
        if (oldKey) process.stdout.write("resign-commits: tag " + t.name + " replaced unverifiable signature (key " + oldKey + ")\n");
        const taggerCreated = keyCreationTime(gpgProgram, policy.signingKey, env);
        const signTime = signTimeFor(taggerEpoch, policy, taggerCreated);
        const signer = createSigner(repo, env, { signingKey: policy.signingKey, signTime, gpgProgram });
        signers.push(signer);
        const newTagSha = buildSignedTagObject(repo, env, signer, {
          object: newTarget,
          type: info.type,
          name: t.name,
          taggerLine: tm[1] + " " + tm[2] + " " + tm[3],
          message: msg
        });
        tagOldObjToNewObj.set(t.obj, newTagSha);
        tagResults.push({ name: t.name, type: t.type, oldSha: t.obj, newSha: newTagSha });
        pending.delete(t.name);
        progressed = true;
      }
      if (!progressed) {
        throw new Refusal("could not resolve tag dependency order for: " + Array.from(pending).join(", "));
      }
    }
    const stdinLines = ["start"];
    for (const b of affectedBranches) {
      stdinLines.push("update refs/heads/" + b.name + " " + newHeadOf(b.sha) + " " + b.sha);
    }
    for (const r of tagResults) {
      stdinLines.push("update refs/tags/" + r.name + " " + r.newSha + " " + r.oldSha);
    }
    stdinLines.push("prepare", "commit");
    const txn = run(repo, ["update-ref", "--stdin"], { env, input: stdinLines.join("\n") + "\n" });
    if (txn.status !== 0) {
      throw new Refusal("ref update transaction failed: " + txn.stderr.trim().split("\n")[0]);
    }
    if (flags["map-out"]) {
      const mapLines = pairs.map((p) => p.old + " " + p.nw).concat(tagResults.map((r) => r.oldSha + " " + r.newSha));
      fs5.writeFileSync(flags["map-out"], mapLines.length ? mapLines.join("\n") + "\n" : "");
    }
    const movedTagNames = new Set(affectedTags.map((t) => t.name));
    const results = [
      verifyTreeDelta(pairs.map((p) => ({ label: p.old, expected: p.origTree, actual: p.newTree }))),
      verifyHeadersPreserved(repo, env, pairs),
      verifyParentsMapped(repo, env, pairs, parsed),
      verifyNewSignatures(repo, env, gpgProgram, policy, pairs, movedTagNames)
    ];
    for (const r of results) process.stdout.write(r.line + "\n");
    for (const p of pairs) {
      process.stdout.write("resign-commits: " + p.old.slice(0, 7) + " -> " + p.nw.slice(0, 7) + (p.old === p.nw ? " (unchanged)" : "") + "\n");
    }
    for (const b of affectedBranches) {
      if (newHeadOf(b.sha) === b.sha) continue;
      process.stdout.write("# git push --force-with-lease=" + b.name + ":" + b.sha + " <remote> " + b.name + "\n");
    }
    for (const r of tagResults) {
      if (r.newSha === r.oldSha) continue;
      process.stdout.write("# git push --force-with-lease=refs/tags/" + r.name + ":" + r.oldSha + " <remote> refs/tags/" + r.name + "\n");
    }
    process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
  } finally {
    for (const s of signers) s.cleanup();
    for (const t of tmpFiles) t.cleanup();
  }
}
var SYNOPSES = {
  commit: "git-sign commit <repo> (--message=<text>|--message-file=<path>) --date=(auto|<date>) [--amend] [--policy=<file>] [--apply]",
  tag: "git-sign tag <repo> <tag> (--message=<text>|--message-file=<path>) --date=(auto|<date>) [--policy=<file>] [--apply]",
  "resign-tags": "git-sign resign-tags <repo> [<tag> ...] [--policy=<file>] [--apply]",
  "resign-commits": "git-sign resign-commits <repo> (<lower>..<upper> | <rev> --from-root) [--map-out=<file>] [--policy=<file>] [--apply]",
  check: "git-sign check <repo> [<range> | --range=<range>] [--tags] [--policy=<file>]"
};
var FOOTER = "Every writing subcommand is a dry run unless --apply is given. See docs/SPECIFICATION.md \xA7 5.";
function usage() {
  return "usage:\n" + Object.values(SYNOPSES).map((l) => "  " + l + "\n").join("") + FOOTER + "\n";
}
var COMMANDS = {
  commit: cmdCommit,
  tag: cmdTag,
  "resign-tags": cmdResignTags,
  check: cmdCheck,
  "resign-commits": cmdResignCommits
};
main("git-sign", (bin) => {
  const sub = process.argv[2];
  const rest = process.argv.slice(3);
  if (sub === void 0) {
    process.stderr.write(bin + ": missing subcommand\n" + usage());
    process.exit(2);
  }
  if (printHelp(sub, rest, SYNOPSES, FOOTER)) return;
  if (!Object.hasOwn(COMMANDS, sub)) throw new UsageError("unknown subcommand '" + sub + "'");
  return COMMANDS[sub](bin, rest);
});
