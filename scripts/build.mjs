import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
await rm('dist', { recursive: true, force: true });
await mkdir('dist/public/assets', { recursive: true });
await build({ entryPoints: ['ui/main.tsx'], bundle: true, format: 'esm', target: 'es2022', jsx: 'automatic',
    outfile: 'dist/public/assets/app.js', minify: true, legalComments: 'external', sourcemap: false,
    define: { 'process.env.NODE_ENV': '"production"' } });
await cp('ui/index.html', 'dist/public/index.html');
const sdkRoot = path.join(root, 'node_modules/@xinonix/easi-view/dist');
const pkg = JSON.parse(await readFile('node_modules/@xinonix/easi-view/package.json', 'utf8'));
if (pkg.version !== '1.0.0-rc.1') throw new Error('Unexpected EASI View SDK version.');
await cp(sdkRoot, 'dist/public/vendor/easi-view/1.0.0-rc.1', { recursive: true });
await cp('LICENSE', 'dist/public/LICENSE.txt');
await cp('NOTICE', 'dist/public/NOTICE.txt');
await cp('licenses', 'dist/public/licenses', { recursive: true });
const files = [];
async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(p);
        else files.push({ path: path.relative('dist/public', p).split(path.sep).join('/'),
            sha256: createHash('sha256').update(await readFile(p)).digest('hex') });
    }
}
await walk('dist/public');
await writeFile('dist/manifest.json', JSON.stringify({ version, easiJs: '1.0.1', easiView: pkg.version, files }, null, 2) + '\n');
console.log(`Built EASI Store ${version}: ${files.length} public files; independent EASI View SDK ${pkg.version}.`);
