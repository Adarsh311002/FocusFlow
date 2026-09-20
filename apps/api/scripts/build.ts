import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { z } from 'zod';

const packageJsonSchema = z.object({
  dependencies: z.record(z.string(), z.string()).default({}),
});

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entryPoint = resolve(packageRoot, 'src/main.ts');
const outfile = resolve(packageRoot, 'dist/main.js');

const readExternals = async (): Promise<string[]> => {
  const raw: unknown = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  const { dependencies } = packageJsonSchema.parse(raw);

  return [
    // Runtime dependencies stay external and are installed on the server; workspace
    // packages ship as TypeScript source, so they have to be bundled in.
    ...Object.keys(dependencies).filter((name) => !name.startsWith('@focus-flow/')),
    // Optional native binding that node-postgres only requires when it is present.
    'pg-native',
  ];
};

const main = async (): Promise<void> => {
  const external = await readExternals();

  await build({
    entryPoints: [entryPoint],
    outfile,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    bundle: true,
    sourcemap: true,
    minify: false,
    external,
  });

  const { size } = await stat(outfile);
  const kilobytes = (size / 1024).toFixed(1);
  process.stdout.write(`built dist/main.js (${kilobytes} kB, ${external.length} external)\n`);
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`build failed: ${message}\n`);
  process.exit(1);
});
