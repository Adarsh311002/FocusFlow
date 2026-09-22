/**
 * Fails when a JavaScript file exists anywhere in the Focus Flow v2 codebase.
 *
 * v2 is TypeScript only, so a stray .js/.jsx/.cjs/.mjs file is an architectural
 * violation rather than a style problem. The legacy v1 application (Client/,
 * Server/) and the design scratch space (archi/) are frozen and excluded.
 *
 * Usage: pnpm check:no-js
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/** Directory names that are never walked, at any depth. */
const SKIPPED_DIRECTORIES = new Set<string>([
  'node_modules',
  '.pnpm-store',
  '.git',
  'dist',
  'build',
  'coverage',
  // Legacy v1 application: frozen, excluded from v2 tooling (I12).
  'Client',
  'Server',
  // Design scratch space: not part of the workspace.
  'archi',
]);

const JAVASCRIPT_EXTENSIONS = new Set<string>(['.js', '.jsx', '.cjs', '.mjs']);

const repoRoot = path.resolve(import.meta.dirname, '..');

/** Repository-relative path with forward slashes, so output is identical on Windows and Linux. */
function toDisplayPath(absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).split(path.sep).join('/');
}

async function collectJavaScriptFiles(directory: string, found: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        await collectJavaScriptFiles(absolutePath, found);
      }
      continue;
    }

    if (entry.isFile() && JAVASCRIPT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      found.push(toDisplayPath(absolutePath));
    }
  }
}

const offendingFiles: string[] = [];
await collectJavaScriptFiles(repoRoot, offendingFiles);
offendingFiles.sort((left, right) => left.localeCompare(right));

if (offendingFiles.length > 0) {
  console.error(`Found ${offendingFiles.length} JavaScript file(s) in the v2 codebase:`);
  for (const file of offendingFiles) {
    console.error(`  ${file}`);
  }
  console.error('');
  console.error('Focus Flow v2 is TypeScript only: convert these files to .ts/.tsx.');
  console.error('If a tool genuinely requires JavaScript, add the case to scripts/check-no-js.ts.');
  process.exitCode = 1;
} else {
  console.log('check:no-js: no JavaScript files found in the v2 codebase.');
}
