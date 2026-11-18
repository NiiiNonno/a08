import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { cp, mkdir } from 'node:fs/promises';

const out = new URL('./dist/', import.meta.url).pathname;
await mkdir(out, { recursive: true });
await build({
  entryPoints: [new URL('./src/main.ts', import.meta.url).pathname],
  bundle: true,
  outfile: `${out}main.js`,
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  sourcemap: 'inline',
  external: [
    'obsidian',
    'electron',
    '@codemirror/*',
    '@lezer/*',
    'bufferutil',
    'utf-8-validate',
    ...builtinModules,
    ...builtinModules.map(m => `node:${m}`),
  ],
  logLevel: 'info',
});
for (const f of ['manifest.json', 'styles.css']) {
  await cp(new URL(`./${f}`, import.meta.url), `${out}${f}`);
}
