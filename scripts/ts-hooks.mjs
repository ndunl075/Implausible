/**
 * Lets the test suite import the app's TypeScript sources directly.
 *
 * Node can already strip types, but it will not resolve the extensionless and
 * `@/`-aliased specifiers the app uses, and plain stripping chokes on TS
 * parameter properties. These hooks add the resolution rules and switch the
 * built-in transform on. No build step, no extra dependency, and tests run
 * against the real source rather than a compiled copy of it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = new URL('../src/', import.meta.url);
const CANDIDATES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

/** Resolves `@/lib/x` and `./x` to a real .ts file, or null to defer to Node. */
function locate(specifier, parentURL) {
  let base;
  if (specifier.startsWith('@/')) {
    base = new URL(specifier.slice(2), SRC);
  } else if (/^\.{1,2}\//.test(specifier) && parentURL) {
    base = new URL(specifier, parentURL);
  } else {
    return null;
  }

  if (path.extname(base.pathname)) return null;

  for (const ext of CANDIDATES) {
    const candidate = new URL(base.href + ext);
    if (existsSync(fileURLToPath(candidate))) return candidate.href;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const found = locate(specifier, context.parentURL);
    if (found) return { url: found, format: 'module', shortCircuit: true };
    return nextResolve(specifier, context);
  },

  load(url, context, nextLoad) {
    if (url.endsWith('.ts') || url.endsWith('.tsx')) {
      const source = readFileSync(fileURLToPath(url), 'utf8');
      return {
        format: 'module',
        shortCircuit: true,
        source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }),
      };
    }
    return nextLoad(url, context);
  },
});
