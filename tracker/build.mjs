/**
 * Builds tracker/src/tracker.js into public/i.js and enforces the size budget.
 *
 * The README claims the tracker is under 1 KB minified. That claim is only
 * worth making if it is checked, so this fails the build when it is exceeded.
 *
 *   node tracker/build.mjs          build + check
 *   node tracker/build.mjs --check  build + check, printing headroom
 */
import { gzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(root, 'tracker', 'src', 'tracker.js');
const OUT = join(root, 'public', 'i.js');

/** Hard budget in bytes. Raising this number requires changing the README too. */
export const BUDGET = 1024;

export async function buildTracker() {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['es2017'],
    legalComments: 'none',
    write: false,
  });

  const [file] = result.outputFiles;
  const code = file.text.trim();
  const bytes = Buffer.byteLength(code, 'utf8');
  const gzip = gzipSync(code).length;

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, code + '\n', 'utf8');

  return { code, bytes, gzip };
}

const fmt = (n) => n.toString().padStart(4, ' ');

/** Only report and gate when run directly; importing this module just builds. */
async function main() {
  const { bytes, gzip } = await buildTracker();
  const over = bytes > BUDGET;

  console.log(`  minified  ${fmt(bytes)} B  / ${BUDGET} B budget`);
  console.log(`  gzipped   ${fmt(gzip)} B`);
  console.log(
    over
      ? `  OVER BUDGET by ${bytes - BUDGET} B`
      : `  ${BUDGET - bytes} B of headroom`,
  );

  if (over) {
    console.error(
      `
Tracker is ${bytes - BUDGET} B over the ${BUDGET} B budget.
` +
        `The "under 1 KB" claim is a documented invariant — trim the script
` +
        `rather than raising the budget. See CONTRIBUTING.md.`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
