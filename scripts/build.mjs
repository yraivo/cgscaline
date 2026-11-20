import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: { cgscaline: join(ROOT, 'src/cli.ts') },
  outdir: join(ROOT, 'dist'),
  bundle: true,
  splitting: true,
  outExtension: { '.js': '.mjs' },
  chunkNames: 'chunks/[name]-[hash]',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['undici'],
  banner: { js: '#!/usr/bin/env node' },
});

await writeFile(join(ROOT, 'dist/cgsport.mjs'), "#!/usr/bin/env node\nimport './cgscaline.mjs';\n");
