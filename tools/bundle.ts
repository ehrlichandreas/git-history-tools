#!/usr/bin/env node
/* Builds the three dist/*.mjs bundles that package.json's "bin" field points
 * at directly (D7): dist/squash.mjs, dist/scan.mjs and dist/rewrite.mjs,
 * each the corresponding lib/*.ts entry plus everything it imports from
 * lib/, bundled by esbuild into one self-contained ESM file. esbuild is a
 * devDependency, required only here -- the lib/*.ts sources it reads still
 * have zero runtime dependencies.
 *
 * Node refuses to type-strip a .ts file whose resolved path contains the
 * literal string "node_modules" (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING),
 * so once this package is installed as a dependency, the raw lib/*.ts files
 * can never be the runtime entry point -- only a compiled dist/*.mjs works.
 * bin/*'s own direct-checkout use (tests, local invocation) is unaffected:
 * those wrappers still exec lib/*.ts straight, with no build step required.
 *
 *   node tools/bundle.ts           write dist/*.mjs
 *   node tools/bundle.ts --check   build everything in memory; exit 1 unless
 *                                  every dist/*.mjs is byte-identical to the
 *                                  committed file and executable -- catches
 *                                  a stale bundle
 *
 * Output is deterministic: no absolute paths, no timestamps -- `absWorkingDir`
 * below pins the build to depend only on the sources, never on where this
 * script was invoked from.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as esbuild from 'esbuild';
import { builtinModules } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

interface DistTarget {
  entry: string;
  out: string;
}
const DIST_TARGETS: DistTarget[] = [
  { entry: path.join(ROOT, 'lib', 'squash.ts'), out: path.join(ROOT, 'dist', 'squash.mjs') },
  { entry: path.join(ROOT, 'lib', 'scan.ts'), out: path.join(ROOT, 'dist', 'scan.mjs') },
  { entry: path.join(ROOT, 'lib', 'rewrite.ts'), out: path.join(ROOT, 'dist', 'rewrite.mjs') },
];

// node:* only: a relative/absolute import is left to esbuild's own resolver
// (it gets bundled in); anything else must name a real Node built-in, and is
// rewritten to its `node:`-prefixed form in the output -- this package has
// no runtime dependencies, and the shipped bundle must not gain any.
const builtins = new Set<string>(builtinModules);
const nodeOnlyImports: esbuild.Plugin = {
  name: 'node-only-imports',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.path.startsWith('.') || args.path.startsWith('/')) return null;
      const bare = args.path.startsWith('node:') ? args.path.slice(5) : args.path;
      if (!builtins.has(bare)) {
        return { errors: [{ text: `import '${args.path}' is not a node:* built-in -- the shipped bundle may import only Node built-ins` }] };
      }
      return { path: 'node:' + bare, external: true };
    });
  },
};

const checking = process.argv.includes('--check');

interface DistPending {
  rel: string;
  out: string;
  content: Buffer;
}

async function main(): Promise<void> {
  const problems: string[] = [];
  const distPending: DistPending[] = [];

  for (const { entry, out: OUT } of DIST_TARGETS) {
    const rel = path.relative(ROOT, OUT);
    // `build` (async), not `buildSync`: esbuild refuses plugins (needed for
    // nodeOnlyImports above) in the synchronous API.
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      plugins: [nodeOnlyImports],
      write: false,
      logLevel: 'silent',
      absWorkingDir: ROOT,
    });
    if (result.errors.length) {
      for (const e of result.errors) problems.push(e.text);
      continue;
    }
    distPending.push({ rel, out: OUT, content: Buffer.from(result.outputFiles![0].contents) });
  }

  if (problems.length) {
    for (const p of problems) process.stderr.write(`bundle: ${p}\n`);
    if (!checking) process.stderr.write('bundle: nothing was written\n');
    process.exit(checking ? 1 : 2);
  }

  if (checking) {
    let staleAny = false;
    for (const { rel, out: OUT, content } of distPending) {
      let have: Buffer | null = null;
      try { have = fs.readFileSync(OUT); } catch { /* missing counts as stale */ }
      if (!have || !have.equals(content)) {
        process.stderr.write(`bundle --check: ${rel} is STALE -- a fresh build differs. Run \`node tools/bundle.ts\` and commit ${rel}.\n`);
        staleAny = true;
        continue;
      }
      let executable = false;
      try { executable = (fs.statSync(OUT).mode & 0o111) !== 0; } catch { /* missing, already reported above */ }
      if (!executable) {
        process.stderr.write(`bundle --check: ${rel} is not executable. Run \`node tools/bundle.ts\` and commit ${rel}.\n`);
        staleAny = true;
        continue;
      }
      process.stdout.write(`bundle --check: ${rel} is byte-identical to a fresh build\n`);
    }
    if (staleAny) process.exit(1);
  } else {
    for (const { rel, out: OUT, content } of distPending) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, content);
      fs.chmodSync(OUT, 0o755);
      process.stdout.write(`bundle: ${rel} written (${content.length} bytes)\n`);
    }
  }
}

main();
