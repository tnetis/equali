/**
 * Build: copy src/ to dist/, sync the manifest version from package.json and
 * minify JS/CSS with esbuild. The source tree already runs unpacked, so this
 * step only optimises + validates.
 */

import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = process.cwd();
const srcDir = path.join(root, 'src');
const distDir = path.join(root, 'dist');

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

if (!existsSync(srcDir)) {
  console.error('No existe src/. Ejecuta el script desde la raíz del proyecto.');
  process.exit(1);
}

await rm(distDir, { recursive: true, force: true });
await cp(srcDir, distDir, { recursive: true });

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const manifestPath = path.join(distDir, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.version = pkg.version;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const files = await walk(distDir);
let js = 0;
let css = 0;
let bytesBefore = 0;
let bytesAfter = 0;

for (const file of files) {
  const code = await readFile(file, 'utf8');
  bytesBefore += Buffer.byteLength(code);

  if (file.endsWith('.js')) {
    const result = await esbuild.transform(code, {
      loader: 'js',
      minifyWhitespace: true,
      minifySyntax: true,
      // Keep exported names intact: eq-engine.js is imported by name from
      // popup.js and offscreen.js, and files are minified one by one.
      minifyIdentifiers: false,
      target: 'chrome116',
      format: 'esm',
      legalComments: 'none'
    });
    await writeFile(file, result.code);
    bytesAfter += Buffer.byteLength(result.code);
    js += 1;
  } else if (file.endsWith('.css')) {
    const result = await esbuild.transform(code, {
      loader: 'css',
      minify: true,
      target: 'chrome116',
      legalComments: 'none'
    });
    await writeFile(file, result.code);
    bytesAfter += Buffer.byteLength(result.code);
    css += 1;
  } else {
    bytesAfter += Buffer.byteLength(code);
  }
}

for (const icon of ['icon16.png', 'icon32.png', 'icon48.png', 'icon128.png']) {
  if (!existsSync(path.join(distDir, 'icons', icon))) {
    console.error(`Falta dist/icons/${icon}`);
    process.exit(1);
  }
}

const saved = bytesBefore ? Math.round((1 - bytesAfter / bytesBefore) * 100) : 0;
console.log(`Build OK · ${js} JS, ${css} CSS · ${(bytesAfter / 1024).toFixed(1)} KiB (${saved}% menos)`);
console.log(`Salida: ${distDir}`);
